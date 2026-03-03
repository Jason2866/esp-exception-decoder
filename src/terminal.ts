import path from 'node:path'

import debug from 'debug'
import { DecodeResult, decode, stringifyDecodeResult } from 'trbr'
import vscode from 'vscode'

import {
  DecodeParams,
  DecodeParamsError,
  createPioDecodeParams,
} from './decodeParams'
import {
  findPioProjects,
  hasPioProjects,
  pickPioEnvironment,
  resolveEnvironment,
  syntheticFqbn,
  type PioResolvedEnv,
} from './platformio'
import type { ReplayStore } from './replay'
import { Debug } from './utils'

const terminalDebug: Debug = debug('espExceptionDecoder:terminal')

let _debugOutput: vscode.OutputChannel | undefined
function debugOutput(): vscode.OutputChannel {
  if (!_debugOutput) {
    _debugOutput = vscode.window.createOutputChannel(
      `${decodeTerminalTitle} (Log)`
    )
  }
  return _debugOutput
}
function createDebugOutput(): Debug {
  return (message) => debugOutput().appendLine(message)
}

export function activatePioDecoderTerminal(
  context: vscode.ExtensionContext,
  replayStore?: ReplayStore
): void {
  context.subscriptions.push(
    new vscode.Disposable(() => _debugOutput?.dispose()),
    vscode.window.registerTreeDataProvider('espExceptionDecoder.welcome', {
      getTreeItem: () => new vscode.TreeItem(''),
      getChildren: () => [],
    }),
    vscode.commands.registerCommand('espExceptionDecoder.showTerminal', () =>
      openPioTerminal({
        show: true,
        debug: createDebugOutput(),
        replayStore,
      })
    )
  )
}

const decodeTerminalTitle = 'ESP Exception Decoder'
const decodeTerminalName = 'Crash Decoder'
const initializing = 'Initializing...'
const busy = 'Decoding...'
const idle = 'Paste crash to decode...'

interface DecodeTerminalState {
  params: DecodeParams | Error
  userInput?: string | undefined
  decoderResult?: DecodeResult | Error | undefined
  statusMessage?: string | undefined
  serialConnected?: boolean
  serialPortLabel?: string
  serialLines?: string[]
}

function findDecodeTerminal(): vscode.Terminal | undefined {
  return vscode.window.terminals.find(
    (terminal) =>
      terminal.name === decodeTerminalName && terminal.exitStatus === undefined
  )
}

function stringifyTerminalState(state: DecodeTerminalState): string {
  const lines = [decodeTerminalTitle]
  const { params, userInput, decoderResult, serialConnected, serialPortLabel } =
    state
  let { statusMessage } = state

  // Show sketch info or decoder error
  if (params instanceof Error && !(params instanceof DecodeParamsError)) {
    lines.push(red(toTerminalEOL(params.message)))
  } else {
    const { fqbn, sketchPath } = params
    lines.push(
      `Sketch: ${green(path.basename(sketchPath))} FQBN: ${green(
        fqbn.toString()
      )}`
    )
    if (params instanceof DecodeParamsError) {
      statusMessage = red(toTerminalEOL(params.message))
    }
  }

  // Serial monitor status and output (always shown, independent of decoder)
  if (serialConnected && serialPortLabel) {
    lines.push(
      `Serial: ${green('CONNECTED')} ${blue(serialPortLabel)}`
    )
  }
  if (state.serialLines && state.serialLines.length > 0) {
    lines.push('')
    lines.push(...state.serialLines.map((l) => toTerminalEOL(l)))
  }

  // Decode results (only when params are valid)
  if (!(params instanceof Error)) {
    if (userInput) {
      lines.push('', userInput)
    }
    if (decoderResult) {
      lines.push('')
      if (decoderResult instanceof Error) {
        lines.push(red(toTerminalEOL(decoderResult.message)))
      } else {
        lines.push(
          ...stringifyDecodeResult(decoderResult, {
            lineSeparator: terminalEOL,
            color: 'force',
          }).split(terminalEOL)
        )
      }
    }
  }

  if (statusMessage) {
    lines.push('', statusMessage, '')
  }
  return stringifyLines(lines)
}

function stringifyLines(lines: string[]): string {
  return toTerminalEOL(lines.join(terminalEOL))
}

function toTerminalEOL(data: string): string {
  return data.split(/\r?\n|\r/g).join(terminalEOL)
}

const terminalEOL = '\r\n'
const clear = '\x1b[2J\x1b[3J\x1b[;H'
const resetFgColorStyle = '\x1b[39m'
enum ANSIStyle {
  red = 31,
  green = 32,
  blue = 34,
}
function red(text: string): string {
  return color(text, ANSIStyle.red)
}
function green(text: string): string {
  return color(text, ANSIStyle.green)
}
function blue(text: string): string {
  return color(text, ANSIStyle.blue)
}
function color(text: string, foregroundColor: ANSIStyle): string {
  return `\x1b[${foregroundColor}m${text}${resetFgColorStyle}`
}

let _activePty: PioDecoderTerminal | undefined

function openPioTerminal(
  options: { show: boolean; debug: Debug; replayStore?: ReplayStore } = {
    show: true,
    debug: terminalDebug,
  }
): { terminal: vscode.Terminal; pty: PioDecoderTerminal } {
  const { debug, show } = options
  const existing = findDecodeTerminal()
  if (existing && _activePty) {
    if (show) existing.show()
    return { terminal: existing, pty: _activePty }
  }
  const { terminal, pty } = createPioDecodeTerminal(debug, options.replayStore)
  if (show) {
    terminal.show()
  }
  return { terminal, pty }
}

function createPioDecodeTerminal(
  dbg: Debug,
  replayStore?: ReplayStore
): { terminal: vscode.Terminal; pty: PioDecoderTerminal } {
  const pty = new PioDecoderTerminal(dbg, replayStore)
  _activePty = pty
  const options: vscode.ExtensionTerminalOptions = {
    name: decodeTerminalName,
    pty,
    iconPath: new vscode.ThemeIcon('debug-console'),
  }
  const terminal = vscode.window.createTerminal(options)
  return { terminal, pty }
}

export function getActivePty(): PioDecoderTerminal | undefined {
  return _activePty
}

const MAX_SERIAL_LINES = 500
const REDRAW_THROTTLE_MS = 100
const CRASH_IDLE_TIMEOUT_MS = 800
const CRASH_DEDUP_WINDOW_MS = 5000

/**
 * Primary crash-start patterns: these always indicate the beginning of a
 * _new_ crash and will finalize any crash that is currently being buffered.
 */
const crashPrimaryStartPatterns = [
  /Guru Meditation Error/,
  /Core\s+\d+\s+panic/,
  /assert failed:/,
]

/**
 * Secondary crash-start patterns: these can start a crash buffer when none
 * is active, but they do NOT interrupt an already-active buffer because they
 * also appear _inside_ a crash (e.g. "Stack memory:", "ELF file SHA256:").
 */
const crashSecondaryStartPatterns = [
  /Backtrace:/,
  /Exception \(/,
  /ELF file SHA256:/,
  /Stack memory:/,
  /Decoding stack results/,
  />>>stack>>>/,
]

const crashEndPatterns = [/Rebooting\.\.\./, /<<<stack<<</, /={10,}/]

class PioDecoderTerminal implements vscode.Pseudoterminal {
  readonly onDidWrite: vscode.Event<string>
  readonly onDidClose: vscode.Event<number | void>

  private readonly onDidWriteEmitter: vscode.EventEmitter<string>
  private readonly onDidCloseEmitter: vscode.EventEmitter<number | void>
  private readonly toDispose: vscode.Disposable[]

  private state: DecodeTerminalState
  private abortController: AbortController | undefined
  private resolvedEnv: PioResolvedEnv | undefined
  private fileWatcher: vscode.FileSystemWatcher | undefined
  private redrawTimer: ReturnType<typeof setTimeout> | undefined
  private crashBuffer: string[] | undefined
  private crashIdleTimer: ReturnType<typeof setTimeout> | undefined
  private lastCrashSignature: string | undefined
  private lastCrashTime = 0
  private suppressedCount = 0
  private serialLineBuffer = ''
  private serialPaused = false
  private serialResumeTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly debug: Debug = terminalDebug,
    private readonly replayStore?: ReplayStore
  ) {
    this.onDidWriteEmitter = new vscode.EventEmitter<string>()
    this.onDidCloseEmitter = new vscode.EventEmitter<number | void>()
    this.toDispose = [
      this.onDidWriteEmitter,
      this.onDidCloseEmitter,
      new vscode.Disposable(() => this.abortController?.abort()),
      new vscode.Disposable(() => this.fileWatcher?.dispose()),
    ]
    this.onDidWrite = this.onDidWriteEmitter.event
    this.onDidClose = this.onDidCloseEmitter.event
    this.state = {
      params: new Error(initializing),
      statusMessage: idle,
    }
  }

  async open(): Promise<void> {
    await this.initializeFromPio()
    // Watch for ELF file changes (rebuild detection)
    this.setupFileWatcher()
  }

  close(): void {
    clearTimeout(this.redrawTimer)
    clearTimeout(this.crashIdleTimer)
    clearTimeout(this.serialResumeTimer)
    vscode.Disposable.from(...this.toDispose).dispose()
  }

  appendSerialData(data: string): void {
    // Buffer partial lines: serial data arrives in arbitrary chunks
    this.serialLineBuffer += data
    const parts = this.serialLineBuffer.split(/\r?\n|\r/)
    // Last element is an incomplete line — keep it in the buffer
    this.serialLineBuffer = parts.pop() ?? ''

    if (parts.length === 0) return

    const serialLines = this.state.serialLines ?? []
    for (const line of parts) {
      // Always run crash detection, even when display is paused
      this.detectCrashLine(line)
      if (!this.serialPaused) {
        serialLines.push(line)
      }
    }
    if (this.serialPaused) return
    // Cap ring buffer
    while (serialLines.length > MAX_SERIAL_LINES) {
      serialLines.shift()
    }
    this.state.serialLines = serialLines
    this.scheduleRedraw()
  }

  setSerialConnected(connected: boolean, portLabel?: string): void {
    if (connected) {
      this.serialPaused = false
      this.suppressedCount = 0
      this.lastCrashSignature = undefined
    }
    this.updateState({
      serialConnected: connected,
      serialPortLabel: portLabel,
      serialLines: connected ? [] : this.state.serialLines,
    })
  }

  private detectCrashLine(line: string): void {
    const isPrimaryStart = crashPrimaryStartPatterns.some((p) => p.test(line))
    const isSecondaryStart =
      !isPrimaryStart && crashSecondaryStartPatterns.some((p) => p.test(line))
    const isCrashStart = isPrimaryStart || isSecondaryStart

    // Only a primary crash start (e.g. "Guru Meditation Error") may
    // interrupt an active buffer.  Secondary patterns like "Stack memory:"
    // or "ELF file SHA256:" appear *inside* a crash and must not split it.
    if (isPrimaryStart && this.crashBuffer) {
      clearTimeout(this.crashIdleTimer)
      this.finalizeCrashBuffer()
    }

    if (!this.crashBuffer) {
      if (isCrashStart) {
        this.debug(`Crash trace detected: ${line}`)
        this.crashBuffer = [line]
        this.resetCrashIdleTimer()
      }
      return
    }

    // Finalize immediately on crash-end markers
    const isCrashEnd = crashEndPatterns.some((p) => p.test(line))
    if (isCrashEnd) {
      this.crashBuffer.push(line)
      clearTimeout(this.crashIdleTimer)
      this.finalizeCrashBuffer()
      return
    }

    this.crashBuffer.push(line)
    this.resetCrashIdleTimer()
  }

  private resetCrashIdleTimer(): void {
    clearTimeout(this.crashIdleTimer)
    this.crashIdleTimer = setTimeout(() => {
      this.finalizeCrashBuffer()
    }, CRASH_IDLE_TIMEOUT_MS)
  }

  private finalizeCrashBuffer(): void {
    if (!this.crashBuffer || this.crashBuffer.length === 0) return
    const crashText = this.crashBuffer.join('\n')
    this.crashBuffer = undefined

    // Dedup: extract stable crash signature (MEPC, MCAUSE, error type)
    // and suppress repeated identical crashes
    const signature = extractCrashSignature(crashText)
    const now = Date.now()
    if (
      signature === this.lastCrashSignature &&
      now - this.lastCrashTime < CRASH_DEDUP_WINDOW_MS
    ) {
      this.suppressedCount++
      this.serialPaused = true
      this.lastCrashTime = now
      this.debug(
        `Suppressed duplicate crash #${this.suppressedCount}`
      )
      this.scheduleSerialResume()
      this.updateState({
        statusMessage: `Crash loop detected — repeated crash suppressed (×${this.suppressedCount + 1})`,
        serialLines: [],
      })
      return
    }
    this.lastCrashSignature = signature
    this.lastCrashTime = now
    this.suppressedCount = 0
    this.serialPaused = false
    clearTimeout(this.serialResumeTimer)

    // Clear serial lines so decode result is visible
    this.debug(`Auto-decoding crash trace (${crashText.length} chars)`)
    this.state.serialLines = []
    this.handleInput(crashText)
  }

  /**
   * After suppressing a duplicate crash, schedule a timer to resume serial
   * display once the dedup window has passed without a new crash.
   */
  private scheduleSerialResume(): void {
    clearTimeout(this.serialResumeTimer)
    this.serialResumeTimer = setTimeout(() => {
      if (this.serialPaused) {
        this.debug('Dedup window expired — resuming serial display')
        this.serialPaused = false
        this.suppressedCount = 0
        this.lastCrashSignature = undefined
        this.updateState({ statusMessage: idle })
      }
    }, CRASH_DEDUP_WINDOW_MS)
  }

  private scheduleRedraw(): void {
    if (this.redrawTimer) return
    this.redrawTimer = setTimeout(() => {
      this.redrawTimer = undefined
      this.redrawTerminal()
    }, REDRAW_THROTTLE_MS)
  }

  handleInput(data: string): void {
    this.debug(`handleInput: ${data}`)
    if (data.trim().length < 2) {
      this.debug(`handleInput, skip: ${data}`)
      return
    }
    if (this.state.params instanceof Error) {
      this.debug(`handleInput, no decode params available`)
      this.updateState({
        userInput: toTerminalEOL(data),
        statusMessage:
          'Crash received (decoding unavailable — no ELF file loaded)',
      })
      return
    }
    const params = this.state.params
    this.updateState({
      userInput: toTerminalEOL(data),
      statusMessage: busy,
      decoderResult: undefined,
    })
    setTimeout(() => this.decode(params, data), 0)
  }

  private async decode(params: DecodeParams, data: string): Promise<void> {
    this.abortController?.abort()
    this.abortController = new AbortController()
    const signal = this.abortController.signal
    let decoderResult: DecodeTerminalState['decoderResult']
    try {
      const result = await decode(params, data, {
        signal,
        debug: this.debug,
      })
      if (Array.isArray(result)) {
        throw new Error(
          'Unexpectedly received a coredump result from the decoder.'
        )
      }
      decoderResult = result
    } catch (err) {
      this.abortController.abort()
      decoderResult = err instanceof Error ? err : new Error(String(err))
    }
    if (!(decoderResult instanceof Error)) {
      this.replayStore?.recordDecode(params, decoderResult)
    }
    this.updateState({ decoderResult, statusMessage: idle })
  }

  private async initializeFromPio(): Promise<void> {
    let params: DecodeTerminalState['params']
    try {
      const pickResult = await pickPioEnvironment()
      if (!pickResult.resolved) {
        const projects = await findPioProjects()
        if (projects.length === 0) {
          const hasIni = await hasPioProjects()
          if (hasIni) {
            throw new Error(
              'platformio.ini found but no valid environments detected.\nCheck that your platformio.ini defines at least one [env:name] section with a "board" property.'
            )
          }
          throw new Error(
            'No PlatformIO project found. Open a project with a platformio.ini file.'
          )
        }
        if (pickResult.failures && pickResult.failures.length > 0) {
          throw new Error(
            'Environments found but cannot resolve:\n' +
              pickResult.failures.join('\n')
          )
        }
        throw new Error(
          'No compiled PlatformIO environment found. Run "pio run" to compile first.'
        )
      }
      const resolved = pickResult.resolved
      this.resolvedEnv = resolved
      params = await createPioDecodeParams({
        elfPath: resolved.elfPath,
        gdbToolPath: resolved.gdbToolPath,
        targetArch: resolved.targetArch,
        projectPath: resolved.project.projectPath,
        fqbnString: syntheticFqbn(resolved.mcu),
      })
    } catch (err) {
      params = err instanceof Error ? err : new Error(String(err))
    }
    this.replayStore?.clearIfParamsMismatch(params)
    this.updateState({ params })
  }

  private setupFileWatcher(): void {
    // Watch for ELF file changes to auto-refresh decode params after rebuild
    const pattern = new vscode.RelativePattern(
      vscode.workspace.workspaceFolders?.[0]?.uri ?? '',
      '**/.pio/build/*/firmware.elf'
    )
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern)
    this.fileWatcher.onDidChange(() => this.refreshParams())
    this.fileWatcher.onDidCreate(() => this.refreshParams())
    this.toDispose.push(this.fileWatcher)
  }

  private async refreshParams(): Promise<void> {
    if (!this.resolvedEnv) {
      return
    }
    // Re-resolve the same environment (ELF might have been rebuilt)
    const resolved = await resolveEnvironment(
      this.resolvedEnv.project,
      this.resolvedEnv.env
    )
    if (!resolved) {
      return
    }
    this.resolvedEnv = resolved
    let params: DecodeTerminalState['params']
    try {
      params = await createPioDecodeParams({
        elfPath: resolved.elfPath,
        gdbToolPath: resolved.gdbToolPath,
        targetArch: resolved.targetArch,
        projectPath: resolved.project.projectPath,
        fqbnString: syntheticFqbn(resolved.mcu),
      })
    } catch (err) {
      params = err instanceof Error ? err : new Error(String(err))
    }
    this.replayStore?.clearIfParamsMismatch(params)
    this.updateState({ params })
  }

  private updateState(partial: Partial<DecodeTerminalState>): void {
    this.debug(`updateState: ${JSON.stringify(partial)}`)
    const shouldDiscardUserInput =
      !(this.state.params instanceof Error) && partial.params instanceof Error
    const shouldDiscardDecoderResult = shouldDiscardUserInput
    this.state = {
      ...this.state,
      ...partial,
    }
    if (shouldDiscardUserInput) {
      this.state.userInput = undefined
    }
    if (shouldDiscardDecoderResult) {
      this.state.decoderResult = undefined
    }
    this.debug(`newState: ${JSON.stringify(partial)}`)
    this.redrawTerminal()
  }

  private redrawTerminal(): void {
    const output = stringifyTerminalState(this.state)
    this.debug(`redrawTerminal: ${output}`)
    this.onDidWriteEmitter.fire(clear)
    this.onDidWriteEmitter.fire(output)
  }
}

/**
 * Extract a stable crash signature from the crash text. Uses MEPC, MCAUSE,
 * RA, and the error description — these stay identical across reboot loops
 * even though stack memory values change slightly.
 */
function extractCrashSignature(text: string): string {
  const parts: string[] = []
  const mepc = text.match(/MEPC\s*:\s*(0x[0-9a-fA-F]+)/)
  if (mepc) parts.push(`MEPC=${mepc[1]}`)
  const ra = text.match(/RA\s*:\s*(0x[0-9a-fA-F]+)/)
  if (ra) parts.push(`RA=${ra[1]}`)
  const mcause = text.match(/MCAUSE\s*:\s*(0x[0-9a-fA-F]+)/)
  if (mcause) parts.push(`MCAUSE=${mcause[1]}`)
  const guru = text.match(/Guru Meditation Error:.*/)
  if (guru) parts.push(guru[0])
  const bt = text.match(/Backtrace:\s*(.*)/)
  if (bt) parts.push(`BT=${bt[1]}`)
  const pc = text.match(/PC\s*:\s*(0x[0-9a-fA-F]+)/)
  if (pc) parts.push(`PC=${pc[1]}`)
  return parts.join('|') || text.slice(0, 200)
}

/** (non-API) */
export const __tests = {
  openPioTerminal,
  stringifyLines,
  stringifyTerminalState,
  decodeTerminalTitle,
  PioDecoderTerminal,
  red,
  green,
  blue,
} as const

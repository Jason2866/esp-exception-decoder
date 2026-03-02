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
}

function findDecodeTerminal(): vscode.Terminal | undefined {
  return vscode.window.terminals.find(
    (terminal) =>
      terminal.name === decodeTerminalName && terminal.exitStatus === undefined
  )
}

function stringifyTerminalState(state: DecodeTerminalState): string {
  const lines = [decodeTerminalTitle]
  const { params, userInput, decoderResult } = state
  let { statusMessage } = state
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
    } else {
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

function openPioTerminal(
  options: { show: boolean; debug: Debug; replayStore?: ReplayStore } = {
    show: true,
    debug: terminalDebug,
  }
): vscode.Terminal {
  const { debug, show } = options
  const terminal =
    findDecodeTerminal() ?? createPioDecodeTerminal(debug, options.replayStore)
  if (show) {
    terminal.show()
  }
  return terminal
}

function createPioDecodeTerminal(
  dbg: Debug,
  replayStore?: ReplayStore
): vscode.Terminal {
  const pty = new PioDecoderTerminal(dbg, replayStore)
  const options: vscode.ExtensionTerminalOptions = {
    name: decodeTerminalName,
    pty,
    iconPath: new vscode.ThemeIcon('debug-console'),
  }
  return vscode.window.createTerminal(options)
}

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
    vscode.Disposable.from(...this.toDispose).dispose()
  }

  handleInput(data: string): void {
    this.debug(`handleInput: ${data}`)
    if (data.trim().length < 2) {
      this.debug(`handleInput, skip: ${data}`)
      return
    }
    if (this.state.params instanceof Error) {
      this.debug(`handleInput, skip: ${this.state.params.message}, ${data}`)
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
      const resolved = await pickPioEnvironment()
      if (!resolved) {
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
        throw new Error(
          'No compiled PlatformIO environment found. Run "pio run" to compile first.'
        )
      }
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

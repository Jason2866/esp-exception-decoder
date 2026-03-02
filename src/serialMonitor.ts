import { ChildProcess, spawn } from 'node:child_process'

import debug from 'debug'
import vscode from 'vscode'

import {
  findPioProjects,
  listPioSerialPorts,
  type PioEnvironment,
  type PioProject,
} from './platformio'
import { getActivePty } from './terminal'
import type { Debug } from './utils'

const monitorDebug: Debug = debug('espExceptionDecoder:serialMonitor')

let statusBarItem: vscode.StatusBarItem
let monitorProcess: ChildProcess | undefined
let activePort: string | undefined
let activeProject: PioProject | undefined
let activeEnv: PioEnvironment | undefined

export function activateSerialMonitor(
  context: vscode.ExtensionContext
): void {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  )
  statusBarItem.command = 'espExceptionDecoder.toggleSerialMonitor'
  updateStatusBar()
  statusBarItem.show()

  context.subscriptions.push(
    statusBarItem,
    vscode.commands.registerCommand(
      'espExceptionDecoder.toggleSerialMonitor',
      () => toggleMonitor(context)
    ),
    new vscode.Disposable(() => stopMonitor())
  )
}

function updateStatusBar(): void {
  if (monitorProcess && activePort) {
    statusBarItem.text = '$(debug-disconnect) ESP Monitor: ' + activePort
    statusBarItem.tooltip = 'Click to disconnect serial monitor'
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      'statusBarItem.warningBackground'
    )
  } else {
    statusBarItem.text = '$(plug) ESP Monitor'
    statusBarItem.tooltip = 'Click to connect serial monitor'
    statusBarItem.backgroundColor = undefined
  }
}

async function toggleMonitor(
  context: vscode.ExtensionContext
): Promise<void> {
  if (monitorProcess) {
    stopMonitor()
    return
  }
  await startMonitor(context)
}

async function startMonitor(
  context: vscode.ExtensionContext
): Promise<void> {
  // 1. Find PlatformIO projects and pick environment
  const projects = await findPioProjects()
  if (projects.length === 0) {
    vscode.window.showWarningMessage(
      'No PlatformIO project found. Open a project with a platformio.ini file.'
    )
    return
  }

  // Collect all environments across projects
  const envItems: Array<{
    project: PioProject
    env: PioEnvironment
  }> = []
  for (const project of projects) {
    for (const env of project.environments) {
      envItems.push({ project, env })
    }
  }

  let selected: { project: PioProject; env: PioEnvironment }
  if (envItems.length === 1) {
    selected = envItems[0]
  } else {
    const pick = await vscode.window.showQuickPick(
      envItems.map((item) => ({
        label: item.env.name,
        description: `${item.env.board} — ${item.env.platform}`,
        item,
      })),
      { placeHolder: 'Select PlatformIO environment for serial monitor' }
    )
    if (!pick) return
    selected = pick.item
  }

  activeProject = selected.project
  activeEnv = selected.env

  const baud = selected.env.monitorSpeed ?? 115200

  // 2. Pick serial port
  statusBarItem.text = '$(sync~spin) ESP Monitor...'
  const ports = await listPioSerialPorts()
  if (ports.length === 0) {
    vscode.window.showWarningMessage('No serial ports found.')
    updateStatusBar()
    return
  }

  let selectedPort: string
  if (ports.length === 1) {
    selectedPort = ports[0].port
  } else {
    const lastPort = context.workspaceState.get<string>(
      'espExceptionDecoder.lastSerialPort'
    )
    const pick = await vscode.window.showQuickPick(
      ports.map((p) => ({
        label: p.port,
        description: p.description,
        detail: p.hwid,
      })),
      {
        placeHolder: 'Select serial port',
        matchOnDescription: true,
      }
    )
    if (!pick) {
      updateStatusBar()
      return
    }
    selectedPort = pick.label
    if (selectedPort !== lastPort) {
      await context.workspaceState.update(
        'espExceptionDecoder.lastSerialPort',
        selectedPort
      )
    }
  }

  activePort = selectedPort

  // 3. Ensure decoder terminal exists
  vscode.commands.executeCommand('espExceptionDecoder.showTerminal')

  // Wait briefly for terminal to initialize
  await new Promise((resolve) => setTimeout(resolve, 300))

  const pty = getActivePty()
  if (pty) {
    pty.setSerialConnected(true, `${selectedPort} @ ${baud}`)
  }

  // 4. Spawn pyserial-based reader (avoids miniterm/termios issues)
  const pyScript = [
    'import serial, sys, time',
    `ser = serial.Serial('${selectedPort.replace(/'/g, "\\'")}', ${baud}, timeout=0.1)`,
    'try:',
    '    while True:',
    '        data = ser.read(1024)',
    '        if data:',
    '            sys.stdout.buffer.write(data)',
    '            sys.stdout.buffer.flush()',
    'except (KeyboardInterrupt, serial.SerialException):',
    '    pass',
    'finally:',
    '    ser.close()',
  ].join('\n')

  monitorDebug(`Spawning pyserial reader on ${selectedPort} @ ${baud}`)

  try {
    monitorProcess = spawn('python3', ['-u', '-c', pyScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to start serial monitor: ${err}`
    )
    activePort = undefined
    updateStatusBar()
    return
  }

  updateStatusBar()

  monitorProcess.stdout?.on('data', (data: Buffer) => {
    const text = data.toString('utf8')
    monitorDebug(`stdout: ${text}`)
    const pty = getActivePty()
    pty?.appendSerialData(text)
  })

  monitorProcess.stderr?.on('data', (data: Buffer) => {
    const text = data.toString('utf8')
    monitorDebug(`stderr: ${text}`)
    // Show PlatformIO errors/warnings in the serial output too
    const pty = getActivePty()
    pty?.appendSerialData(text)
  })

  monitorProcess.on('exit', (code) => {
    monitorDebug(`Monitor process exited with code ${code}`)
    monitorProcess = undefined
    activePort = undefined
    const pty = getActivePty()
    pty?.setSerialConnected(false)
    updateStatusBar()
  })

  monitorProcess.on('error', (err) => {
    monitorDebug(`Monitor process error: ${err.message}`)
    vscode.window.showErrorMessage(
      `Serial monitor error: ${err.message}`
    )
    monitorProcess = undefined
    activePort = undefined
    const pty = getActivePty()
    pty?.setSerialConnected(false)
    updateStatusBar()
  })
}

function stopMonitor(): void {
  if (monitorProcess) {
    monitorDebug('Stopping serial monitor')
    monitorProcess.kill()
    monitorProcess = undefined
  }
  activePort = undefined
  const pty = getActivePty()
  pty?.setSerialConnected(false)
  updateStatusBar()
}

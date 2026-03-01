import vscode from 'vscode'

import { ReplayStore } from './replay'
import { registerReplay } from './replayRegistration'
import { activatePioDecoderTerminal } from './terminal'

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const replayStore = new ReplayStore()
  context.subscriptions.push(replayStore)
  registerReplay(context, replayStore)
  activatePioDecoderTerminal(context, replayStore)
}

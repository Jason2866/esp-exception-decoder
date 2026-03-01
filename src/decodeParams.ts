import { FQBN } from 'fqbn'
import {
  createDecodeParams as trbrCreateDecodeParams,
  type DecodeParams as TrbrDecodeParams,
} from 'trbr'

import type { TrbrTargetArch } from './platformio'

export interface DecodeParams extends TrbrDecodeParams {
  fqbn: FQBN
  sketchPath: string
}

// ---------------------------------------------------------------------------
// PlatformIO-specific decode params (uses toolPath + targetArch directly)
// ---------------------------------------------------------------------------

export interface PioDecodeParamsInput {
  elfPath: string
  gdbToolPath: string
  targetArch: TrbrTargetArch
  projectPath: string
  fqbnString: string
}

export async function createPioDecodeParams(
  params: PioDecodeParamsInput
): Promise<DecodeParams> {
  const { elfPath, gdbToolPath, targetArch, projectPath, fqbnString } = params
  const fqbn = new FQBN(fqbnString).sanitize()
  const decodeParams = await trbrCreateDecodeParams({
    elfPath,
    toolPath: gdbToolPath,
    targetArch,
  })
  return {
    ...decodeParams,
    fqbn,
    sketchPath: projectPath,
  }
}

export class DecodeParamsError extends Error {
  constructor(
    message: string,
    private readonly partial: Pick<DecodeParams, 'fqbn' | 'sketchPath'>
  ) {
    super(message)
    Object.setPrototypeOf(this, DecodeParamsError.prototype)
  }

  get fqbn(): string {
    return this.partial.fqbn.toString()
  }

  get sketchPath(): string {
    return this.partial.sketchPath
  }
}

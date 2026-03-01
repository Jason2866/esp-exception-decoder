import * as fs from 'node:fs/promises'
import path from 'node:path'

import debug from 'debug'
import vscode from 'vscode'

const pioDebug = debug('espExceptionDecoder:platformio')

type Sections = Record<string, Record<string, string>>

// ---------------------------------------------------------------------------
// PlatformIO INI parsing
// ---------------------------------------------------------------------------

export interface PioEnvironment {
  name: string
  platform: string
  board: string
  framework?: string
  monitorSpeed?: number
  buildFlags?: string
}

export interface PioProject {
  projectPath: string
  iniPath: string
  environments: PioEnvironment[]
}

/** Minimal INI parser for platformio.ini (handles multi-line values) */
function parsePlatformioIni(content: string): Sections {
  const sections: Sections = {}
  let currentSection: string | undefined
  let lastKey: string | undefined
  const lines = content.split(/\r?\n/)

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) {
      continue
    }
    const sectionMatch = trimmed.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim()
      sections[currentSection] = sections[currentSection] ?? {}
      lastKey = undefined
      continue
    }
    if (currentSection) {
      // Continuation line: starts with whitespace and no '=' before content
      // (or has '=' but the raw line starts with whitespace, indicating
      // it's a continuation of a multi-line value like build_flags)
      if (lastKey && /^\s/.test(rawLine) && !/^\S/.test(rawLine)) {
        sections[currentSection][lastKey] += '\n' + trimmed
        continue
      }
      const kvMatch = trimmed.match(/^([^=]+)=(.*)$/)
      if (kvMatch) {
        const key = kvMatch[1].trim()
        const value = kvMatch[2].trim()
        sections[currentSection][key] = value
        lastKey = key
      }
    }
  }
  return sections
}

// ---------------------------------------------------------------------------
// extra_configs handling
// ---------------------------------------------------------------------------

/**
 * Merge `source` sections into `target`. Keys in `source` override those in
 * `target` when both define the same key within the same section.
 */
function mergeSections(target: Sections, source: Sections): void {
  for (const [sectionName, props] of Object.entries(source)) {
    if (!target[sectionName]) {
      target[sectionName] = {}
    }
    Object.assign(target[sectionName], props)
  }
}

/**
 * Convert a simple PlatformIO glob pattern (supports `*` and `?`) into a
 * RegExp anchored to the full string.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const withWildcards = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${withWildcards}$`)
}

/** Check whether a string contains glob meta-characters. */
function isGlobPattern(value: string): boolean {
  return /[*?\[\]]/.test(value)
}

/**
 * Resolve `extra_configs` entries (plain paths and globs) relative to the
 * project directory and return the list of resolved absolute paths.
 */
async function resolveExtraConfigPaths(
  projectPath: string,
  rawEntries: string[]
): Promise<string[]> {
  const resolved: string[] = []
  for (const entry of rawEntries) {
    if (!entry) continue
    if (isGlobPattern(entry)) {
      // Resolve the glob against the directory containing the pattern
      const globDir = path.resolve(projectPath, path.dirname(entry))
      const globBase = path.basename(entry)
      const regex = globToRegex(globBase)
      try {
        const dirEntries = await fs.readdir(globDir)
        for (const name of dirEntries.sort()) {
          if (regex.test(name)) {
            resolved.push(path.join(globDir, name))
          }
        }
      } catch {
        pioDebug(`Cannot read directory for glob: ${globDir}`)
      }
    } else {
      resolved.push(path.resolve(projectPath, entry))
    }
  }
  return resolved
}

/**
 * Parse the `extra_configs` value from the `[platformio]` section into a list
 * of individual path/glob entries.
 */
function parseExtraConfigsValue(value: string): string[] {
  return value
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Read and merge all extra config files referenced from the `[platformio]`
 * section's `extra_configs` key. Merges them in order into the provided
 * `sections` object.
 */
async function mergeExtraConfigs(
  projectPath: string,
  sections: Sections
): Promise<void> {
  const pioSection = sections['platformio']
  if (!pioSection?.['extra_configs']) return

  const rawEntries = parseExtraConfigsValue(pioSection['extra_configs'])
  const configPaths = await resolveExtraConfigPaths(projectPath, rawEntries)

  for (const configPath of configPaths) {
    try {
      const content = await fs.readFile(configPath, 'utf8')
      const extraSections = parsePlatformioIni(content)
      mergeSections(sections, extraSections)
      pioDebug(`Merged extra config: ${configPath}`)
    } catch {
      pioDebug(`Cannot read extra config: ${configPath}`)
    }
  }
}

// ---------------------------------------------------------------------------
// ${section.key} variable interpolation
// ---------------------------------------------------------------------------

/** Maximum recursion depth for variable interpolation to prevent loops. */
const MAX_INTERPOLATION_DEPTH = 10

/**
 * Resolve `${section.key}` variable references within all section values.
 * PlatformIO allows cross-section references like `${core.platform}` or
 * `${esp_defaults.build_flags}`.
 */
function interpolateVariables(sections: Sections): void {
  const variablePattern = /\$\{([^}]+)\}/g

  function resolve(
    value: string,
    depth: number,
    visited: Set<string>
  ): string {
    if (depth > MAX_INTERPOLATION_DEPTH) return value
    return value.replace(variablePattern, (match, ref: string) => {
      const dotIndex = ref.indexOf('.')
      if (dotIndex < 0) return match
      const sectionName = ref.slice(0, dotIndex)
      const keyName = ref.slice(dotIndex + 1)
      const refKey = `${sectionName}.${keyName}`
      if (visited.has(refKey)) return match // circular reference guard
      const section = sections[sectionName]
      if (!section || !(keyName in section)) return match
      visited.add(refKey)
      return resolve(section[keyName], depth + 1, new Set(visited))
    })
  }

  for (const props of Object.values(sections)) {
    for (const [key, value] of Object.entries(props)) {
      if (value.includes('${')) {
        props[key] = resolve(value, 0, new Set())
      }
    }
  }
}

/**
 * Resolve a section's properties following the PlatformIO `extends` chain.
 * Handles multiple and recursive inheritance with circular-reference protection.
 */
function resolveExtends(
  sectionName: string,
  sections: Sections,
  visited = new Set<string>()
): Record<string, string> {
  if (visited.has(sectionName)) return {} // circular reference guard
  visited.add(sectionName)

  const section = sections[sectionName]
  if (!section) return {}

  let result: Record<string, string> = {}
  const extendsValue = section['extends']
  if (extendsValue) {
    const parents = extendsValue.split(',').map((s) => s.trim())
    for (const parent of parents) {
      result = { ...result, ...resolveExtends(parent, sections, visited) }
    }
  }
  return { ...result, ...section }
}

function parseEnvironments(sections: Sections): PioEnvironment[] {
  // The [env] section (without a name) provides defaults inherited by all
  // named [env:xxx] sections.
  const baseEnv = sections['env'] ?? {}
  const envs: PioEnvironment[] = []
  let hasNamedEnvs = false

  for (const [sectionName, props] of Object.entries(sections)) {
    if (!sectionName.startsWith('env:')) {
      continue
    }
    hasNamedEnvs = true
    const envName = sectionName.slice(4)
    // Merge: base [env] → extends chain → own props
    const resolved = resolveExtends(sectionName, sections)
    const merged = { ...baseEnv, ...resolved }
    const platform = merged['platform'] ?? ''
    const board = merged['board'] ?? ''
    if (!board) {
      continue
    }
    envs.push({
      name: envName,
      platform,
      board,
      framework: merged['framework'],
      monitorSpeed: merged['monitor_speed']
        ? parseInt(merged['monitor_speed'], 10)
        : undefined,
      buildFlags: merged['build_flags'],
    })
  }

  // If there are no named [env:xxx] sections but [env] defines a board,
  // treat it as a single default environment.
  if (!hasNamedEnvs && baseEnv['board']) {
    envs.push({
      name: 'default',
      platform: baseEnv['platform'] ?? '',
      board: baseEnv['board'],
      framework: baseEnv['framework'],
      monitorSpeed: baseEnv['monitor_speed']
        ? parseInt(baseEnv['monitor_speed'], 10)
        : undefined,
      buildFlags: baseEnv['build_flags'],
    })
  }

  return envs
}

// ---------------------------------------------------------------------------
// MCU → trbr target architecture mapping
// ---------------------------------------------------------------------------

export type TrbrTargetArch =
  | 'xtensa'
  | 'esp32c2'
  | 'esp32c3'
  | 'esp32c6'
  | 'esp32h2'
  | 'esp32h4'
  | 'esp32p4'

const mcuToTargetArch: Record<string, TrbrTargetArch> = {
  esp32: 'xtensa',
  esp32s2: 'xtensa',
  esp32s3: 'xtensa',
  esp32c2: 'esp32c2',
  esp32c3: 'esp32c3',
  esp32c6: 'esp32c6',
  esp32h2: 'esp32h2',
  esp32h4: 'esp32h4',
  esp32p4: 'esp32p4',
}

/**
 * Known board → MCU mappings for common ESP32 boards. Used as fallback if board
 * JSON cannot be found.
 */
const knownBoardMcu: Record<string, string> = {
  esp32dev: 'esp32',
  esp32cam: 'esp32',
  esp32doit: 'esp32',
  nodemcu: 'esp32',
  'nodemcu-32s': 'esp32',
  lolin32: 'esp32',
  wemos_d1_mini32: 'esp32',
  esp32thing: 'esp32',
  featheresp32: 'esp32',
  esp32_s2_saola: 'esp32s2',
  esp32s2box: 'esp32s2',
  lolin_s2_mini: 'esp32s2',
  'esp32-s2-kaluga-1': 'esp32s2',
  'esp32-s2-saola-1': 'esp32s2',
  'esp32-s3-devkitc-1': 'esp32s3',
  'esp32-s3-devkitm-1': 'esp32s3',
  esp32s3box: 'esp32s3',
  esp32s3camlcd: 'esp32s3',
  lolin_s3: 'esp32s3',
  esp32_c3_devkitm: 'esp32c3',
  'esp32-c3-devkitc-02': 'esp32c3',
  'esp32-c3-devkitm-1': 'esp32c3',
  lolin_c3_mini: 'esp32c3',
  'esp32-c6-devkitc-1': 'esp32c6',
  'esp32-c6-devkitm-1': 'esp32c6',
  'esp32-h2-devkitm-1': 'esp32h2',
}

export function mcuToArch(mcu: string): TrbrTargetArch | undefined {
  return mcuToTargetArch[mcu.toLowerCase().replace(/-/g, '')]
}

// ---------------------------------------------------------------------------
// Board JSON resolution
// ---------------------------------------------------------------------------

async function tryReadBoardJson(
  boardName: string,
  platformPackagePaths: string[]
): Promise<{ mcu: string } | undefined> {
  for (const pkgPath of platformPackagePaths) {
    const boardJsonPath = path.join(pkgPath, 'boards', `${boardName}.json`)
    try {
      const content = await fs.readFile(boardJsonPath, 'utf8')
      const json = JSON.parse(content)
      const mcu = json?.build?.mcu
      if (typeof mcu === 'string') {
        return { mcu }
      }
    } catch {
      // board JSON not found at this path, try next
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// PlatformIO directory helpers
// ---------------------------------------------------------------------------

function platformioHomePath(): string {
  return (
    process.env['PLATFORMIO_HOME_DIR'] ??
    path.join(
      process.env['HOME'] ?? process.env['USERPROFILE'] ?? '~',
      '.platformio'
    )
  )
}

function platformioPackagesPath(): string {
  return path.join(platformioHomePath(), 'packages')
}

/**
 * Find the PlatformIO platform package directory for espressif32 or
 * espressif8266.
 */
async function findPlatformPackagePaths(
  platformName: string
): Promise<string[]> {
  const packagesDir = platformioPackagesPath()
  const candidates: string[] = []
  try {
    const entries = await fs.readdir(packagesDir)
    for (const entry of entries) {
      if (
        entry.startsWith('framework-arduinoespressif') ||
        entry === `platform-${platformName}` ||
        entry.startsWith('framework-espidf')
      ) {
        candidates.push(path.join(packagesDir, entry))
      }
    }
  } catch {
    // packages dir not found
  }

  // Also check the project's platform-espressif32 in workspace
  for (const wsFolder of vscode.workspace.workspaceFolders ?? []) {
    const boardsDir = path.join(wsFolder.uri.fsPath, 'boards')
    try {
      await fs.access(boardsDir)
      candidates.push(wsFolder.uri.fsPath)
    } catch {
      // not a platform directory
    }
  }

  return candidates
}

// ---------------------------------------------------------------------------
// GDB tool path resolution
// ---------------------------------------------------------------------------

export async function findGdbToolPath(
  targetArch: TrbrTargetArch
): Promise<string | undefined> {
  const packagesDir = platformioPackagesPath()
  const isXtensa = targetArch === 'xtensa'

  // Primary: dedicated GDB tool packages
  const gdbToolDir = isXtensa
    ? path.join(packagesDir, 'tool-xtensa-esp-elf-gdb', 'bin')
    : path.join(packagesDir, 'tool-riscv32-esp-elf-gdb', 'bin')

  const gdbBinaryName = isXtensa
    ? 'xtensa-esp-elf-gdb-no-python'
    : 'riscv32-esp-elf-gdb-no-python'

  try {
    const toolPath = path.join(gdbToolDir, gdbBinaryName)
    await fs.access(toolPath)
    return toolPath
  } catch {
    // try fallback
  }

  // Fallback: toolchain package
  const toolchainDir = isXtensa
    ? path.join(packagesDir, 'toolchain-xtensa-esp-elf', 'bin')
    : path.join(packagesDir, 'toolchain-riscv32-esp', 'bin')

  const fallbackBinaryName = isXtensa
    ? 'xtensa-esp-elf-gdb'
    : 'riscv32-esp-elf-gdb'

  try {
    const toolPath = path.join(toolchainDir, fallbackBinaryName)
    await fs.access(toolPath)
    return toolPath
  } catch {
    // not found
  }

  return undefined
}

// ---------------------------------------------------------------------------
// ELF file resolution for PlatformIO builds
// ---------------------------------------------------------------------------

export async function findPioElfPath(
  projectPath: string,
  envName: string
): Promise<string | undefined> {
  const buildDir = path.join(projectPath, '.pio', 'build', envName)
  const elfPath = path.join(buildDir, 'firmware.elf')
  try {
    await fs.access(elfPath)
    return elfPath
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// PlatformIO project scanning
// ---------------------------------------------------------------------------

/**
 * Collect candidate directories that may contain a platformio.ini.
 * Checks workspace folder roots and their immediate subdirectories.
 */
async function collectCandidatePaths(): Promise<string[]> {
  const candidates: string[] = []
  for (const wsFolder of vscode.workspace.workspaceFolders ?? []) {
    const rootPath = wsFolder.uri.fsPath
    candidates.push(rootPath)
    try {
      const entries = await fs.readdir(rootPath, { withFileTypes: true })
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          entry.name !== 'node_modules'
        ) {
          candidates.push(path.join(rootPath, entry.name))
        }
      }
    } catch {
      // ignore
    }
  }
  return candidates
}

export async function findPioProjects(): Promise<PioProject[]> {
  const projects: PioProject[] = []
  const candidatePaths = await collectCandidatePaths()
  for (const candidatePath of candidatePaths) {
    const iniPath = path.join(candidatePath, 'platformio.ini')
    try {
      const content = await fs.readFile(iniPath, 'utf8')
      const sections = parsePlatformioIni(content)
      // Merge additional config files referenced by extra_configs
      await mergeExtraConfigs(candidatePath, sections)
      // Resolve ${section.key} variable references across all sections
      interpolateVariables(sections)
      const environments = parseEnvironments(sections)
      if (environments.length > 0) {
        projects.push({
          projectPath: candidatePath,
          iniPath,
          environments,
        })
      } else {
        pioDebug(
          `platformio.ini found at ${iniPath} but no valid environments (missing "board" key?)`
        )
      }
    } catch {
      // not a PlatformIO project
    }
  }
  return projects
}

// ---------------------------------------------------------------------------
// Resolve target architecture from board name
// ---------------------------------------------------------------------------

export async function resolveBoardArch(
  boardName: string,
  platformName: string
): Promise<TrbrTargetArch | undefined> {
  // 1. Try known boards mapping
  const knownMcu = knownBoardMcu[boardName]
  if (knownMcu) {
    const arch = mcuToArch(knownMcu)
    if (arch) {
      return arch
    }
  }

  // 2. Try reading board JSON from PlatformIO packages, workspace, etc.
  const platformPackagePaths = await findPlatformPackagePaths(platformName)
  const boardJson = await tryReadBoardJson(boardName, platformPackagePaths)
  if (boardJson) {
    const arch = mcuToArch(boardJson.mcu)
    if (arch) {
      return arch
    }
  }

  // 3. Platform-based fallback
  if (platformName.includes('espressif32') || platformName.includes('esp32')) {
    return 'xtensa' // default for ESP32
  }
  if (
    platformName.includes('espressif8266') ||
    platformName.includes('esp8266')
  ) {
    return 'xtensa'
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Full PlatformIO environment resolution
// ---------------------------------------------------------------------------

export interface PioResolvedEnv {
  project: PioProject
  env: PioEnvironment
  elfPath: string
  gdbToolPath: string
  targetArch: TrbrTargetArch
  mcu: string
}

export async function resolveEnvironment(
  project: PioProject,
  env: PioEnvironment
): Promise<PioResolvedEnv | undefined> {
  const elfPath = await findPioElfPath(project.projectPath, env.name)
  if (!elfPath) {
    pioDebug(`No ELF found for env:${env.name}`)
    return undefined
  }

  const targetArch = await resolveBoardArch(env.board, env.platform)
  if (!targetArch) {
    pioDebug(`Cannot determine target arch for board: ${env.board}`)
    return undefined
  }

  const gdbToolPath = await findGdbToolPath(targetArch)
  if (!gdbToolPath) {
    pioDebug(`Cannot find GDB tool for arch: ${targetArch}`)
    return undefined
  }

  // Determine MCU
  const knownMcu = knownBoardMcu[env.board]
  let mcu = knownMcu ?? env.board
  const platformPackagePaths = await findPlatformPackagePaths(env.platform)
  const boardJson = await tryReadBoardJson(env.board, platformPackagePaths)
  if (boardJson) {
    mcu = boardJson.mcu
  }

  return {
    project,
    env,
    elfPath,
    gdbToolPath,
    targetArch,
    mcu,
  }
}

/**
 * Picks a PlatformIO environment. If only one exists, uses that; otherwise
 * shows a quick pick.
 */
export async function pickPioEnvironment(): Promise<
  PioResolvedEnv | undefined
> {
  const projects = await findPioProjects()
  if (projects.length === 0) {
    return undefined
  }

  // Collect all resolvable environments
  const resolved: PioResolvedEnv[] = []
  for (const project of projects) {
    for (const env of project.environments) {
      const r = await resolveEnvironment(project, env)
      if (r) {
        resolved.push(r)
      }
    }
  }

  if (resolved.length === 0) {
    return undefined
  }

  if (resolved.length === 1) {
    return resolved[0]
  }

  const pick = await vscode.window.showQuickPick(
    resolved.map((r) => ({
      label: r.env.name,
      description: `${r.env.board} (${r.mcu}) — ${r.targetArch}`,
      detail: r.elfPath,
      resolved: r,
    })),
    { placeHolder: 'Select PlatformIO environment for crash decoding' }
  )

  return pick?.resolved
}

// ---------------------------------------------------------------------------
// Synthetic FQBN for compatibility with existing decode infrastructure
// ---------------------------------------------------------------------------

/**
 * Creates a synthetic Arduino FQBN from PlatformIO board/MCU info. The FQBN is
 * used by the existing decode infrastructure.
 */
export function syntheticFqbn(mcu: string): string {
  const normalizedMcu = mcu.toLowerCase().replace(/-/g, '')
  if (normalizedMcu.startsWith('esp32') || normalizedMcu === 'esp32') {
    return `esp32:esp32:${normalizedMcu}`
  }
  if (normalizedMcu.startsWith('esp8266') || normalizedMcu === 'esp8266') {
    return `esp8266:esp8266:${normalizedMcu}`
  }
  return `esp32:esp32:${normalizedMcu}`
}

/** Returns true if at least one platformio.ini is detected in the workspace. */
export async function hasPioProjects(): Promise<boolean> {
  const candidatePaths = await collectCandidatePaths()
  for (const candidatePath of candidatePaths) {
    const iniPath = path.join(candidatePath, 'platformio.ini')
    try {
      await fs.access(iniPath)
      return true
    } catch {
      // continue
    }
  }
  return false
}

/**
 * Niubash executable resolution, argv assembly, and the runtime facts the
 * teaching layer reads back.
 *
 * Every shell command in this deployment is evaluated by Niubash as one
 * non-interactive process:
 *
 * ```text
 * niu -c "<command>"
 * ```
 *
 * `-c` is Niubash's one-shot command mode: it loads no `~/.niubashrc`, no
 * plugin, and no interactive hook, prints no banner, and passes the command's
 * exit code straight through. That is the deterministic surface an agent
 * needs, and it is why the executor never asks for a login/interactive shell.
 *
 * Niubash is a Windows-native Bash: the language engine is rubash and the Unix
 * commands (`ls`, `grep`, `sed`, …) are real WinuxCmd binaries on `PATH`. The
 * executable that carries both has been named `niu.exe` since the rename; a
 * deployment may still ship compatibility shims named `winuxsh`/`niubash`,
 * which is why resolution below accepts an explicit path first.
 *
 * @module dsh-niubash-only/niubash
 */

import { statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/** Join path segments the way the *target* platform does, whatever host runs the code. */
function joinFor(platform, ...segments) {
  return platform === 'win32' ? win32.join(...segments) : posix.join(...segments)
}

/** The argv prefix every command runs behind (the command is appended last). */
export const DEFAULT_NIU_ARGS = ['-c']

/** Environment variable consulted when the composition does not set `niuPath`. */
export const NIUBASH_PATH_ENV = 'DSH_NIU_PATH'

/**
 * Runtime facts discovered by the executor at boot. The teaching layer imports
 * this same module instance, so a prompt section can name the exact Niubash
 * version without a second probe.
 */
export const niuRuntime = {
  /** The executable name or path the executor spawns. */
  path: undefined,
  /** Resolved absolute executable path, when `ctx.subprocess` could resolve it. */
  resolvedPath: undefined,
  /** The `Niubash x.y.z` version reported by the boot probe. */
  version: undefined,
  /** The rubash engine revision Niubash reports, when present. */
  rubash: undefined,
  /** The WinuxCmd command layer version Niubash reports, when present. */
  winuxcmd: undefined,
  /** How `path` was selected: `config`, `DSH_NIU_PATH`, `PATH`, `install-dir`, or `default`. */
  source: undefined,
  /** Why resolution or the probe failed, when it did. */
  error: undefined,
  /**
   * The shell shims Niubash itself provides. `bash`/`sh` are handed a command
   * only when they resolve here; a `bash` that resolves to Git Bash or WSL is a
   * foreign shell and is refused.
   */
  nativeShells: { names: [], paths: [] },
  /**
   * The boot smoke test: whether one real one-shot command ran. A deployment can
   * resolve `niu` and answer `--version` and still be unable to run anything —
   * most notably when a confined sandbox denies the history file `niu -c` opens
   * while building the shell — and saying so at boot beats failing every call.
   */
  smoke: { ok: undefined, detail: undefined },
}

/** Default file-existence probe (a plain `stat`, so links count as present). */
function defaultExists(candidate) {
  try {
    const stat = statSync(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * The executable file name to look for on this platform.
 * @param platform - `process.platform`.
 * @returns `niu.exe` on Windows, `niu` elsewhere.
 */
export function niubashExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'niu.exe' : 'niu'
}

/**
 * Well-known install directories, checked after `PATH`.
 *
 * This matters in practice: Niubash's installer appends its directory to the
 * *user* `PATH` and then broadcasts the change, but a harness process that was
 * already running keeps the environment it started with. Falling back to the
 * documented install directory keeps a Niubash-only deployment working without
 * asking the user to restart the editor/agent host.
 * @param env - environment to read the directory variables from.
 * @param platform - `process.platform`.
 * @returns candidate directories, most likely first.
 */
export function candidateInstallDirs(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return []
  const dirs = []
  const localAppData = env?.LOCALAPPDATA
  if (typeof localAppData === 'string' && localAppData.length > 0) dirs.push(win32.join(localAppData, 'Programs', 'Niubash'))
  const programFiles = env?.ProgramFiles
  if (typeof programFiles === 'string' && programFiles.length > 0) dirs.push(win32.join(programFiles, 'Niubash'))
  const programFilesX86 = env?.['ProgramFiles(x86)']
  if (typeof programFilesX86 === 'string' && programFilesX86.length > 0) dirs.push(win32.join(programFilesX86, 'Niubash'))
  return dirs
}

/**
 * Scan the `PATH` entries for the executable, honoring the platform delimiter
 * and the quoting Windows environment values sometimes carry.
 * @param pathValue - the raw `PATH` value.
 * @param executable - the file name to look for.
 * @param options - `platform`, `exists`, and the PATH `delimiter`.
 * @returns the first existing candidate, or undefined.
 */
export function scanPath(pathValue, executable, options = {}) {
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? defaultExists
  const separator = options.delimiter ?? (platform === 'win32' ? ';' : ':')
  if (typeof pathValue !== 'string' || pathValue.length === 0) return undefined
  for (const entry of pathValue.split(separator)) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0) continue
    const candidate = joinFor(platform, trimmed, executable)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolve the Niubash executable: an explicit `niuPath` config value, else
 * `$DSH_NIU_PATH`, else a `PATH` entry that holds it, else the well-known
 * install directory, else bare `niu` for a last-chance `PATH` resolution by the
 * spawn implementation.
 *
 * The function is pure with respect to the filesystem — pass `exists` to test
 * the decision table without touching disk.
 * @param configured - the composition's `niuPath`, when set.
 * @param options - `env`, `platform`, `exists`, and PATH `delimiter` overrides.
 * @returns the executable to spawn and how it was selected.
 */
export function resolveNiubashPath(configured, options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const exists = options.exists ?? defaultExists
  const fromConfig = typeof configured === 'string' ? configured.trim() : ''
  if (fromConfig.length > 0) return { path: fromConfig, source: 'config' }
  const fromEnv = typeof env?.[NIUBASH_PATH_ENV] === 'string' ? env[NIUBASH_PATH_ENV].trim() : ''
  if (fromEnv.length > 0) return { path: fromEnv, source: NIUBASH_PATH_ENV }
  const executable = niubashExecutableName(platform)
  const onPath = scanPath(env?.PATH, executable, { platform, exists, delimiter: options.delimiter })
  if (onPath !== undefined) return { path: onPath, source: 'PATH' }
  for (const dir of candidateInstallDirs(env, platform)) {
    const candidate = joinFor(platform, dir, executable)
    if (exists(candidate)) return { path: candidate, source: 'install-dir' }
  }
  return { path: executable, source: 'default' }
}

/**
 * Validate and normalize the argv prefix. The command travels as the final
 * argument, so the prefix must not already contain a command placeholder.
 * @param raw - the `niuArgs` config value, when set.
 * @returns a fresh argv prefix ending at the `-c` flag.
 * @throws Error when the value is not a non-empty array of strings.
 */
export function normalizeNiuArgs(raw) {
  if (raw === undefined || raw === null) return [...DEFAULT_NIU_ARGS]
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((entry) => typeof entry !== 'string')) {
    throw new Error('dsh-niubash-only: niuArgs must be a non-empty array of strings')
  }
  return [...raw]
}

/**
 * Build the exact argv one command runs as.
 * @param command - the Bash source the caller supplied.
 * @param options - the resolved executable and argv prefix.
 * @returns the complete argv handed to `ctx.subprocess`.
 */
export function niubashArgv(command, options = {}) {
  const prefix = options.niuArgs === undefined ? [...DEFAULT_NIU_ARGS] : normalizeNiuArgs(options.niuArgs)
  const path = options.niuPath ?? niubashExecutableName()
  return [path, ...prefix, command]
}

/**
 * Parse `niu --version` output:
 *
 * ```text
 * Niubash 1.1.4 — bash-compatible shell for Windows
 *   rubash   git 8b81c7501646
 *   winuxcmd WinuxCmd 1.0.8
 * ```
 * @param text - captured stdout/stderr of `niu --version`.
 * @returns the version facts, or undefined when no `Niubash x.y.z` line is present.
 */
export function parseNiubashVersion(text) {
  if (typeof text !== 'string') return undefined
  const version = /\bNiubash\s+(\d+)\.(\d+)\.(\d+)/.exec(text)
  if (version === null) return undefined
  const rubash = /\brubash\s+(?:git\s+)?([0-9a-f]{6,40}|\d+\.\d+\.\d+)\b/i.exec(text)
  const winuxcmd = /\bwinuxcmd\s+(?:WinuxCmd\s+)?(\d+\.\d+\.\d+)/i.exec(text)
  return {
    version: `${version[1]}.${version[2]}.${version[3]}`,
    rubash: rubash === null ? undefined : rubash[1],
    winuxcmd: winuxcmd === null ? undefined : winuxcmd[1],
  }
}

/**
 * Normalize a program token into a comparable path: drop quoting and the
 * MSYS-style drive form, unify separators, and lowercase (Windows paths are
 * case-insensitive, and `command -v` reports `/c/Users/...` while the model
 * writes `C:\Users\...`).
 * @param token - a raw program token from a command.
 * @returns the comparable path form.
 */
export function normalizeShellPath(token) {
  let value = typeof token === 'string' ? token.trim() : ''
  value = value.replace(/^["']|["']$/g, '')
  value = value.replace(/\\/g, '/')
  const drive = /^\/?([A-Za-z])\/(.*)$/.exec(value)
  if (drive !== null) value = `${drive[1]}:/${drive[2]}`
  value = value.replace(/\/{2,}/g, '/')
  return value.toLowerCase()
}

/**
 * Read the shells Niubash's own `PATH` resolves, from the output of
 * `command -v bash; command -v sh`.
 *
 * A shim under Niubash's install tree (`…/Niubash/winuxcmd/usr/bin/bash.exe`)
 * is the same rubash engine, so handing a command to it stays inside the
 * dialect. A `bash` that resolves anywhere else is Git Bash / WSL / MSYS and
 * is a foreign shell.
 * @param text - captured output of the probe.
 * @returns the native shell names and their normalized paths.
 */
export function parseNativeShells(text) {
  const names = new Set()
  const paths = new Set()
  if (typeof text !== 'string') return { names: [], paths: [] }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const normalized = normalizeShellPath(line)
    if (!normalized.includes('/winuxcmd/') && !normalized.includes('/niubash/')) continue
    const base = normalized.split('/').pop() ?? ''
    const name = base.replace(/\.(exe|cmd|bat|com)$/, '')
    if (name.length === 0) continue
    names.add(name)
    paths.add(normalized)
  }
  return { names: [...names], paths: [...paths] }
}

export default resolveNiubashPath

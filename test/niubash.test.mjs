/**
 * Niubash resolution tests: the decision table that finds `niu.exe`, the argv
 * assembly, the `--version` parse, and the `bash`/`sh` shim facts the guard
 * depends on.
 *
 * Everything here is a pure function — no process is spawned and no file is
 * read — so the table can be exercised for both platforms and for the awkward
 * real-world case this plugin exists to survive: a harness process whose `PATH`
 * predates the Niubash install.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  candidateInstallDirs,
  niubashArgv,
  niubashExecutableName,
  normalizeNiuArgs,
  normalizeShellPath,
  parseNativeShells,
  parseNiubashVersion,
  resolveNiubashPath,
  scanPath,
} from '../lib/niubash.js'

/** A file-existence probe over an explicit set of paths. */
function existsIn(paths) {
  const set = new Set(paths.map((entry) => entry.replace(/\\/g, '/')))
  return (candidate) => set.has(candidate.replace(/\\/g, '/'))
}

test('an explicit niuPath wins, then $DSH_NIU_PATH, then PATH', () => {
  const env = { PATH: 'C:\\tools;C:\\Users\\me\\AppData\\Local\\Programs\\Niubash', DSH_NIU_PATH: 'D:\\niu\\niu.exe', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }
  assert.deepEqual(resolveNiubashPath('E:\\x\\niu.exe', { env, platform: 'win32' }), { path: 'E:\\x\\niu.exe', source: 'config' })
  assert.deepEqual(resolveNiubashPath('', { env, platform: 'win32' }), { path: 'D:\\niu\\niu.exe', source: 'DSH_NIU_PATH' })
  const onPath = resolveNiubashPath(undefined, {
    env: { PATH: env.PATH, LOCALAPPDATA: env.LOCALAPPDATA },
    platform: 'win32',
    exists: existsIn(['C:\\Users\\me\\AppData\\Local\\Programs\\Niubash\\niu.exe']),
  })
  assert.deepEqual(onPath, { path: 'C:\\Users\\me\\AppData\\Local\\Programs\\Niubash\\niu.exe', source: 'PATH' })
})

test('the documented install directory is the fallback for a stale PATH', () => {
  const env = { PATH: 'C:\\Windows;C:\\Windows\\System32', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }
  const resolved = resolveNiubashPath(undefined, {
    env,
    platform: 'win32',
    exists: existsIn(['C:\\Users\\me\\AppData\\Local\\Programs\\Niubash\\niu.exe']),
  })
  assert.equal(resolved.source, 'install-dir')
  assert.equal(resolved.path, 'C:\\Users\\me\\AppData\\Local\\Programs\\Niubash\\niu.exe')
})

test('with nothing found, the bare executable name is handed to the spawn implementation', () => {
  const win = resolveNiubashPath(undefined, { env: { PATH: 'C:\\Windows' }, platform: 'win32', exists: () => false })
  assert.deepEqual(win, { path: 'niu.exe', source: 'default' })
  const posix = resolveNiubashPath(undefined, { env: { PATH: '/usr/bin' }, platform: 'linux', exists: () => false })
  assert.deepEqual(posix, { path: 'niu', source: 'default' })
  assert.equal(niubashExecutableName('win32'), 'niu.exe')
  assert.equal(niubashExecutableName('linux'), 'niu')
})

test('PATH scanning honors quoting, empty entries, and the platform delimiter', () => {
  const exists = existsIn(['C:\\Program Files\\Niubash\\niu.exe'])
  assert.equal(
    scanPath('"C:\\Program Files\\Niubash";;;C:\\Windows', 'niu.exe', { platform: 'win32', exists }),
    'C:\\Program Files\\Niubash\\niu.exe',
  )
  assert.equal(scanPath('/opt/niu:/usr/bin', 'niu', { platform: 'linux', exists: existsIn(['/opt/niu/niu']) }), '/opt/niu/niu')
  assert.equal(scanPath('', 'niu.exe', { platform: 'win32', exists }), undefined)
})

test('install directories come from the environment, most likely first', () => {
  const dirs = candidateInstallDirs({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files' }, 'win32')
  assert.equal(dirs[0], 'C:\\Users\\me\\AppData\\Local\\Programs\\Niubash')
  assert.equal(dirs[1], 'C:\\Program Files\\Niubash')
  assert.deepEqual(candidateInstallDirs({ LOCALAPPDATA: 'C:\\x' }, 'linux'), [])
})

test('argv assembly is the documented one-shot command form', () => {
  assert.deepEqual(niubashArgv('ls -la', { niuPath: 'niu.exe' }), ['niu.exe', '-c', 'ls -la'])
  assert.deepEqual(niubashArgv('echo hi', { niuPath: 'C:\\Niubash\\niu.exe', niuArgs: ['--quiet', '-c'] }), ['C:\\Niubash\\niu.exe', '--quiet', '-c', 'echo hi'])
  assert.deepEqual(normalizeNiuArgs(undefined), ['-c'])
  assert.throws(() => normalizeNiuArgs([]), /niuArgs/)
  assert.throws(() => normalizeNiuArgs(['-c', 1]), /niuArgs/)
})

test('niu --version is parsed into the facts the guide reports', () => {
  const text = 'Niubash 1.1.4 — bash-compatible shell for Windows\n  rubash   git 8b81c7501646\n  winuxcmd WinuxCmd 1.0.8\n'
  assert.deepEqual(parseNiubashVersion(text), { version: '1.1.4', rubash: '8b81c7501646', winuxcmd: '1.0.8' })
  assert.deepEqual(parseNiubashVersion('Niubash 2.0.0'), { version: '2.0.0', rubash: undefined, winuxcmd: undefined })
  assert.equal(parseNiubashVersion('no version here'), undefined)
  assert.equal(parseNiubashVersion(undefined), undefined)
})

test('native shells are read from the probe, and only from a Niubash install', () => {
  const parsed = parseNativeShells([
    '/c/Users/me/AppData/Local/Programs/Niubash/winuxcmd/usr/bin/bash.exe',
    '/c/Users/me/AppData/Local/Programs/Niubash/winuxcmd/usr/bin/sh.exe',
  ].join('\r\n'))
  assert.deepEqual(parsed.names.sort(), ['bash', 'sh'])
  assert.deepEqual(parsed.paths.sort(), [
    'c:/users/me/appdata/local/programs/niubash/winuxcmd/usr/bin/bash.exe',
    'c:/users/me/appdata/local/programs/niubash/winuxcmd/usr/bin/sh.exe',
  ])
  assert.deepEqual(parseNativeShells('/usr/bin/bash\n').names, [])
  assert.deepEqual(parseNativeShells('').names, [])
  assert.deepEqual(parseNativeShells(undefined).paths, [])
})

test('path normalization makes MSYS, native, and POSIX spellings comparable', () => {
  assert.equal(normalizeShellPath('/c/Users/me/Niubash/niu.exe'), 'c:/users/me/niubash/niu.exe')
  assert.equal(normalizeShellPath('C:\\Users\\me\\Niubash\\niu.exe'), 'c:/users/me/niubash/niu.exe')
  assert.equal(normalizeShellPath('"C:/Users/me/Niubash/niu.exe"'), 'c:/users/me/niubash/niu.exe')
  assert.equal(normalizeShellPath('niu.exe'), 'niu.exe')
})

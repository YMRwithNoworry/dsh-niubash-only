/**
 * Scratch harness for one question: what fails when Niubash runs inside the
 * harness's confined (`workspace-write`) sandbox. It installs the plugin into a
 * scratch profile, boots it with the diagnostic probe, and prints the probe's
 * per-command results.
 *
 * ```sh
 * node test/scratch/confined-diag.mjs            # workspace-write
 * node test/scratch/confined-diag.mjs read-only
 * ```
 *
 * @module dsh-niubash-only/test/scratch/confined-diag
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..', '..')
const mode = process.argv[2] ?? 'workspace-write'
const cliCandidates = [
  process.env.DSH_INTEGRATION_CLI,
  resolve(pluginDir, '..', '.verify', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
].filter((entry) => typeof entry === 'string' && entry.length > 0)
const cli = cliCandidates.find((candidate) => existsSync(candidate))
if (cli === undefined) throw new Error('no dsh CLI found; set DSH_INTEGRATION_CLI')

const profile = `niudiag${Date.now() % 100000}`
const home = mkdtempSync(join(tmpdir(), `dsh-niu-diag-${mode}-`))
const env = { ...process.env, DSH_HOME: home, DSH_PERMISSION_MODE: mode }
const run = (args) => spawnSync(process.execPath, [cli, ...args], { env, cwd: pluginDir, encoding: 'utf8' })
const install = run(['plugin', '--profile', profile, 'add', `file:${pluginDir}`])
if (install.status !== 0) {
  console.error(`install failed\n${install.stdout}\n${install.stderr}`)
  process.exit(2)
}
const profileDir = join(home, 'profiles', profile)
copyFileSync(join(here, 'confined-diag-probe.mjs'), join(profileDir, 'diag-probe.mjs'))
const patchPath = join(profileDir, 'diag.patch.yml')
writeFileSync(patchPath, ['- insert:', '    - id: diag-probe', '      name: ./diag-probe.mjs', ''].join('\n'))
const boot = run(['--profile', profile, '--patch', patchPath])
console.log(`diag: exit=${boot.status} home=${home}`)
console.log(boot.stdout ?? '')
if ((boot.stderr ?? '').trim().length > 0) console.log(`diag stderr:\n${boot.stderr}`)

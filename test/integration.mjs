/**
 * Integration harness: prove the plugin works inside a real dsh composition.
 *
 * It creates a scratch `$DSH_HOME`, installs this package into a fresh profile
 * (`dsh plugin --profile niubashprobe add file:<this package>`, which is what a
 * user does), then boots that profile with one extra `--patch` overlay carrying
 * the probe plugin from `test/probe/probe.mjs`. The probe observes the live
 * registries — shell seam, prompt assembly, tool schemas — and exits non-zero
 * when any promise is broken.
 *
 * ```sh
 * node test/integration.mjs                      # danger-full-access (default)
 * node test/integration.mjs --mode workspace-write
 * DSH_INTEGRATION_CLI=/path/to/@deepseek-ai/dsh/lib/bin.js node test/integration.mjs
 * ```
 *
 * @module dsh-niubash-only/test/integration
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..')
const probeSource = join(here, 'probe', 'probe.mjs')

/** The CLI to drive: an explicit install, else a sibling verification tree, else the global `dsh`. */
function resolveCli() {
  if (process.env.DSH_INTEGRATION_CLI !== undefined && process.env.DSH_INTEGRATION_CLI.length > 0) {
    return resolve(process.env.DSH_INTEGRATION_CLI)
  }
  const local = resolve(pluginDir, '..', '.verify', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(local)) return local
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8' })
  const found = which.stdout?.split(/\r?\n/).find((line) => line.trim().length > 0)
  if (found === undefined) throw new Error('no dsh CLI found; set DSH_INTEGRATION_CLI')
  return resolve(dirname(found.trim()), '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

function parseMode() {
  const index = process.argv.indexOf('--mode')
  if (index === -1) return 'danger-full-access'
  const value = process.argv[index + 1]
  if (value !== 'danger-full-access' && value !== 'workspace-write' && value !== 'read-only') {
    throw new Error(`unknown --mode ${JSON.stringify(value)}`)
  }
  return value
}

const mode = parseMode()
const cli = resolveCli()
const node = process.execPath
const profile = 'niubashprobe'
const home = mkdtempSync(join(tmpdir(), `dsh-niu-${mode}-`))
const env = { ...process.env, DSH_HOME: home, DSH_PERMISSION_MODE: mode }

console.log(`integration: cli=${cli}`)
console.log(`integration: DSH_HOME=${home} mode=${mode}`)

function run(args, options = {}) {
  return spawnSync(node, [cli, ...args], { env, cwd: pluginDir, encoding: 'utf8', ...options })
}

try {
  const install = run(['plugin', '--profile', profile, 'add', `file:${pluginDir}`])
  if (install.status !== 0) {
    console.error(`integration: profile install failed (${install.status})\n${install.stdout}\n${install.stderr}`)
    process.exit(2)
  }

  const profileDir = join(home, 'profiles', profile)
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  console.log(`integration: profile bundles = ${bundles.join(', ')}`)
  if (!bundles.includes('dsh-niubash-only')) {
    console.error('integration: the installer did not reconcile dsh-niubash-only into dsh.profile.bundles')
    process.exit(2)
  }

  // The probe runs from the profile directory so its bare imports resolve the
  // same way the bundle's do.
  const probePath = join(profileDir, 'niubash-probe.mjs')
  copyFileSync(probeSource, probePath)
  const patchPath = join(profileDir, 'niubash-probe.patch.yml')
  writeFileSync(patchPath, ['- insert:', '    - id: niubash-probe', '      name: ./niubash-probe.mjs', ''].join('\n'))

  const boot = run(['--profile', profile, '--patch', patchPath], { timeout: 300000 })
  console.log('integration: --- dsh output ---')
  console.log((boot.stdout ?? '').trim())
  const stderr = (boot.stderr ?? '').trim()
  if (stderr.length > 0) console.log(`integration: --- dsh stderr ---\n${stderr}`)
  console.log('integration: --- end ---')

  const passed = boot.status === 0 && (boot.stdout ?? '').includes('PROBE OK')
  if (!passed) {
    console.error(`integration: FAILED (exit ${boot.status}); scratch home kept at ${home}`)
    process.exit(1)
  }
  console.log(`integration: PASSED (${mode})`)
} catch (error) {
  console.error(`integration: harness error: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(3)
} finally {
  if (process.exitCode === 0 || process.exitCode === undefined) rmSync(home, { recursive: true, force: true })
}

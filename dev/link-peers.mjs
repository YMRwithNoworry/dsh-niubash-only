/**
 * Local-development helper: link the `@deepseek-ai/*` peer packages this plugin
 * extends out of an installed DeepSeek Harness tree into `node_modules/`, so
 * `node --test` can import `lib/executor.js` without running a profile install.
 *
 * A real profile install resolves these through pnpm plus the harness's own
 * module fallback; this script exists only so the repository's tests run from a
 * checkout.
 *
 * Usage:
 *
 * ```sh
 * node dev/link-peers.mjs            # link from the globally installed dsh
 * DSH_NODE_MODULES=/path/to/@deepseek-ai node dev/link-peers.mjs
 * ```
 *
 * @module dsh-niubash-only/dev/link-peers
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Direct imports of the plugin, plus the packages their seams name. */
const PEERS = [
  'cordis',
  'cosmokit',
  'schemastery',
  'dsh-bash-local',
  'dsh-bash-sandbox',
  'dsh-pwsh-local',
  'dsh-pwsh-sandbox',
  'dsh-sandbox',
  'dsh-sandbox-policy',
  'dsh-scope',
  'dsh-shell',
  'dsh-subprocess',
  'dsh-system-prompt',
  'dsh-timeout',
]

/** Candidate directories that hold the `@deepseek-ai` package set. */
function candidateRoots() {
  const roots = []
  if (process.env.DSH_NODE_MODULES !== undefined && process.env.DSH_NODE_MODULES.length > 0) {
    roots.push(process.env.DSH_NODE_MODULES)
  }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim()
    roots.push(join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  } catch {
    // No global npm root available; the environment variable is the fallback.
  }
  return roots.filter((root) => existsSync(root))
}

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const target = join(projectRoot, 'node_modules', '@deepseek-ai')

const roots = candidateRoots()
if (roots.length === 0) {
  console.error('link-peers: no installed dsh tree found; set DSH_NODE_MODULES=/path/to/@deepseek-ai')
  process.exit(1)
}

mkdirSync(target, { recursive: true })
let linked = 0
let missing = 0
for (const peer of PEERS) {
  const source = roots.map((root) => join(root, peer)).find((candidate) => existsSync(candidate))
  const link = join(target, peer)
  if (source === undefined) {
    missing++
    console.warn(`link-peers: ${peer} not found in ${roots.join(', ')} — skipped`)
    continue
  }
  rmSync(link, { recursive: true, force: true })
  symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir')
  linked++
}
console.log(`link-peers: linked ${linked} package(s) from ${roots[0]}${missing > 0 ? ` (${missing} missing)` : ''}`)

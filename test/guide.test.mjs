/**
 * Guide tests: the teaching text is only worth shipping if it is true.
 *
 * Two kinds of check run here:
 *
 * 1. **Every ```bash block in the guide is executed by the Niubash installed on
 *    this machine.** A guide example that does not run is a bug, not a typo.
 * 2. **The tool inventory the guide teaches matches the machine.** The names the
 *    guide promises are present must resolve, and the names it tells the model
 *    not to reach for must not — otherwise the model is being taught the wrong
 *    thing about the deployment it is actually in.
 *
 * Both skip cleanly when Niubash is not installed, so the repository's tests
 * still pass on a machine without it (the resolution and dialect tests are the
 * parts that need no shell).
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  GUIDE_FENCE,
  NIUBASH_COMMAND_PARAM_DESCRIPTION,
  buildGuide,
  buildShellRules,
  buildToolDescription,
} from '../lib/guide.js'

/** The executable under test: an explicit path, else the documented name. */
const NIU = process.env.DSH_NIU_PATH ?? (process.platform === 'win32' ? 'niu.exe' : 'niu')

/** Run one `niu` invocation. */
function niu(args, options = {}) {
  return spawnSync(NIU, args, { encoding: 'utf8', timeout: 120000, ...options })
}

/** Whether Niubash is installed and usable. */
function niuAvailable() {
  try {
    return niu(['--version']).status === 0
  } catch {
    return false
  }
}

const available = niuAvailable()

/** Every fenced block of the guide's own language. */
function blocks(markdown, fence = GUIDE_FENCE) {
  const pattern = new RegExp(`\`\`\`${fence}\\n([\\s\\S]*?)\`\`\``, 'g')
  return [...markdown.matchAll(pattern)].map((match) => match[1])
}

/** The tools the guide's "available" row promises, plus its listed Unix tools. */
const PRESENT = [
  'ls', 'cat', 'grep', 'sed', 'find', 'head', 'tail', 'wc', 'sort', 'uniq', 'tr', 'cut', 'xargs', 'tee',
  'diff', 'patch', 'du', 'df', 'ps', 'less', 'which', 'env', 'printf', 'sleep', 'seq', 'mktemp',
  'od', 'stat', 'realpath', 'basename', 'dirname', 'sha256sum', 'md5sum', 'base64', 'yes', 'touch',
  'rm', 'cp', 'mv', 'ln', 'chmod', 'tar', 'curl', 'tree', 'more', 'dir',
]

/** The tools the guide tells the model to work around. */
const ABSENT = ['awk', 'jq', 'yq', 'rg', 'perl', 'make', 'cmake', 'gcc', 'clang', 'zip', 'unzip', '7z', 'bc', 'vim', 'nano', 'wget', 'iconv', 'ffmpeg']

/** Resolve a list of program names through the shell, as the model would. */
function resolveNames(names) {
  const command = names.map((name) => `if command -v ${name} >/dev/null 2>&1; then echo "${name}=yes"; else echo "${name}=no"; fi`).join('\n')
  const result = niu(['-c', command])
  assert.equal(result.status, 0, `probe failed: ${result.stderr}`)
  const statuses = new Map()
  for (const line of result.stdout.split(/\r?\n/)) {
    const [name, value] = line.split('=')
    if (name !== undefined && value !== undefined && value.length > 0) statuses.set(name, value === 'yes')
  }
  return statuses
}

test('the rules section states what changes behavior', () => {
  const rules = buildShellRules()
  for (const expected of ['Niubash', 'niu -c', 'fresh', 'workdir', 'powershell', 'cmd /c', 'wsl', 'awk', '$env:NAME', '127', 'Niubash hint']) {
    assert.ok(rules.includes(expected), `the rules must mention ${expected}`)
  }
})

test('the guide carries the sections the model needs', () => {
  const guide = buildGuide({ variant: 'full', version: '1.1.4', winuxcmd: '1.0.8' })
  for (const expected of [
    'Niubash guide (Niubash 1.1.4, WinuxCmd 1.0.8)',
    '### What this shell is',
    '### Language essentials',
    '### The Unix tools that ship',
    '### Paths: three spellings',
    '### Pipes, redirection, and exit codes',
    '### PowerShell → Bash (Niubash)',
    '### CMD → Bash (Niubash)',
    '### When a command fails',
    '### Traps worth knowing',
    '$env:NAME',
    'cd /c',
    'tar -xf',
    'workdir',
  ]) {
    assert.ok(guide.includes(expected), `the guide must mention ${expected}`)
  }
  assert.equal(buildGuide({ variant: 'off' }), '')
  const compact = buildGuide({ variant: 'compact' })
  assert.ok(compact.includes('niu -c'))
  assert.ok(compact.length < guide.length)
})

test('the tool description states the dialect and the traps', () => {
  const description = buildToolDescription({ background: true, escalation: true, guide: true })
  for (const expected of ['Bash on Windows', 'niu -c', 'PowerShell and CMD are not available', 'workdir', 'exit code: N', 'Niubash hint', 'sandbox_permissions', 'run_in_background']) {
    assert.ok(description.includes(expected), `the description must mention ${expected}`)
  }
  assert.ok(!description.includes('pwsh -Command'))
  assert.match(NIUBASH_COMMAND_PARAM_DESCRIPTION, /Bash/)
})

test('every runnable guide block runs under Niubash', { skip: available ? false : 'Niubash is not installed on this machine' }, () => {
  const markdown = [buildGuide({ variant: 'full' }), buildGuide({ variant: 'compact' })].join('\n')
  const snippets = blocks(markdown)
  assert.ok(snippets.length >= 6, `expected several runnable blocks, found ${snippets.length}`)
  for (const snippet of snippets) {
    const result = niu(['-c', snippet])
    assert.equal(
      result.status,
      0,
      `block failed (exit ${result.status}):\n${snippet}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    )
  }
})

test('the tool inventory the guide teaches matches this machine', { skip: available ? false : 'Niubash is not installed on this machine' }, () => {
  const statuses = resolveNames([...PRESENT, ...ABSENT])
  const missing = PRESENT.filter((name) => statuses.get(name) !== true)
  assert.deepEqual(missing, [], `the guide promises these exist: ${missing.join(', ')}`)
  const unexpected = ABSENT.filter((name) => statuses.get(name) !== false)
  assert.deepEqual(unexpected, [], `the guide says these are absent but they resolve: ${unexpected.join(', ')}`)
})

test('the path contract the guide teaches is the real one', { skip: available ? false : 'Niubash is not installed on this machine' }, () => {
  const ok = niu(['-c', '[ -f /c/Windows/win.ini ] && [ -f "C:\\Windows\\win.ini" ] && cd /c/Windows && pwd'])
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /C:\/Windows/)
  // The bare mount is context-dependent: fine at the top level, broken in a subshell.
  const topLevel = niu(['-c', 'cd /c && pwd'])
  assert.equal(topLevel.status, 0, topLevel.stderr)
  assert.match(topLevel.stdout, /C:\//)
  const subshell = niu(['-c', '(cd /c && pwd)'])
  assert.notEqual(subshell.status, 0, 'the guide documents the bare mount as unreliable inside a subshell')
  assert.match(subshell.stderr, /No such file or directory/)
})

test('the silent `$env:NAME` trap the guide warns about is real', { skip: available ? false : 'Niubash is not installed on this machine' }, () => {
  const result = niu(['-c', 'echo $env:PATH'])
  assert.equal(result.status, 0, 'the trap is that it does not fail')
  assert.equal(result.stdout.trim(), ':PATH')
})

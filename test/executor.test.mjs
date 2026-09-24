/**
 * Executor tests: the argv seam, the guard's reach, the dialect preflight, the
 * failure hint, and the confined and full-access paths — driven through a
 * stand-in subprocess seam, so no dsh boot and no real command is needed.
 *
 * Since dsh `0.1.7-rc.1` the shell seam has one execution verb, `execute(spec)`,
 * which resolves with a live handle whose `result()` is the memoized foreground
 * projection; these tests drive that contract.
 *
 * The `@deepseek-ai/*` peer packages the executor extends are resolved from the
 * dsh installation that `dev/link-peers.mjs` links into `node_modules/` for
 * local development.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import Schema from '@deepseek-ai/schemastery'
import { Service } from '@deepseek-ai/cordis'
import { NATIVE_SHELL_PROBE, NiubashExecutor } from '../lib/executor.js'
import { niuRuntime, parseNativeShells } from '../lib/niubash.js'

/** The boot probe's answer on this machine: Niubash's own rubash shims. */
const NATIVE = parseNativeShells([
  '/c/Users/me/AppData/Local/Programs/Niubash/winuxcmd/usr/bin/bash.exe',
  '/c/Users/me/AppData/Local/Programs/Niubash/winuxcmd/usr/bin/sh.exe',
].join('\n'))

/**
 * A `ctx.subprocess` handle: collects what the executor asked for, never spawns.
 *
 * `defer: true` keeps the process alive until the returned handle's `release()`
 * is called, so a test can observe the live state a real, still-running child
 * would show.
 */
function fakeSubprocess({ exitCode = 0, stdout = 'ok', stderr = '', fail = false, defer = false } = {}) {
  const spawns = []
  const procs = []
  const reader = (text) => ({ readFrom: () => ({ text, lossy: false, nextOffset: text.length }) })
  const spawn = (spec) => {
    spawns.push(spec)
    let release
    const outcome = defer ? new Promise((resolve) => { release = resolve }) : Promise.resolve()
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: fail
        ? Promise.reject(new Error('spawn failed'))
        : outcome.then(() => ({ exitCode, signal: null })),
      collected: {
        stdout: reader(stdout),
        stderr: reader(stderr),
      },
      release: () => release?.(),
      terminate() {
        proc.status = 'killed'
      },
    }
    procs.push(proc)
    return proc
  }
  return { spawn, spawns, procs }
}

/** A `ctx` stand-in covering the services the executor and its base class touch. */
function fakeContext({ subprocess, sandboxMode = 'danger-full-access', confine = (argv) => argv } = {}) {
  const confined = []
  const ctx = {
    inject() {},
    // The cordis `Service` base class registers itself through `ctx.reflect.provide`.
    reflect: { provide: () => () => {} },
    get: () => undefined,
    subprocess,
    sandboxPolicy: {
      defaultMode: sandboxMode,
      resolve: () => ({ mode: sandboxMode, workspaceRoot: process.cwd() }),
    },
    sandbox: {
      confine(argv, policy, signal) {
        confined.push({ argv, policy, signal })
        return {
          argv: confine(argv, policy),
          enforcement: 'strict',
          denialSignatures: ['denied'],
          runnerFailureRules: [],
        }
      },
    },
    logger: { info() {}, warn() {} },
  }
  return { ctx, confined }
}

const baseConfig = {
  cwd: process.cwd(),
  timeoutMs: 5000,
  maxTimeoutMs: 10000,
  maxOutputBytes: 4096,
  maxSpillBytes: 65536,
  graceMs: 100,
  niuPath: 'niu.exe',
  requireNiubash: false,
  verifyNiubash: false,
  probeNativeShells: false,
}

/**
 * Resolve a config the way the cordis plugin loader does. The inherited
 * executor schema declares its budget fields `volatile`, so the base class reads
 * them through `.get()` and only a schema-resolved config is serviceable.
 */
function resolveConfig(raw) {
  return Schema.resolve({ ...raw }, NiubashExecutor.Config)[0]
}

function makeExecutor(options = {}) {
  const subprocess = options.subprocess ?? fakeSubprocess()
  const { ctx, confined } = fakeContext({ subprocess, sandboxMode: options.sandboxMode, confine: options.confine })
  const executor = new NiubashExecutor(ctx, resolveConfig({ ...baseConfig, ...options.config }))
  if (options.nativeShells !== undefined) executor.niuOptions.nativeShells = options.nativeShells
  return { executor, subprocess, confined, ctx }
}

/** Run one request to settlement: the foreground projection of `execute`. */
async function settle(executor, request) {
  const handle = await executor.execute(executor.resolve(request))
  return handle.result()
}

test('builds the documented Niubash argv', () => {
  const { executor } = makeExecutor()
  assert.deepEqual(executor.niuShellArgv('ls -la | grep md'), ['niu.exe', '-c', 'ls -la | grep md'])
  assert.deepEqual(executor.argv({ command: 'echo hi' }), ['niu.exe', '-c', 'echo hi'])
})

test('honors niuPath and niuArgs', () => {
  const { executor } = makeExecutor({ config: { niuPath: 'C:\\Niubash\\niu.exe', niuArgs: ['--quiet', '-c'] } })
  assert.deepEqual(executor.niuShellArgv('ls'), ['C:\\Niubash\\niu.exe', '--quiet', '-c', 'ls'])
  assert.equal(executor.niuExecutable, 'C:\\Niubash\\niu.exe')
})

test('refuses a foreign-shell handoff from every entry point', () => {
  const { executor } = makeExecutor()
  assert.throws(() => executor.niuShellArgv('pwsh -Command Get-ChildItem'), /Niubash-only/)
  assert.throws(() => executor.argv({ command: 'cmd /c dir' }), /Niubash-only/)
  assert.throws(() => executor.confine('wsl ls', { mode: 'workspace-write' }), /Niubash-only/)
})

test('Niubash\'s own bash/sh are allowed only when the boot probe proved them', () => {
  const unproven = makeExecutor()
  assert.throws(() => unproven.executor.niuShellArgv('bash -c "echo hi"'), /unproven-name|Niubash-only/)

  const proven = makeExecutor({ nativeShells: NATIVE })
  assert.deepEqual(proven.executor.niuShellArgv('bash -c "echo hi"'), ['niu.exe', '-c', 'bash -c "echo hi"'])
  assert.throws(() => proven.executor.niuShellArgv('"/c/Program Files/Git/bin/bash.exe" -c x'), /Niubash-only/)
})

test('refuses PowerShell habits before anything runs', () => {
  const { executor, subprocess } = makeExecutor()
  assert.throws(() => executor.niuShellArgv('echo $env:PATH'), /refusing a powershell-env/)
  assert.throws(() => executor.niuShellArgv('Get-ChildItem'), /refusing a powershell-cmdlet/)
  assert.throws(() => executor.niuShellArgv('ls -Recurse'), /refusing a powershell-flag/)
  assert.equal(subprocess.spawns.length, 0, 'a refusal must not spawn anything')
})

test('the guard and the preflight can be disabled or allowlisted', () => {
  const off = makeExecutor({ config: { enforceNiubashOnly: false, dialectLint: false } })
  assert.deepEqual(off.executor.niuShellArgv('pwsh -Command ls'), ['niu.exe', '-c', 'pwsh -Command ls'])

  const allow = makeExecutor({ config: { foreignShellAllowlist: ['^pwsh -Command "legacy"$'] } })
  assert.deepEqual(allow.executor.niuShellArgv('pwsh -Command "legacy"'), ['niu.exe', '-c', 'pwsh -Command "legacy"'])
  assert.throws(() => allow.executor.niuShellArgv('pwsh -Command "other"'), /Niubash-only/)
})

test('a dangerous malformed allowlist or argv prefix fails at construction', () => {
  assert.throws(() => makeExecutor({ config: { foreignShellAllowlist: ['('] } }), /valid regular expression/)
  assert.throws(() => makeExecutor({ config: { niuArgs: [] } }), /niuArgs/)
})

test('full-access execution spawns the Niubash argv and reports unconfined facts', async () => {
  const { executor, subprocess, confined } = makeExecutor({ sandboxMode: 'danger-full-access' })
  const result = await settle(executor, { command: 'echo hi' })
  assert.equal(subprocess.spawns.length, 1)
  assert.deepEqual(subprocess.spawns[0].argv, ['niu.exe', '-c', 'echo hi'])
  assert.equal(subprocess.spawns[0].cwd, process.cwd())
  assert.equal(confined.length, 0, 'the full-access path never asks the sandbox to wrap')
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.text, 'ok')
})

test('the handle exposes the live process and one memoized result', async () => {
  const subprocess = fakeSubprocess({ defer: true })
  const { executor } = makeExecutor({ subprocess, sandboxMode: 'danger-full-access' })
  const handle = await executor.execute(executor.resolve({ command: 'echo hi' }))
  assert.equal(handle.status, 'running')
  assert.equal(typeof handle.readOutput, 'function')
  assert.equal(handle.result(), handle.result(), 'result() is memoized')
  subprocess.procs[0].release()
  await handle.result()
  assert.equal(handle.status, 'completed')
  assert.equal(subprocess.spawns.length, 1)
})

test('the default posture is direct execution: a confined session is NOT wrapped', async () => {
  const { executor, subprocess, confined } = makeExecutor({
    sandboxMode: 'workspace-write',
    confine: (argv) => ['acl-runner', '--', ...argv],
  })
  const result = await settle(executor, { command: 'ls' })
  assert.equal(confined.length, 0, 'ctx.sandbox is never asked to wrap by default')
  assert.deepEqual(subprocess.spawns[0].argv, ['niu.exe', '-c', 'ls'])
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false, bypassed: 'workspace-write' })
})

test('a hand-built spec still reports the deployment policy it bypassed', async () => {
  const { executor, subprocess } = makeExecutor({ sandboxMode: 'workspace-write' })
  const handle = await executor.execute({
    command: 'ls',
    workdir: process.cwd(),
    timeoutMs: 5000,
    onExpiry: 'kill',
    stdoutMaxBytes: 4096,
    sandboxPolicy: undefined,
  })
  const result = await handle.result()
  assert.deepEqual(subprocess.spawns[0].argv, ['niu.exe', '-c', 'ls'])
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false, bypassed: 'workspace-write' })
})

test('the unconfined confine() envelope says what it did not do', () => {
  const { executor } = makeExecutor({ sandboxMode: 'workspace-write' })
  const wrapped = executor.confine('ls', { mode: 'workspace-write' })
  assert.deepEqual(wrapped.argv, ['niu.exe', '-c', 'ls'])
  assert.equal(wrapped.enforcement, 'none')
  assert.deepEqual(wrapped.denialSignatures, [])
})

test('sandbox: true keeps the first-party confinement path', async () => {
  const { executor, subprocess, confined } = makeExecutor({
    sandboxMode: 'workspace-write',
    confine: (argv) => ['acl-runner', '--', ...argv],
    config: { sandbox: true },
  })
  const result = await settle(executor, { command: 'ls' })
  assert.deepEqual(confined[0].argv, ['niu.exe', '-c', 'ls'])
  assert.equal(confined[0].policy.mode, 'workspace-write')
  assert.deepEqual(subprocess.spawns[0].argv, ['acl-runner', '--', 'niu.exe', '-c', 'ls'])
  assert.deepEqual(result.sandbox, { mode: 'workspace-write', denied: false, enforcement: 'strict' })
})

test('sandbox: true forwards the provider cancellation to ctx.sandbox.confine', async () => {
  const { executor, confined } = makeExecutor({
    sandboxMode: 'workspace-write',
    confine: (argv) => ['acl-runner', '--', ...argv],
    config: { sandbox: true },
  })
  await settle(executor, { command: 'ls' })
  assert.equal(confined.length, 1)
  assert.equal(confined[0].signal instanceof AbortSignal, true, 'the 0.1.7 confine signature carries the signal')
})

test('a refusal inside a confined call happens before the sandbox is asked to wrap', async () => {
  const { executor, confined } = makeExecutor({ sandboxMode: 'workspace-write', config: { sandbox: true } })
  await assert.rejects(() => executor.execute(executor.resolve({ command: 'cmd /c dir' })), /Niubash-only/)
  assert.equal(confined.length, 0)
})

test('background execution returns a live handle that can be killed', async () => {
  const subprocess = fakeSubprocess({ defer: true })
  const { executor } = makeExecutor({ subprocess, sandboxMode: 'danger-full-access' })
  const handle = await executor.execute(executor.resolve({ command: 'sleep 5', onExpiry: 'none' }))
  assert.deepEqual(subprocess.spawns[0].argv, ['niu.exe', '-c', 'sleep 5'])
  assert.equal(handle.status, 'running')
  assert.equal(handle.kill(), true)
  assert.equal(handle.status, 'killed')
  subprocess.procs[0].release()
  await handle.done
})

test('sandbox: true wraps background runs and stamps sandbox facts on settlement', async () => {
  const { executor, subprocess } = makeExecutor({
    sandboxMode: 'workspace-write',
    confine: (argv) => ['acl-runner', '--', ...argv],
    config: { sandbox: true },
  })
  const handle = await executor.execute(executor.resolve({ command: 'ls', onExpiry: 'none' }))
  assert.deepEqual(subprocess.spawns[0].argv, ['acl-runner', '--', 'niu.exe', '-c', 'ls'])
  await handle.done
  assert.equal(handle.status, 'completed')
  assert.equal(handle.sandbox?.mode, 'workspace-write')
  assert.equal(handle.sandbox?.denied, false)
})

test('by default background runs are not wrapped either', async () => {
  const { executor, subprocess, confined } = makeExecutor({
    sandboxMode: 'workspace-write',
    confine: (argv) => ['acl-runner', '--', ...argv],
  })
  const handle = await executor.execute(executor.resolve({ command: 'ls', onExpiry: 'none' }))
  assert.equal(confined.length, 0)
  assert.deepEqual(subprocess.spawns[0].argv, ['niu.exe', '-c', 'ls'])
  await handle.done
})

test('a failed call carries an actionable Niubash hint on its stderr', async () => {
  const { executor } = makeExecutor({
    subprocess: fakeSubprocess({ exitCode: 127, stdout: '', stderr: 'bash: line 1: awk: command not found\n' }),
    sandboxMode: 'danger-full-access',
  })
  const result = await settle(executor, { command: "awk '{print $1}' f.txt" })
  assert.match(result.stderr.text, /Niubash hint \(missing-program\)/)
  assert.match(result.stderr.text, /is not installed in this Niubash deployment/)
})

test('hints can be turned off', async () => {
  const { executor } = makeExecutor({
    subprocess: fakeSubprocess({ exitCode: 127, stdout: '', stderr: 'bash: line 1: awk: command not found\n' }),
    config: { dialectHints: false },
  })
  const result = await settle(executor, { command: 'awk 1 f' })
  assert.equal(result.stderr.text, 'bash: line 1: awk: command not found\n')
})

test('the resolve path keeps the inherited budgets and the caller workdir', () => {
  const { executor } = makeExecutor()
  const spec = executor.resolve({ command: 'ls', workdir: 'D:\\work', timeoutMs: 999_999 })
  assert.equal(spec.workdir, 'D:\\work')
  assert.equal(spec.timeoutMs, 10000, 'per-call timeout is capped by maxTimeoutMs')
  assert.equal(spec.stdoutMaxBytes, 4096)
})

/** A `ctx.subprocess` seam that answers each successive spawn from a script. */
function scriptedSubprocess(replies) {
  const spawns = []
  const reader = (text) => ({ readFrom: () => ({ text, lossy: false, nextOffset: text.length }) })
  const spawn = (spec) => {
    spawns.push(spec)
    const reply = replies[Math.min(spawns.length - 1, replies.length - 1)] ?? {}
    const proc = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: Promise.resolve({ exitCode: reply.exitCode ?? 0, signal: null }),
      collected: {
        stdout: reader(reply.stdout ?? ''),
        stderr: reader(reply.stderr ?? ''),
      },
      terminate() {
        proc.status = 'killed'
      },
    }
    return proc
  }
  return { spawn, spawns }
}

/** The output `command -v bash; command -v sh` gives on a Niubash deployment. */
const NATIVE_PROBE_TEXT = [
  '/c/Users/me/AppData/Local/Programs/Niubash/winuxcmd/usr/bin/bash.exe',
  '/c/Users/me/AppData/Local/Programs/Niubash/winuxcmd/usr/bin/sh.exe',
  '',
].join('\n')

const VERSION_TEXT = [
  'Niubash 1.1.4 — bash-compatible shell for Windows',
  '  rubash   git 8b81c7501646',
  '  winuxcmd WinuxCmd 1.0.8',
  '',
].join('\n')

/** Boot one executor through `Service.init` with a scripted subprocess seam. */
async function bootExecutor(replies, config = {}) {
  const subprocess = scriptedSubprocess(replies)
  const { ctx, confined } = fakeContext({ subprocess })
  const executor = new NiubashExecutor(ctx, resolveConfig({
    ...baseConfig,
    verifyNiubash: true,
    requireNiubash: true,
    ...config,
  }))
  await executor[Service.init]()
  return { executor, subprocess, confined }
}

test('the boot probe parses the shim output instead of the subprocess envelope', async () => {
  const { executor } = await bootExecutor([{ stdout: NATIVE_PROBE_TEXT }], { probeNativeShells: true })
  assert.deepEqual(executor.niuNativeShells.names, ['bash', 'sh'])
  assert.deepEqual(executor.niuNativeShells.paths, [
    'c:/users/me/appdata/local/programs/niubash/winuxcmd/usr/bin/bash.exe',
    'c:/users/me/appdata/local/programs/niubash/winuxcmd/usr/bin/sh.exe',
  ])
  // The parsed shims are what the guard consults, so the handoff is allowed.
  assert.deepEqual(executor.niuShellArgv('bash -c "echo hi"'), ['niu.exe', '-c', 'bash -c "echo hi"'])
})

test('boot records the version, runs one real command, then probes the shims', async () => {
  const { executor, subprocess } = await bootExecutor([
    { stdout: VERSION_TEXT },
    { stdout: 'niubash-smoke-ok\n' },
    { stdout: NATIVE_PROBE_TEXT },
  ], { probeNativeShells: true })

  assert.equal(executor.niuVersion, '1.1.4')
  assert.deepEqual(executor.niuNativeShells.names, ['bash', 'sh'])
  assert.deepEqual(subprocess.spawns.map((spec) => spec.argv), [
    ['niu.exe', '--version'],
    ['niu.exe', '-c', 'echo niubash-smoke-ok'],
    ['niu.exe', '-c', NATIVE_SHELL_PROBE],
  ])
  assert.deepEqual(niuRuntime.smoke, { ok: true, detail: 'niubash-smoke-ok' })
})

test('a smoke test that cannot run is reported at boot without failing it', async () => {
  const { executor, subprocess } = await bootExecutor([
    { stdout: VERSION_TEXT },
    { exitCode: 1, stdout: '', stderr: 'failed to open history provider\n' },
  ], { probeNativeShells: false })

  assert.deepEqual(subprocess.spawns.map((spec) => spec.argv), [
    ['niu.exe', '--version'],
    ['niu.exe', '-c', 'echo niubash-smoke-ok'],
  ])
  assert.equal(niuRuntime.smoke.ok, false)
  assert.match(niuRuntime.smoke.detail, /failed to open history provider/)
})

test('smokeTest: false keeps the boot to the version probe alone', async () => {
  const { subprocess } = await bootExecutor([{ stdout: VERSION_TEXT }], { smokeTest: false, probeNativeShells: false })
  assert.deepEqual(subprocess.spawns.map((spec) => spec.argv), [['niu.exe', '--version']])
})

test('a shim probe that answers nothing leaves bash refused, not allowed', async () => {
  const { executor } = await bootExecutor([{ stdout: VERSION_TEXT }, { stdout: 'niubash-smoke-ok\n' }, { stdout: '/usr/bin/bash\n' }], { probeNativeShells: true })
  assert.deepEqual(executor.niuNativeShells.names, [])
  assert.throws(() => executor.niuShellArgv('bash -c "echo hi"'), /Niubash-only/)
})

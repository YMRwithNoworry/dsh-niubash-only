/**
 * The Niubash shell executor: the single `ctx.shell` provider of a Niubash-only
 * deployment.
 *
 * It reuses dsh's own sandbox-consuming executor for the machinery that must not
 * drift — request defaulting and caps, deadline fusion, cause classification,
 * output capture and spill, background handles, and the sandbox wrap plus its
 * denial/runner-failure facts — and changes exactly one thing: the argv a
 * command runs as. Instead of `bash -c <command>` / `pwsh -Command <command>`,
 * every command runs as `niu -c <command>`.
 *
 * ## The 0.1.7 shell seam
 *
 * Since dsh `0.1.7-rc.1` the seam has ONE execution verb:
 * `execute(spec) -> ShellExecution`. The `run` / `start` / `runArgv` /
 * `startArgv` set the 0.1.5 line exposed is gone, and `ShellExecution` is the
 * live process handle plus the memoized foreground projection `result()` —
 * "foreground" is a property of what the caller awaits, not of the spawn. This
 * class therefore overrides:
 *
 * - `execute(spec)` — the one entry point. With the bundle default
 *   (`sandbox: false`) the command runs directly on the host, so that branch is
 *   rebuilt here and `danger-full-access` can never fall back to the base
 *   shell's argv; with `sandbox: true` the base executor owns both branches
 *   (confined and full access) and reaches Niubash through the `confine`
 *   override below. Either way the handle's `result()` carries the failure hint.
 * - `argv(spec)` — the argv seam the pwsh family exposes, and the one its
 *   confining sibling calls from `execute`.
 * - `confine(subject, policy, signal)` — the confinement seam. The bash family
 *   passes the command string and the pwsh family the resolved spec, so the
 *   override accepts either; `signal` is the provider's cancellation, forwarded
 *   to the sandbox provider unchanged.
 *
 * All three overrides are written platform-agnostically: the class works
 * whichever base it resolved, and `execute` produces identical results on both.
 * (Niubash itself is a Windows product; on POSIX the executor still works if a
 * `niu` is on `PATH`, and the boot probe is what decides whether the deployment
 * is usable.)
 *
 * The state this class adds lives in plain instance properties, not `#private`
 * fields: cordis hands the service out through a proxy, and a private-field
 * access on that receiver throws.
 *
 * @module dsh-niubash-only/executor
 */

import { Service } from '@deepseek-ai/cordis'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import { assertNiubashOnly, compileForeignShellAllowlist } from './guard.js'
import { assertNiubashDialect, dialectHint } from './dialect.js'
import {
  normalizeNiuArgs,
  niuRuntime,
  niubashArgv,
  parseNativeShells,
  parseNiubashVersion,
  resolveNiubashPath,
} from './niubash.js'

/**
 * The platform's sandbox-consuming first-party executor. Both families are
 * installed with `dsh-base`; the platform picks which of them a default
 * deployment mounts, and this plugin preserves that choice's mechanics.
 */
const BaseExecutor = process.platform === 'win32' ? SandboxPwshExecutor : SandboxBashExecutor

/** Plugin name used by loader diagnostics. */
export const name = 'niubash-executor'

/** Service dependencies: the subprocess seam, the sandbox provider, and the policy resolver. */
export const inject = [...BaseExecutor.inject]

/** The probe that teaches the guard which `bash`/`sh` are Niubash's own shims. */
export const NATIVE_SHELL_PROBE = 'command -v bash 2>/dev/null; command -v sh 2>/dev/null'

/**
 * The per-call sandbox policy of a spec, defaulted exactly the way the base
 * executor's own `resolve` defaults it. A caller that hand-built a spec without
 * resolving it would otherwise be treated as "no policy", which is the wrong
 * direction to fail — the deployment policy is what the session really runs
 * under, and it is also what the settled sandbox facts report back.
 * @param executor - the executor holding the sandbox-policy service.
 * @param spec - the resolved (or hand-built) execution spec.
 * @returns the policy to honor, or undefined when no policy service exists.
 */
function policyOf(executor, spec) {
  return spec.sandboxPolicy ?? executor.ctx.sandboxPolicy?.resolve?.()
}

/** Log one line through the composition's logger, tolerating a logger-less context. */
function log(executor, level, message) {
  try {
    executor.ctx.logger[level](`dsh-niubash-only: ${message}`)
  } catch {
    // Logging is best-effort; the executor works without a logger.
  }
}

/**
 * A Niubash-backed `ctx.shell` provider. Configuration:
 *
 * | Field | Default | Meaning |
 * |---|---|---|
 * | `niuPath` | `$DSH_NIU_PATH`, else `PATH`, else the install dir | Niubash executable. |
 * | `niuArgs` | `['-c']` | Argv prefix; the command is appended last. |
 * | `enforceNiubashOnly` | `true` | Refuse commands that hand off to another shell. |
 * | `foreignShellAllowlist` | `[]` | Whole-command regexes exempt from the guard and the dialect lint. |
 * | `dialectLint` | `true` | Refuse PowerShell/CMD habits (`$env:VAR`, `Get-ChildItem`, `ls -Recurse`, `foreach (…)`, `@(…)`, `$x = 1`) before spawning. |
 * | `dialectHints` | `true` | Append one actionable hint to stderr when a command fails in a recognizable way. |
 * | `requireNiubash` | `true` | Fail boot when `niu` cannot be resolved. |
 * | `verifyNiubash` | `true` | Run `niu --version` once at boot. |
 * | `verifyTimeoutMs` | `10000` | Bound for that probe. |
 * | `probeNativeShells` | `true` | Ask Niubash which `bash`/`sh` its `PATH` resolves, so handing a command to those is allowed only when they are Niubash's own shims. |
 * | `smokeTest` | `true` | Run one real one-shot command at boot, so a deployment that resolves `niu` but cannot run it — a sandbox that denies `$HOME/.niubash_history`, which `niu -c` opens while building the shell — is reported once at boot instead of on every call. |
 * | `sandbox` | `false` | Whether `ctx.sandbox` confines shell commands. Off: `niu` runs directly on the host, and the run reports `mode: danger-full-access` (plus `bypassed: <policy mode>` when the session asked for confinement). On: the first-party confinement path is used unchanged. |
 *
 * The inherited `bash-sandbox`/`pwsh-sandbox` budgets (`cwd`, `timeoutMs`,
 * `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes`, `graceMs`) apply unchanged
 * and stay layered with the `shell` settings section.
 */
export class NiubashExecutor extends BaseExecutor {
  /** Service dependencies (re-stated so the plugin's own row is self-describing). */
  static inject = [...BaseExecutor.inject]

  /** The inherited sandbox executor config schema; extra Niubash keys pass through schemastery. */
  static Config = BaseExecutor.Config

  /**
   * @param ctx - the plugin context.
   * @param config - the composition entry's config, validated by the inherited schema.
   */
  constructor(ctx, config = {}) {
    const source = config ?? {}
    const executable = resolveNiubashPath(source.niuPath)
    const options = {
      executable: executable.path,
      source: executable.source,
      args: normalizeNiuArgs(source.niuArgs),
      allow: compileForeignShellAllowlist(source.foreignShellAllowlist),
      enforce: source.enforceNiubashOnly !== false,
      lint: source.dialectLint !== false,
      hints: source.dialectHints !== false,
      requireNiubash: source.requireNiubash !== false,
      verifyNiubash: source.verifyNiubash !== false,
      smokeTest: source.smokeTest !== false,
      probeNativeShells: source.probeNativeShells !== false,
      sandbox: source.sandbox === true,
      verifyTimeoutMs: Number.isFinite(source.verifyTimeoutMs) && source.verifyTimeoutMs > 0 ? source.verifyTimeoutMs : 10000,
      resolvedPath: undefined,
      nativeShells: { names: [], paths: [] },
    }
    super(ctx, source)
    this.niuOptions = options
    niuRuntime.path = executable.path
    niuRuntime.source = executable.source
    niuRuntime.sandbox = options.sandbox
  }

  /**
   * Resolve `niu`, prove it runs, and learn which `bash`/`sh` are Niubash's own
   * shims — all before the first tool call. A Niubash-only deployment whose
   * Niubash is missing should say so at boot, with the ways to fix it, instead
   * of failing every command mid-session.
   */
  async [Service.init]() {
    const options = this.niuOptions
    const subprocess = this.ctx.subprocess
    let resolvedPath
    try {
      resolvedPath = typeof subprocess?.resolveExecutable === 'function'
        ? await subprocess.resolveExecutable(options.executable)
        : options.executable
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      niuRuntime.error = detail
      if (options.requireNiubash) {
        throw new Error(
          `dsh-niubash-only: cannot resolve the Niubash executable ${JSON.stringify(options.executable)} (${detail}). `
          + 'Install Niubash (it puts `niu.exe` on the user PATH), or set `niuPath` / `DSH_NIU_PATH`; '
          + 'set executor config `requireNiubash: false` to boot anyway.',
        )
      }
      log(this, 'warn', `Niubash executable ${JSON.stringify(options.executable)} not resolved (${detail}); shell commands will fail until it is available`)
      return
    }
    options.resolvedPath = resolvedPath
    niuRuntime.resolvedPath = resolvedPath
    if (options.verifyNiubash) {
      try {
        const facts = await this.probeVersion(resolvedPath)
        if (facts !== undefined) {
          niuRuntime.version = facts.version
          niuRuntime.rubash = facts.rubash
          niuRuntime.winuxcmd = facts.winuxcmd
        }
        const described = [
          facts?.version === undefined ? undefined : `Niubash ${facts.version}`,
          facts?.rubash === undefined ? undefined : `rubash ${facts.rubash}`,
          facts?.winuxcmd === undefined ? undefined : `WinuxCmd ${facts.winuxcmd}`,
        ].filter((entry) => entry !== undefined).join(', ')
        log(this, 'info', described.length === 0
          ? `shell executor bound to Niubash at ${resolvedPath} (version not reported)`
          : `shell executor bound to ${described} (${resolvedPath})`)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        niuRuntime.error = detail
        if (options.requireNiubash) {
          throw new Error(
            `dsh-niubash-only: Niubash at ${resolvedPath} failed its \`--version\` probe (${detail}). `
            + 'Fix the executable, or set executor config `requireNiubash: false` / `verifyNiubash: false` to boot anyway.',
          )
        }
        log(this, 'warn', `Niubash \`--version\` probe failed (${detail}); continuing without a version`)
      }
    } else {
      log(this, 'info', `shell executor bound to Niubash at ${resolvedPath}`)
    }
    if (options.sandbox === true) {
      log(this, 'info', 'sandbox: shell commands are wrapped by ctx.sandbox confinement')
    } else {
      log(this, 'warn', 'sandbox: this deployment runs Niubash directly on the host — shell commands are NOT wrapped by ctx.sandbox (executor config `sandbox: true` restores confinement, which Niubash 1.1.4 cannot start under a confined policy)')
    }
    // Resolving `niu` and answering `--version` do not prove that a command can
    // run, and the failure mode worth naming at boot (a sandbox denying the
    // history file `niu -c` opens while building its shell) is invisible until
    // one really does. This probe executes a command, so it stays independent of
    // the `--version` switch.
    if (options.smokeTest) {
      try {
        await this.smokeTest()
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        niuRuntime.smoke = { ok: false, detail }
        log(this, 'warn', `the boot smoke test raised (${detail})`)
      }
    }
    if (!options.probeNativeShells) return
    try {
      const nativeShells = await this.probeNativeShells(resolvedPath)
      options.nativeShells = nativeShells
      niuRuntime.nativeShells = nativeShells
      log(this, 'info', nativeShells.names.length === 0
        ? 'no Niubash-owned `bash`/`sh` shim was found: handing a command to either is refused'
        : `Niubash-owned shells allowed: ${nativeShells.names.join(', ')} (${nativeShells.paths.join(', ')})`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // A failed probe is not a boot failure: refusing `bash`/`sh` is the safe
      // default, and the guard's message explains how to relax it.
      log(this, 'warn', `could not probe which bash/sh Niubash provides (${detail}); handing a command to bash/sh will be refused`)
    }
  }

  /** The executable the executor spawns (resolved when the probe ran). */
  get niuExecutable() {
    return this.niuOptions.resolvedPath ?? this.niuOptions.executable
  }

  /** The probed Niubash version, when known. */
  get niuVersion() {
    return niuRuntime.version
  }

  /** Whether the foreign-shell guard is active. */
  get niuEnforceNiubashOnly() {
    return this.niuOptions.enforce
  }

  /** The shells Niubash itself provides, as the boot probe found them. */
  get niuNativeShells() {
    return this.niuOptions.nativeShells
  }

  /** The boot smoke test's outcome: `{ ok, detail }`. */
  get niuSmoke() {
    return niuRuntime.smoke
  }

  /**
   * The exact argv one command runs as, after the Niubash-only guard and the
   * dialect preflight. Both refusals happen before a subprocess exists, so a
   * habit the model can fix cheaply costs nothing to fail.
   * @param command - Bash source from the caller.
   * @returns the argv handed to the subprocess seam.
   * @throws Error when the command hands off to another shell, or uses PowerShell/CMD syntax.
   */
  niuShellArgv(command) {
    const options = this.niuOptions
    if (options.enforce) assertNiubashOnly(command, { allow: options.allow, nativeShells: options.nativeShells })
    if (options.lint) assertNiubashDialect(command, { allow: options.allow })
    return niubashArgv(command, { niuPath: this.niuExecutable, niuArgs: options.args })
  }

  /**
   * The argv seam the PowerShell family exposes; its confining sibling calls
   * `this.argv(spec)` from `execute`.
   * @param spec - the resolved execution spec.
   * @returns the Niubash argv for this spec.
   */
  argv(spec) {
    return this.niuShellArgv(spec.command)
  }

  /**
   * The confinement seam of the POSIX family (`confine(command, policy, signal)`)
   * and of the Windows family (`confine(spec, policy, signal)`).
   *
   * With `sandbox: true` this is the parent's wrap through `ctx.sandbox`,
   * keeping the provider's own enforcement and classification facts, with the
   * provider's cancellation forwarded unchanged. With the bundle default
   * (`sandbox: false`) a caller that asks for confinement still gets an honest
   * envelope — the unwrapped argv, `enforcement: 'none'`, no denial signatures —
   * because this deployment does not confine shell commands.
   * @param subject - the command string (POSIX) or the resolved spec (Windows).
   * @param policy - the per-call sandbox policy.
   * @param signal - cancellation of confinement preparation.
   * @returns the sandbox provider's wrap result, or the unconfined envelope.
   */
  confine(subject, policy, signal) {
    const command = typeof subject === 'string' ? subject : subject.command
    const argv = this.niuShellArgv(command)
    if (this.niuOptions.sandbox === true) return this.ctx.sandbox.confine(argv, policy, signal)
    return { argv, enforcement: 'none', denialSignatures: [], runnerFailureRules: [] }
  }

  /**
   * The sandbox facts a run reports.
   *
   * Running unconfined is reported as `danger-full-access` because that is what
   * happened, and a session that *asked* for confinement gets the ignored mode
   * as `bypassed` so the deviation is visible in the result rather than only in
   * the boot log.
   * @param spec - the resolved spec being run.
   * @param policy - the already-resolved per-call policy, when the caller has it.
   * @returns the facts object attached to the settled result.
   */
  sandboxFacts(spec, policy) {
    const facts = { mode: 'danger-full-access', denied: false }
    const resolved = policy ?? policyOf(this, spec)
    if (resolved !== undefined && resolved.mode !== 'danger-full-access') facts.bypassed = resolved.mode
    return facts
  }

  /**
   * The one execution entry point of the 0.1.7 seam.
   *
   * With `sandbox: true` the parent owns both branches (it wraps the Niubash
   * argv through the `confine` override), so the delegate is stamped with the
   * policy this class defaulted when the spec carried none — the parent reads
   * `spec.sandboxPolicy` itself, and a hand-built spec must fail closed onto the
   * deployment policy rather than run unconfined.
   *
   * With the bundle default (`sandbox: false`) the command runs directly on the
   * host, so no spec shape can fall back to the base shell's argv; the settled
   * facts say what ran and which mode was bypassed.
   * @param spec - a resolved spec from {@link resolve}.
   * @returns the live execution handle, exactly one per call.
   */
  async execute(spec) {
    const policy = policyOf(this, spec)
    if (this.niuOptions.sandbox !== true) {
      const handle = await this.executeArgv(spec, this.niuShellArgv(spec.command))
      return NiubashExecutor.decorateResult(handle, (result) => this.withDialectHint(spec, {
        ...result,
        sandbox: this.sandboxFacts(spec, policy),
      }))
    }
    const delegated = spec.sandboxPolicy === undefined && policy !== undefined ? { ...spec, sandboxPolicy: policy } : spec
    const handle = await super.execute(delegated)
    return NiubashExecutor.decorateResult(handle, (result) => this.withDialectHint(spec, result))
  }

  /**
   * Append one actionable hint to a failed command's stderr. The hint is chosen
   * from what the shell actually printed, so it answers the failure that
   * happened (a program this deployment does not have, a PowerShell flag, a
   * `$null` redirect, a drive-root path) instead of repeating the whole guide.
   * @param spec - the resolved spec the command came from.
   * @param result - the settled run result.
   * @returns the result, with the hint appended to its stderr when one applies.
   */
  withDialectHint(spec, result) {
    if (!this.niuOptions.hints) return result
    const stderr = result?.stderr
    const text = typeof stderr?.text === 'string' ? stderr.text : undefined
    if (text === undefined) return result
    const hint = dialectHint(spec.command, text, { exitCode: result.exitCode, stdout: result.stdout?.text })
    if (hint === undefined) return result
    const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n'
    return { ...result, stderr: { ...stderr, text: `${text}${separator}${hint}\n` } }
  }

  /** The working directory a boot probe spawns in (`config.cwd` is a live schema ref). */
  probeCwd() {
    const declared = this.config?.cwd
    const value = typeof declared?.get === 'function' ? declared.get() : declared
    return typeof value === 'string' && value.length > 0 ? value : process.cwd()
  }

  /** Capture the output and exit status of one short probe process. */
  async probeArgv(argv) {
    const signal = AbortSignal.timeout(this.niuOptions.verifyTimeoutMs)
    const handle = this.ctx.subprocess.spawn({
      argv,
      cwd: this.probeCwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 8192 },
        stderr: { maxBytes: 8192 },
      },
      graceMs: 1000,
      signal,
    })
    const settled = await handle.done
    const stdout = handle.collected?.stdout
    const stderr = handle.collected?.stderr
    return {
      text: `${stdout === undefined ? '' : stdout.readFrom(0).text}${stderr === undefined ? '' : stderr.readFrom(0).text}`,
      exitCode: settled?.exitCode ?? null,
    }
  }

  /**
   * Run `niu --version` through the subprocess seam.
   * @param executable - the resolved executable path.
   * @returns the parsed version facts, or undefined when the output has none.
   */
  async probeVersion(executable) {
    const { text } = await this.probeArgv([executable, '--version'])
    const facts = parseNiubashVersion(text)
    if (facts === undefined && text.trim().length === 0) throw new Error('no output')
    return facts
  }

  /**
   * Run one real command at boot, end to end, because resolving `niu` and
   * answering `--version` do not prove that a *tool call* can run.
   *
   * The case this exists for: Niubash builds its history provider inside
   * `Shell::new`, which `niu -c` also calls, and that provider opens
   * `$HOME/.niubash_history`. Under a sandbox that denies paths outside the
   * workspace the open fails, `niu` exits 1 before running anything, and every
   * tool call would report the same opaque error. A warning that names the cause
   * and the fix is worth more than a session full of confusing failures.
   *
   * It deliberately goes through {@link execute} rather than the raw subprocess
   * seam, so the smoke test observes exactly what a tool call observes —
   * including the sandbox wrap and the settled facts.
   */
  async smokeTest() {
    let result
    try {
      const handle = await this.execute(this.resolve({ command: 'echo niubash-smoke-ok' }))
      result = await handle.result()
    } catch (error) {
      // A refusal here would mean the guard or the preflight rejected the
      // plugin's own smoke command, which is a plugin bug worth yelling about.
      const detail = error instanceof Error ? error.message : String(error)
      niuRuntime.smoke = { ok: false, detail }
      log(this, 'warn', `the boot smoke test was refused before it could run (${detail})`)
      return
    }
    const text = `${result?.stdout?.text ?? ''}${result?.stderr?.text ?? ''}`
    const ok = result?.exitCode === 0 && text.includes('niubash-smoke-ok')
    const detail = text.trim().split(/\r?\n/)[0] ?? ''
    niuRuntime.smoke = { ok, detail }
    if (ok) return
    if (/failed to open history provider/i.test(text)) {
      log(this, 'warn', 'Niubash cannot start commands in this sandbox mode: building the shell for `niu -c` opens $HOME/.niubash_history, the configured sandbox denies that path, and `niu` exits 1 before the command runs. '
        + 'Run this profile with the `danger-full-access` permission preset (or make the history file reachable from the sandbox). '
        + 'This is a Niubash host-layer limitation — `niu -c` needs no history — not a refusal by dsh-niubash-only; see "沙箱模式与 Niubash" in the README.')
      return
    }
    log(this, 'warn', `the boot smoke test failed (exit ${result?.exitCode}): ${detail.length === 0 ? '(no output)' : detail}`)
  }

  /**
   * Ask Niubash which `bash`/`sh` its own `PATH` resolves, so the guard can
   * tell Niubash's rubash shims from Git Bash / WSL.
   * @param executable - the resolved executable path.
   * @returns the native shell names and their normalized paths.
   */
  async probeNativeShells(executable) {
    const { text } = await this.probeArgv([executable, ...this.niuOptions.args, NATIVE_SHELL_PROBE])
    return parseNativeShells(text)
  }
}

export default NiubashExecutor

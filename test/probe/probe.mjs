/**
 * Integration self-test: boots inside a real dsh composition (the plugin
 * installed as a profile bundle) and checks, at runtime, the promises the
 * plugin makes — that the shell seam runs Niubash, that a foreign-shell handoff
 * and a PowerShell habit are refused, that a failure carries a hint, and that
 * the model-facing prompt and tool schemas describe what actually runs. Exits 0
 * when every check passes.
 *
 * Run it through `test/integration.mjs`, which creates the scratch profile.
 *
 * Two properties of a real boot shape this probe:
 *
 * - A composition booted with `--patch` overlays applies its include list more
 *   than once, disposing and recreating plugin fibers. A check that spans an
 *   await can therefore find its context inactive; the preset-scoped block runs
 *   first, and an inactive context is reported as a skip rather than a failure.
 * - A web composition mounts the shell tools inside agent presets, not on the
 *   host plane, so "no global shell tool" is normal there.
 *
 * @module dsh-niubash-only/test/probe
 */

import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Services that must exist before the probe can observe anything. */
export const inject = ['shell', 'systemPrompt', 'subprocess', 'tools', 'sandboxPolicy']

const results = []
const skipped = []

function record(name, ok, detail) {
  results.push({ name, ok: ok === true, detail: detail === undefined ? '' : String(detail).replace(/\s+/g, ' ').trim().slice(0, 220) })
  console.log(`${ok === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${detail}`}`)
}

function skip(name, reason) {
  skipped.push({ name, reason })
  console.log(`SKIP ${name} :: ${reason}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The assembled tool schema for one name, from the live prompt registry. */
function toolOf(assembly, name) {
  return assembly.tools.find((tool) => tool.name === name)
}

/**
 * Rendered prompt text. A deployment whose global sections reference
 * agent-supplied variables (`{{model}}` and friends) cannot render an unscoped
 * assembly, so fall back to the section texts — the guide and rules this probe
 * checks are static sections and survive either way.
 */
function promptText(assembly) {
  try {
    return renderPrompt(assembly)
  } catch {
    return assembly.sections.map((section) => section.text).join('\n\n')
  }
}

/** Whether a thrown error means this probe's fiber was disposed mid-check. */
function isInactiveContext(error) {
  return /inactive context/i.test(error instanceof Error ? error.message : String(error))
}

/** Check one exposed shell tool's schema. */
function checkShellTool(tool, label) {
  record(`${label} ${tool.name} describes Niubash`, /Bash on Windows through Niubash/.test(tool.description))
  record(`${label} ${tool.name} never claims the old dialect`, !/bash -c/.test(tool.description) && !/pwsh -Command/.test(tool.description))
  record(`${label} ${tool.name} command parameter is Bash`, /Bash command/.test(tool.parameters?.properties?.command?.description ?? ''))
  record(`${label} ${tool.name} warns about PowerShell habits`, /PowerShell and CMD are not available/.test(tool.description))
}

/** Apply the probe: observe, assert, report, exit. */
export async function apply(ctx) {
  try {
    const shell = ctx.shell
    record('shell service is the Niubash executor', shell?.constructor?.name === 'NiubashExecutor', shell?.constructor?.name)
    record('probed Niubash version', typeof shell.niuVersion === 'string', shell.niuVersion ?? '(unknown)')
    record('Niubash-owned bash/sh were probed', (shell.niuNativeShells?.names ?? []).length > 0, (shell.niuNativeShells?.names ?? []).join(','))

    // An agent preset mounts its own shell tool inside a child scope. Teaching
    // has to reach it: the waterfall listener runs at the root, and a root
    // listener still receives a scoped assembly. This block goes first, before
    // any other await, so a re-applied include cannot dispose the fiber midway.
    let scopedTool
    try {
      const presetKey = { probe: 'preset-scoped-agent' }
      const presetScope = createScope(ctx, presetKey)
      presetScope.ctx.tools.register(defineTool({
        name: 'pwsh',
        description: 'Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr.',
        parameters: {
          command: { type: 'string', required: true, description: 'The PowerShell command to execute.' },
          workdir: { type: 'string', description: 'Working directory for this command.' },
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
          render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        async execute() {
          return { text: 'scoped' }
        },
      }))
      const scopedAssembly = await ctx.systemPrompt.assemble({ scope: presetKey })
      scopedTool = toolOf(scopedAssembly, 'pwsh')
      record('a preset-scoped shell tool is reachable', scopedTool !== undefined)
      if (scopedTool !== undefined) checkShellTool(scopedTool, 'preset-scoped')
      record('a scoped assembly still renders the guide', promptText(scopedAssembly).includes('Niubash guide'))
    } catch (error) {
      if (!isInactiveContext(error)) throw error
      skip('preset-scoped shell tool checks', 'the include was re-applied and disposed this fiber')
    }

    // A deployment that opts into confinement (`sandbox: true`) in a session
    // whose policy confines cannot run *any* command under Niubash 1.1.4: the
    // shell opens `$HOME/.niubash_history` while building itself and the sandbox
    // denies it. The executor reports that in its boot smoke test. The bundle
    // default (running on the host) never reaches this branch; when it does hit,
    // the refusals below still hold (they happen before a subprocess exists) and
    // the checks that need a real command are reported as skips with the cause.
    const smoke = shell.niuSmoke
    // Only the documented host-layer failure excuses the command checks. Any
    // other smoke failure (a missing executable, a broken install) stays a
    // failure, so the detector cannot hide a real breakage behind a skip.
    const blockedByShellStartup = smoke?.ok === false && /history/i.test(String(smoke.detail ?? ''))
    const blockedReason = blockedByShellStartup
      ? `Niubash cannot start a command in this sandbox mode (${String(smoke.detail ?? '').split('\n')[0].slice(0, 140)})`
      : ''
    if (blockedByShellStartup) {
      skip('the boot smoke test ran a real command', blockedReason)
      console.log(`NOTE the boot smoke test already failed: ${blockedReason}`)
    } else {
      record('the boot smoke test ran a real command', smoke?.ok === true, smoke?.ok === true ? 'ok' : String(smoke?.detail ?? '(not reported)'))
    }

    if (blockedByShellStartup) {
      skip('runs a shell builtin', blockedReason)
      skip('runs a Unix-tool pipeline', blockedReason)
      skip('the run reports its sandbox facts', blockedReason)
      skip('runs a native Windows program', blockedReason)
      skip('reports a non-zero exit instead of throwing', blockedReason)
      skip('allows Niubash\'s own bash shim', blockedReason)
      skip('a failed call carries a Niubash hint', blockedReason)
    } else {
      const builtin = await shell.run(shell.resolve({ command: 'echo "hello from niubash"' }))
      record('runs a shell builtin', builtin.exitCode === 0 && /hello from niubash/.test(builtin.stdout.text), builtin.stdout.text)

      const pipeline = await shell.run(shell.resolve({ command: "printf 'beta\\nalpha\\n' | sort | head -1" }))
      record('runs a Unix-tool pipeline', pipeline.exitCode === 0 && pipeline.stdout.text.trim() === 'alpha', pipeline.stdout.text)

      // The bundle's posture: `niu` runs directly on the host. In a session whose
      // policy asks for confinement the work still happens, and the settled facts
      // say both what ran (danger-full-access) and what was ignored (`bypassed`).
      const expectedMode = ctx.sandboxPolicy?.defaultMode
      if (expectedMode === undefined || expectedMode === 'danger-full-access') {
        record('the run reports its sandbox facts', pipeline.sandbox?.mode === 'danger-full-access', `reported ${JSON.stringify(pipeline.sandbox)}`)
      } else {
        record(
          `a ${expectedMode} session still runs commands (the executor runs on the host)`,
          pipeline.exitCode === 0 && pipeline.sandbox?.mode === 'danger-full-access' && pipeline.sandbox?.bypassed === expectedMode,
          `reported ${JSON.stringify(pipeline.sandbox)}`,
        )
      }

      const external = await shell.run(shell.resolve({ command: 'git --version' }))
      record('runs a native Windows program', external.exitCode === 0 && /git version/.test(external.stdout.text), external.stdout.text)

      const failure = await shell.run(shell.resolve({ command: 'exit 3' }))
      record('reports a non-zero exit instead of throwing', failure.exitCode === 3, `exit ${failure.exitCode}`)

      // Niubash's own bash shim is the same engine, so it is allowed once the
      // boot probe proved what `bash` resolves to.
      const nested = await shell.run(shell.resolve({ command: 'bash -c "echo nested-ok"' }))
      record('allows Niubash\'s own bash shim', nested.exitCode === 0 && /nested-ok/.test(nested.stdout.text), nested.stdout.text)

      // Post-failure hinting: an error the preflight cannot predict still comes
      // back with one actionable line naming the fix.
      const hinted = await shell.run(shell.resolve({ command: "awk '{print $1}' package.json" }))
      record('a failed call carries a Niubash hint', /Niubash hint \(missing-program\)/.test(hinted.stderr.text), hinted.stderr.text.replace(/\s+/g, ' ').slice(0, 160))
      record('the hint names a concrete replacement', /not installed in this Niubash deployment/.test(hinted.stderr.text))
    }

    let refused = ''
    try {
      await shell.run(shell.resolve({ command: 'pwsh -Command Get-ChildItem' }))
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    record('refuses a foreign-shell handoff', /Niubash-only/.test(refused), refused)
    record('that refusal teaches the Bash form', /Get-ChildItem/.test(refused) && /enforceNiubashOnly/.test(refused))

    // The dialect preflight: habits that would otherwise fail (or, for
    // `$env:NAME`, silently print the wrong text) are refused before spawning.
    let dialectRefusal = ''
    try {
      await shell.run(shell.resolve({ command: 'echo $env:PATH' }))
    } catch (error) {
      dialectRefusal = error instanceof Error ? error.message : String(error)
    }
    record('refuses a PowerShell environment reference', /Niubash-only shell: refusing a powershell-env/.test(dialectRefusal), dialectRefusal)
    record('that refusal explains the silent-wrong-output trap', /silently|silent/.test(dialectRefusal) && /dialectLint: false/.test(dialectRefusal))

    let flagRefusal = ''
    try {
      await shell.run(shell.resolve({ command: 'ls -Recurse' }))
    } catch (error) {
      flagRefusal = error instanceof Error ? error.message : String(error)
    }
    record('refuses a PowerShell flag and names the Bash one', /refusing a powershell-flag/.test(flagRefusal) && /ls -R/.test(flagRefusal), flagRefusal)

    let assembly
    for (let attempt = 0; attempt < 100; attempt++) {
      assembly = await ctx.systemPrompt.assemble()
      if (toolOf(assembly, 'bash') !== undefined || toolOf(assembly, 'pwsh') !== undefined) break
      await sleep(100)
    }
    const prompt = promptText(assembly)
    record('system prompt carries the shell rules', prompt.includes('Shell: Niubash only'))
    record('system prompt carries the syntax guide', prompt.includes('Niubash guide'))
    record('system prompt carries the translation tables', prompt.includes('PowerShell → Bash (Niubash)') && prompt.includes('CMD → Bash (Niubash)'))
    record('system prompt teaches the freshness contract', prompt.includes('workdir'))
    record('system prompt carries the failure catalogue', prompt.includes('When a command fails'))
    record('system prompt names the tools that are absent', prompt.includes('awk') && prompt.includes('jq'))
    record('system prompt carries the traps', prompt.includes('Traps worth knowing'))

    // A host composition (TUI, headless) keeps the shell tool globally; a web
    // composition mounts it per preset, which the scoped block above covers.
    const globalShellTools = assembly.tools.filter((tool) => tool.name === 'bash' || tool.name === 'pwsh')
    const observed = scopedTool === undefined ? globalShellTools : [...globalShellTools, scopedTool]
    if (observed.length === 0) {
      skip('the composition exposes a shell tool', 'no global shell tool, and the preset-scoped check was skipped')
    } else {
      record('the composition exposes a shell tool', true, observed.map((tool) => tool.name).join(','))
    }
    for (const tool of globalShellTools) checkShellTool(tool, 'host')

    const failed = results.filter((result) => !result.ok)
    console.log(`PROBE ${failed.length === 0 ? 'OK' : 'FAILED'} (${results.length - failed.length}/${results.length} checks${skipped.length === 0 ? '' : `, ${skipped.length} skipped`})`)
    process.exit(failed.length === 0 ? 0 : 1)
  } catch (error) {
    console.error(`PROBE ERROR: ${error instanceof Error ? error.stack : String(error)}`)
    process.exit(2)
  }
}

// Plugin metadata must sit on the function itself: the harness's module loader
// unwraps a `default` export before reading it.
apply.inject = inject

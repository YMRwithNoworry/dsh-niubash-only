/**
 * Diagnostic probe: what exactly fails when Niubash runs inside the harness's
 * confined (`workspace-write`) sandbox? It runs the same trivial command several
 * times and prints each result, so a state-dependent failure is distinguishable
 * from a per-command one. Not part of the suite; run it through
 * `test/scratch/confined-diag.mjs`.
 *
 * @module dsh-niubash-only/test/scratch/confined-diag-probe
 */

export const inject = ['shell', 'sandboxPolicy']

export async function apply(ctx) {
  const shell = ctx.shell
  console.log(`DIAG mode=${ctx.sandboxPolicy?.defaultMode} executor=${shell?.constructor?.name}`)
  const commands = [
    'echo one',
    'echo two',
    'echo three',
    'printf "x\\n" | wc -l',
    'echo four',
    'git --version',
    'echo five',
    'exit 3',
    'echo six',
    'awk 1 /dev/null',
    'echo seven',
  ]
  for (const command of commands) {
    try {
      const result = await (await shell.execute(shell.resolve({ command }))).result()
      const stderr = (result.stderr?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
      console.log(`DIAG ${JSON.stringify(command)} exit=${result.exitCode} sandbox=${result.sandbox?.mode} out=${JSON.stringify((result.stdout?.text ?? '').trim().slice(0, 40))} err=${JSON.stringify(stderr)}`)
    } catch (error) {
      console.log(`DIAG ${JSON.stringify(command)} threw ${error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 160) : String(error)}`)
    }
  }
  console.log('DIAG DONE')
  process.exit(0)
}

apply.inject = inject

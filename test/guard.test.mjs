/**
 * Guard tests: what "only Niubash" refuses, and what it deliberately allows.
 *
 * The cases come from the kinds of command a Windows-trained model actually
 * writes — a PowerShell one-liner "to be safe", a `cmd /c` habit, a `$(…)` that
 * hides a handoff — plus the shapes that must NOT be refused, because a false
 * refusal is worse than a foreign shell: data that merely looks like a command
 * (strings, comments, heredocs) and Niubash's own `bash`/`sh` shims.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertNiubashOnly,
  blankHeredocBodies,
  classifyShellToken,
  commandSubstitutions,
  compileForeignShellAllowlist,
  findForeignShellHandoff,
  findShellReferences,
  programName,
  splitStatements,
  tokenize,
} from '../lib/guard.js'
import { parseNativeShells } from '../lib/niubash.js'

/** What the boot probe returns on this machine: Niubash's own rubash shims. */
const NATIVE = parseNativeShells([
  '/c/Users/me/AppData/Local/Programs/Niubash/winuxcmd/usr/bin/bash.exe',
  '/c/Users/me/AppData/Local/Programs/Niubash/winuxcmd/usr/bin/sh.exe',
].join('\n'))

test('programName reads a program out of a path or a bare name', () => {
  assert.equal(programName('C:\\Windows\\System32\\cmd.exe'), 'cmd')
  assert.equal(programName('/c/Program Files/Git/bin/bash.exe'), 'bash')
  assert.equal(programName('pwsh'), 'pwsh')
  assert.equal(programName('\\cmd'), 'cmd')
  assert.equal(programName('"C:/Program Files/PowerShell/7/pwsh.exe"'), 'pwsh')
})

test('statement splitting and tokenizing follow Bash quoting', () => {
  assert.deepEqual(splitStatements('a; b | c && d').map((part) => part.trim()).filter((part) => part.length > 0), ['a', 'b', 'c', 'd'])
  assert.deepEqual(tokenize("git commit -m 'a b'"), ['git', 'commit', '-m', 'a b'])
  assert.equal(splitStatements('echo "a;b"\n# comment ; here\necho c').length >= 2, true)
})

test('a bare foreign shell is refused', () => {
  for (const command of ['pwsh -Command ls', 'powershell -NoProfile -Command "ls"', 'cmd /c dir', 'wsl ls', 'nu -c "ls"', 'zsh -c ls']) {
    const handoff = findForeignShellHandoff(command)
    assert.notEqual(handoff, undefined, `${command} must be refused`)
    assert.equal(handoff.decision, 'foreign')
  }
})

test('wrappers, assignments, and punctuation do not hide a handoff', () => {
  const commands = [
    'sudo pwsh -Command ls',
    'env FOO=1 pwsh -Command ls',
    'FOO=bar cmd /c dir',
    '(pwsh -Command ls)',
    '{ cmd /c dir; }',
    '$(nu -c "ls")',
    'echo hi && pwsh -Command ls',
    'git status | pwsh -Command "Get-Item ."',
    'x=$(powershell -Command "ls")',
    'echo "$(cmd /c dir)"',
  ]
  for (const command of commands) {
    assert.notEqual(findForeignShellHandoff(command), undefined, `${command} must be refused`)
  }
})

test('backtick substitution is inspected too', () => {
  assert.notEqual(findForeignShellHandoff('echo `pwsh -Command ls`'), undefined)
})

test('strings, comments, and heredoc bodies are data, not commands', () => {
  const allowed = [
    'echo "pwsh -Command ls"',
    "echo 'cmd /c dir'",
    '# pwsh -Command ls',
    'echo hi # cmd /c dir',
    "cat > run.ps1 <<'EOF'\npwsh -Command Get-ChildItem\nEOF",
    "cat > a.sh <<EOF\nnu -c ls\nEOF\ncat > b.sh <<'EOF'\ncmd /c dir\nEOF",
    "printf '%s\\n' 'wsl ls'",
  ]
  for (const command of allowed) {
    assert.equal(findForeignShellHandoff(command), undefined, `${command} must not be refused`)
  }
})

test('heredoc blanking preserves length and line structure', () => {
  const command = "cat <<'EOF'\npwsh -Command ls\nEOF\necho done"
  const blanked = blankHeredocBodies(command)
  assert.equal(blanked.length, command.length)
  assert.equal(blanked.split('\n').length, command.split('\n').length)
  assert.match(blanked, /echo done$/)
  assert.doesNotMatch(blanked, /pwsh/)
})

test('bash and sh are judged by what they resolve to', () => {
  // Without probe facts, a bare `bash` cannot be proven to be Niubash's shim.
  assert.equal(findForeignShellHandoff('bash -c "echo hi"').decision, 'foreign')
  assert.equal(findForeignShellHandoff('bash -c "echo hi"').reason, 'unproven-name')
  assert.equal(findForeignShellHandoff('sh -c "echo hi"').decision, 'foreign')

  // With the probe's facts, the same commands stay inside the dialect.
  assert.equal(findForeignShellHandoff('bash -c "echo hi"', { nativeShells: NATIVE }), undefined)
  assert.equal(findForeignShellHandoff('sh script.sh', { nativeShells: NATIVE }), undefined)
  assert.equal(findForeignShellHandoff('/c/Users/me/AppData/Local/Programs/Niubash/winuxcmd/usr/bin/bash.exe -c x', { nativeShells: NATIVE }), undefined)

  // A Git Bash or WSL bash is a different shell, named bare or by path.
  const gitBash = findForeignShellHandoff("'/c/Program Files/Git/bin/bash.exe' -c 'echo hi'", { nativeShells: NATIVE })
  assert.equal(gitBash.decision, 'foreign')
  assert.equal(gitBash.reason, 'foreign-path')
  assert.equal(findForeignShellHandoff('"C:\\Program Files\\Git\\bin\\bash.exe" -c x', { nativeShells: NATIVE }).reason, 'foreign-path')
})

test('Niubash itself is never refused', () => {
  for (const command of ['niu -c "echo hi"', 'niubash -c ls', 'winuxsh -c ls', 'rubash -c ls']) {
    assert.equal(findForeignShellHandoff(command), undefined, `${command} must stay allowed`)
  }
})

test('a non-shell program that mentions a shell is untouched', () => {
  assert.equal(findForeignShellHandoff('git log --grep=pwsh'), undefined)
  assert.equal(findForeignShellHandoff('grep -rn "cmd /c" src/'), undefined)
  assert.equal(findForeignShellHandoff('node -e "console.log(1)"'), undefined)
})

test('classifyShellToken reports why a shell was judged', () => {
  assert.equal(classifyShellToken('pwsh', {}).decision, 'foreign')
  assert.equal(classifyShellToken('niu', {}).decision, 'self')
  assert.equal(classifyShellToken('bash', {}).reason, 'unproven-name')
  assert.equal(classifyShellToken('bash', { nativeShells: NATIVE }).reason, 'probed-name')
  assert.equal(classifyShellToken('/c/Users/me/AppData/Local/Programs/Niubash/winuxcmd/usr/bin/bash.exe', {}).reason, 'install-path')
  assert.equal(classifyShellToken('grep', {}), undefined)
})

test('parseNativeShells only accepts shims inside a Niubash install', () => {
  const parsed = parseNativeShells('/usr/bin/bash\n/c/Program Files/Git/bin/sh.exe\n/c/x/Niubash/winuxcmd/usr/bin/bash.exe\n')
  assert.deepEqual(parsed.names, ['bash'])
  assert.equal(parsed.paths.length, 1)
  assert.match(parsed.paths[0], /winuxcmd\/usr\/bin\/bash\.exe$/)
})

test('findShellReferences lists every reference, not just the first', () => {
  const references = findShellReferences('pwsh -Command ls; echo ok; cmd /c dir')
  assert.deepEqual(references.map((entry) => entry.name), ['pwsh', 'cmd'])
})

test('commandSubstitutions finds executed substitutions and skips literal ones', () => {
  assert.deepEqual(commandSubstitutions('echo $(date) `whoami`'), ['date', 'whoami'])
  assert.deepEqual(commandSubstitutions("echo '$ (date)'"), [])
  assert.deepEqual(commandSubstitutions('x=$(cd /tmp && pwd)'), ['cd /tmp && pwd'])
})

test('the guard throws a message that teaches, and honors the allowlist', () => {
  assert.throws(
    () => assertNiubashOnly('pwsh -Command Get-ChildItem'),
    (error) => /Niubash-only shell: refusing to hand this command to `pwsh`/.test(error.message)
      && /niu -c/.test(error.message)
      && /Get-ChildItem/.test(error.message)
      && /enforceNiubashOnly: false/.test(error.message),
  )
  const allow = compileForeignShellAllowlist(['^pwsh -Command "legacy"$'])
  assert.doesNotThrow(() => assertNiubashOnly('pwsh -Command "legacy"', { allow }))
  assert.throws(() => assertNiubashOnly('pwsh -Command "other"', { allow }), /Niubash-only/)
})

test('a malformed allowlist fails loudly', () => {
  assert.throws(() => compileForeignShellAllowlist('nope'), /must be an array/)
  assert.throws(() => compileForeignShellAllowlist([42]), /must be strings/)
  assert.throws(() => compileForeignShellAllowlist(['(']), /valid regular expression/)
})

/**
 * Dialect tests: the PowerShell/CMD habits the preflight refuses, the commands
 * it must leave alone, and the failure hints — built from error text this
 * machine's Niubash actually printed.
 *
 * The stderr strings in the hint cases are verbatim captures from Niubash
 * 1.1.4 / WinuxCmd 1.0.8 (see README's failure table), so a hint that stops
 * matching a real message shows up here rather than in a session.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DIALECT_HINT_IDS,
  DIALECT_RULE_IDS,
  assertNiubashDialect,
  codeView,
  dialectHint,
  dialectMessage,
  findDialectIssue,
} from '../lib/dialect.js'

/** The rule a command is refused by, or undefined. */
function ruleOf(command) {
  return findDialectIssue(command)?.id
}

test('PowerShell environment references are refused (the silent trap)', () => {
  assert.equal(ruleOf('echo $env:PATH'), 'powershell-env')
  assert.equal(ruleOf('echo "${env:PATH}"'.replace('"', '')), 'powershell-env')
  const message = dialectMessage(findDialectIssue('echo $env:PATH'))
  assert.match(message, /:NAME/)
  assert.match(message, /silent/)
  assert.match(message, /dialectLint: false/)
})

test('PowerShell/CMD habits are refused with the right rule id', () => {
  const cases = [
    ['echo hi > $null', 'powershell-null-redirect'],
    ['ls /x 2>$null', 'powershell-null-redirect'],
    ['echo $LASTEXITCODE', 'powershell-automatic-variable'],
    ['echo $PSItem', 'powershell-automatic-variable'],
    ['if ($x -eq 1) { echo y }', 'powershell-conditional-syntax'],
    ['@(1,2,3)', 'powershell-array-literal'],
    ['h=@{a=1}', 'powershell-array-literal'],
    ['$h = @{a=1}', 'spaced-assignment'],
    ['foreach ($i in 1..3) { echo $i }', 'powershell-foreach'],
    ['-not (Test-Path x)', 'powershell-operator'],
    ['ls -Recurse', 'powershell-flag'],
    ['ls -ErrorAction SilentlyContinue', 'powershell-flag'],
    ['echo a | % { $_ }', 'powershell-pipeline-alias'],
    ['param($a, $b)', 'powershell-param-block'],
    ['Get-ChildItem', 'powershell-cmdlet'],
    ['cat f | Select-Object -First 3', 'powershell-cmdlet'],
    ['Write-Host hi', 'powershell-cmdlet'],
    ['del file.txt', 'cmd-builtin'],
    ['copy a.txt b.txt', 'cmd-builtin'],
    ['cls', 'cmd-builtin'],
    ['$x = 1', 'spaced-assignment'],
  ]
  for (const [command, id] of cases) {
    assert.equal(ruleOf(command), id, `${command} should be refused as ${id}`)
  }
})

test('a PowerShell line continuation (backtick) is refused', () => {
  assert.equal(ruleOf('echo one `\necho two'), 'powershell-backtick-continuation')
  assert.equal(ruleOf('echo one \\\necho two'), undefined)
})

test('valid Bash is never refused', () => {
  const allowed = [
    'ls -la',
    'if [ "$x" -eq 1 ]; then echo y; fi',
    'if [[ $a == $b ]]; then echo same; fi',
    'if (( x > 1 )); then echo big; fi',
    'arr=(1 2 3); echo "${arr[1]}"',
    'for f in *.md; do echo "$f"; done',
    'echo "$PATH" | tr ":" "\\n" | head -3',
    'grep -rn "cmd" src/',
    'git commit -m "fix: -Force handling"',
    'sed -n "s/foo/bar/p" file.txt',
    'printf "%s\\n" "$HOME"',
    'node -e "process.exit(3)"; echo $?',
    'cat f 2>&1 | tail -1',
    'declare -A map=([a]=1)',
    'x=1; echo $((x + 1))',
    'while read -r line; do echo "$line"; done < f.txt',
  ]
  for (const command of allowed) {
    assert.equal(findDialectIssue(command), undefined, `${command} must not be refused`)
  }
})

test('quoted data and heredoc bodies are not judged as code', () => {
  const allowed = [
    "echo 'Get-ChildItem $env:PATH'",
    'echo "$env:PATH is a PowerShell spelling"',
    'grep -rn "$null" .',
    "cat > write.ps1 <<'EOF'\nGet-ChildItem -Recurse $env:PATH\nEOF",
    'printf "%s\\n" "ls -Recurse"',
  ]
  for (const command of allowed) {
    assert.equal(findDialectIssue(command), undefined, `${command} must not be refused`)
  }
})

test('codeView blanks data but keeps offsets and code', () => {
  const command = 'echo "hidden" ; Get-ChildItem'
  const view = codeView(command)
  assert.equal(view.length, command.length)
  assert.doesNotMatch(view, /hidden/)
  assert.match(view, /Get-ChildItem/)
  // A blanked `#` comment keeps its newline so later offsets still line up.
  const commented = '# cmd /c dir\necho hi'
  assert.equal(codeView(commented).length, commented.length)
  assert.match(codeView(commented), /echo hi/)
})

test('the preflight refusal names the rule, the fix, and the escape hatch', () => {
  assert.throws(
    () => assertNiubashDialect('ls -Recurse'),
    (error) => /Niubash-only shell: refusing a powershell-flag/.test(error.message)
      && /ls -R/.test(error.message)
      && /dialectLint: false/.test(error.message),
  )
  assert.doesNotThrow(() => assertNiubashDialect('ls -R'))
  assert.doesNotThrow(() => assertNiubashDialect('ls -Recurse', { allow: [/^-Recurse$/].length === 0 ? [] : [/-/] }))
})

test('hints answer the failures a preflight cannot predict', () => {
  const missingAwk = 'bash: line 1: awk: command not found\n'
  const hint = dialectHint("awk '{print $1}' f.txt", missingAwk, { exitCode: 127 })
  assert.match(hint, /^Niubash hint \(missing-program\)/)
  assert.match(hint, /`awk` is not installed/)
  assert.match(hint, /cut/)

  const missingJq = 'bash: line 1: jq: command not found\n'
  assert.match(dialectHint('jq . f.json', missingJq, { exitCode: 127 }), /jq/)

  const unknown = 'bash: line 1: frobnicate: command not found\n'
  assert.match(dialectHint('frobnicate --now', unknown, { exitCode: 127 }), /command -v/)

  const option = "ls: invalid option -- 'e'\nTry 'ls --help' for more information.\n"
  const optionHint = dialectHint("ls -Recurse /d/code", option, { exitCode: 2 })
  assert.match(optionHint, /^Niubash hint \(invalid-option\)/)
  assert.match(optionHint, /--help/)

  const syntax = "bash: -c: line 1: syntax error near unexpected token `('\n"
  const syntaxHint = dialectHint('foreach ($i in 1..3) { echo $i }', syntax, { exitCode: 2 })
  assert.match(syntaxHint, /^Niubash hint \(powershell-syntax\)/)
  assert.match(syntaxHint, /for x in/)

  const nullRedirect = 'bash: line 1: : No such file or directory\n'
  assert.match(dialectHint('echo hi 2>$null', nullRedirect, { exitCode: 1 }), /^Niubash hint \(powershell-null-redirect\)/)

  const cdDrive = 'cd: C:\\Users\\me\\AppData\\Local\\Programs\\Niubash\\winuxcmd\\c: No such file or directory\n'
  const cdHint = dialectHint('cd /c', cdDrive, { exitCode: 1 })
  assert.match(cdHint, /^Niubash hint \(cd-drive-root\)/)
  assert.match(cdHint, /cd \/c\/Windows/)

  const procsub = 'bash: line 1: cat: <(echo inner): No such file or directory\n'
  assert.match(dialectHint('cat <(echo inner)', procsub, { exitCode: 1 }), /^Niubash hint \(process-substitution\)/)

  const eof = 'bash: -c: line 1: syntax error: unexpected EOF while looking for matching `)\'\n'
  assert.match(dialectHint('echo a `\necho b', eof, { exitCode: 2 }), /^Niubash hint \(unbalanced-quote\)/)

  const denied = "ls: cannot open directory '/root': Permission denied\n"
  assert.match(dialectHint("ls /root", denied, { exitCode: 2 }), /^Niubash hint \(permission-denied\)/)
})

test('a silent non-zero exit is explained instead of left bare', () => {
  const hint = dialectHint('grep -q needle file.txt', '', { exitCode: 1, stdout: '' })
  assert.match(hint, /^Niubash hint \(silent-exit\)/)
  assert.match(hint, /pipefail/)
  assert.equal(dialectHint('true', '', { exitCode: 0, stdout: '' }), undefined)
  assert.equal(dialectHint('echo hi', '', { exitCode: 1, stdout: 'hi\n' }), undefined)
})

test('an unrecognized failure gets no invented hint', () => {
  assert.equal(dialectHint('ls', 'some unexpected text\n', { exitCode: 9 }), undefined)
})

test('the rule and hint catalogues are exported for docs and drift checks', () => {
  assert.ok(DIALECT_RULE_IDS.includes('powershell-cmdlet'))
  assert.ok(DIALECT_RULE_IDS.includes('cmd-builtin'))
  assert.ok(DIALECT_HINT_IDS.includes('missing-program'))
  assert.ok(DIALECT_HINT_IDS.includes('silent-exit'))
})

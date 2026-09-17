/**
 * Dialect preflight and failure hints: the part of the Niubash-only contract
 * that answers *how the model actually gets it wrong*.
 *
 * The guard (`guard.js`) covers the escape hatch that would run another shell.
 * This module covers the next class of failures: a command that is valid
 * **PowerShell** (or CMD), is not a shell handoff, and therefore reaches
 * Niubash, where it dies — or, worse, silently does the wrong thing.
 *
 * Two mechanisms, both deterministic:
 *
 * 1. {@link assertNiubashDialect} — refuse before spawning, naming the habit
 *    and the Bash spelling. A refusal that teaches beats a confusing failure,
 *    and it costs nothing: the command was going to fail anyway. The one habit
 *    that is *not* a failure is `$env:NAME`, which Bash happily expands to the
 *    empty variable `$env` followed by the literal `:NAME` — a silent wrong
 *    answer, and the strongest reason this preflight exists.
 * 2. {@link dialectHint} — for the failures a preflight cannot know (a missing
 *    program, a flag from another dialect, a path that does not exist),
 *    append one actionable line to the captured stderr.
 *
 * Both are conservative by construction: strings, comments, and heredoc bodies
 * are blanked before matching, and statement-level rules only look at the
 * program token of a statement (`|` starts a new statement, so pipeline
 * cmdlets are seen too).
 *
 * Every error signature and every "this is not installed here" fact below was
 * observed on a real Niubash 1.1.4 install (WinuxCmd 1.0.8) while building this
 * plugin; `test/dialect.test.mjs` pins them.
 *
 * @module dsh-niubash-only/dialect
 */

import { blankHeredocBodies, splitStatements, tokenize } from './guard.js'

/**
 * Blank out strings, comments, and heredoc bodies, preserving length and
 * newlines so a match offset still points at the original command.
 *
 * Note what is *not* blanked: backticks. In Bash a backtick is command
 * substitution — the text inside it runs — so PowerShell habits hidden inside
 * one are still judged. Single quotes are literal, double quotes still execute
 * `$( … )`, and a `#` only starts a comment at the start of a word.
 * @param command - the Bash source.
 * @returns a same-length view with data regions replaced by spaces.
 */
export function codeView(command) {
  if (typeof command !== 'string') return ''
  const chars = blankHeredocBodies(command).split('')
  const blank = (from, to) => {
    for (let index = from; index < to && index < chars.length; index++) {
      if (chars[index] !== '\n') chars[index] = ' '
    }
  }
  let index = 0
  while (index < chars.length) {
    const char = chars[index]
    if (char === "'" || char === '"') {
      // Single quotes are fully literal; inside double quotes only `\` escapes,
      // but the whole run is data either way, so it is blanked whole.
      let cursor = index + 1
      while (cursor < chars.length) {
        if (chars[cursor] === '\\' && char === '"') {
          cursor += 2
          continue
        }
        if (chars[cursor] === char) break
        cursor++
      }
      const stop = Math.min(cursor + 1, chars.length)
      blank(index, stop)
      index = stop
      continue
    }
    if (char === '#' && (index === 0 || /[\s;&|(]/.test(chars[index - 1] ?? ' '))) {
      let cursor = index
      while (cursor < chars.length && chars[cursor] !== '\n') cursor++
      blank(index, cursor)
      index = cursor
      continue
    }
    index++
  }
  return chars.join('')
}

/**
 * One preflight rule. `find` receives the code view and returns the offending
 * fragment, or undefined when this habit is absent.
 */
const RULES = [
  {
    id: 'powershell-env',
    detail: '`$env:NAME` is PowerShell. Bash does not fail on it — it expands the (empty) variable `$env` and then prints the literal `:NAME`, so the mistake is silent. Write `$NAME` (or `export NAME=value` for a child process).',
    find: (view) => matchFragment(view, /\$\{?env:[A-Za-z_]/),
  },
  {
    id: 'powershell-null-redirect',
    detail: '`>$null` / `2>$null` is PowerShell. Bash discards output with the null device: `cmd >/dev/null` or `cmd 2>/dev/null` (`nul` also works on Windows).',
    find: (view) => matchFragment(view, /(?:^|[\s;&|(])[12]?>>?\s*\$null\b/),
  },
  {
    id: 'powershell-automatic-variable',
    detail: '`$null`, `$true`, `$false`, `$PSItem`, `$PSScriptRoot`, and `$LASTEXITCODE` are PowerShell automatic variables. In Bash: discard with `/dev/null`, use the builtins `true` / `false`, refer to the exit status as `$?`, and to the script directory as `$(dirname "$0")`.',
    find: (view) => matchFragment(view, /\$(?:PSItem|PSScriptRoot|PSCmdlet|MyInvocation|LASTEXITCODE|ErrorActionPreference|null|true|false)\b/),
  },
  {
    id: 'powershell-backtick-continuation',
    detail: 'PowerShell continues a line with a backtick. In Bash the continuation character is `\\` (and a backtick starts command substitution instead, which is why this fails as an unterminated string).',
    find: (view, command) => {
      const match = /(?:^|\s)`[ \t]*\r?\n/.exec(command)
      if (match === null) return undefined
      return { offset: match.index, fragment: match[0].trim() }
    },
  },
  {
    id: 'powershell-operator',
    detail: 'PowerShell operators (`-not`, `-and`, `-or`, `-like`, `-match`, `-contains`, `-replace`) are not Bash. Bash negates with `!`, chains with `&&` / `||`, matches with `case` or `[[ $s =~ re ]]`, and replaces with `${s/old/new}` or `sed`.',
    find: (view) => matchFragment(view, /(?:^|[\s(])(?:-not|-and|-or|-like|-notlike|-match|-notmatch|-contains|-notcontains|-replace|-is|-as)\b/),
  },
  {
    id: 'powershell-array-literal',
    detail: '`@( … )` is a PowerShell array and `@{ … }` a PowerShell hashtable. A Bash array is `name=(a b c)` and an associative array is `declare -A name=([k]=v)`.',
    find: (view) => matchFragment(view, /(?:^|[\s(,=])@[({]/),
  },
  {
    id: 'powershell-foreach',
    detail: '`foreach ($x in $xs) { … }` is PowerShell. In Bash: `for x in "${xs[@]}"; do …; done` (over files: `for f in *.txt; do …; done`).',
    find: (view) => matchFragment(view, /\bforeach\s*\(/),
  },
  {
    id: 'powershell-conditional-syntax',
    detail: 'PowerShell wraps conditions in parentheses with `$`-variables (`if ($x -eq 1) { … }`). Bash uses `if [ "$x" -eq 1 ]; then …; fi` (or `[[ … ]]`), and `$x` needs no parentheses.',
    find: (view) => matchFragment(view, /\b(?:if|while|elseif|for)\s*\(\s*\$|\belseif\b|\belse\s*if\s*\(/),
  },
  {
    id: 'powershell-flag',
    detail: 'PowerShell named parameters (`-Recurse`, `-Force`, `-ErrorAction`, `-Filter`, `-LiteralPath`) are not options for the Unix tools Niubash ships. Those take short flags (`ls -R`, `rm -f`, `grep -r`); because a single dash is read letter by letter, `ls -Recurse` fails with `invalid option -- \'e\'`. Run `<command> --help` for the real flags.',
    find: (view) => matchFragment(view, /(?:^|\s)-(?:Recurse|Force|LiteralPath|ErrorAction|Filter|Confirm|WhatIf|SilentlyContinue|NoProfile|OutVariable|OutFile|Encoding|Path|Name)\b/),
  },
  {
    id: 'powershell-pipeline-alias',
    detail: '`| % { … }` and `| ? { … }` are PowerShell aliases for ForEach-Object / Where-Object. In Bash use `| while read -r line; do … done`, `| grep`, `| xargs`, or `| sed`.',
    find: (view) => matchFragment(view, /\|\s*[%?]\s*\{/),
  },
  {
    id: 'powershell-param-block',
    detail: 'A `param( … )` block is PowerShell. Bash reads positional parameters as `$1`, `$2`, `$@`, and named flags with `while [ $# -gt 0 ]; do case "$1" in … esac; shift; done` (or `getopts`).',
    find: (view) => matchFragment(view, /(?:^|\n)\s*param\s*\(/),
  },
]

/** PowerShell cmdlets that are never a program on this PATH, with their Unix equivalents. */
const POWERSHELL_CMDLETS = new Map([
  ['get-childitem', '`ls` (`ls -R` to recurse, `find . -name \'*.md\'` to search by name)'],
  ['get-content', '`cat <path>` (`head -20`, `tail -20`, `wc -l`)'],
  ['set-content', '`printf \'%s\\n\' "value" > <path>`'],
  ['add-content', '`"value" >> <path>`'],
  ['out-file', '`> <path>` (or `>>` to append)'],
  ['out-string', '`cat` (or `$( … )` to capture)'],
  ['out-null', '`>/dev/null`'],
  ['get-item', '`ls -l <path>` or `[ -e <path> ]`'],
  ['test-path', '`[ -e <path> ]`, `[ -d <dir> ]`, `[ -f <file> ]`'],
  ['join-path', '`"$a/$b"` (or `realpath -m "$a/$b"`)'],
  ['split-path', '`dirname <path>` / `basename <path>`'],
  ['resolve-path', '`realpath <path>`'],
  ['select-object', '`head -n 20` / `tail -n 20` / `cut -d, -f1,3`'],
  ['where-object', '`grep` (or `while read -r line; do … done` for real logic)'],
  ['foreach-object', '`for x in …; do …; done`, `while read -r line; do … done`, or `xargs`'],
  ['sort-object', '`sort` (`sort -u`, `sort -k2 -n`)'],
  ['group-object', '`sort | uniq -c`'],
  ['measure-object', '`wc -l`, `wc -c`'],
  ['select-string', '`grep -n <pattern> <file>` (recursive: `grep -rn`)'],
  ['write-output', '`echo`'],
  ['write-host', '`echo`'],
  ['remove-item', '`rm <path>`, `rm -r <dir>`, `rm -f <path>`'],
  ['copy-item', '`cp -r <src> <dst>`'],
  ['move-item', '`mv <src> <dst>`'],
  ['new-item', '`touch <file>` or `mkdir -p <dir>`'],
  ['get-command', '`command -v <name>` (or `which <name>`, `type <name>`)'],
  ['get-process', '`ps`'],
  ['stop-process', '`taskkill //PID <pid> //F` (or `kill <pid>` inside Niubash)'],
  ['start-process', 'run the program directly (`cmd arg &` to background it)'],
  ['start-sleep', '`sleep <seconds>` (`sleep 0.5` works)'],
  ['invoke-webrequest', '`curl -sSL <url> -o <file>`'],
  ['invoke-restmethod', '`curl -sS <url>`'],
  ['convertto-json', '`python -c \'import json,sys; print(json.dumps(json.load(sys.stdin)))\'` (there is no `jq` here)'],
  ['convertfrom-json', '`python -c \'import json,sys; print(json.load(sys.stdin)["key"])\'` (no `jq`)'],
  ['convertto-csv', '`awk`-free: `sed`/`cut`, or `python -c` with the `csv` module'],
  ['convertfrom-csv', '`cut -d, -f1`, or `python -c` with the `csv` module'],
  ['get-filehash', '`sha256sum <file>` / `md5sum <file>`'],
  ['get-date', '`date +%Y-%m-%d`'],
  ['get-location', '`pwd`'],
  ['set-location', '`cd`'],
  ['get-help', '`<command> --help` (or `man`-less: `--help` / `-h`)'],
  ['get-member', '`ls -l`, `file`, or the program\'s `--help`'],
  ['new-object', 'no equivalent: use `python`, `node`, `cargo`, or the Git/dotnet CLI instead'],
  ['clear-host', '`clear`'],
  ['set-variable', '`x=value` / `local x=value` / `export x=value`'],
  ['get-variable', '`echo "$x"` / `declare -p x`'],
  ['set-itemproperty', 'no equivalent: edit the file with `sed -i` or the fs tools'],
  ['get-itemproperty', '`grep` the file, or parse it with `python -c`'],
  ['start-job', '`cmd &` (background) plus `wait`; long work belongs in the harness\'s own background jobs'],
  ['wait-job', '`wait`'],
  ['receive-job', 'read the background job\'s output in the harness instead'],
  ['export-csv', 'redirect the text yourself: `… > out.csv`'],
  ['import-csv', '`cut -d, -f1`, or `python -c` with the `csv` module'],
  ['tee-object', '`tee`'],
  ['find-module', 'no PowerShell gallery here: use `cargo`, `npm`, `pip`, or `git`'],
  ['install-module', 'no PowerShell gallery here: use `cargo`, `npm`, `pip`, or `git`'],
])

/** CMD built-ins that are not programs on this PATH, with their Bash equivalents. */
const CMD_BUILTINS = new Map([
  ['del', '`rm <file>`'],
  ['erase', '`rm <file>`'],
  ['copy', '`cp <src> <dst>`'],
  ['move', '`mv <src> <dst>`'],
  ['ren', '`mv <old> <new>`'],
  ['rename', '`mv <old> <new>`'],
  ['cls', '`clear`'],
  ['mklink', '`ln -s <target> <link>`'],
  ['start', 'run the program directly; background it with `&`'],
])

/**
 * Programs this deployment is known to lack, with a working alternative. This
 * is a *hint* table, never a refusal: another WinuxCmd build may ship them, and
 * a command that names an absent program already fails loudly on its own.
 */
const MISSING_TOOLS = new Map([
  ['awk', '`cut -d, -f1`, `sed -n \'s/…/…/p\'`, or `python -c` for anything field-aware'],
  ['gawk', '`cut` / `sed` / `python -c`'],
  ['mawk', '`cut` / `sed` / `python -c`'],
  ['nawk', '`cut` / `sed` / `python -c`'],
  ['jq', '`python -c \'import json,sys; print(json.load(sys.stdin)["key"])\'` or the same one-liner with `node -e`'],
  ['yq', '`python -c` with the `yaml` module, or `node -e`'],
  ['rg', '`grep -rn --include=\'*.rs\' <pattern> <dir>`'],
  ['perl', '`sed` / `python -c`'],
  ['make', 'the project\'s own build entry point (`gradlew.bat`, `cargo`, `npm run`)'],
  ['cmake', 'the project\'s own build entry point'],
  ['gcc', '`cargo` / `dotnet` / the project\'s toolchain'],
  ['g++', '`cargo` / `dotnet` / the project\'s toolchain'],
  ['cc', '`cargo` / `dotnet` / the project\'s toolchain'],
  ['clang', '`cargo` / `dotnet` / the project\'s toolchain'],
  ['zip', '`tar -cf <name>.tar <paths>` (or `python -c "import shutil; shutil.make_archive(...)"`)'],
  ['unzip', '`tar -xf <archive>.zip` (bsdtar reads zip)'],
  ['7z', '`tar -xf <archive>.zip`'],
  ['bc', '`python -c \'print(1/3)\'` or `$(( ))` for integer arithmetic'],
  ['vim', 'edit files with the file tools instead of the shell'],
  ['nano', 'edit files with the file tools instead of the shell'],
  ['wget', '`curl -sSL <url> -o <file>`'],
  ['iconv', '`python -c` with `codecs`, or `sed` for line-ending fixes'],
  ['ffmpeg', 'not available in this deployment'],
  ['java', 'not on PATH here: use the project\'s JDK (`D:\\MC\\jdk\\…`) via an absolute path or `JAVA_HOME`'],
  ['gradle', 'use the project wrapper `./gradlew.bat` with `JAVA_HOME` set'],
  ['mvn', 'not available in this deployment'],
])

/** Every cmdlet name this module refuses, for docs and tests. */
const CMDLET_NAMES = new Set([...POWERSHELL_CMDLETS.keys()])

/** Read-only names Bash owns; rebinding them is a different error. */
const BASH_RESERVED = new Set(['?', '#', '$', '!', '-', '_', '@', '*'])

/** Locate a regex match and return it as a rule finding. */
function matchFragment(view, pattern) {
  const match = pattern.exec(view)
  if (match === null) return undefined
  return { offset: match.index, fragment: match[0].trim() }
}

/**
 * Find a statement whose program token is a PowerShell cmdlet or a CMD
 * built-in. `|` splits statements too, so `… | Select-Object -First 3` is seen.
 * @param command - the Bash source.
 * @returns the finding, or undefined.
 */
function findForeignProgram(command) {
  let cursor = 0
  for (const statement of splitStatements(command)) {
    const start = command.indexOf(statement, cursor)
    cursor = start === -1 ? cursor : start + statement.length
    const trimmed = statement.trim()
    if (trimmed.length === 0) continue
    const tokens = tokenize(statement)
    const first = tokens[0]
    if (first === undefined) continue
    if (first.startsWith('\\')) continue // an explicitly escaped program name is deliberate
    const base = first.split(/[\\/]/).pop() ?? first
    const name = base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
    const cmdlet = POWERSHELL_CMDLETS.get(name)
    if (cmdlet !== undefined) {
      return {
        id: 'powershell-cmdlet',
        offset: Math.max(start, 0),
        fragment: first,
        detail: `\`${first}\` is a PowerShell cmdlet, not a program on this PATH. In Bash: ${cmdlet}.`,
      }
    }
    const builtin = CMD_BUILTINS.get(name)
    if (builtin !== undefined) {
      return {
        id: 'cmd-builtin',
        offset: Math.max(start, 0),
        fragment: first,
        detail: `\`${first}\` is a CMD built-in, not a program on this PATH. In Bash: ${builtin}.`,
      }
    }
  }
  return undefined
}

/**
 * A `$name = value` assignment: PowerShell's spelling, which in Bash expands
 * the variable first and then tries to run `= value` as a command. `==`, `<=`,
 * and `>=` are excluded so `[[ $a == $b ]]` stays clean.
 */
function findSpacedAssignment(view) {
  const match = /\$([A-Za-z_][A-Za-z0-9_]*)[ \t]+=(?!=)/.exec(view)
  if (match === null) return undefined
  const name = match[1]
  if (BASH_RESERVED.has(name)) return undefined
  return {
    id: 'spaced-assignment',
    offset: match.index,
    fragment: match[0].trim(),
    detail: `\`$ ${name} = …\` is PowerShell (and with the \`$\` it expands the variable before Bash ever sees an assignment). In Bash an assignment has no spaces: \`${name}=value\`, \`local ${name}=value\`, or \`export ${name}=value\`.`,
  }
}

/**
 * Find the first dialect habit in a command.
 * @param command - the Bash source about to run.
 * @returns the finding (id, offset, fragment, detail), or undefined when clean.
 */
export function findDialectIssue(command) {
  if (typeof command !== 'string' || command.trim().length === 0) return undefined
  const view = codeView(command)
  const findings = []
  for (const rule of RULES) {
    const match = rule.find(view, command)
    if (match === undefined) continue
    findings.push({ id: rule.id, detail: rule.detail, offset: match.offset, fragment: match.fragment })
  }
  const assignment = findSpacedAssignment(view)
  if (assignment !== undefined) findings.push(assignment)
  const foreign = findForeignProgram(view)
  if (foreign !== undefined) findings.push(foreign)
  if (findings.length === 0) return undefined
  findings.sort((a, b) => a.offset - b.offset)
  return findings[0]
}

/**
 * The model-facing refusal: names the habit, states the rule, shows the Bash
 * spelling, and repeats the escape hatches.
 * @param issue - a finding from {@link findDialectIssue}.
 * @returns the error message.
 */
export function dialectMessage(issue) {
  return [
    `Niubash-only shell: refusing a ${issue.id} command — PowerShell and CMD syntax is not translated`,
    '',
    'Every shell command in this deployment runs through Niubash (`niu -c "<command>"`), which speaks Bash on Windows. Niubash does not fail on every foreign habit: some of them (like `$env:NAME`) silently produce the wrong text, so they are refused before anything runs.',
    issue.detail,
    `Offending fragment: ${JSON.stringify(issue.fragment.slice(0, 200))}`,
    '',
    'If the fragment is data rather than syntax — a string, a JSON payload, a script you are writing into a file — quote it (single quotes keep `$` literal) or put it in a heredoc; heredoc bodies are not checked. Relax this check with executor config `dialectLint: false`.',
  ].join('\n')
}

/**
 * Throw unless the command is Bash this deployment will accept, or exempt by
 * the whole-command allowlist.
 * @param command - the Bash source about to run.
 * @param options - optional compiled allowlist patterns.
 * @throws Error describing the refusal when a dialect habit is found.
 */
export function assertNiubashDialect(command, options = {}) {
  const allow = options.allow ?? []
  if (allow.length > 0 && allow.some((pattern) => pattern.test(command))) return
  const issue = findDialectIssue(command)
  if (issue !== undefined) throw new Error(dialectMessage(issue))
}

/** The program token of every statement that runs something, in command order. */
function programNames(command) {
  const names = []
  for (const statement of splitStatements(command)) {
    const tokens = tokenize(statement)
    const first = tokens[0]
    if (first === undefined) continue
    if (first.startsWith('\\')) continue
    const base = first.split(/[\\/]/).pop() ?? first
    const name = base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) names.push({ name, raw: first })
  }
  return names
}

/**
 * The post-failure hints, keyed by what Niubash (rubash) actually printed.
 * Order matters: the first matching signature wins, so the specific ones come
 * first.
 */
const HINTS = [
  {
    id: 'missing-program',
    match: /command not found/,
    text: 'That program is not on this PATH.',
  },
  {
    id: 'powershell-null-redirect',
    match: /^\s*(?:bash: line \d+:)?\s*:\s*No such file or directory\s*$/m,
    text: 'A redirect target expanded to nothing — `>$null` / `2>$null` is PowerShell, and Bash reads `$null` as an empty variable. Discard output with `>/dev/null` or `2>/dev/null` (`nul` works on Windows too).',
  },
  {
    id: 'invalid-option',
    match: /invalid option --|unrecognized option|Try '\S+ --help'/,
    text: 'The Unix tools Niubash ships take short flags (`ls -R`, `rm -f`, `grep -rn`), not PowerShell named parameters: a single dash is read letter by letter, so `ls -Recurse` becomes `-R -e -c …`. Run `<command> --help` for the real flags.',
  },
  {
    id: 'unbalanced-quote',
    match: /unexpected EOF while looking for matching|unexpected end of file/,
    text: 'An unbalanced quote or backtick. PowerShell continues lines with a backtick — Bash uses `\\` — and a heredoc (`cat > f <<\'EOF\' … EOF`) is the reliable way to pass multi-line text.',
  },
  {
    id: 'powershell-syntax',
    match: /syntax error near unexpected token|syntax error: unexpected/,
    text: 'That is PowerShell/CMD shape, not Bash. Conditions are `if [ "$x" -eq 1 ]; then …; fi`, loops are `for x in "${xs[@]}"; do …; done`, arrays are `xs=(a b c)`, and there is no `@( … )` or `param( … )`.',
  },
  {
    id: 'cd-drive-root',
    match: /cd: .*[\\/][A-Za-z]: No such file or directory/,
    text: 'A single-letter drive mount was resolved as a folder under Niubash\'s own Unix root rather than as `C:/`. `cd /c` lands on `C:/` only at the top level of a command line — inside a `( … )` subshell it fails like this. Write `cd /c/Windows`, `cd C:/`, or `cd C:/Windows` instead.',
  },
  {
    id: 'process-substitution',
    match: /(?:cat|head|tail|grep|sed|wc|sort|uniq): [<>]\(/,
    text: 'Process substitution (`<(...)`) is only partially supported by this Niubash build: it works in some argument positions and not others. Write to a temp file instead — `tmp=$(mktemp); cmd > "$tmp"; cat "$tmp"; rm -f "$tmp"`.',
  },
  {
    id: 'path-not-found',
    match: /No such file or directory/,
    text: 'That path does not exist (or is spelled with the wrong separators). Check it first: `[ -e "$p" ] && echo yes`, `ls -l "$p"`. Niubash accepts `C:\\dir\\file`, `C:/dir/file`, and `/c/dir/file` — but `cd /c` alone is not a drive root, and native programs need the drive letter (`node C:/x/y.js`).',
  },
  {
    id: 'permission-denied',
    match: /Permission denied/,
    text: 'Permission denied. In a sandboxed session this is usually the harness sandbox, not the command: the tool reports `[sandbox: file access denied under <mode> mode]` for a policy denial. Otherwise check whether the file is in use or read-only.',
  },
]

/**
 * One actionable line for a failed command, chosen by what the shell printed.
 * @param command - the command that ran.
 * @param stderr - the captured stderr text.
 * @param options - settled-process facts: `exitCode` and `stdout`.
 * @returns the hint text, or undefined when nothing is known about this failure.
 */
export function dialectHint(command, stderr, options = {}) {
  if (typeof stderr !== 'string') return undefined
  const text = stderr.replace(/\r\n/g, '\n')
  if (text.trim().length > 0) {
    for (const hint of HINTS) {
      if (!hint.match.test(text)) continue
      let detail = hint.text
      if (hint.id === 'missing-program') {
        detail = missingProgramHint(command) ?? `${detail} Check the name with \`command -v <name>\`; the Unix tools that do ship with Niubash are \`ls cat grep sed find head tail wc sort uniq tr cut xargs tee diff patch du df ps less which env printf sleep seq mktemp od stat realpath sha256sum tar curl\`.`
      }
      const preflight = findDialectIssue(command)
      const extra = preflight === undefined || preflight.id === hint.id
        ? ''
        : ` (the preflight also flags this command as ${preflight.id})`
      return `Niubash hint (${hint.id}): ${detail}${extra}`
    }
    return undefined
  }
  // No stderr at all but a non-zero status: worth explaining, because Bash
  // reports a failing command's status without printing anything.
  const exitCode = options.exitCode
  const stdout = options.stdout ?? ''
  if (text.trim().length === 0 && stdout.trim().length === 0 && typeof exitCode === 'number' && exitCode !== 0) {
    return 'Niubash hint (silent-exit): the command produced no output and exited non-zero — a plain `grep` with no match, `[ … ]` that was false, or a program that failed quietly. Inspect the status explicitly (`grep … || echo "no match"`, `if [ … ]; then …; fi`) and remember `set -o pipefail` is available when a pipeline\'s status matters.'
  }
  return undefined
}

/**
 * The concrete replacement for a program this deployment does not have, read
 * from the failing command's own text. Known-missing programs win over the
 * first statement, because `cd x && awk …` fails on `awk`, not on `cd`.
 * @param command - the command that failed.
 * @returns the hint sentence, or undefined when no name is recognized.
 */
function missingProgramHint(command) {
  if (typeof command !== 'string') return undefined
  const programs = programNames(command)
  for (const program of programs) {
    const replacement = MISSING_TOOLS.get(program.name)
    if (replacement !== undefined) {
      return `\`${program.name}\` is not installed in this Niubash deployment. Use ${replacement} instead.`
    }
  }
  for (const program of programs) {
    const cmdlet = POWERSHELL_CMDLETS.get(program.name)
    if (cmdlet !== undefined) return `\`${program.raw}\` is a PowerShell cmdlet, not a program. In Bash: ${cmdlet}.`
    const builtin = CMD_BUILTINS.get(program.name)
    if (builtin !== undefined) return `\`${program.raw}\` is a CMD built-in, not a program. In Bash: ${builtin}.`
  }
  return undefined
}

/** Every preflight rule id this module can refuse, for docs and tests. */
export const DIALECT_RULE_IDS = [
  ...RULES.map((rule) => rule.id),
  'spaced-assignment',
  'powershell-cmdlet',
  'cmd-builtin',
]

/** Every hint id this module can emit, for docs and tests. */
export const DIALECT_HINT_IDS = [...HINTS.map((hint) => hint.id), 'silent-exit']

/** The cmdlets and CMD built-ins the preflight refuses, for docs and tests. */
export const FOREIGN_PROGRAM_NAMES = { powershell: [...CMDLET_NAMES], cmd: [...CMD_BUILTINS.keys()] }

/** The programs this deployment is known to lack, for docs and tests. */
export const MISSING_PROGRAM_NAMES = [...MISSING_TOOLS.keys()]

/**
 * The teaching layer's text: the mandatory shell rules, the "Bash on Windows"
 * guide, and the Niubash-dialect shell-tool description.
 *
 * Every ```bash block in {@link buildGuide} is executed by
 * `test/guide.test.mjs` against the Niubash installed on the machine, so the
 * guide teaches commands that are known to run rather than commands that merely
 * look right. The "present / absent" tool inventory, the path rules, and the
 * failure catalogue come from probing a real Niubash 1.1.4 (WinuxCmd 1.0.8)
 * install; `test/dialect.test.mjs` pins the error strings.
 *
 * @module dsh-niubash-only/guide
 */

/** Fence language of the runnable examples inside the guide. */
export const GUIDE_FENCE = 'bash'

/**
 * The short, high-salience rules section. Prompt sections are prepended to every
 * request, so this states only what changes behavior.
 * @param options - rules options.
 * @param options.sandbox - whether `ctx.sandbox` confines commands (`false` = they run directly on the host).
 * @returns the rules text.
 */
export function buildShellRules(options = {}) {
  const sandboxed = options.sandbox === true
  return [
    '## Shell: Niubash only (Bash on Windows)',
    '',
    'Every shell command in this deployment runs through **Niubash** (`niu -c "<command>"`) — a native Windows shell whose language engine is Bash (GNU Bash 5.3 semantics, the `rubash` engine) with the Unix tools (`ls`, `grep`, `sed`, `find`, …) supplied by WinuxCmd. Write Bash. PowerShell and CMD are not available and are not translated.',
    '',
    '- Each call runs in a **fresh, non-interactive process**. `cd`, variables, functions, `export`, and aliases do NOT persist between calls — pass the tool\'s `workdir` parameter instead of using `cd`. `~/.niubashrc` and its plugins are not loaded, so a shell alias the user defined interactively does not exist here.',
    '- Handing a command to another shell (`powershell`, `pwsh`, `cmd /c`, `wsl`, `nu -c`, or a Git Bash/WSL `bash`) is refused: Niubash is the only shell. `bash` and `sh` are allowed only because Niubash ships them as its own shims for the same engine.',
    '- PowerShell/CMD habits are refused **before** anything runs, with the Bash spelling in the error. The worst of them is silent otherwise: `$env:NAME` does not fail in Bash — it expands an empty variable and prints `:NAME`. Write `$NAME`.',
    sandboxed
      ? '- Commands run under the harness file sandbox: a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a command bug.'
      : '- Commands run **directly on the host** with the harness process\'s own permissions: no file sandbox wraps them, `[sandbox: …]` markers never appear, and `sandbox_permissions` has no effect. A command can reach anything the harness can reach.',
    '- Exit codes are preserved exactly, and an unknown program exits `127`. Niubash prints no banner and no startup noise, so stdout/stderr are exactly the command\'s.',
    '- The Unix tools are real WinuxCmd binaries; the ones an agent reaches for most (`ls cat grep sed find head tail wc sort uniq tr cut xargs tee diff patch du df ps less which env printf sleep seq mktemp od stat realpath sha256sum tar curl`) are present. `awk`, `jq`, `rg`, `perl`, `make`, `gcc`, `zip`/`unzip`, `bc`, `vim` are NOT — use `python`, `node`, `cargo`, `tar`, or `sed`/`cut` instead. Check any name with `command -v <name>`.',
    '- Paths: `/c/…`, `C:/…`, and `C:\\…` all work, and arguments are converted to native Windows paths when a native program (`git`, `node`, `python`) receives them. A bare one-letter mount is the one unreliable spelling (`cd /c` works at the top level of a command line but fails inside a `( … )` subshell), so write `cd /c/Windows`, `cd C:/`, or `cd C:/Windows`; `cd /` goes to Niubash\'s own Unix root.',
    '- Failure text is augmented: a failed call appends a `Niubash hint (…)` line naming the concrete fix (missing program and its replacement, a PowerShell flag, a wrong path). Read it before retrying.',
    '- Single-quoted strings and heredoc bodies are never judged as code, so writing a script into a file (`cat > run.sh <<\'EOF\' … EOF`) is safe. The `shell: niubash-guide` section below has the syntax, the translation tables, and the traps.',
  ].join('\n')
}

function overviewSection() {
  return [
    '### What this shell is',
    '',
    '```bash',
    'echo "$BASH_VERSION"        # 5.3.0(1)-release — this is the Bash dialect the engine implements',
    'echo "$SHELL"               # …\\Niubash\\niu.exe',
    'uname -a                    # MSWindows_NT … 10.0 19045 x86_64 (no WSL, no MSYS emulation)',
    'command -v ls grep          # the WinuxCmd binaries that supply the Unix tools',
    '```',
    '',
    'There is no `/mnt/c`, no MSYS path rewriting, and no Linux kernel: `niu.exe` is a normal Windows process that parses Bash itself and finds `ls`, `grep`, `sed` as ordinary executables on `PATH`. Windows programs (`git.exe`, `node.exe`, `python.exe`, `cargo.exe`) are called exactly as you would call them in Bash anywhere else.',
  ].join('\n')
}

function languageSection() {
  return [
    '### Language essentials',
    '',
    '```bash',
    'name="dsh"; count=2',
    'echo "$name count=$count sum=$((count + 3))"',
    'if [ "$count" -eq 2 ]; then echo "if-ok"; fi',
    'for item in one two; do echo "loop:$item"; done',
    'case "$name" in dsh) echo "case-ok";; esac',
    'items=(alpha beta); echo "array=${items[1]} n=${#items[@]}"',
    'captured=$(printf \'x\\ny\\n\' | wc -l); echo "captured=$captured"',
    'upper=${name^^}; echo "upper=$upper"',
    '```',
    '',
    'GNU Bash semantics hold: `$( … )` command substitution, arithmetic `$(( … ))`, arrays, `case`, functions, `[[ … ]]` with `=~`, `${var^^}` / `${var/old/new}`, `set -euo pipefail`, `trap`, `mapfile`, here-strings (`<<<`), and heredocs. Bash-only escapes and quoting rules are the Bash ones — there is no extra layer that rewrites arguments.',
  ].join('\n')
}

function toolsSection() {
  return [
    '### The Unix tools that ship, and what to use instead of the rest',
    '',
    '```bash',
    'tmp=$(mktemp -d)',
    'printf \'beta\\nalpha\\nbeta\\n\' > "$tmp/f.txt"',
    'sort -u "$tmp/f.txt" | tr \'\\n\' \' \'; echo',
    'grep -n alpha "$tmp/f.txt"',
    'sed -n \'1p\' "$tmp/f.txt"',
    'cut -c1 "$tmp/f.txt" | sort -u | tr -d \'\\n\'; echo',
    'wc -l < "$tmp/f.txt"; head -1 "$tmp/f.txt"; tail -1 "$tmp/f.txt"',
    'find "$tmp" -name \'*.txt\' -type f',
    'rm -rf "$tmp"',
    '```',
    '',
    '| available (WinuxCmd) | use it for |',
    '|---|---|',
    '| `ls` `cat` `head` `tail` `wc` `stat` `realpath` `basename` `dirname` `od` | listing and reading files |',
    '| `grep` `sed` `sort` `uniq` `tr` `cut` `comm` `join` | text pipeline work |',
    '| `find` `xargs` `tee` `diff` `patch` `mktemp` | file sets, patching, temporary files |',
    '| `du` `df` `ps` | disk and process inspection |',
    '| `sha256sum` `md5sum` `base64` `seq` `yes` `env` `printf` `sleep` `touch` `rm` `cp` `mv` `ln` `chmod` | everyday shell work |',
    '| `tar` (bsdtar), `curl`, `less`, `which`, `tree`, `more`, `dir` | archives, HTTP, paging |',
    '| Windows tools already on `PATH`: `git` `node` `python` `pip` `cargo` `dotnet` `where` `findstr` `tasklist` `taskkill` `attrib` `xcopy` | real Windows programs, called normally |',
    '',
    '| not installed | use instead |',
    '|---|---|',
    '| `awk` | `cut -d, -f1`, `sed -n \'s/…/…/p\'`, or `python -c` for field-aware work |',
    '| `jq` / `yq` | `python -c \'import json,sys; print(json.load(sys.stdin)["k"])\'` (or the same idea with `node -e`) |',
    '| `rg` | `grep -rn --include=\'*.md\' <pattern> <dir>` |',
    '| `perl` | `sed`, `python -c` |',
    '| `make` / `cmake` / `gcc` / `clang` | the project\'s own build entry point (`gradlew.bat`, `cargo`, `npm run`) |',
    '| `zip` / `unzip` / `7z` | `tar -cf out.tar <paths>`; `tar -xf archive.zip` extracts zips |',
    '| `bc` | `python -c \'print(1/3)\'`, or `$(( ))` for integers |',
    '| `vim` / `nano` | edit files with the harness file tools, not the shell |',
    '| `wget` | `curl -sSL <url> -o <file>` |',
    '| `java` / `gradle` / `mvn` | not on `PATH`; use the project wrapper (`./gradlew.bat`) with `JAVA_HOME` set to the project\'s JDK |',
    '',
    'JSON without `jq`, on one line:',
    '',
    '```bash',
    'printf \'{"name":"niu","ok":true}\\n\' | python -c \'import json,sys; print(json.load(sys.stdin)["name"])\'',
    'printf \'{"name":"niu","ok":true}\\n\' | node -e \'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).name))\'',
    '```',
  ].join('\n')
}

function pathSection() {
  return [
    '### Paths: three spellings, one filesystem',
    '',
    '```bash',
    'echo "HOME=$HOME"                        # C:/Users/you (forward slashes)',
    '[ -f /c/Windows/win.ini ] && echo "drive-mount ok"',
    '[ -f "C:\\Windows\\win.ini" ] && echo "native ok"',
    'cat /c/Windows/win.ini | head -1',
    'cd /c/Windows && pwd                     # C:/Windows',
    'ls "/c/Program Files" >/dev/null && echo "quoted space ok"',
    '```',
    '',
    '- `/c/…`, `/d/…` are drive mounts, `C:/…` and `C:\\…` are native, and all three address the same file. Directory names with spaces need quoting either way.',
    '- Arguments are converted for native programs: `node /c/x/y.js` passes `C:\\x\\y.js`, so a Windows program never sees a Unix-style path it would reject.',
    '- A bare drive letter is the one spelling that depends on context: `cd /c && pwd` prints `C:/` at the top level of a command line, but `(cd /c && pwd)` fails with `No such file or directory` because the mount is then resolved under Niubash\'s Unix root. Use `cd /c/Windows`, `cd C:/`, or `cd C:/Windows`.',
    '- `cd /` and absolute paths like `/tmp`, `/bin`, `/usr` refer to **Niubash\'s own Unix root** (the WinuxCmd tree inside the install), not to `C:\\`. `mktemp` and `/dev/null` behave as expected there; a scratch file you want to keep belongs somewhere under `$HOME` or the workspace.',
    '- In double quotes `\\` is mostly literal (`"C:\\Windows"` works); in single quotes it is always literal. Prefer single quotes when a path or regex contains backslashes.',
  ].join('\n')
}

function pipelineSection() {
  return [
    '### Pipes, redirection, and exit codes',
    '',
    '```bash',
    'tmp=$(mktemp)',
    'printf \'a\\nb\\nb\\n\' > "$tmp"',
    'sort "$tmp" | uniq -c | tr -s \' \'',
    'grep -q zzz "$tmp" || echo "no match (that is the documented way to test)"',
    'if grep -q a "$tmp"; then echo "found"; fi',
    'wc -l < "$tmp"',
    'cat "$tmp" 2>/dev/null | tail -1',
    'echo "last status=$?"',
    'rm -f "$tmp"',
    '```',
    '',
    '- `>` `>>` `<` `2>` `2>&1` `2>/dev/null` `&>` all work as in Bash; the null device is `/dev/null` (`nul` also works on Windows). **`$null` is PowerShell** — as a redirect target it expands to the empty string and the shell reports `: No such file or directory`.',
    '- Exit codes pass through untouched: a command that exits 3 is reported as `[exit code: 3]`, an unknown program is `127`, and `grep` with no match is `1`. Use `command || true`, `if cmd; then`, `set -o pipefail`, or `$?` exactly as in Bash.',
    '- A failing command does **not** stop the rest of the command unless you ask for it (`set -e`); the tool reports the *last* status, so check what matters explicitly when the difference matters.',
    '- Niubash writes LF line endings and UTF-8 text, so `wc -l`, `grep`, and non-ASCII output behave normally (no CRLF surprises when piping between the Unix tools).',
  ].join('\n')
}

function translationSection() {
  return [
    '### PowerShell → Bash (Niubash)',
    '',
    '| PowerShell | Niubash (Bash) |',
    '|---|---|',
    '| `$env:NAME` | `$NAME` (reading), `export NAME=value` (setting) — `$env:NAME` silently prints `:NAME` |',
    '| `$x = 1` | `x=1`, `local x=1`, or `export x=1` (no spaces around `=`, and no `$` on the left) |',
    '| `Get-ChildItem`, `ls -Recurse` | `ls`, `ls -R`, `find . -name \'*.md\'` |',
    '| `Get-Content f`, `gc f` | `cat f`, `head -20 f`, `tail -20 f` |',
    '| `Set-Content f x` / `Add-Content f x` | `printf \'%s\\n\' "x" > f` / `>> f` |',
    '| `Test-Path p` | `[ -e "$p" ]`, `[ -d "$p" ]`, `[ -f "$p" ]` |',
    '| `Join-Path a b` / `Split-Path p` / `Resolve-Path p` | `"$a/$b"` / `dirname p` · `basename p` / `realpath p` |',
    '| `Where-Object { … }`, `? { … }` | `grep`, or `while read -r line; do … done` |',
    '| `ForEach-Object { … }`, `% { … }` | `for x in …; do …; done`, `while read -r line; do … done`, `xargs` |',
    '| `Select-Object -First 20` | `head -20` (`-Last 20` → `tail -20`) |',
    '| `Sort-Object` / `Group-Object` / `Measure-Object` | `sort` / `sort \\| uniq -c` / `wc -l` |',
    '| `Select-String -Pattern p` | `grep -n p <file>` (recursive: `grep -rn`) |',
    '| `Write-Host` / `Write-Output` | `echo` |',
    '| `Out-File f` / `Out-Null` | `> f` / `>/dev/null` |',
    '| `Test-Path`-style `if (…) { }` | `if [ … ]; then …; fi` (a `$`-variable needs no parentheses) |',
    '| `foreach ($x in $xs) { … }` | `for x in "${xs[@]}"; do …; done` |',
    '| `@(1,2,3)` / `@{k=1}` | `arr=(1 2 3)` / `declare -A map=([k]=1)` |',
    '| `-eq -ne -gt -lt`, `-and -or -not` | `-eq -ne -gt -lt` inside `[ ]` / `[[ ]]`; `&&`, `\\|\\|`, `!` |',
    '| `-match \'re\'`, `-replace a,b` | `[[ $s =~ re ]]`, `${s/a/b}` or `sed` |',
    '| `$?`, `$LASTEXITCODE` | `$?` (the previous command\'s status) |',
    '| `Remove-Item -Recurse -Force d` | `rm -rf d` |',
    '| `Copy-Item` / `Move-Item` / `New-Item` | `cp -r` / `mv` / `touch` · `mkdir -p` |',
    '| `Get-Command x` | `command -v x` (or `which x`, `type x`) |',
    '| `Start-Sleep 5` | `sleep 5` |',
    '| `Invoke-WebRequest url -OutFile f` | `curl -sSL url -o f` |',
    '| `ConvertTo-Json` / `ConvertFrom-Json` | `python -c` (or `node -e`) — there is no `jq` |',
    '| `Get-Process` / `Stop-Process -Id N` | `ps` / `taskkill //PID N //F` |',
    '| `param($a, $b)` | `a="$1"; b="$2"` (or `getopts`) |',
    '| backtick line continuation | `\\` at end of line |',
    '',
    '### CMD → Bash (Niubash)',
    '',
    '| CMD | Niubash (Bash) |',
    '|---|---|',
    '| `dir` | `ls` (`dir` also exists as a WinuxCmd tool, but `ls` is the portable habit) |',
    '| `del` / `copy` / `move` / `ren` | `rm` / `cp` / `mv` / `mv` |',
    '| `cls` | `clear` |',
    '| `type f` | `cat f` |',
    '| `findstr p f` | `grep p f` |',
    '| `where x` | `command -v x` (Windows `where.exe` also works) |',
    '| `tasklist` / `taskkill` | `ps` / `taskkill //PID N //F` |',
    '| `%VAR%` | `$VAR` |',
    '| `cmd /c …`, `powershell -Command …` | write Bash directly — handing off to another shell is refused |',
  ].join('\n')
}

function failureSection() {
  return [
    '### When a command fails: the real messages and their fixes',
    '',
    'These are the failures observed on a real Niubash install, in the words the shell actually prints. The preflight refuses most of the left column before it spawns, and everything else comes back with a `Niubash hint (…)` line.',
    '',
    '| you wrote | Niubash printed | write this instead |',
    '|---|---|---|',
    '| `echo $env:PATH` | `:PATH` (no error — a **silent** wrong answer) | `echo "$PATH"` |',
    '| `Get-ChildItem` / `Get-Content f` / `Test-Path p` | `bash: line 1: Get-ChildItem: command not found` (exit 127) | `ls` / `cat f` / `[ -e p ]` |',
    '| `ls -Recurse` | `ls: invalid option -- \'e\'` | `ls -R`, `find . -name …` |',
    '| `if ($x -eq 1) { }` | `syntax error near unexpected token \'(\'` | `if [ "$x" -eq 1 ]; then …; fi` |',
    '| `foreach ($x in 1..3) { }` | `syntax error near unexpected token \'(\'` | `for x in 1 2 3; do …; done` |',
    '| `@(1,2,3)` | `syntax error near unexpected token \'(\'` | `arr=(1 2 3)` |',
    '| `echo hi > $null` | `bash: line 1: : No such file or directory` | `>/dev/null` |',
    '| a backtick at end of line | `syntax error: unexpected EOF while looking for matching \')\'` | end the line with `\\` |',
    '| `awk \'{print $1}\' f` | `awk: command not found` | `cut -d, -f1`, `sed`, or `python -c` |',
    '| `jq . f` | `jq: command not found` | `python -c \'import json,sys; print(json.load(open("f")))\'` |',
    '| `cd /c` inside `( … )` | `cd: …\\winuxcmd\\c: No such file or directory` | `cd /c/Windows`, `cd C:/` |',
    '| `cat <(echo hi)` | `cat: <(echo hi): No such file or directory` | `tmp=$(mktemp); echo hi > "$tmp"; cat "$tmp"; rm -f "$tmp"` |',
    '| `unzip a.zip` | `unzip: command not found` | `tar -xf a.zip` |',
    '',
    'The correct forms of the same work, in one running command:',
    '',
    '```bash',
    'tmp=$(mktemp -d); printf \'one\\ntwo\\n\' > "$tmp/f.txt"',
    'grep -n two "$tmp/f.txt"            # not `Select-String`',
    'ls -la "$tmp" | wc -l               # not `ls -Recurse`',
    '[ -f "$tmp/f.txt" ] && echo "file test ok"   # not `Test-Path`',
    'echo "HOME is $HOME"                # not `$env:HOME`',
    "literal='$env:NAME inside single quotes stays literal'; echo \"$literal\"",
    'rm -rf "$tmp"',
    '```',
  ].join('\n')
}

function trapSection(options = {}) {
  const sandboxed = options.sandbox === true
  return [
    '### Traps worth knowing',
    '',
    '- **Every call is a fresh process.** `cd`, `x=1`, `export`, functions, and `set -o` do not survive into the next call; use the tool\'s `workdir` parameter instead of `cd`, and pass values explicitly. The same is true in reverse: a variable you set in one call is gone in the next.',
    sandboxed
      ? '- **Commands are confined by the harness file sandbox.** A blocked operation comes back as `[sandbox: file access denied under <mode> mode]`, which is a policy denial rather than a command bug.'
      : '- **Commands run directly on the host, unconfined.** `niu` is spawned as-is: no file sandbox wraps it, `[sandbox: …]` markers never appear, and `sandbox_permissions` does nothing. A command can read, write, and delete whatever the harness process can — treat `rm -rf`, `git clean`, and anything that overwrites files with the same care you would in your own terminal, and prefer explicit paths over wildcards.',
    '- **`~/.niubashrc` and its plugins do not load** for `niu -c`. Aliases such as `ll`, `gst`, or `gco`, prompt themes, and plugin-provided helpers are interactive-only; write the full command (`ls -la`, `git status`) instead.',
    '- **`$env:NAME` is the silent trap.** Bash expands the empty variable `$env` and leaves `:NAME` as literal text, exiting 0. Anything you copy from PowerShell habit must become `$NAME`.',
    '- **`$null`, `$true`, `$false`, `$_`, `$PSItem`, `$PSScriptRoot`, `$LASTEXITCODE`** are PowerShell automatic variables; in Bash read `$?` for a status, use the `true`/`false` builtins, and `$(dirname "$0")` for the script directory.',
    '- **A single dash is letter-by-letter.** `ls -Recurse` fails as `-R -e -c …`; the Unix tools take their own short flags (`ls -R`, `rm -rf`, `grep -rn`, `sort -u`). PowerShell\'s `-Force`, `-Filter`, `-ErrorAction`, `-LiteralPath` do not exist here.',
    '- **Process substitution is only partially supported** in this build: `diff <(a) <(b)` works, `cat <(a)` does not. When it matters, write to a temp file (`tmp=$(mktemp)`) — that always works.',
    '- **`where` is Windows `where.exe`**, not a Bash builtin; `command -v`, `which`, and `type` are the Bash spellings. All four resolve the same `PATH`.',
    '- **`bash` and `sh` resolve to Niubash itself** (WinuxCmd ships them as shims for the same rubash engine), so `bash script.sh` and `sh -c \'…\'` stay in the dialect. A `bash` from Git for Windows or WSL is a different shell and is refused — including by absolute path.',
    '- **`/`, `/tmp`, `/bin`, `/usr`, `/etc`, `/dev` live inside Niubash\'s install tree** (the WinuxCmd root), not on `C:\\`: `/` lists `bin dev etc opt tmp usr var`, `/tmp` is writable, `/dev/null` discards, and `mktemp` works — but `ls /etc` shows Niubash\'s own files, not Windows\'. Scratch data you want to keep belongs under `$HOME` or the workspace.',
    '- **Long-running work belongs in the harness\'s background jobs** (`run_in_background`), not in `nohup`/`&` inside a single call: the call ends when the command ends, and an orphaned child loses its output. If you do background a process inside one command, `wait` for it.',
    '- **Output is the command\'s own.** No banner, no prompt, no rc noise; a trailing `[exit code: N]` marker is the harness\'s, not the shell\'s, and long output is truncated to its tail with the full text saved to a spill file the tool reports.',
    '- **Writing a script is safe from the dialect check**: heredoc bodies and single-quoted strings are data, so `cat > run.sh <<\'EOF\'` may contain PowerShell for some other tool without being refused (running it, of course, is a different matter).',
  ].join('\n')
}

/**
 * The full Bash-on-Windows guide: mandatory rules, runnable syntax, the tool
 * inventory, the path contract, the PowerShell/CMD translation tables, the real
 * failure catalogue, and the traps.
 * @param options - guide options.
 * @param options.variant - `full` (default) or `compact`; `off` returns an empty string.
 * @param options.version - the probed Niubash version, when known.
 * @param options.winuxcmd - the probed WinuxCmd version, when known.
 * @returns the guide text, or an empty string when the guide is off.
 */
export function buildGuide(options = {}) {
  const variant = options.variant ?? 'full'
  if (variant === 'off') return ''
  const versions = [
    options.version === undefined ? '' : `Niubash ${options.version}`,
    options.winuxcmd === undefined ? '' : `WinuxCmd ${options.winuxcmd}`,
  ].filter((entry) => entry.length > 0).join(', ')
  const header = [
    `## Bash on Windows: the Niubash guide${versions.length === 0 ? '' : ` (${versions})`}`,
    '',
    'Shell commands are evaluated as `niu -c "<command>"`: a fresh, non-interactive Niubash process per call — Bash 5.3 semantics from the rubash engine, Unix tools from WinuxCmd, native Windows paths, no rc file, no plugins, no banner.'
      + (options.sandbox === true
        ? ' Commands run under the harness file sandbox.'
        : ' Commands run **directly on the host**: nothing wraps them, so `[sandbox: …]` markers never appear and `sandbox_permissions` does nothing.'),
  ].join('\n')
  if (variant === 'compact') {
    return [
      header,
      '',
      '```bash',
      'ls -la; grep -rn --include=\'*.md\' pattern .   # Unix tools ship with Niubash (WinuxCmd)',
      'x=1; echo "$x $((x + 1))"                       # Bash: no spaces around =, no $ on the left',
      'if [ -f file ]; then echo yes; fi               # not `if (Test-Path file) { }`',
      'for f in *.md; do echo "$f"; done               # not `foreach ($f in …) { }`',
      'cat f | sort -u | head -5                       # pipes and redirection are Bash',
      '```',
      '',
      'Not available: PowerShell (`$env:NAME` silently prints `:NAME` — write `$NAME`), `Get-ChildItem`/`Get-Content`/`Test-Path`, `cmd /c`, WSL, `nu`, `awk`, `jq`, `rg`, `unzip` (use `tar -xf`). Every call is a new process: `cd`/`export` do not persist, so pass `workdir`. Handing a command to another shell is refused; PowerShell habits are refused before running with the Bash spelling in the error, and a failed call appends a `Niubash hint (…)` line.',
    ].join('\n')
  }
  return [
    header,
    '',
    overviewSection(),
    '',
    languageSection(),
    '',
    toolsSection(),
    '',
    pathSection(),
    '',
    pipelineSection(),
    '',
    translationSection(),
    '',
    failureSection(),
    '',
    trapSection({ sandbox: options.sandbox === true }),
  ].join('\n')
}

/**
 * The model-facing description that replaces the first-party bash/PowerShell
 * description. It keeps the first-party semantics (fresh process, exit markers,
 * background, escalation) and states the dialect — and, because this bundle
 * runs `niu` directly on the host by default, it states that too instead of
 * promising sandbox markers that can never appear.
 * @param options - description options.
 * @param options.background - whether the tool advertises `run_in_background`.
 * @param options.escalation - whether the tool advertises `sandbox_permissions`.
 * @param options.sandbox - whether `ctx.sandbox` confines commands (`false` = runs directly on the host).
 * @param options.guide - whether a guide section is registered in the prompt.
 * @returns the tool description.
 */
export function buildToolDescription(options = {}) {
  const background = options.background === true
    ? 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.'
    : 'Background execution is not available; long-running commands must finish within the timeout.'
  const sandboxed = options.sandbox === true
  const execution = sandboxed
    ? 'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. '
    : 'Commands run **directly on the host** with the harness process\'s own permissions: no file sandbox wraps them, so `[sandbox: …]` markers never appear and the `sandbox_permissions` parameter has no effect — do not use it. Everything you can reach from the harness, the command can reach too. '
  const base = 'Execute a command with Bash on Windows through Niubash (`niu -c`) and return its stdout/stderr. '
    + 'The dialect is Bash (GNU Bash 5.3 semantics, the rubash engine) with the Unix tools supplied by WinuxCmd; PowerShell and CMD are not available — `$env:NAME` is the worst trap because Bash prints `:NAME` instead of failing, and `Get-ChildItem`/`Test-Path`/`if (…) { }` are not commands. '
    + 'Each call runs in a fresh, non-interactive process: no state (cwd, variables, functions, environment, aliases) persists between calls, and `~/.niubashrc` is not loaded — pass `workdir` instead of using `cd`. '
    + 'Non-zero exits are reported as `[exit code: N]` (an unknown program is 127). Current harness environment facts are exposed as `$DSH_*` variables; inspect them when needed. '
    + 'Essentials: `ls grep sed find head tail wc sort uniq tr cut xargs tee diff patch du df ps which env printf sleep seq mktemp od stat realpath sha256sum tar curl` all exist; `awk`, `jq`, `rg`, `perl`, `make`, `gcc`, `zip`/`unzip`, `bc`, `vim` do not — use `python`, `node`, `cargo`, `tar`, `sed`, or `cut` instead, and check any name with `command -v`. '
    + 'Paths: `/c/…`, `C:/…`, and `C:\\…` all work (arguments are converted for native programs), a bare `cd /c` is the one context-dependent spelling — use `cd /c/Windows` or `cd C:/` — and `cd /` is Niubash\'s own Unix root. '
    + execution
    + 'Handing a command to another shell (`powershell`, `cmd /c`, `wsl`, `nu`, or a non-Niubash `bash`) is refused, and PowerShell/CMD habits are refused before anything runs with the Bash spelling in the error; a failed call appends a `Niubash hint (…)` line naming the fix. '
    + 'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. '
    + background
    + (options.guide === false ? '' : ' The system prompt carries the full Niubash guide (`shell: niubash-guide`).')
  if (options.escalation !== true || !sandboxed) return base
  return base + ' Attempting a command the sandbox may deny is safe and expected: run it and read the marker rather than assuming the denial. When a command is denied and a wider mode would let it succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) plus a one-sentence `justification`. Do not detour through chat to ask permission first — the approval prompt raised by that retry is how the user consents. If the session states approval prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. Never escalate speculatively: ground the request in a real denial — normally the one this command just hit; escalating up front is fine only when this session already denied the same access. A rejected escalation is final for that command — stop and explain, never work around it — but it does not forbid attempting or escalating other commands later.'
}

/** The description for the shell tool's `command` parameter. */
export const NIUBASH_COMMAND_PARAM_DESCRIPTION = 'The Bash command to execute (Niubash on Windows: GNU Bash dialect with WinuxCmd Unix tools; not PowerShell and not CMD).'

# dsh-niubash-only

[English](README.en.md) | [中文](README.md)

A Profile Bundle that makes [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) run **Niubash as its only shell**, and **teaches the model to write the Bash Niubash supports**.

Target: **dsh `0.1.5-rc.2`** (measured against both the CLI and the libraries; `0.1.5-rc.1` works too). Runtime requirements: Node `>=22.19.0` and [Niubash](https://github.com/unixwin/niubash) (measured with `Niubash 1.1.4` + `WinuxCmd 1.0.8` on Windows 10/11).

Niubash is a Windows-native shell: the language engine is rubash (GNU Bash semantics, `$BASH_VERSION=5.3.0(1)-release`) and the Unix commands come from WinuxCmd (`ls`/`grep`/`sed`/`find`… are real binaries on `PATH`), all carried by one `niu.exe`. This plugin routes **every** shell execution in dsh through it.

## What it does

One plugin, five cooperating parts:

1. **Takes over `ctx.shell` (the execution layer)**
   The two first-party executors `bash-sandbox` / `pwsh-sandbox` are disabled and replaced by `dsh-niubash-only/executor`: every shell execution becomes
   `niu -c "<command>"`.
   It swaps the **capability seam** rather than the model tool, so every consumer in dsh that goes through `ctx.shell` uses Niubash: the model tools, background jobs (`run_in_background`), the hook bridges (`dsh-hooks-*`), `tmux-context`, and any in-process plugin call. Timeouts, output caps, spill files, background handles, cancellation, sandbox policy and denial facts all stay on the first-party implementation (it extends `SandboxPwshExecutor` / `SandboxBashExecutor` and only replaces argv).
   `niu -c` is a one-shot command domain: it loads **no `~/.niubashrc`, no plugins, no interactive hooks, no banner**, and passes the exit code through unchanged — exactly the deterministic contract an agent needs.

2. **Refuses "just run it in another shell" (the enforcement layer)**
   The executor carries a narrow guard: if a command hands execution to another shell at the start of a statement (`pwsh`, `powershell`, `cmd /c`, `wsl`, `nu -c`, `zsh`…, including `sudo`/`env` wrappers, `FOO=1` assignment prefixes, `( … )` subshells, `$( … )` and backtick command substitution), it is refused with a clear error that also gives the Bash spelling.
   `bash` / `sh` are **conditional**: Niubash ships same-named shims of its own through WinuxCmd (the same rubash engine), so at boot the plugin probes where this machine's `bash`/`sh` actually resolve — if they resolve inside the Niubash install tree they are allowed, otherwise (Git Bash, WSL bash, including absolute-path spellings) they are always refused. On by default; turn it off with `enforceNiubashOnly: false`, or allow individual call sites through `foreignShellAllowlist`.

3. **Refuses PowerShell / CMD habits (the dialect preflight layer)**
   "Niubash is the only shell" is not enough: on Windows the model habitually writes commands that are **syntactically valid but belong to another dialect**. The most dangerous one fails **silently**:

   ```text
   $ niu -c 'echo $env:PATH'
   :PATH          ← exit code 0, no error, wrong answer
   ```

   Bash expands `$env` as an empty variable and prints `:PATH` literally. Likewise `ls -Recurse` is parsed letter by letter after a single dash (`invalid option -- 'e'`), `Get-ChildItem` is `command not found`, `>$null` becomes an empty filename, and `foreach ($x in …) { }` is a syntax error.
   The preflight refuses these before spawning and puts the Bash spelling in the error text (`$env:VAR` → `$VAR`; `Get-ChildItem` → `ls`; `ls -Recurse` → `ls -R`; `$x = 1` → `x=1`…). Strings, comments and heredoc bodies are masked first, so writing PowerShell inside `cat > x.ps1 <<'EOF' … EOF` is not misread.

4. **The teaching layer (the prompt layer)**
   - `shell: niubash-rules`: the mandatory rules (dialect, a fresh process per call, `workdir`, no shell handoffs, the tool inventory, the path contract).
   - `shell: niubash-guide`: a Bash-on-Windows manual — runnable syntax, **the commands this machine really has and really lacks**, the three path spellings, pipes and exit codes, PowerShell→Bash and CMD→Bash translation tables, **a catalogue of the real errors**, and the traps. It is evaluated at every assembly, so it carries the probed Niubash / WinuxCmd versions.
   - It rewrites the `bash` / `pwsh` tool descriptions and the `command` parameter description the model sees into what Niubash actually supports (the tool **names** stay unchanged, so presets, `toolOrder`, AGENTS.md references and the like keep working).
   - The teaching layer registers on the **host plane**: even in web mode, where the shell tool comes from an agent preset (a separate scope), the description rewrite and the manual still apply (verified by the integration test).

5. **Failure hints (the correction layer)**
   When a call fails, one `Niubash hint (…)` line is appended to stderr, chosen from the real error text: a program this machine does not have (`awk`/`jq`/`rg`/`perl`/`make`/`gcc`/`unzip`…) plus its replacement, PowerShell named parameters, `$null` redirection, the `cd /c` context trap, process substitution, and silent non-zero exits.

## Why these rules: the measured data

The rules in this plugin were not invented. Every row below was measured on this machine with Niubash 1.1.4 / WinuxCmd 1.0.8 (`test/guide.test.mjs` runs every ```bash block in the manual through the real `niu`, and `test/dialect.test.mjs` uses these real stderr texts as regressions):

| What the model might write | What Niubash actually does | The correct spelling |
|---|---|---|
| `echo $env:PATH` | prints `:PATH`, exit code 0 (**silent error**) | `echo "$PATH"` |
| `Get-ChildItem` / `Get-Content f` / `Test-Path p` | `command not found` (127) | `ls` / `cat f` / `[ -e p ]` |
| `ls -Recurse` | `ls: invalid option -- 'e'` | `ls -R`, `find . -name …` |
| `if ($x -eq 1) { }` | `syntax error near unexpected token '('` | `if [ "$x" -eq 1 ]; then …; fi` |
| `foreach ($i in 1..3) { }` | same | `for i in 1 2 3; do …; done` |
| `@(1,2,3)` | same | `arr=(1 2 3)` |
| `echo hi > $null` | `bash: line 1: : No such file or directory` | `>/dev/null` (`nul` works too) |
| a trailing-backtick line continuation | `syntax error: unexpected EOF while looking for matching ')'` | a trailing `\` |
| `awk '{print $1}' f` | `awk: command not found` | `cut -d, -f1`, `sed`, `python -c` |
| `cd /c` (inside `( … )`) | `cd: …\winuxcmd\c: No such file or directory` | `cd /c/Windows`, `cd C:/` |
| `cat <(echo hi)` | `cat: <(echo hi): No such file or directory` | `tmp=$(mktemp); echo hi > "$tmp"; cat "$tmp"` |
| `unzip a.zip` | `unzip: command not found` | `tar -xf a.zip` |

The tool inventory is measured the same way (`test/guide.test.mjs` asserts that the table matches the machine):

- **Present**: `ls cat grep sed find head tail wc sort uniq tr cut xargs tee diff patch du df ps less which env printf sleep seq mktemp od stat realpath basename dirname sha256sum md5sum base64 yes touch rm cp mv ln chmod tar curl tree more dir dos2unix`, plus the Windows programs on `PATH` (`git` `node` `python` `pip` `cargo` `dotnet` `where` `findstr` `tasklist` `taskkill` `attrib` `xcopy`).
- **Absent**: `awk jq yq rg perl make cmake gcc clang zip unzip 7z bc vim nano wget iconv ffmpeg` (and `java gradle mvn` when they are not on this machine's `PATH`).

## Install

```sh
# Install straight from GitHub into a profile (recommended; no npm release needed)
dsh plugin --profile web add github:YMRwithNoworry/dsh-niubash-only

# Pin a commit for reproducibility (optional)
dsh plugin --profile web add github:YMRwithNoworry/dsh-niubash-only#<sha>

# Or install a local checkout
dsh plugin --profile web add file:/path/to/dsh-niubash-only
```

**Restart that profile** after installing. `dsh plugin` registers the package in `dsh.profile.bundles` (this package declares `dsh.bundle.patch`), and the patch layer inserts the executor and teaching rows into the composed tree.

> **⚠️ Remove or disable the other shell providers first**: one context allows exactly one `ctx.shell` provider. If the profile already has another shell-executor bundle you must deal with it first, or boot fails on a duplicate `shell` service. The two most common ones:
>
> ```sh
> # the earlier Nushell plugin
> dsh plugin --profile web remove dsh-nushell-only
> # the old Winuxsh/Niubash bundle (its own winuxsh-sandbox row is also a shell provider)
> dsh plugin --profile web remove @cmx666/dsh-winuxsh-bundle
> ```
>
> If you want to keep that bundle's other features (its web settings card, say), you can instead disable just its row in the profile's `cordis.patch.yml`:
>
> ```yaml
> - id: winuxsh-sandbox
>   disabled: true
> ```
>
> **Another real trap**: `@cmx666/dsh-winuxsh-bundle@0.1.0-rc.8` hardcodes the executable name `winuxsh`, but the binary has been called `niu.exe` since the Niubash rename — install that bundle without a same-named shim and every shell call fails with `spawn winuxsh ENOENT`. This plugin resolves `niu.exe`, and falls back to the install directory when `PATH` does not have it (see below), so it is unaffected.

Verify:

```sh
dsh --profile web --dump-config | grep -n niubash
# Expect: bash-sandbox / pwsh-sandbox = disabled, plus the niubash-executor and niubash-teaching rows
```

## Configuration

The patch layer's defaults (`cordis.patch.yml`):

```yaml
- id: niubash-executor
  name: dsh-niubash-only/executor
  config:
    timeoutMs: 120000
    maxTimeoutMs: 600000
    maxOutputBytes: 64000
    graceMs: 3000
    enforceNiubashOnly: true   # refuse handing a command to another shell
    dialectLint: true          # refuse PowerShell/CMD habits before spawning, naming the Bash form
    dialectHints: true         # append one Niubash hint chosen from the real error text
    requireNiubash: true       # fail boot when niu cannot be found (instead of failing every call)
    verifyNiubash: true        # probe `niu --version` once at boot
    probeNativeShells: true    # probe whether this machine's bash/sh resolve to Niubash
    smokeTest: true            # run one real command at boot, so a sandbox that blocks it says so at once

- id: niubash-teaching
  name: dsh-niubash-only/teaching
  config:
    guide: full                # full | compact | off
    rules: true
    rewriteToolDescriptions: true
```

Executor fields:

| Field | Default | Meaning |
|---|---|---|
| `niuPath` | `$DSH_NIU_PATH` → `PATH` → install dir → `niu.exe` | The Niubash executable |
| `niuArgs` | `['-c']` | Argv prefix; the command is appended last |
| `enforceNiubashOnly` | `true` | The guard switch |
| `foreignShellAllowlist` | `[]` | Whole-command regex strings; a match is allowed through (shared by the guard and the dialect preflight) |
| `dialectLint` | `true` | Refuse PowerShell/CMD habits before spawning |
| `dialectHints` | `true` | Append one `Niubash hint (…)` line to a failed call's stderr |
| `requireNiubash` | `true` | Fail boot when `niu` cannot be resolved |
| `verifyNiubash` / `verifyTimeoutMs` | `true` / `10000` | Probe `niu --version` at boot, and its timeout |
| `smokeTest` | `true` | Run one real call path at boot (`echo niubash-smoke-ok`), so boot-time failures like "the sandbox blocks `niu -c`" are written to the boot log (see "Sandbox modes and Niubash") |
| `probeNativeShells` | `true` | Probe `command -v bash; command -v sh` at boot and decide from it whether `bash`/`sh` are allowed |

**Executable resolution order**: `niuPath` → `DSH_NIU_PATH` → the first `PATH` entry holding `niu.exe` → the known install directories (`%LOCALAPPDATA%\Programs\Niubash`, `%ProgramFiles%\Niubash`, `%ProgramFiles(x86)%\Niubash`) → bare `niu.exe`.
The install-directory step is deliberate: the Niubash installer appends its directory to the **user PATH** and broadcasts the environment change, but an already-running harness process still holds the environment it started with — falling back to the documented install directory keeps a deployment working without restarting the host.

`cwd`, `timeoutMs`, `maxTimeoutMs`, `maxOutputBytes`, `maxSpillBytes` and `graceMs` keep dsh's own `shell` settings namespace, so the `shell:` section of `settings.yaml` can still change the budgets at runtime.

Override by id in this profile's `cordis.patch.yml`, for example:

```yaml
- id: niubash-executor
  config:
    niuPath: 'C:\Users\me\AppData\Local\Programs\Niubash\niu.exe'
    enforceNiubashOnly: false
```

## What "Niubash only" does not cover

What the plugin guarantees is that **everything going through `ctx.shell`** is Niubash. It cannot reach the following, and this README says so plainly to avoid false confidence:

1. **Rows in a preset that spawn a shell themselves**. For example a preset's `custom-bash.mjs` (which calls `ctx.subprocess.spawn(['bash.exe','-c',…])` directly) or a `persistent-shell` group (a PTY-backed resident shell). Those tools bypass `ctx.shell`, so the plugin can neither change what they execute nor rewrite their description (the description rewrite only touches first-party tools that claim `bash -c` / `pwsh -Command`, so it never lies). For a Niubash-only deployment, set those rows to `disabled: true` in the preset files, or disable the whole `persistent-shell` group.
2. **Nested calls**. In `niu -c 'python -c "import subprocess; …"'` the inner layer is another program; by design the guard only looks at the first word of a statement and at command substitutions that execute — it is not a process-level sandbox. The guard stops explicit handoffs ("the model wants to bypass Niubash"), not a security boundary.
3. **The conditional `bash`/`sh` allowance**. They are allowed only when the boot probe proves they resolve inside the Niubash install directory; when the probe fails (because `niu` will not start, say) they are always refused, and the error explains the cause and how to relax it.
4. **The hook commands of `dsh-hooks-claude-code` / `dsh-hooks-codex`**. They execute through `ctx.shell`, so they are Niubash now: **hooks written for PowerShell will fail**, hooks written for Bash work.
5. **The TUI's resident PTY shell** (`dsh-terminal-bash` + `dsh-tool-bash-persistent`) goes through the terminal seam, not `ctx.shell`, and the plugin does not replace it.

Sandboxing and permissions are unchanged: `danger-full-access` executes directly, and confined modes still wrap Niubash's argv through `ctx.sandbox.confine()` and report `mode` / `denied` / `enforcement` as usual.

## Sandbox modes and Niubash

While building the shell for `niu -c`, Niubash opens `$HOME/.niubash_history` — even when the one command it is about to run needs no history at all. A confined sandbox (`workspace-write` / `read-only`) does not allow writing outside the workspace, so `niu` exits **before running any command**:

```text
niu: failed to open history provider C:\\Users\\me\\.niubash_history: I/O error: 拒绝访问。 (os error 5)
```

That is a Niubash host-layer limitation, not a refusal by this plugin: the plugin can neither skip the history file on its behalf nor pretend everything is fine in that mode. Therefore:

- The executor runs a **smoke test** at boot (`smokeTest: true`, on by default). It takes exactly the path a model tool call takes (`run(resolve({ command }))`), so when the sandbox really blocks it, the boot log shows **the reason above, immediately**, together with the two ways out — switch to the `danger-full-access` permission preset, or make the history file reachable from the sandbox — instead of waiting for every tool call to report the same cryptic error.
- That fact is exposed to in-process consumers as `niuSmoke` (`{ ok, detail }`) on the shell service. The integration test uses it to mark the "needs a real command" assertions as SKIP rather than FAIL, while still checking every refusal (foreign-shell handoff, dialect preflight) and the prompt assembly **one by one** — they all happen before a subprocess exists, so the sandbox is irrelevant to them.

**Bottom line**: to run dsh with Niubash on Windows, set the permission mode to `danger-full-access` (`DSH_PERMISSION_MODE=danger-full-access`, or the same-named permission preset in the web UI). Measured on this machine: under `danger-full-access` the integration test passes 35/35; under `workspace-write` it passes 26/26 with 8 SKIPs, and every SKIP is explained by the limitation above.

## What the teaching layer gives the model

With `guide: full`, the system prompt gains (right next to the shell tool's guidance slot):

- A rules section: the dialect is Bash (Niubash/rubash), a fresh process per call (`cd`/variables/`export`/aliases do not survive; use `workdir`), `~/.niubashrc` is not loaded, shell handoffs are refused, PowerShell habits are refused (including the silent `$env:NAME` trap), exit codes and 127, the tool inventory, the path contract.
- A syntax manual: the Bash language essentials (arrays, `case`, `[[ ]]`, `$(( ))`, `${v^^}`, heredocs, functions, `set -euo pipefail`).
- The tool inventory: the Unix commands that **really exist** and those that **really do not**, with replacements for the missing ones (`python` / `node` / `cargo` / `tar` / `sed` / `cut`). Including a two-liner that parses JSON without `jq`.
- The path contract: the three spellings `/c/…`, `C:/…`, `C:\…`; the automatic conversion when a path is passed to a native program; the `cd /c` context trap; `/` being Niubash's own Unix root (`/tmp`, `/dev/null`, `mktemp` all live in it); quoting and backslashes.
- Pipes/redirection/exit codes: `> >> 2> 2>&1 2>/dev/null &>`, `/dev/null` versus `nul`, exit codes passed through unchanged, `pipefail`, and the fact that a failing command does not abort the ones after it.
- Translation tables: PowerShell→Bash (30 rows, including `$env:NAME`, `Get-*`, `Select-Object -First`, `-eq/-and`, `Invoke-WebRequest`, `ConvertTo-Json`, backtick continuations…) and CMD→Bash (`dir/del/copy/cls/type/findstr/%VAR%`…).
- A failure catalogue: the real errors from the table above with their fixes, plus a runnable correct spelling.
- The traps: a fresh process every time, no rc (so aliases like `ll`/`gst` do not exist), the silent `$env:` error, single-dash letter-by-letter parsing, process substitution being only partly available, `where` being `where.exe`, `bash`/`sh` being Niubash itself, `/tmp` living inside the install tree, long jobs belonging in the background, and heredoc bodies escaping the dialect lint when writing scripts.

Every ```bash block in the manual is run through **the real niu on this machine** by `test/guide.test.mjs`, so the examples are not "probably right" — they run.

## Development and verification

```sh
node --test test/                 # 75 unit tests (guard / dialect preflight and hints / manual and inventory / resolution table / executor argv, boot probes and sandbox paths / teaching layer)
node test/integration.mjs         # end to end: a scratch DSH_HOME, a real profile install, a real boot, 35 assertions
node test/integration.mjs --mode workspace-write   # confined mode: the command assertions SKIP per "Sandbox modes and Niubash", everything else is asserted as usual
node dev/link-peers.mjs           # symlink this machine's @deepseek-ai/* into node_modules/ so a checkout can run the tests
```

The integration test checks, in order: `ctx.shell` is the `NiubashExecutor`; the `niu --version` and `bash/sh` probes; **the boot smoke test really ran a command**; a shell builtin; a Unix-tool pipeline; a native Windows program; a non-zero exit reported as a result; **a foreign-shell handoff is refused**; **Niubash's own bash shim is allowed**; **the dialect preflight refuses `$env:PATH` and `ls -Recurse` and names the Bash form**; **a failed call carries a `Niubash hint`**; the system prompt carries the rules/manual/tables/failure catalogue/traps; the `bash`/`pwsh` descriptions and the parameter description are rewritten; **a shell tool inside a preset child scope is rewritten too**; and the sandbox facts are reported correctly. Point it at a specific CLI with `DSH_INTEGRATION_CLI=/path/to/@deepseek-ai/dsh/lib/bin.js`.

## Troubleshooting

| Symptom | What to do |
|---|---|
| Boot fails with `cannot resolve the Niubash executable` | Install Niubash (it puts `niu.exe` on the user PATH) / set `niuPath` or `DSH_NIU_PATH` / restart the host so it re-reads the environment; to get moving, set `requireNiubash: false` |
| Boot fails with `failed its --version probe` | `niu.exe` is not executable or is damaged; `verifyNiubash: false` skips the probe |
| The boot log says `failed to open history provider … 拒绝访问`, and every later call fails the same way | A confined sandbox does not let `niu` write `$HOME/.niubash_history` (a Niubash host-layer limitation). Switch to `danger-full-access`, or make that file reachable from the sandbox; see "Sandbox modes and Niubash" |
| Boot fails with a duplicate `shell` service registration | Another shell-executor bundle (`dsh-nushell-only`, `@cmx666/dsh-winuxsh-bundle`…) is still installed or not disabled |
| A tool call says `Niubash-only shell: refusing to hand this command to …` | The command calls `powershell`/`cmd`/`wsl`/`nu` or a non-Niubash `bash`; rewrite it in Bash as the message says, or use `foreignShellAllowlist` / `enforceNiubashOnly: false` when it is genuinely needed |
| A tool call says `refusing a powershell-…` but the command really is valid Bash | A false positive: put the whole command in `foreignShellAllowlist`; every rule in `lib/dialect.js` carries an id, which makes it easy to locate |
| A command prints something nonsensical like `:PATH` | That is the silent `$env:NAME` error (with the preflight turned off); write `$NAME` |
| A program is clearly installed but you get `command not found` | Check with `command -v <name>`; Niubash's Unix commands come from WinuxCmd, and `awk`/`jq`/`rg`/`unzip` and friends really are absent (use `python`/`node`/`tar` instead) |
| The model still writes PowerShell | Check `guide: full` and `rewriteToolDescriptions: true`; then check whether the model's `toolOrder`/preset swapped the shell tool for a self-built one (see point 1 of "What 'Niubash only' does not cover") |

## License

MIT.

# Making an agent preset Niubash-only

The bundle replaces the host `ctx.shell` provider, so every tool that runs its
commands through `ctx.shell` (`@deepseek-ai/dsh-tool-bash`,
`@deepseek-ai/dsh-tool-pwsh`, and the jobs/hook consumers built on them) runs
Niubash automatically.

A preset can also mount a tool that **spawns its own shell** and never touches
`ctx.shell`. Those rows must be disabled in the preset's `agent.cordis.yml` for
the deployment to be genuinely Niubash-only. Two common shapes:

## 1. A preset-local tool that spawns a shell directly

```yaml
# Before: a custom `bash` tool that spawns Git Bash / sh through ctx.subprocess.
- id: custom-bash
  name: ./custom-bash.mjs
  disabled: !!js process.platform !== 'win32'
```

```yaml
# After: disabled. The first-party `bash` tool remains (this bundle disables
# `tool-pwsh` and mounts `tool-bash`, whose dialect is exactly what Niubash
# speaks) and now executes Niubash, because `ctx.shell` is the Niubash executor.
- id: custom-bash
  name: ./custom-bash.mjs
  disabled: true
```

## 2. A PTY-backed persistent shell

```yaml
# Before: an interactive bash kept alive by @deepseek-ai/dsh-terminal-bash.
- id: persistent-shell
  name: cordis:group
  group: true
  isolate:
    terminals: true
  config:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'
    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
```

```yaml
# After: disabled, and the one-shot shell tool kept. The one-shot tool runs
# Niubash per call and does not need a PTY; state does not persist between
# calls, so pass `workdir` instead of `cd`.
- id: persistent-shell
  name: cordis:group
  group: true
  disabled: true
  isolate:
    terminals: true
  config:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'
    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
```

If a persistent Niubash session is genuinely required, point the terminal
backend at `niu` instead. Unlike the Nushell case the dialect declaration is
honest here — Niubash *is* a Bash (`shellDialect: bash`), so the readiness
stack's assumptions hold:

```yaml
    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
      config:
        shellDialect: bash
        shellPath: niu                 # the executable may be any program
        shellArgs: []                  # `niu` with no arguments is the interactive shell
```

Note what that gives up: `niu -c`, the one-shot mode this package is built
around, deliberately loads **no `~/.niubashrc`, no plugins, no interactive
hooks and no banner**. An interactive `niu` does, so a persistent session is a
different contract — with its own startup cost and its own rc-dependent
behaviour. This package does not verify that surface; the one-shot executor is
what it tests.

## Checking a preset

Boot the profile and inspect the composed tree:

```sh
dsh --profile web --dump-config | grep -n -i "niubash\|bash\|pwsh\|terminal"
```

Every `bash` / `pwsh` row that survives should be one of the first-party tools
(`@deepseek-ai/dsh-tool-bash`, `@deepseek-ai/dsh-tool-pwsh`), and the shell
provider should be `niubash-executor`; a row that names a custom module which
spawns a shell is the bypass to disable.

# dsh-niubash-only

[English](README.en.md) | 中文

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的**唯一 shell 换成 Niubash**，并**教会模型写 Niubash 支持的 Bash** 的 Profile Bundle。

适配版本：**dsh `0.1.5-rc.2`**（CLI 与库均实测通过；`0.1.5-rc.1` 亦可）。运行时要求 Node `>=22.19.0` 与 [Niubash](https://github.com/unixwin/niubash)（实测 `Niubash 1.1.4` + `WinuxCmd 1.0.8`，Windows 10/11）。

Niubash 是 Windows 原生 shell：语言引擎是 rubash（GNU Bash 语义，`$BASH_VERSION=5.3.0(1)-release`），Unix 命令来自 WinuxCmd（`ls`/`grep`/`sed`/`find`… 是真二进制，在 `PATH` 上），一个 `niu.exe` 全包。本插件让 dsh 里**每一次** shell 执行都走它。

## 它做了什么

一个插件、四件事，互相配合：

1. **接管 `ctx.shell`（执行层）**
   `bash-sandbox` / `pwsh-sandbox` 两个第一方执行器被禁用，换成 `dsh-niubash-only/executor`：所有 shell 执行一律变成
   `niu -c "<command>"`。
   换的是**能力接缝**（capability seam）而不是模型工具，所以 dsh 里所有走 `ctx.shell` 的消费者都会用 Niubash：模型工具、后台任务（`run_in_background`）、hook 桥（`dsh-hooks-*`）、`tmux-context`、以及任何进程内插件调用。超时、输出上限、spill 文件、后台句柄、取消、沙箱策略与拒绝事实全部沿用第一方实现（继承 `SandboxPwshExecutor` / `SandboxBashExecutor`，只替换 argv）。
   `niu -c` 是一发式命令域：**不加载 `~/.niubashrc`、不加载插件、不跑交互钩子、无 banner**，退出码原样传递——这正是 agent 需要的确定性契约。

2. **拒绝"换个 shell 跑"（强制层）**
   执行器里带一个窄口径守卫：命令若在语句开头把执行权交给别的 shell（`pwsh`、`powershell`、`cmd /c`、`wsl`、`nu -c`、`zsh`…，含 `sudo`/`env` 包装、`FOO=1` 赋值前缀、`( … )` 子 shell、`$( … )` 与反引号命令替换），直接以清晰的错误拒绝，并给出 Bash 写法对照。
   `bash` / `sh` 是**条件放行**的：Niubash 自己用 WinuxCmd 提供了同名 shim（同一个 rubash 引擎），所以启动时会探测"本机 `bash`/`sh` 到底解析到哪"——解析到 Niubash 安装目录就放行，否则（Git Bash、WSL bash，含绝对路径写法）一律拒绝。默认开启，可用 `enforceNiubashOnly: false` 关闭，或用 `foreignShellAllowlist` 给个别调用点开白名单。

3. **拒绝 PowerShell / CMD 习惯（方言预检层）**
   "唯一 shell 是 Niubash"还不够：模型在 Windows 上会习惯性写出**语法合法但属于别的方言**的命令。最危险的一条是**静默出错**的：

   ```text
   $ niu -c 'echo $env:PATH'
   :PATH          ← 退出码 0，没有报错，答案是错的
   ```

   Bash 把 `$env` 当空变量展开，`:PATH` 原样输出。类似地 `ls -Recurse` 会被单横线逐字母解析（`invalid option -- 'e'`）、`Get-ChildItem` 是 `command not found`、`>$null` 变成空文件名、`foreach ($x in …) { }` 是语法错误。
   预检层在 spawn 之前就拒掉这些，并把 Bash 写法写进错误文本（`$env:VAR` → `$VAR`；`Get-ChildItem` → `ls`；`ls -Recurse` → `ls -R`；`$x = 1` → `x=1`…）。字符串、注释、heredoc 体先被遮蔽，所以 `cat > x.ps1 <<'EOF' … EOF` 里写 PowerShell 不会被误判。

4. **教学层（提示词层）**
   - `shell: niubash-rules`：强制规则（方言、每次调用全新进程、`workdir`、不许换 shell、工具清单、路径契约）。
   - `shell: niubash-guide`：Bash on Windows 手册——可运行语法、**本机确实存在/确实缺失的命令清单**、路径三写法、管道与退出码、PowerShell→Bash 与 CMD→Bash 对照表、**真实报错目录**、以及坑。每次装配时求值，因此会带上探测到的 Niubash / WinuxCmd 版本号。
   - 把模型看到的 `bash` / `pwsh` 工具描述与 `command` 参数说明改写成 Niubash 实际上支持的东西（工具**名字**保持不变，避免破坏 preset、`toolOrder`、AGENTS.md 等对工具名的引用）。
   - 教学层注册在**宿主平面**：即使 web 模式的 shell 工具来自 agent preset（独立 scope），描述重写与手册依然生效（已由集成测试验证）。

5. **失败提示（纠错层）**
   执行失败时，stderr 末尾追加一行 `Niubash hint (…)`，按真实错误文本给出对应修法：本机没有的程序（`awk`/`jq`/`rg`/`perl`/`make`/`gcc`/`unzip`…）及其替代写法、PowerShell 命名参数、`$null` 重定向、`cd /c` 的上下文陷阱、进程替换、静默非零退出。

## 为什么要这些规则：来自实测的数据

本插件的规则不是想出来的。下面每一条都在本机 Niubash 1.1.4 / WinuxCmd 1.0.8 上实测过（`test/guide.test.mjs` 会把手册里每个 ```bash 代码块用真实 `niu` 跑一遍，`test/dialect.test.mjs` 用上面这些真实 stderr 文本做回归）：

| 模型可能写的 | Niubash 实际反应 | 正确写法 |
|---|---|---|
| `echo $env:PATH` | 输出 `:PATH`，退出码 0（**静默错误**） | `echo "$PATH"` |
| `Get-ChildItem` / `Get-Content f` / `Test-Path p` | `command not found`（127） | `ls` / `cat f` / `[ -e p ]` |
| `ls -Recurse` | `ls: invalid option -- 'e'` | `ls -R`、`find . -name …` |
| `if ($x -eq 1) { }` | `syntax error near unexpected token '('` | `if [ "$x" -eq 1 ]; then …; fi` |
| `foreach ($i in 1..3) { }` | 同上 | `for i in 1 2 3; do …; done` |
| `@(1,2,3)` | 同上 | `arr=(1 2 3)` |
| `echo hi > $null` | `bash: line 1: : No such file or directory` | `>/dev/null`（`nul` 也行） |
| 行尾反引号续行 | `syntax error: unexpected EOF while looking for matching ')'` | 行尾 `\` |
| `awk '{print $1}' f` | `awk: command not found` | `cut -d, -f1`、`sed`、`python -c` |
| `cd /c`（在 `( … )` 里） | `cd: …\winuxcmd\c: No such file or directory` | `cd /c/Windows`、`cd C:/` |
| `cat <(echo hi)` | `cat: <(echo hi): No such file or directory` | `tmp=$(mktemp); echo hi > "$tmp"; cat "$tmp"` |
| `unzip a.zip` | `unzip: command not found` | `tar -xf a.zip` |

工具清单同样是实测的（`test/guide.test.mjs` 会断言这张表与机器一致）：

- **有**：`ls cat grep sed find head tail wc sort uniq tr cut xargs tee diff patch du df ps less which env printf sleep seq mktemp od stat realpath basename dirname sha256sum md5sum base64 yes touch rm cp mv ln chmod tar curl tree more dir dos2unix`，外加 `PATH` 上的 Windows 程序（`git` `node` `python` `pip` `cargo` `dotnet` `where` `findstr` `tasklist` `taskkill` `attrib` `xcopy`）。
- **没有**：`awk jq yq rg perl make cmake gcc clang zip unzip 7z bc vim nano wget iconv ffmpeg`（以及本机 `PATH` 上没有的 `java gradle mvn`）。

## 安装

```sh
# 从 GitHub 直接安装进某个 profile（推荐，不需要 npm 发布）
dsh plugin --profile web add github:YMRwithNoworry/dsh-niubash-only

# 锁定提交可复现（可选）
dsh plugin --profile web add github:YMRwithNoworry/dsh-niubash-only#<sha>

# 或安装本地 checkout
dsh plugin --profile web add file:/path/to/dsh-niubash-only
```

安装后**重启该 profile**。`dsh plugin` 会把包登记进 `dsh.profile.bundles`（本包声明了 `dsh.bundle.patch`），补丁层会把执行器与教学层两行插进组合树。

> **⚠️ 先卸掉/禁用别的 shell 提供者**：一个上下文只允许一个 `ctx.shell` 提供者。如果 profile 里已经有别的 shell 执行器 bundle，必须先处理，否则启动时会因重复注册 `shell` 服务而失败。最常见的两个：
>
> ```sh
> # 之前的 Nushell 插件
> dsh plugin --profile web remove dsh-nushell-only
> # 旧的 Winuxsh/Niubash bundle（它自己的 winuxsh-sandbox 也是一行 shell 提供者）
> dsh plugin --profile web remove @cmx666/dsh-winuxsh-bundle
> ```
>
> 若想保留那个 bundle 的其他功能（例如它的 Web 设置卡片），也可以只在 profile 的 `cordis.patch.yml` 里禁用它那一行：
>
> ```yaml
> - id: winuxsh-sandbox
>   disabled: true
> ```
>
> **另一个真实的坑**：`@cmx666/dsh-winuxsh-bundle@0.1.0-rc.8` 里把可执行文件名硬编码成了 `winuxsh`，而 Niubash 改名后二进制叫 `niu.exe`——装了它又没装同名 shim，所有 shell 调用都会以 `spawn winuxsh ENOENT` 失败。本插件按 `niu.exe` 解析，并在 `PATH` 找不到时回退到安装目录（见下），不受影响。

验证：

```sh
dsh --profile web --dump-config | grep -n niubash
# 期望看到：bash-sandbox / pwsh-sandbox = disabled，以及 niubash-executor、niubash-teaching 两行
```

## 配置

补丁层默认配置（`cordis.patch.yml`）：

```yaml
- id: niubash-executor
  name: dsh-niubash-only/executor
  config:
    timeoutMs: 120000
    maxTimeoutMs: 600000
    maxOutputBytes: 64000
    graceMs: 3000
    enforceNiubashOnly: true   # 拒绝把命令交给别的 shell
    dialectLint: true          # spawn 前拒绝 PowerShell/CMD 习惯，并给出 Bash 写法
    dialectHints: true         # 失败时按真实错误文本追加一行 Niubash hint
    requireNiubash: true       # 找不到 niu 就启动失败（而不是每次调用都失败）
    verifyNiubash: true        # 启动时跑一次 `niu --version`
    probeNativeShells: true    # 探测本机 bash/sh 是否解析到 Niubash，决定是否放行
    smokeTest: true            # 启动时跑一条真实命令，被沙箱挡住就当场把原因报出来

- id: niubash-teaching
  name: dsh-niubash-only/teaching
  config:
    guide: full                # full | compact | off
    rules: true
    rewriteToolDescriptions: true
```

执行器可选项：

| 字段 | 默认 | 含义 |
|---|---|---|
| `niuPath` | `$DSH_NIU_PATH` → `PATH` → 安装目录 → `niu.exe` | Niubash 可执行文件 |
| `niuArgs` | `['-c']` | argv 前缀，命令追加在最后 |
| `enforceNiubashOnly` | `true` | 守卫开关 |
| `foreignShellAllowlist` | `[]` | 整条命令匹配的正则（字符串），命中则放行（守卫与方言预检共用） |
| `dialectLint` | `true` | spawn 前拒掉 PowerShell/CMD 习惯 |
| `dialectHints` | `true` | 失败时在 stderr 末尾追加一行 `Niubash hint (…)` |
| `requireNiubash` | `true` | 无法解析 `niu` 时启动即失败 |
| `verifyNiubash` / `verifyTimeoutMs` | `true` / `10000` | 启动探测 `niu --version` 及其超时 |
| `smokeTest` | `true` | 启动时走一次真实调用路径（`echo niubash-smoke-ok`），把"沙箱挡住 `niu -c`"这类启动期故障写在启动日志里（见"沙箱模式与 Niubash"） |
| `probeNativeShells` | `true` | 启动探测 `command -v bash; command -v sh`，据此决定 `bash`/`sh` 放行与否 |

**可执行文件解析顺序**：`niuPath` → `DSH_NIU_PATH` → `PATH` 里第一个含 `niu.exe` 的目录 → 已知安装目录（`%LOCALAPPDATA%\Programs\Niubash`、`%ProgramFiles%\Niubash`、`%ProgramFiles(x86)%\Niubash`）→ 裸 `niu.exe`。
安装目录这一档是刻意的：Niubash 安装程序把目录加进**用户 PATH** 后广播环境变更，但已经在运行的 harness 进程仍持有启动时的环境——回退到文档化的安装目录，可以让部署不必重启宿主。

`cwd`、`timeoutMs`、`maxTimeoutMs`、`maxOutputBytes`、`maxSpillBytes`、`graceMs` 沿用 dsh 自己的 `shell` 设置命名空间，`settings.yaml` 的 `shell:` 段仍然可以热改预算。

在本 profile 的 `cordis.patch.yml` 里按 id 覆盖即可，例如：

```yaml
- id: niubash-executor
  config:
    niuPath: 'C:\Users\me\AppData\Local\Programs\Niubash\niu.exe'
    enforceNiubashOnly: false
```

## "只用 Niubash" 的边界

插件能保证的是**经过 `ctx.shell` 的一切**都是 Niubash。以下情况它管不到，README 明说，避免误判：

1. **preset 里自己 spawn shell 的行**。例如某个 preset 的 `custom-bash.mjs`（直接 `ctx.subprocess.spawn(['bash.exe','-c',…])`）或 `persistent-shell` 组（PTY 常驻 shell）。这类工具绕开 `ctx.shell`，插件既无法改写它的执行，也**不会**改写它的描述（描述重写只针对自称 `bash -c` / `pwsh -Command` 的第一方工具，以免说谎）。要用 Niubash-only，请在这些 preset 文件里把对应行 `disabled: true`，或把 `persistent-shell` 组整体禁用。
2. **嵌套调用**。`niu -c 'python -c "import subprocess; …"'` 里层是别的程序，守卫按设计只看语句首词与执行的命令替换，不做进程级沙箱。守卫挡的是"模型想绕过 Niubash"这类显式 handoff，不是安全边界。
3. **`bash`/`sh` 的条件放行**。只有启动探测证明它们解析到 Niubash 安装目录时才放行；探测失败（例如 `niu` 起不来）时一律拒绝，错误信息里会说明原因与放宽方式。
4. **`dsh-hooks-claude-code` / `dsh-hooks-codex` 的 hook 命令**。它们通过 `ctx.shell` 执行，现在就是 Niubash：**为 PowerShell 写的 hook 会失败**，为 Bash 写的 hook 正常工作。
5. **TUI 的常驻 PTY shell**（`dsh-terminal-bash` + `dsh-tool-bash-persistent`）走的是 terminal 接缝，不是 `ctx.shell`，插件不替换它。

沙箱与权限不变：`danger-full-access` 直接执行，受限模式仍然经 `ctx.sandbox.confine()` 包裹 Niubash 的 argv，并照常上报 `mode` / `denied` / `enforcement` 事实。

## 沙箱模式与 Niubash

`niu -c` 在构造 shell 时会打开 `$HOME/.niubash_history`——哪怕这一发命令根本不需要历史。受限沙箱（`workspace-write` / `read-only`）不允许写工作区以外的路径，于是 `niu` 在跑任何命令**之前**就退出：

```text
niu: failed to open history provider C:\Users\me\.niubash_history: I/O error: 拒绝访问。 (os error 5)
```

这是 Niubash 宿主层的限制，不是插件拒绝执行：插件既不能替它跳过历史文件，也不该在这种模式下假装一切正常。所以：

- 执行器启动时跑一次**冒烟测试**（`smokeTest: true`，默认开）。它走的正是模型工具调用那条路径（`run(resolve({ command }))`），因此真被沙箱挡住时，启动日志里会**当场**出现上面那行原因与两个可行做法——改用 `danger-full-access` 权限档，或让沙箱能访问历史文件——而不是等到每次工具调用都报同一句难懂的错。
- 这条事实通过 shell 服务的 `niuSmoke`（`{ ok, detail }`）暴露给进程内消费者。集成测试据此把"需要真命令"的断言标成 SKIP 而不是 FAIL，但**仍然逐条验证**拒绝类行为（外部 shell handoff、方言预检）与提示词装配——它们都发生在 spawn 之前，与沙箱无关。

**结论**：在 Windows 上用 Niubash 跑 dsh，请把权限档设为 `danger-full-access`（`DSH_PERMISSION_MODE=danger-full-access`，或 web UI 里的同名权限预设）。本机实测：`danger-full-access` 下集成测试 35/35 全过；`workspace-write` 下 26/26 通过 + 8 条 SKIP，SKIP 全部由上面这条限制解释。

## 教学层给了模型什么

`guide: full` 时，系统提示里会出现（顺序紧贴 shell 工具引导位）：

- 规则段：方言是 Bash（Niubash/rubash）、每次调用全新进程（`cd`/变量/`export`/alias 不保留，用 `workdir`）、不加载 `~/.niubashrc`、换 shell 会被拒、PowerShell 习惯会被拒（含 `$env:NAME` 的静默陷阱）、退出码与 127、工具清单、路径契约。
- 语法手册：Bash 语言要点（数组、`case`、`[[ ]]`、`$(( ))`、`${v^^}`、heredoc、函数、`set -euo pipefail`）。
- 工具清单：**确实存在**的 Unix 命令与**确实缺失**的命令，以及缺失时的替代（`python` / `node` / `cargo` / `tar` / `sed` / `cut`）。含两行可跑的"没有 jq 也能解析 JSON"示例。
- 路径契约：`/c/…`、`C:/…`、`C:\…` 三写法；参数到原生程序时的自动转换；`cd /c` 的上下文陷阱；`/` 是 Niubash 自己的 Unix 根（`/tmp`、`/dev/null`、`mktemp` 都在里面）；单引号与反斜杠。
- 管道/重定向/退出码：`> >> 2> 2>&1 2>/dev/null &>`、`/dev/null` 与 `nul`、退出码原样、`pipefail`、以及"失败的命令不会自动中断后续"。
- 对照表：PowerShell→Bash（30 行，含 `$env:NAME`、`Get-*`、`Select-Object -First`、`-eq/-and`、`Invoke-WebRequest`、`ConvertTo-Json`、反引号续行…）与 CMD→Bash（`dir/del/copy/cls/type/findstr/%VAR%`…）。
- 失败目录：上表那些真实报错与修法，附一段可运行的正确写法。
- 坑：每次全新进程、rc 不加载（`ll`/`gst` 这类 alias 不存在）、`$env:` 静默错误、单横线逐字母、进程替换只部分可用、`where` 是 `where.exe`、`bash`/`sh` 就是 Niubash 自己、`/tmp` 在安装树里、长任务用后台 job、写脚本时 heredoc 体不受方言检查。

手册里的每个 ```bash 代码块都会被 `test/guide.test.mjs` 用**本机真实的 niu** 跑一遍，所以例子不是"看起来对"，而是跑得通。

## 开发与验证

```sh
node --test test/                 # 75 个单元测试（守卫 / 方言预检与提示 / 手册与工具清单 / 解析决策表 / 执行器 argv、启动探测与沙箱路径 / 教学层）
node test/integration.mjs         # 端到端：建临时 DSH_HOME、装 profile、真实启动、35 项断言
node test/integration.mjs --mode workspace-write   # 受限沙箱模式：命令类断言按"沙箱模式与 Niubash"那条限制 SKIP，其余照常断言
node dev/link-peers.mjs           # 把本机 dsh 安装里的 @deepseek-ai/* 软链到 node_modules/，供 checkout 直接跑测试
```

集成测试会依次验证：`ctx.shell` 就是 `NiubashExecutor`、`niu --version` 与 `bash/sh` 探测、**启动冒烟测试真跑通一条命令**、shell 内建、Unix 工具管道、原生 Windows 程序、非零退出以结果上报、**外部 shell handoff 被拒**、**Niubash 自己的 bash shim 放行**、**方言预检拒绝 `$env:PATH` 与 `ls -Recurse` 并给出 Bash 写法**、**失败调用带回 `Niubash hint`**、系统提示含规则/手册/对照表/失败目录/坑、`bash`/`pwsh` 描述与参数说明已改写、**preset 子 scope 里的 shell 工具同样被改写**、沙箱事实正确上报。可用 `DSH_INTEGRATION_CLI=/path/to/@deepseek-ai/dsh/lib/bin.js` 指定要驱动的 CLI。

## 排错

| 现象 | 处理 |
|---|---|
| 启动报 `cannot resolve the Niubash executable` | 装 Niubash（它会把 `niu.exe` 放进用户 PATH）/ 设 `niuPath` 或 `DSH_NIU_PATH` / 启动宿主重读环境；临时先跑可设 `requireNiubash: false` |
| 启动报 `failed its --version probe` | `niu.exe` 不可执行或损坏；`verifyNiubash: false` 可跳过探测 |
| 启动日志报 `failed to open history provider … 拒绝访问`，之后每次调用都同样失败 | 受限沙箱不让 `niu` 写 `$HOME/.niubash_history`（Niubash 宿主层限制）。改用 `danger-full-access`，或让沙箱能访问该文件；详见"沙箱模式与 Niubash" |
| 启动报重复注册 `shell` 服务 | 还有别的 shell 执行器 bundle（`dsh-nushell-only`、`@cmx666/dsh-winuxsh-bundle`…）没卸掉或没禁用 |
| 工具调用报 `Niubash-only shell: refusing to hand this command to …` | 命令里在调 `powershell`/`cmd`/`wsl`/`nu` 或非 Niubash 的 `bash`；按提示改写成 Bash，或确有需要时用 `foreignShellAllowlist` / `enforceNiubashOnly: false` |
| 工具调用报 `refusing a powershell-…`，但命令其实是合法 Bash | 误判：把整条命令写进 `foreignShellAllowlist`；`lib/dialect.js` 的规则都带 id，便于定位 |
| 命令输出 `:PATH` 之类莫名其妙的结果 | 那就是 `$env:NAME` 的静默错误（若预检被关掉了）；改成 `$NAME` |
| 明明装了某个程序却 `command not found` | 用 `command -v <name>` 确认；Niubash 的 Unix 命令来自 WinuxCmd，`awk`/`jq`/`rg`/`unzip` 等确实没有（用 `python`/`node`/`tar` 替代） |
| 模型仍写 PowerShell | 检查 `guide: full`、`rewriteToolDescriptions: true`；再看模型侧 `toolOrder`/preset 是否把 shell 工具换成了自建工具（见"边界"第 1 条） |

## 许可

MIT。

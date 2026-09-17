/**
 * The "only Niubash" guard: refuse a command that hands execution to another
 * shell.
 *
 * Replacing the `ctx.shell` provider already means *the harness* only ever runs
 * Niubash. This guard closes the remaining escape hatch the model controls: a
 * Bash command that immediately delegates to PowerShell, `cmd`, WSL, Nushell,
 * or a Git Bash/MSYS `bash` would leave the dialect (and, on Windows, the
 * sandbox's process expectations) behind, and the model would get a confusing
 * error from the other shell instead of a rule it can follow.
 *
 * Two classes of "shell" tokens are treated differently on purpose:
 *
 * - **Definitely foreign** (`pwsh`, `powershell`, `cmd`, `wsl`, `nu`, `zsh`,
 *   `fish`, …): always refused. No Niubash deployment ever needs them, because
 *   the whole point of the deployment is that Bash is available natively.
 * - **`bash` / `sh`**: Niubash ships its own shims for these, and those shims
 *   *are* rubash — the same engine. Handing a command to them stays inside the
 *   dialect, so they are allowed — but only after the boot probe proves that
 *   is what they resolve to. A `bash` that resolves to `C:\Program Files\Git`
 *   or `C:\Windows\System32\bash.exe` (WSL) is refused, whether it was named
 *   bare or by absolute path.
 *
 * The detector is deliberately narrow: it looks at the first word of every
 * statement in the command (statements being `;`, newline, `|`, `&`, and
 * `&&`/`||` separated), after skipping command wrappers (`sudo`, `env`, …) and
 * `NAME=value` prefixes, and after leading `(`, `{`, and `$(` punctuation so
 * `(pwsh -c …)` and `$(nu -c …)` are seen. A foreign shell named anywhere else
 * — as an argument to a program that is not a shell, inside a string, or in a
 * heredoc body — is not this guard's business.
 *
 * @module dsh-niubash-only/guard
 */

import { normalizeShellPath } from './niubash.js'

/** Shells a Niubash-only deployment never hands a command to. */
export const FOREIGN_SHELLS = new Set([
  'pwsh',
  'powershell',
  'pwsh-preview',
  'cmd',
  'wsl',
  'wslconfig',
  'nu',
  'nushell',
  'zsh',
  'fish',
  'ksh',
  'mksh',
  'pdksh',
  'dash',
  'ash',
  'csh',
  'tcsh',
  'yash',
  'xonsh',
  'elvish',
  'oil',
  'osh',
  'gitbash',
  'git-bash',
  'busybox',
  'cscript',
  'wscript',
])

/**
 * POSIX shells Niubash itself provides as shims for the same engine. Whether
 * they are allowed depends on what they resolve to at runtime.
 */
export const NIUBASH_SHELL_NAMES = new Set(['bash', 'sh'])

/** Names that are Niubash itself (or a compatibility shim for it). */
export const SELF_SHELL_NAMES = new Set(['niu', 'niubash', 'winuxsh', 'rubash'])

/** Command wrappers skipped while looking for the real program of a statement. */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'exec',
  'nohup',
  'nice',
  'time',
  'timeout',
  'xargs',
  'setsid',
  'stdbuf',
])

/** An assignment prefix (`FOO=bar`) is a wrapper too, never the program itself. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** Leading punctuation that is not part of the program name. */
const LEADING_PUNCTUATION = /^[({$]+/

/**
 * Compile the allowlist: whole-command regular expressions that override the
 * guard (for a deployment that genuinely needs one foreign-shell call site).
 * @param patterns - regex sources from the `foreignShellAllowlist` config.
 * @returns compiled expressions.
 * @throws Error when an entry is not a string or does not compile.
 */
export function compileForeignShellAllowlist(patterns) {
  if (patterns === undefined || patterns === null) return []
  if (!Array.isArray(patterns)) throw new Error('dsh-niubash-only: foreignShellAllowlist must be an array of regular expression strings')
  return patterns.map((pattern) => {
    if (typeof pattern !== 'string') throw new Error('dsh-niubash-only: foreignShellAllowlist entries must be strings')
    try {
      return new RegExp(pattern)
    } catch (error) {
      throw new Error(`dsh-niubash-only: foreignShellAllowlist entry ${JSON.stringify(pattern)} is not a valid regular expression: ${String(error)}`)
    }
  })
}

/**
 * Blank out heredoc bodies, preserving length and newlines so every offset
 * still points at the original command.
 *
 * Without this, a command that *writes a script* (`cat > run.sh <<'EOF' … EOF`)
 * would be judged by the text it is writing — a heredoc body full of
 * PowerShell would be refused as if it were being executed.
 * @param text - the command source.
 * @returns a same-length view with heredoc bodies replaced by spaces.
 */
export function blankHeredocBodies(text) {
  if (typeof text !== 'string' || !text.includes('<<')) return text
  const chars = text.split('')
  const pending = []
  let index = 0
  let quote = null
  while (index < chars.length) {
    const char = chars[index]
    if (quote !== null) {
      if (char === '\\' && quote === '"') {
        index += 2
        continue
      }
      if (char === quote) quote = null
      index++
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      index++
      continue
    }
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '#' && (index === 0 || /[\s;&|(]/.test(chars[index - 1] ?? ' '))) {
      while (index < chars.length && chars[index] !== '\n') index++
      continue
    }
    if (char === '<' && chars[index + 1] === '<' && chars[index + 2] !== '<') {
      let cursor = index + 2
      let stripTabs = false
      if (chars[cursor] === '-') {
        stripTabs = true
        cursor++
      }
      while (chars[cursor] === ' ' || chars[cursor] === '\t') cursor++
      const delimiterQuote = chars[cursor] === "'" || chars[cursor] === '"' ? chars[cursor] : null
      if (delimiterQuote !== null) cursor++
      let word = ''
      while (cursor < chars.length && /[A-Za-z0-9_]/.test(chars[cursor])) {
        word += chars[cursor]
        cursor++
      }
      if (delimiterQuote !== null && chars[cursor] === delimiterQuote) cursor++
      if (word.length > 0) pending.push({ word, stripTabs })
      index = cursor
      continue
    }
    if (char === '\n' && pending.length > 0) {
      let cursor = index + 1
      for (const item of pending) {
        while (cursor < chars.length) {
          const newline = text.indexOf('\n', cursor)
          const lineEnd = newline === -1 ? chars.length : newline
          const line = text.slice(cursor, lineEnd)
          const candidate = item.stripTabs ? line.replace(/^\t+/, '') : line
          cursor = lineEnd + 1
          if (candidate.trim() === item.word) break
        }
      }
      for (let blanked = index + 1; blanked < Math.min(cursor, chars.length); blanked++) {
        if (chars[blanked] !== '\n') chars[blanked] = ' '
      }
      pending.length = 0
      index = cursor
      continue
    }
    index++
  }
  return chars.join('')
}

/**
 * Split a command into statement segments, honoring single/double quotes,
 * backslash escapes, and `#` comments so separators inside strings do not split.
 * @param command - the Bash source.
 * @returns one string per statement.
 */
export function splitStatements(command) {
  const segments = []
  let current = ''
  let quote = null
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (quote !== null) {
      if (char === '\\' && quote === '"') {
        current += char
        index++
        current += command[index] ?? ''
        continue
      }
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      current += char
      continue
    }
    if (char === '\\') {
      current += char
      index++
      current += command[index] ?? ''
      continue
    }
    if (char === '#' && (index === 0 || /[\s;&|(]/.test(command[index - 1] ?? ' '))) {
      segments.push(current)
      current = ''
      while (index < command.length && command[index] !== '\n') index++
      continue
    }
    if (char === ';' || char === '\n' || char === '|' || char === '&') {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

/**
 * Read the whitespace-separated tokens of one statement, keeping quoted runs
 * together and dropping the quotes.
 * @param text - one statement segment.
 * @returns the token list.
 */
export function tokenize(text) {
  const tokens = []
  let index = 0
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index++
    if (index >= text.length) break
    let quote = text[index] === "'" || text[index] === '"' ? text[index] : null
    if (quote !== null) {
      index++
      let token = ''
      while (index < text.length && text[index] !== quote) {
        if (text[index] === '\\' && quote === '"') {
          token += text[index]
          index++
        }
        token += text[index] ?? ''
        index++
      }
      index++
      tokens.push(token)
      continue
    }
    let token = ''
    while (index < text.length && !/\s/.test(text[index])) {
      token += text[index]
      index++
    }
    tokens.push(token)
  }
  return tokens
}

/** Drop the Bash sigils from a token (`^cmd` is not Bash, but `\cmd` and `$(…)` are common). */
function stripSigil(token) {
  let value = token
  while (value.length > 0 && value[0] === '\\') value = value.slice(1)
  return value
}

/** Basename of a program token, lowercased and extension-free (`C:\…\cmd.exe` → `cmd`). */
export function programName(token) {
  const cleaned = stripSigil(token).replace(/^["']|["']$/g, '')
  if (cleaned.length === 0) return ''
  const base = cleaned.split(/[\\/]/).pop() ?? ''
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '')
}

/** Whether a token names a file rather than a bare command. */
function isPathToken(token) {
  return /[\\/]/.test(stripSigil(token).replace(/^["']|["']$/g, ''))
}

/**
 * The program token of one statement, after skipping wrappers, assignments, and
 * leading `(` / `{` / `$(` punctuation.
 * @param statement - one statement segment.
 * @returns the token index and value, or undefined when the statement runs nothing.
 */
function programToken(statement) {
  const tokens = tokenize(statement)
  let index = 0
  for (let wrapper = 0; wrapper <= 6 && index < tokens.length; wrapper++) {
    const token = tokens[index]
    const bare = token.replace(LEADING_PUNCTUATION, '')
    if (bare.length === 0) {
      index++
      continue
    }
    if (bare !== token) {
      // `(cmd`, `{cmd`, `$(cmd`: re-examine the stripped token in place.
      tokens[index] = bare
      continue
    }
    if (ASSIGNMENT.test(token) || WRAPPERS.has(programName(token))) {
      index++
      continue
    }
    break
  }
  const token = tokens[index]
  if (token === undefined) return undefined
  return { index, token }
}

/**
 * Classify a shell-program token against the deployment's shell facts.
 * @param token - the program token of a statement.
 * @param options - `nativeShells` facts from the boot probe.
 * @returns the classification, or undefined when the token is not a shell.
 */
export function classifyShellToken(token, options = {}) {
  const name = programName(token)
  if (name.length === 0) return undefined
  if (SELF_SHELL_NAMES.has(name)) return { name, token, decision: 'self' }
  if (FOREIGN_SHELLS.has(name)) return { name, token, decision: 'foreign', reason: 'foreign-shell' }
  if (!NIUBASH_SHELL_NAMES.has(name)) return undefined
  const native = options.nativeShells ?? {}
  const nativeNames = new Set(native.names ?? [])
  const nativePaths = new Set(native.paths ?? [])
  if (isPathToken(token)) {
    const normalized = normalizeShellPath(token)
    if (nativePaths.has(normalized)) return { name, token, decision: 'native', reason: 'probed-path' }
    if (normalized.includes('/winuxcmd/') || normalized.includes('/niubash/')) return { name, token, decision: 'native', reason: 'install-path' }
    return { name, token, decision: 'foreign', reason: 'foreign-path' }
  }
  if (nativeNames.has(name)) return { name, token, decision: 'native', reason: 'probed-name' }
  return { name, token, decision: 'foreign', reason: 'unproven-name' }
}

/**
 * The bodies of the substitutions Bash actually executes: `$( … )` and
 * `` ` … ` `` outside single quotes (inside double quotes they still run).
 *
 * This is what catches `x=$(powershell -Command …)` and
 * `echo "$(cmd /c dir)"`, which are real handoffs even though the statement's
 * first word is an assignment or `echo`.
 * @param text - the command source (heredoc bodies already blanked).
 * @returns the inner text of each executed substitution.
 */
export function commandSubstitutions(text) {
  const bodies = []
  const chars = text.split('')
  let index = 0
  let inSingle = false
  while (index < chars.length) {
    const char = chars[index]
    if (inSingle) {
      if (char === "'") inSingle = false
      index++
      continue
    }
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === "'") {
      inSingle = true
      index++
      continue
    }
    if (char === '$' && chars[index + 1] === '(' && chars[index + 2] !== '(') {
      let depth = 1
      let cursor = index + 2
      while (cursor < chars.length && depth > 0) {
        if (chars[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (chars[cursor] === '(') depth++
        else if (chars[cursor] === ')') depth--
        if (depth === 0) break
        cursor++
      }
      bodies.push(text.slice(index + 2, Math.min(cursor, chars.length)))
      index = cursor + 1
      continue
    }
    if (char === '`') {
      const end = text.indexOf('`', index + 1)
      bodies.push(text.slice(index + 1, end === -1 ? chars.length : end))
      index = (end === -1 ? chars.length : end) + 1
      continue
    }
    index++
  }
  return bodies
}

/**
 * Every shell reference in a command, with its classification: one entry per
 * statement that names a shell, plus one per executed command substitution that
 * does (recursively, to a shallow depth).
 * @param command - the Bash source.
 * @param options - `nativeShells` facts from the boot probe.
 * @returns the classified shell references.
 */
export function findShellReferences(command, options = {}) {
  if (typeof command !== 'string' || command.trim().length === 0) return []
  const view = blankHeredocBodies(command)
  const references = []
  for (const statement of splitStatements(view)) {
    const program = programToken(statement)
    if (program === undefined) continue
    const classification = classifyShellToken(program.token, options)
    if (classification === undefined) continue
    references.push({ ...classification, statement: statement.trim() })
  }
  const depth = options.depth ?? 0
  if (depth < 3) {
    for (const body of commandSubstitutions(view)) {
      for (const nested of findShellReferences(body, { ...options, depth: depth + 1 })) {
        references.push({ ...nested, substitution: true })
      }
    }
  }
  return references
}

/**
 * Find the first statement that hands execution to a shell this deployment
 * refuses.
 * @param command - the Bash source.
 * @param options - `nativeShells` facts from the boot probe.
 * @returns the refused handoff, or undefined when the command is clean.
 */
export function findForeignShellHandoff(command, options = {}) {
  return findShellReferences(command, options).find((reference) => reference.decision === 'foreign')
}

/**
 * The model-facing refusal: names the shell, states the rule, and shows the
 * Niubash way, because a dead end without a translation teaches nothing.
 * @param handoff - the detected handoff.
 * @returns the error message.
 */
export function handoffMessage(handoff) {
  const explanation = handoff.reason === 'unproven-name'
    ? `\`${handoff.name}\` was refused because it does not resolve to Niubash's own shim in this deployment (it would run Git Bash, MSYS, or WSL Bash instead).`
    : handoff.reason === 'foreign-path'
      ? `\`${handoff.token}\` points at a shell outside the Niubash install.`
      : `\`${handoff.name}\` is a different shell.`
  return [
    `Niubash-only shell: refusing to hand this command to \`${handoff.name}\``,
    '',
    explanation,
    'Every shell command in this deployment runs through Niubash (`niu -c "<command>"`), which speaks Bash natively on Windows: `bash`/`sh` from Niubash are the same rubash engine, but PowerShell, `cmd`, WSL, Nushell, and Git Bash are not available and are refused.',
    `Offending statement: ${JSON.stringify(handoff.statement.slice(0, 200))}`,
    '',
    'Write the command in Bash instead of delegating: PowerShell `Get-ChildItem` → `ls`, `Get-Content f` → `cat f`, `$env:VAR` → `$VAR`, `cmd /c dir` → `ls`, `wsl ls` → `ls`, `nu -c "…"` → the Bash equivalent. Unix tools (`ls`, `grep`, `sed`, `find`, …) ship with Niubash through WinuxCmd.',
    'If a foreign shell is genuinely required for one call site, ask the user to relax the guard (executor config `enforceNiubashOnly: false` or `foreignShellAllowlist`).',
  ].join('\n')
}

/**
 * Throw unless the command stays inside Niubash. Infrastructure failures are
 * thrown, never rendered as command output, so the caller sees the rule rather
 * than a confusing error from another shell.
 * @param command - the Bash source about to run.
 * @param options - compiled allowlist patterns and `nativeShells` facts.
 * @throws Error describing the refusal when a foreign-shell handoff is found.
 */
export function assertNiubashOnly(command, options = {}) {
  const allow = options.allow ?? []
  if (allow.length > 0 && allow.some((pattern) => pattern.test(command))) return
  const handoff = findForeignShellHandoff(command, options)
  if (handoff !== undefined) throw new Error(handoffMessage(handoff))
}

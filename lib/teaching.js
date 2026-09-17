/**
 * The teaching layer: make the model write Bash that Niubash actually runs.
 *
 * Three contributions, all host-plane and therefore in force for every agent —
 * including agents composed from an agent preset, whose shell tool rows are
 * mounted inside the preset:
 *
 * 1. `shell: niubash-rules` — a short, imperative prompt section at the shell
 *    tool's own prompt position.
 * 2. `shell: niubash-guide` — the Bash-on-Windows guide: runnable syntax, the
 *    tool inventory, the path contract, the PowerShell/CMD translation tables,
 *    the real failure catalogue, and the traps. Evaluated per assembly so it can
 *    name the probed Niubash and WinuxCmd versions.
 * 3. A `system-prompt/assemble` listener that rewrites the shell tool's
 *    description (and its `command` parameter) into what this deployment
 *    actually runs. The tool *name* stays `bash` — presets, `toolOrder` lists,
 *    and instruction files reference that name, and Bash is the dialect — but
 *    nothing the model reads still claims PowerShell, or claims that
 *    `~/.niubashrc`, `awk`, or `jq` are available.
 *
 * @module dsh-niubash-only/teaching
 */

import { NIUBASH_COMMAND_PARAM_DESCRIPTION, buildGuide, buildShellRules, buildToolDescription } from './guide.js'
import { niuRuntime } from './niubash.js'

/** Plugin name used by loader diagnostics. */
export const name = 'niubash-teaching'

/** Prompt contributions need the system-prompt registry. */
export const inject = ['systemPrompt']

/** Prompt section name of the mandatory rules. */
export const RULES_SECTION = 'shell:niubash-rules'

/** Prompt section name of the syntax guide. */
export const GUIDE_SECTION = 'shell:niubash-guide'

/** Tool names whose descriptions are rewritten. */
const DEFAULT_TOOL_NAMES = ['bash', 'pwsh']

/**
 * A description is only rewritten when it claims a foreign dialect, or when it
 * already describes Niubash (idempotent). A deployment can register a
 * same-named tool that spawns its own shell — a preset's `custom-bash.mjs` on
 * Windows, for example, or the `pwsh` tool of a composition that re-enabled the
 * PowerShell row — and rewriting that description would make the schema lie
 * about what actually runs, so it is left exactly as its owner wrote it. The
 * README explains how to find and remove such a bypass.
 */
const FOREIGN_DIALECT_CLAIM = /bash -[a-z]*c\b|pwsh -[a-z]*c\b|Execute a (?:bash|PowerShell|pwsh) command|Niubash/i

/**
 * Validate the teaching config at load, so a typo fails the boot instead of
 * silently dropping a teaching contribution.
 * @param config - the composition entry's config.
 * @returns the normalized options.
 */
export function normalizeConfig(config = {}) {
  const source = config ?? {}
  const guide = source.guide ?? 'full'
  if (guide !== 'full' && guide !== 'compact' && guide !== 'off') {
    throw new Error(`dsh-niubash-only: guide must be "full", "compact", or "off"; got ${JSON.stringify(guide)}`)
  }
  const toolNames = source.toolNames ?? DEFAULT_TOOL_NAMES
  if (!Array.isArray(toolNames) || toolNames.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error('dsh-niubash-only: toolNames must be an array of non-empty strings')
  }
  return {
    guide,
    rules: source.rules !== false,
    rewriteToolDescriptions: source.rewriteToolDescriptions !== false,
    toolNames,
  }
}

/** Resolve a centrally allocated prompt order, falling back for a version change. */
function sectionOrder(ctx, placement, fallback) {
  try {
    const value = ctx.systemPrompt.getSectionOrder(placement)
    return Number.isFinite(value) ? value : fallback
  } catch {
    return fallback
  }
}

/**
 * Rewrite one assembled tool schema into what this deployment runs.
 * @param tool - the assembled tool schema.
 * @param options - normalized teaching options.
 * @returns the rewritten schema, or the original when it is not a shell tool.
 */
function rewriteTool(tool, options) {
  if (tool === null || typeof tool !== 'object') return tool
  if (!options.toolNames.includes(tool.name)) return tool
  const parameters = tool.parameters
  const properties = parameters?.properties
  if (properties === null || typeof properties !== 'object' || properties.command === undefined) return tool
  const description = typeof tool.description === 'string' ? tool.description : ''
  if (!FOREIGN_DIALECT_CLAIM.test(description)) return tool
  return {
    ...tool,
    description: buildToolDescription({
      background: Object.hasOwn(properties, 'run_in_background'),
      escalation: Object.hasOwn(properties, 'sandbox_permissions'),
      guide: options.guide !== 'off',
    }),
    parameters: {
      ...parameters,
      properties: {
        ...properties,
        command: {
          ...properties.command,
          description: NIUBASH_COMMAND_PARAM_DESCRIPTION,
        },
      },
    },
  }
}

/**
 * Apply the teaching layer.
 * @param ctx - the plugin context (`systemPrompt` is injected).
 * @param config - the composition entry's config.
 */
export function apply(ctx, config = {}) {
  const options = normalizeConfig(config)
  const shellOrder = sectionOrder(ctx, 'TOOL_BASH', 1000)

  if (options.rules) {
    ctx.systemPrompt.section({
      name: RULES_SECTION,
      order: shellOrder,
      text: buildShellRules(),
    })
  }

  if (options.guide !== 'off') {
    ctx.systemPrompt.section({
      name: GUIDE_SECTION,
      order: shellOrder + 1,
      text: () => buildGuide({ variant: options.guide, version: niuRuntime.version, winuxcmd: niuRuntime.winuxcmd }),
    })
  }

  if (options.rewriteToolDescriptions) {
    ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const result = await next()
      if (result === null || typeof result !== 'object' || !Array.isArray(result.tools)) return result
      const tools = result.tools.map((tool) => rewriteTool(tool, options))
      return { ...result, tools }
    })
  }

  try {
    const shell = [niuRuntime.version === undefined ? undefined : `Niubash ${niuRuntime.version}`, niuRuntime.winuxcmd === undefined ? undefined : `WinuxCmd ${niuRuntime.winuxcmd}`].filter((entry) => entry !== undefined).join(', ')
    ctx.logger.info(`dsh-niubash-only: teaching Bash-on-Windows${shell.length === 0 ? '' : ` (${shell})`} — guide: ${options.guide}, tool descriptions: ${options.rewriteToolDescriptions ? 'rewritten' : 'untouched'}`)
  } catch {
    // Logging is best-effort.
  }
}

// The harness's module loader unwraps a `default` export before reading plugin
// metadata, so the injection declaration also lives on the function itself: a
// composition that mounts the bare package name still gets its dependencies
// injected.
apply.inject = inject

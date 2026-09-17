/**
 * `dsh-niubash-only` — a DeepSeek Harness profile bundle that makes Niubash the
 * harness's only shell and teaches the model to write Bash that Niubash runs.
 *
 * The bundle patch (`cordis.patch.yml`) mounts two rows:
 *
 * - `dsh-niubash-only/executor` — the `ctx.shell` provider that runs every
 *   command as `niu -c "<command>"` (plus the foreign-shell guard, the
 *   PowerShell/CMD dialect preflight, and the failure hints).
 * - `dsh-niubash-only/teaching` — prompt sections and tool-description rewrites.
 *
 * This root module re-exports both surfaces for programmatic use; its default
 * export is the teaching plugin, so a composition that mounts the bare package
 * name gets the teaching layer while `dsh-niubash-only/executor` stays the
 * explicit executor row.
 *
 * @module dsh-niubash-only
 */

export { NATIVE_SHELL_PROBE, NiubashExecutor, inject as executorInject, name as executorName } from './executor.js'
export { apply as applyTeaching, normalizeConfig as normalizeTeachingConfig, RULES_SECTION, GUIDE_SECTION } from './teaching.js'
export { buildGuide, buildShellRules, buildToolDescription, GUIDE_FENCE, NIUBASH_COMMAND_PARAM_DESCRIPTION } from './guide.js'
export {
  assertNiubashOnly,
  blankHeredocBodies,
  classifyShellToken,
  commandSubstitutions,
  compileForeignShellAllowlist,
  findForeignShellHandoff,
  findShellReferences,
  FOREIGN_SHELLS,
  NIUBASH_SHELL_NAMES,
  programName,
  SELF_SHELL_NAMES,
  splitStatements,
  tokenize,
} from './guard.js'
export {
  assertNiubashDialect,
  codeView,
  dialectHint,
  dialectMessage,
  DIALECT_HINT_IDS,
  DIALECT_RULE_IDS,
  findDialectIssue,
  FOREIGN_PROGRAM_NAMES,
  MISSING_PROGRAM_NAMES,
} from './dialect.js'
export {
  candidateInstallDirs,
  DEFAULT_NIU_ARGS,
  NIUBASH_PATH_ENV,
  niubashArgv,
  niubashExecutableName,
  niuRuntime,
  normalizeNiuArgs,
  normalizeShellPath,
  parseNativeShells,
  parseNiubashVersion,
  resolveNiubashPath,
  scanPath,
} from './niubash.js'
export { apply as default } from './teaching.js'

/**
 * Default delegate model derived from the caller's current main model.
 * User-decided policy (2026-09-16): fable→opus, opus→sonnet, sonnet→sonnet;
 * an explicit `model` argument always wins, and anything unrecognized
 * (deepseek mains, haiku, unknown ids) falls back to config.model.
 * Matches by substring so both aliases ('fable') and full ids
 * ('claude-sonnet-4-5', 'us.anthropic.claude-opus-…') resolve. Order matters
 * only if an id ever carried two family names, which none does today.
 *
 * Lives in its own dependency-free module so scripts/test-delegate-model.mjs
 * can import it without dragging in the host service graph.
 */
export function delegateModelFor(mainModel: string | undefined): string | undefined {
  if (!mainModel) return undefined
  const m = mainModel.toLowerCase()
  if (m.includes('fable')) return 'opus'
  if (m.includes('opus')) return 'sonnet'
  if (m.includes('sonnet')) return 'sonnet'
  return undefined
}

/** Claude Code CLI effort tiers, single source of truth for schema + follow. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Default delegate effort derived from the caller's current reasoning effort
 * (user policy 2026-09-16: delegation follows the main session's effort tier).
 * Only passes through values Claude Code actually accepts — a DSH session on
 * a provider with a foreign tier name falls back to config.effort. Explicit
 * `effort` argument always wins upstream.
 */
export function delegateEffortFor(mainEffort: string | undefined): string | undefined {
  if (!mainEffort) return undefined
  const e = mainEffort.toLowerCase()
  return (EFFORT_LEVELS as readonly string[]).includes(e) ? e : undefined
}

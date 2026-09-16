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

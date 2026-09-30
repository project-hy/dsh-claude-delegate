/**
 * Client half of dsh-claude-code: contributes a third `conversation.view` tab
 * ("Claude Code") next to Chat and Trajectory. Selecting it swaps the whole
 * conversation body for the delegation monitor panel.
 *
 * The registration is wrapped in `slots.inject` because a bare `register` would
 * throw when this bundle loads before ui-conversation declares the slot. A new
 * entry id sits alongside the built-in tabs (reusing an id would replace one);
 * the tab strip orders entries by plugin load order rather than by `order`, so
 * `order: 100` expresses intent while the actual position follows the profile.
 */
import { createApi } from './api.js'
import { createClaudeCodeView } from './ClaudeCodeView.js'
import { installStyles } from './styles.js'
import { t } from './locales.js'
import type { Context, JobsClient } from './types.js'

/** Services required before the panel can register (client runtime provides both). */
export const inject = ['slots', 'connection']

/**
 * Client plugin body.
 * @param ctx - the client cordis context (slots + connection).
 */
export function apply(ctx: Context): void {
  installStyles()
  // 0.2 moved the background-jobs roster into a first-class client service
  // (`ctx.jobs`, installed by ui-jobs) and dropped the session store's
  // `jobsBySession` mirror; the panel reads the service when it is there and
  // falls back to the mirror otherwise. Looked up rather than injected so the
  // bundle still loads on a 0.1.x client that has no such service.
  const jobs = ctx.get?.<JobsClient>('jobs')
  const ClaudeCodeView = createClaudeCodeView(createApi(ctx.connection), jobs)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'claude-code',
    order: 100,
    label: () => t('view.label'),
  }, ClaudeCodeView))
}

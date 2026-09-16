// Offline assertions for the follow-main-model delegation default
// (user-decided policy 2026-09-16: fable→opus, opus→sonnet, sonnet→sonnet).
// Run: node scripts/test-delegate-model.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { delegateModelFor, delegateEffortFor, EFFORT_LEVELS } from '../lib/delegate-model.js'

// --- the mapping itself --------------------------------------------------------
assert.equal(delegateModelFor('fable'), 'opus', 'fable main delegates opus')
assert.equal(delegateModelFor('opus'), 'sonnet', 'opus main delegates sonnet (cost downgrade)')
assert.equal(delegateModelFor('sonnet'), 'sonnet', 'sonnet main delegates sonnet')

// Full ids resolve like their aliases.
assert.equal(delegateModelFor('claude-sonnet-4-5'), 'sonnet')
assert.equal(delegateModelFor('us.anthropic.claude-opus-4-6-v1'), 'sonnet')
assert.equal(delegateModelFor('Claude Fable 5'), 'opus', 'case-insensitive')

// Unrecognized mains fall through to the configured fallback (undefined here).
assert.equal(delegateModelFor('deepseek-v4-flash'), undefined, 'non-claude main → no dynamic default')
assert.equal(delegateModelFor('haiku'), undefined, 'haiku unspecified by the policy → configured fallback')
assert.equal(delegateModelFor(undefined), undefined)
assert.equal(delegateModelFor(''), undefined)

// --- follow-main-effort (user-decided policy 2026-09-16) -----------------------
assert.deepEqual([...EFFORT_LEVELS], ['low', 'medium', 'high', 'xhigh', 'max'],
  'effort tiers are the Claude Code CLI set, single source of truth')
for (const tier of EFFORT_LEVELS) assert.equal(delegateEffortFor(tier), tier, `${tier} passes through`)
assert.equal(delegateEffortFor('MAX'), 'max', 'case-insensitive')
assert.equal(delegateEffortFor('ultra'), undefined, 'foreign tier name → configured fallback')
assert.equal(delegateEffortFor(undefined), undefined, 'no session effort → configured fallback')
assert.equal(delegateEffortFor(''), undefined)

// --- wiring: precedence and projection read live in the built artifact ---------
const built = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
assert.match(built, /args\.model\s*\?\?\s*\(config\.followMainModel !== false \? delegateModelFor\(main\.model\) : undefined\)\s*\?\?\s*config\.model/,
  'model precedence must be: explicit arg > follow-main-model > config fallback')
assert.match(built, /args\.effort\s*\?\?\s*\(config\.followMainEffort !== false \? delegateEffortFor\(main\.reasoningEffort\) : undefined\)\s*\?\?\s*config\.effort/,
  'effort precedence must be: explicit arg > follow-main-effort > config fallback')
assert.match(built, /followMainEffort: z\.boolean\(\)/, 'followMainEffort must be a configurable switch')
assert.match(built, /args\.cwd\s*\?\?\s*config\.cwd\s*\?\?\s*sessionCwd\(exec\.agent\)\s*\?\?\s*process\.cwd\(\)/,
  'cwd precedence must be: explicit arg > configured cwd > calling session cwd > process.cwd()')
assert.match(built, /session\?\.meta\?\.cwd \?\? a\?\.options\?\.cwd/,
  'session cwd must come from session meta with creation-time options as fallback')
assert.match(built, /stateOf\(a\.session, ['"]modelSelection['"]\)/,
  'main model must come from the live modelSelection projection (mid-session switches)')
assert.match(built, /state\?\.pending \?\? state\?\.lastUsed/,
  'pending selection (about to apply) must win over lastUsed')
// REGRESSION (0.4.0 → 0.4.1): this cordis has NO optional-inject form. Any
// name in `inject` blocks activation until the service exists, and the
// `{required, optional}` object form is read as literal service names
// "required"/"optional" — the fiber deadlocks ("waiting for services:
// required, optional") and the whole plugin tree fails to load.
const injectDecl = built.match(/export const inject = ([^;\n]+)/)?.[1] ?? ''
assert.match(injectDecl, /^\[/, 'inject must be the plain array form (no object form on this cordis)')
assert.doesNotMatch(injectDecl, /sessionProjections|required|optional/,
  'sessionProjections must NOT be injected — a missing service would block activation forever')
assert.match(built, /\.get\?\.\(['"]sessionProjections['"]\)/,
  'sessionProjections must be read lazily via ctx.get(), which bypasses the inject requirement')

console.log('test-delegate-model: all assertions passed')

/**
 * Where the foreground chat's spend ceiling comes from.
 *
 * `runChatTurnSdk`'s pre-turn check (`src/editor/agent-chat-sdk/run-chat-turn-sdk.ts`)
 * refuses a new turn once the session's cumulative cost crosses
 * `opts.costCeilingUsd`. This module is the single place that turns the raw
 * `.desde/config.json` `chat.costCeilingUsd` value into what gets passed
 * there. It lives outside the SDK-heavy runtime module on purpose, because
 * `editor-cli/src/server/chat-handler.ts` otherwise only loads that lazily to
 * keep `@anthropic-ai/claude-agent-sdk` out of paths that don't need it.
 *
 * **There is no default ceiling** (changed 2026-08-14, at Mo's request). A
 * project that says nothing about cost gets unlimited spend. Audit Task 15 had
 * introduced a $20 soft default; this reverses that half of it deliberately.
 *
 * The reason it went is that the limit was never visible. There is no cost
 * meter, no remaining-budget chip and no setting anywhere in the product, so
 * the number reached the user in exactly one place: the refusal string, at the
 * moment a long session stopped working. A budget nobody was told about does
 * not read as a budget, it reads as a bug. For a single-user local tool, the
 * honest fix is to remove the surprise rather than explain it.
 *
 * Know what that costs: the SDK's own in-turn `maxBudgetUsd` stop goes with it,
 * and foreground chat sets no `maxTurns` either, so a runaway tool loop inside
 * one turn now has no dollar backstop, only the abort controller.
 *
 * Deliberately NOT wired into the WS4 edit-fix mini-turn
 * (`edit-fix-mini-turn.ts`). That headless lane keeps its own much tighter
 * `costCeilingUsd: input.costCeilingUsd ?? 1.0`, alongside maxTurns 12 and a
 * 90s abort. It is bounded because it runs without a human watching, which is
 * not true of chat.
 */

/**
 * Resolve the project-config `chat.costCeilingUsd` value into the ceiling
 * `runChatTurnSdk` should enforce for a foreground chat turn.
 *
 *   - `undefined` (key omitted from config) → unlimited.
 *   - `null` or `0` (explicit config value) → unlimited. `project-config.ts`
 *     already normalizes an explicit `0` to `null` at parse time; `0` is
 *     handled here too so a caller that bypasses config parsing (tests, future
 *     entry points) gets the same "opt out" semantics rather than an
 *     instantly-tripped $0 ceiling.
 *   - any other positive number → used verbatim. A project that wants a
 *     ceiling still gets one by setting the key.
 *
 * Unlimited is `undefined`, not `null` and not `Infinity`. Both enforcement
 * points in `run-chat-turn-sdk.ts` are `typeof === 'number'` guards, and the
 * SDK's own `maxBudgetUsd?: number` is spread conditionally, so an absent value
 * is the only shape that reliably means "no ceiling" all the way down.
 */
export function resolveCostCeilingUsd(configured: number | null | undefined): number | undefined {
  if (configured === undefined || configured === null || configured === 0) return undefined
  return configured
}

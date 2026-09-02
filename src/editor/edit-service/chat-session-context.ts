/**
 * AsyncLocalStorage context that scopes lock events to a chat
 * session. Phase 3 follow-up of tasks/editor-detached-sessions.md.
 *
 * Both chat orchestrators wrap each turn in `runWithChatSession`
 * before invoking the LLM / SDK. Any `withWriteLock` call inside
 * that asynchronous scope inherits the `(sessionId, repoRoot)`
 * from the context, and the shared FileLockManager's persistence
 * sink reads it to route lock events to the correct
 * `lock-events.jsonl` file.
 *
 * Lock events fired OUTSIDE any session scope (e.g. direct bridge
 * mutations from the inspector that happen between turns) are
 * intentionally dropped — they have no session to attribute to.
 * When the user manually edits via the inspector DURING a chat
 * turn, the context is active and those events DO show up on the
 * session's timeline (concurrent activity is exactly what the
 * timeline is meant to reveal).
 *
 * Why AsyncLocalStorage instead of threading sessionId through
 * every `withWriteLock` call site: today's edit-handler /
 * edit/route call sites don't carry sessionId at all (they
 * service direct bridge mutations). Plumbing an optional sessionId
 * through every one of them would force the call sites to know
 * about chat lifecycle. AsyncLocalStorage lets the chat
 * orchestrators set the scope at the top and have it inherited
 * implicitly. Pre-empts a much larger refactor at the cost of one
 * Node.js-native primitive.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface ChatSessionScope {
  sessionId: string
  repoRoot: string
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const storage = new AsyncLocalStorage<ChatSessionScope>()

/**
 * Returns the current scope, or `undefined` if no chat session
 * context is active.
 */
export function getChatSessionScope(): ChatSessionScope | undefined {
  return storage.getStore()
}

/**
 * Run `fn` inside a chat-session scope. The `fn` and any async
 * descendants will see this scope via `getChatSessionScope()`.
 *
 * Throws synchronously if `sessionId` or `repoRoot` is invalid —
 * callers should construct the scope from validated inputs (chat
 * routes already validate sessionId before reaching the
 * orchestrator).
 */
export function runWithChatSession<T>(
  scope: ChatSessionScope,
  fn: () => Promise<T>,
): Promise<T> {
  if (!scope || typeof scope !== 'object') {
    throw new Error('runWithChatSession: scope is required')
  }
  if (typeof scope.sessionId !== 'string' || !SESSION_ID_PATTERN.test(scope.sessionId)) {
    throw new Error(
      'runWithChatSession: scope.sessionId must match /^[A-Za-z0-9_-]{1,64}$/',
    )
  }
  if (typeof scope.repoRoot !== 'string' || scope.repoRoot.length === 0) {
    throw new Error('runWithChatSession: scope.repoRoot must be a non-empty string')
  }
  return storage.run(scope, fn)
}

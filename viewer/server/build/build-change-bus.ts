import { EventEmitter } from "node:events"

/**
 * In-process fan-out for build-log SSE streams, keyed by DEPLOYMENT id.
 *
 * Deliberately a sibling of `comments/change-bus.ts` rather than a
 * generalization of it. The two carry different keys with different
 * lifetimes (a project is permanent, a deployment's stream is interesting
 * for the minutes a build runs), and merging them would mean one emitter
 * whose event namespace has to encode which kind of id it holds — more
 * coupling than the ~20 duplicated lines are worth.
 *
 * Content-free by design, same as its sibling: the signal is "this
 * deployment changed", and the SSE handler re-reads the row. That keeps the
 * bus from becoming a second, divergent copy of deployment state.
 *
 * Single-node, like everything in C-lite. A multi-instance bus is a Phase 4
 * concern.
 */
export interface BuildChangeBus {
  emit(deploymentId: string): void
  subscribe(deploymentId: string, listener: () => void): () => void
  /** Test/observability only — lets a test prove a listener was removed. */
  listenerCount(deploymentId: string): number
}

export function createBuildChangeBus(): BuildChangeBus {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0) // one listener per open SSE connection
  return {
    emit(deploymentId) {
      emitter.emit(`build:${deploymentId}`)
    },
    subscribe(deploymentId, listener) {
      emitter.on(`build:${deploymentId}`, listener)
      return () => emitter.off(`build:${deploymentId}`, listener)
    },
    listenerCount(deploymentId) {
      return emitter.listenerCount(`build:${deploymentId}`)
    },
  }
}

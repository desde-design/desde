import { EventEmitter } from "node:events"

export interface CommentChangeBus {
  emit(projectId: string): void
  subscribe(projectId: string, listener: () => void): () => void
  /**
   * Test/observability support only — not used by the SSE route itself.
   * Lets a test assert that a disconnected SSE client's listener was
   * actually removed (no leaked `EventEmitter` registration) instead of
   * inferring it indirectly.
   */
  listenerCount(projectId: string): number
}

/**
 * In-process fan-out for comment SSE streams. Single-node by design —
 * C-lite runs one process; a multi-instance / Firestore-backed bus is a
 * Phase 4 concern and deliberately not modeled here.
 */
export function createCommentChangeBus(): CommentChangeBus {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0) // one listener per open SSE connection
  return {
    emit(projectId) {
      emitter.emit(`comments:${projectId}`)
    },
    subscribe(projectId, listener) {
      emitter.on(`comments:${projectId}`, listener)
      return () => emitter.off(`comments:${projectId}`, listener)
    },
    listenerCount(projectId) {
      return emitter.listenerCount(`comments:${projectId}`)
    },
  }
}

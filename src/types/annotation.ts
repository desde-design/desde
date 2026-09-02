/**
 * Shared base types for annotation-like features (comments, notes).
 * Comment-specific types in bridge.ts alias these for backward compatibility.
 */

export interface AnnotationPosition {
  anchorSelector: string
  page: string
  tabPanelIds?: string[]
  /** Document-relative X coordinate — fallback when selector no longer matches */
  anchorX?: number
  /** Document-relative Y coordinate — fallback when selector no longer matches */
  anchorY?: number
}

export interface AnnotationAuthor {
  uid: string
  displayName: string
  email: string
  photoURL: string
}

export interface AnnotationReply {
  id: string
  body: string
  author: AnnotationAuthor
  createdAt: string
  mentions: string[]
}

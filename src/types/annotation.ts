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
  /**
   * Where inside the anchored element the reviewer actually clicked, as a
   * FRACTION of its box: 0 is the left edge, 1 the right edge; same for Y
   * top-to-bottom.
   *
   * A fraction rather than a pixel offset, because the pin has to survive
   * responsive reflow. A hero that measures 1200px on a laptop and 380px on a
   * phone would throw a pixel-offset pin clean outside its own element; a
   * fraction keeps it at the same proportional spot. On a small target — a
   * button, an icon — the two are the same number anyway.
   *
   * BOTH OPTIONAL, and absent means the pre-2026-09-13 behaviour: the pin goes
   * to the element's top-right corner. Every comment written before this field
   * existed therefore keeps rendering exactly where it always did, with no
   * migration. A consumer must treat one-present-one-absent as absent.
   */
  offsetRatioX?: number
  offsetRatioY?: number
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

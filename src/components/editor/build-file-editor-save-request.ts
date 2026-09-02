/**
 * The `POST /api/editor/edit` body for a file-editor save
 * (`file-editor-pane.tsx`'s `performSave`).
 *
 * Extracted as its own pure function (Task 4b, round 2) because this lane
 * was found building its wire body BY HAND — `{ edit: { kind: "overwrite",
 * ... } }` — instead of going through `buildEditRequest`
 * (`src/editor/adapters/bridge/build-edit-request.ts`), the one place the
 * verification-join fix threaded a `correlationId` onto every edit kind.
 * It bypasses that chokepoint because it has no `StructuralEdit` to hand
 * it — this is a raw source save from a code editor, not a DOM-driven
 * edit — so it has to mint and attach its own join key here instead of
 * inheriting one for free.
 *
 * This lane sends NO verification record today (`file-editor-pane.tsx`
 * never calls `beginVerification`), so nothing currently reads the id
 * back. It gets one anyway, on the same rule every other `lane: "direct"`
 * write follows: a plain user-initiated save is not the chat/LLM-repair
 * exclusion (see `activity-panel.tsx`'s doc comment for what IS excluded
 * and why) — leaving it out would be the exact defect this task exists to
 * close, just deferred to whenever this lane grows verification. A
 * colocated test pins that the request body always carries one, so that
 * day doesn't rediscover this by hand again.
 */

import { makeEditId } from "@/hooks/make-edit-id"

export interface FileEditorSaveArgs {
  file: string
  newSource: string
  /** Omitted for a forced save (`opts.force` — the "Save anyway" path). */
  baseHash?: string
}

export function buildFileEditorSaveRequest(
  args: FileEditorSaveArgs,
): Record<string, unknown> {
  return {
    edit: {
      kind: "overwrite" as const,
      file: args.file,
      newSource: args.newSource,
      ...(args.baseHash ? { baseHash: args.baseHash } : {}),
    },
    correlationId: makeEditId(),
  }
}

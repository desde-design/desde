/**
 * Tiny stable-identity helper for anything that mints a
 * `StructuralEdit`/`PropEdit` id: the edit lanes, the style-edit builders next
 * to it, and the shell. Split out verbatim from `useEditorEditing.ts` in
 * share-readiness Phase 3 Batch B, and moved out of `src/hooks/` once the
 * lanes needed it, because an edit-service module importing a hook is the
 * wrong direction.
 */
export function makeEditId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `edit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

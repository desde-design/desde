/**
 * Tiny stable-identity helper shared by `useEditorEditing` and the pure
 * modules extracted from it (e.g. `style-edit-builders.ts`) that need to
 * mint a `StructuralEdit`/`PropEdit` id without importing back from the
 * hook itself (which would create a cycle). Split out verbatim from
 * `useEditorEditing.ts` — share-readiness Phase 3 Batch B.
 */
export function makeEditId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `edit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

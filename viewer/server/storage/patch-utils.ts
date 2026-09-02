/**
 * Returns a shallow copy of `patch` with any explicitly-`undefined` values
 * removed.
 *
 * Both `StorageAdapter` impls merge patches with `{ ...existing, ...patch }`.
 * If a caller passes an update key with an explicit `undefined` value (as
 * opposed to simply omitting the key) — e.g. `updateProject(id, { name:
 * undefined })` — a raw spread would let that `undefined` clobber the
 * existing field. Filtering the patch through this first closes that: only
 * keys with a defined value are ever merged in.
 *
 * `null` passes through unchanged — it's a valid explicit "clear this
 * field" (e.g. `repoUrl: null`), distinct from "field not specified."
 */
export function omitUndefined<T extends object>(patch: T): Partial<T> {
  const result: Partial<T> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value
  }
  return result
}

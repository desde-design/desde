"use client"

import { useRouter } from "next/navigation"

/**
 * `useRouter().refresh`, guarded against a missing Next App Router context.
 *
 * Split out of `[slug]/prototype-unavailable.tsx` (codex round 4, Fix 2) so
 * `review-shell.tsx` can call the SAME guarded refresh for its own
 * `useProcessRecovery({ mode: "embedded" })` call, instead of a second copy
 * of this guard drifting from the first.
 *
 * The guard itself: the gallery's registry sweep (`gallery/registry.test.tsx`)
 * renders review fixtures directly through React Testing Library — there is
 * no real Next app around them, no `<AppRouterContext>`, nothing
 * `useRouter()` can read — and it throws synchronously there ("invariant
 * expected app router to be mounted"). The real review page always has the
 * context (it is rendered by the actual Next app), so the `catch` below is a
 * gallery-only path, never a product one. The `try` wraps a single
 * unconditional call, in the same position on every render — it changes what
 * `useRouter()` DOES, not whether or how many times this component calls it,
 * so it does not trip the hook-order rule the way a real conditional hook
 * call would.
 */
export function useRouterRefresh(): () => void {
  try {
    const router = useRouter()
    return () => router.refresh()
  } catch {
    return () => {}
  }
}

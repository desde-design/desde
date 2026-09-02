"use client"

import type { ReactNode } from "react"
import { CurrentUserProvider } from "./use-current-user"

/**
 * A client-component boundary so a Server Component `page.tsx` can wrap
 * several panels in one `CurrentUserProvider`, instead of each one calling
 * `useCurrentUser()` independently and firing its own `GET /api/v1/me`.
 *
 * Originally added for the settings page (Fix wave M1 review): Tokens,
 * Members, Domain rules and Instance settings each fetched separately, four
 * requests for one page load. Relocated out of `settings/` (viewer-membership
 * Task 12) once the dashboard grew a second `useCurrentUser()` caller
 * (`ProjectsList`'s delete-affordance gating, alongside `AccountMenu`'s
 * existing one) — the wrapper has no settings-specific logic, so it's shared
 * from here rather than duplicated.
 */
export function CurrentUserBoundary({ children }: { children: ReactNode }) {
  return <CurrentUserProvider>{children}</CurrentUserProvider>
}

"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { isInstanceRole, type InstanceRole } from "./instance-role"

/**
 * Minimal local shape of the server's `User` (`viewer/server/storage/types.ts`)
 * — declared here rather than imported, mirroring `review/use-participants.ts`'s
 * `ReviewParticipant`: server-only code isn't reachable from app code via the
 * `@/*` alias (that alias points at the repo-root `src/`), and this hook only
 * ever needs the wire shape returned by `GET /api/v1/me`.
 *
 * `role` is the shared `InstanceRole` (`./instance-role.ts`); the widened
 * `provider` mirrors the server's `User["provider"]` — declared as a literal
 * union here rather than imported, same convention as `ProjectMemberView` in
 * `project-access.tsx`.
 */
export interface ViewerUser {
  id: string
  provider: "github" | "email"
  email: string
  displayName: string
  avatarUrl: string
  role: InstanceRole
  createdAt: string
}

function isViewerUser(v: unknown): v is ViewerUser {
  if (typeof v !== "object" || v === null) return false
  const u = v as Record<string, unknown>
  return (
    typeof u.id === "string" &&
    typeof u.email === "string" &&
    typeof u.displayName === "string" &&
    typeof u.avatarUrl === "string" &&
    isInstanceRole(u.role)
  )
}

export interface UseCurrentUserResult {
  user: ViewerUser | null
  loading: boolean
  authEnabled: boolean
  /**
   * The path a signed-out visitor should be sent to, or `null` when this
   * deployment has no provider they can use. `AccountMenu` uses this (not
   * `authEnabled`) to decide whether to show a "Sign in" button — see its
   * doc comment for why the two aren't the same question.
   */
  signInUrl: string | null
  /**
   * Whether this deployment can email a sign-in link (`viewer-membership`
   * Task 15) — mirrors `/api/v1/me`'s `emailSignInEnabled`, itself
   * `deps.config.email !== null` (boot-time SMTP config). `AccountMenu` uses
   * this together with `signInUrl` to decide whether "Sign in" goes straight
   * to GitHub or hops through `/signin` first: a page hop is only earned when
   * there is a CHOICE to make there.
   */
  emailSignInEnabled: boolean
  /**
   * Re-fetches `GET /api/v1/me` and updates every field above from the
   * response. Returns once that update has landed (or the fetch has failed
   * and the state has been reset to signed-out), so a caller that needs to
   * act AFTER the refresh — e.g. `members-panel.tsx` navigating away once
   * the caller's own session is confirmed dead — can `await` it.
   *
   * Added for viewer-membership Fix wave 4 (codex round-4): after a member
   * changes their OWN role, or removes their OWN account, the server's
   * session state has moved out from under whatever `/me` returned at page
   * load. Without this, every panel reading `useCurrentUser()` keeps
   * showing the stale role (or a stale signed-in user) until the next full
   * page load.
   */
  refresh: () => Promise<void>
}

/**
 * Fetches `GET /api/v1/me`, when `enabled`. The endpoint always 200s with
 * `{ user, authEnabled, signInUrl }` — `authEnabled` is what distinguishes
 * "signed out" from "auth isn't configured on this deployment at all", and
 * `signInUrl` is where a signed-out visitor should be sent (or `null` when
 * there's nowhere to send them). A fetch failure (network error, non-200,
 * malformed body) degrades to signed-out-and-disabled rather than throwing,
 * since a transient hiccup here must never block the review page from
 * rendering.
 *
 * `enabled` exists so `useCurrentUser` below can call this UNCONDITIONALLY
 * (satisfying the rules of hooks) while still skipping the network request
 * when a `CurrentUserProvider` ancestor is already doing the one fetch for
 * the whole subtree — the effect below still runs, it just returns
 * immediately instead of calling `fetch`.
 */
function useCurrentUserFetch(enabled: boolean): UseCurrentUserResult {
  const [user, setUser] = useState<ViewerUser | null>(null)
  const [authEnabled, setAuthEnabled] = useState(false)
  const [signInUrl, setSignInUrl] = useState<string | null>(null)
  const [emailSignInEnabled, setEmailSignInEnabled] = useState(false)
  const [loading, setLoading] = useState(enabled)

  // Guards a completing fetch's state updates against a component that has
  // since unmounted. Shared by the mount-time load AND by `refresh()` below
  // (either can still be in flight when the caller goes away) — previously
  // this was a `cancelled` local re-declared inside the mount effect, which
  // covered only that one call.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    try {
      // A hung request (not merely a failed one) must not block this
      // forever: `review-shell.tsx` renders the signed-out identity form
      // only once `loading` flips false, so a request that never settles
      // would permanently hide a flow that needed no server call before
      // Phase 3a. The timeout degrades to the same signed-out-and-disabled
      // state as any other fetch failure below.
      const res = await fetch("/api/v1/me", { signal: AbortSignal.timeout(5000) })
      if (!res.ok) throw new Error(`GET /api/v1/me ${res.status}`)
      const data = (await res.json()) as {
        user?: unknown
        authEnabled?: unknown
        signInUrl?: unknown
        emailSignInEnabled?: unknown
      }
      const nextUser = isViewerUser(data.user) ? data.user : null
      const nextAuthEnabled = data.authEnabled === true
      const nextSignInUrl = typeof data.signInUrl === "string" ? data.signInUrl : null
      const nextEmailSignInEnabled = data.emailSignInEnabled === true
      if (mountedRef.current) {
        setUser(nextUser)
        setAuthEnabled(nextAuthEnabled)
        setSignInUrl(nextSignInUrl)
        setEmailSignInEnabled(nextEmailSignInEnabled)
      }
    } catch (err) {
      console.warn("[viewer] failed to load current user:", err)
      if (mountedRef.current) {
        setUser(null)
        setAuthEnabled(false)
        setSignInUrl(null)
        setEmailSignInEnabled(false)
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void load()
  }, [enabled, load])

  return { user, loading, authEnabled, signInUrl, emailSignInEnabled, refresh: load }
}

const CurrentUserContext = createContext<UseCurrentUserResult | null>(null)

/**
 * Performs the ONE `GET /api/v1/me` fetch for every `useCurrentUser()` call
 * beneath it in the tree, instead of each caller fetching independently.
 *
 * Added for the settings page (Fix wave M1 review): its four panels — Tokens,
 * Members, Domain rules, Instance settings — each call `useCurrentUser()` on
 * mount, which meant four separate `/me` requests for one page load. Optional
 * by design: a component tree with no provider ancestor still works exactly
 * as before, because `useCurrentUser` falls back to its own fetch when
 * `useContext` finds nothing (`null`) to read.
 */
export function CurrentUserProvider({ children }: { children: ReactNode }) {
  const value = useCurrentUserFetch(true)
  return <CurrentUserContext.Provider value={value}>{children}</CurrentUserContext.Provider>
}

export function useCurrentUser(): UseCurrentUserResult {
  const ctx = useContext(CurrentUserContext)
  // Always called, never conditionally — the rules of hooks forbid skipping
  // it based on `ctx`. When `ctx` is present, `enabled: false` keeps this
  // instance from ever calling `fetch`: its state stays at its unused
  // initial values, and `ctx` (never `null` once a provider is mounted) is
  // what gets returned.
  const own = useCurrentUserFetch(ctx === null)
  return ctx ?? own
}

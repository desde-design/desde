import { EmptyState } from "@/components/blocks"

/**
 * Where a visitor lands when this instance is invite-only and they aren't a
 * member (viewer-membership Task 8, Milestone 1). Three copy variants, chosen
 * by the `reason` query param:
 *
 * - default: a signed-in (or signed-out) visitor who isn't invited.
 * - `reason=invite-invalid`: they followed an invite link that no longer
 *   works (already used, revoked, or expired).
 * - `reason=link-invalid`: they followed a SIGN-IN link (a magic link, or one
 *   an admin issued) that no longer works. Task 14.
 *
 * Each `reason` is one bucket covering several server-side causes on purpose.
 * `link-invalid` is sent for a malformed token, an expired one, an already-used
 * one, and an admission the gate refused — the redirect must not tell whoever
 * holds a dead link WHICH of those is true, and none of it is actionable for
 * them anyway. The copy therefore says what to do, not what happened.
 *
 * Deliberately bare: no sign-in button, no "request access" link, no
 * mention of whether the instance itself, or any project on it, exists.
 * This is the same indistinguishable-404 discipline
 * `review/[slug]/not-found.tsx` uses — an affordance here would tell an
 * outsider something about a private instance that the plain refusal does
 * not.
 */

interface DeniedCopy {
  title: string
  description: string
}

const DEFAULT_COPY: DeniedCopy = {
  title: "This viewer is invite-only",
  description: "Ask an admin to invite you.",
}

const INVITE_INVALID_COPY: DeniedCopy = {
  title: "That invite link is no longer valid",
  description: "Ask an admin for a new one.",
}

const LINK_INVALID_COPY: DeniedCopy = {
  title: "That sign-in link is no longer valid",
  description: "Sign-in links work once and expire. Request a new one.",
}

const COPY_BY_REASON: Record<string, DeniedCopy> = {
  "invite-invalid": INVITE_INVALID_COPY,
  "link-invalid": LINK_INVALID_COPY,
}

/**
 * The presentational half, exported separately so the gallery fixture can
 * render it directly with a plain `reason` prop — `DeniedPage` below is
 * `async` (Next 16 hands `searchParams` in as a `Promise`), and an async
 * component can't be mounted by `react-dom/client` the way the gallery
 * mounts every other plain page (see `review-not-found.tsx`'s fixture for
 * the sync case this mirrors).
 */
export function DeniedContent({ reason }: { reason?: string }) {
  // An unrecognized reason falls back to the default copy rather than echoing
  // anything from the query string — `reason` is attacker-controllable, and
  // this page is reachable by anyone.
  //
  // `Object.hasOwn`, not a bare index: a plain object literal inherits from
  // `Object.prototype`, so `COPY_BY_REASON["constructor"]` (or `"toString"`,
  // or `"__proto__"`) resolves to a FUNCTION rather than `undefined`. The
  // `??` then keeps it, `copy.title` is undefined, and `?reason=constructor`
  // renders a blank page. An own-property check is the fix; a `Map` or
  // `Object.create(null)` would work equally well.
  const copy =
    reason !== undefined && Object.hasOwn(COPY_BY_REASON, reason)
      ? COPY_BY_REASON[reason]
      : DEFAULT_COPY
  return (
    <main className="mx-auto flex max-w-md flex-col items-center gap-4 p-8 text-center">
      {/* `denied` — this whole page is the refusal (Mo, 2026-08-29). */}
      <EmptyState tone="denied" title={copy.title} description={copy.description} />
    </main>
  )
}

export default async function DeniedPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string | string[] }>
}) {
  const params = await searchParams
  const reason = typeof params.reason === "string" ? params.reason : undefined
  return <DeniedContent reason={reason} />
}

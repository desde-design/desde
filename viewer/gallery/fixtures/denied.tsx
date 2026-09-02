import { DeniedContent } from "../../app/denied/page"
import type { SurfaceEntry } from "@/components/gallery/types"

/**
 * Where a visitor lands when this instance is invite-only and they aren't a
 * member (viewer-membership Task 8).
 *
 * `DeniedPage` (the route's default export) is `async` — Next 16 hands
 * `searchParams` in as a `Promise` — so, like `review-not-found.tsx`'s
 * fixture works around `ReviewPage` needing `headers()`, this renders the
 * named `DeniedContent` export directly with a plain `reason` prop instead
 * of going through the route.
 */
export const DENIED_SURFACE: SurfaceEntry = {
  id: "denied",
  title: "Denied — invite-only instance",
  kind: "page",
  sourceFile: "viewer/app/denied/page.tsx",
  states: [
    {
      id: "denied/not-invited",
      label: "Not invited",
      render: () => <DeniedContent />,
    },
    {
      id: "denied/invite-invalid",
      label: "Invite link no longer valid",
      render: () => <DeniedContent reason="invite-invalid" />,
    },
    {
      id: "denied/link-invalid",
      label: "Sign-in link no longer valid",
      render: () => <DeniedContent reason="link-invalid" />,
    },
  ],
}

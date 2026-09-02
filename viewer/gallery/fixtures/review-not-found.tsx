import ReviewNotFound from "../../app/review/[slug]/not-found"
import { setGalleryConfig } from "../harness/shims/server-config"
import type { SurfaceEntry } from "@/components/gallery/types"

/**
 * The 404 a reviewer lands on when a slug does not resolve.
 *
 * `ReviewNotFound` is a Server Component, but a synchronous one with no props,
 * so `react-dom/client` renders the real module — nothing is reconstructed by
 * hand here. Its one branch reads `loadConfig().githubAuth`, which the
 * gallery's config shim supplies.
 *
 * The two states matter because the page deliberately says the SAME thing
 * either way about whether the project exists (telling a missing slug apart
 * from a members-only project would leak that the project exists). All that
 * changes is whether signing in is offered at all — and offering it on a
 * deployment with no GitHub App would be a dead link.
 */

/** Enough of a githubAuth block to make `config.githubAuth` non-null; no value is read. */
const GITHUB_AUTH_CONFIGURED = {
  clientId: "Iv1.gallery",
  clientSecret: "gallery-secret",
}

export const REVIEW_NOT_FOUND_SURFACE: SurfaceEntry = {
  id: "review-not-found",
  title: "Review — not found",
  kind: "page",
  sourceFile: "viewer/app/review/[slug]/not-found.tsx",
  states: [
    {
      id: "review-not-found/auth-configured",
      label: "Sign-in offered (GitHub App configured)",
      render: () => {
        setGalleryConfig({ githubAuth: GITHUB_AUTH_CONFIGURED })
        return <ReviewNotFound />
      },
    },
    {
      id: "review-not-found/no-auth",
      label: "No sign-in offered (no GitHub App)",
      render: () => {
        setGalleryConfig({ githubAuth: null })
        return <ReviewNotFound />
      },
    },
  ],
}

/**
 * The one set of sample records every viewer fixture draws from.
 *
 * Shared rather than per-fixture so the gallery reads as one product: the same
 * person, the same project, the same repository turn up on the dashboard, in
 * the review screen and in the members dialog. A catalog where each screen
 * invents its own names makes it harder, not easier, to tell whether two
 * screens agree with each other.
 *
 * Every shape here mirrors what the real API returns — see the route modules
 * under `viewer/server/api/`. They are declared as plain literals rather than
 * imported types because the server's types live behind `node:` imports the
 * browser cannot follow.
 */

import type { Comment } from "@/types/bridge"

export const SAMPLE_USER = {
  id: "user-mo",
  provider: "github" as const,
  email: "mo@example.com",
  displayName: "Mo Chang",
  avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  role: "admin" as const,
  createdAt: "2026-06-01T09:00:00.000Z",
}

/**
 * `signInUrl` mirrors the real `/me` contract (`viewer/server/api/auth-routes.ts`):
 * the GitHub path when GitHub sign-in is configured, `null` when it isn't.
 * The two constants below always move together because on the real server
 * they're derived from the same `githubAuth !== null` check — there is no
 * wire shape where they disagree.
 */
const GITHUB_SIGN_IN_URL = "/api/v1/auth/github"

/**
 * Signed in, auth configured — the default the harness boots with.
 * `emailSignInEnabled: false` throughout this file's `ME_*` constants unless
 * a state is specifically about the `/signin` page (Task 15): every OTHER
 * fixture in the catalog is exercising something else, and defaulting email
 * sign-in off keeps `AccountMenu`'s button pointed at GitHub's `signInUrl`
 * directly rather than hopping through a page those fixtures don't render.
 */
export const ME_SIGNED_IN = {
  user: SAMPLE_USER,
  authEnabled: true,
  signInUrl: GITHUB_SIGN_IN_URL,
  emailSignInEnabled: false,
}
/** Auth configured, nobody signed in — `AccountMenu` offers the sign-in button. */
export const ME_SIGNED_OUT = {
  user: null,
  authEnabled: true,
  signInUrl: GITHUB_SIGN_IN_URL,
  emailSignInEnabled: false,
}
/**
 * A deployment with no GitHub App and no SMTP at all — nothing for
 * `AccountMenu` to send a visitor to, so it hides itself entirely rather
 * than showing a dead button. (Local-mode deployments have a way in — the
 * boot console URL — but `/me` never advertises it; see `signInUrl`'s doc
 * comment on `UseCurrentUserResult`.) `/signin`'s own "neither" state
 * reuses this exact shape — see `gallery/fixtures/signin.tsx`.
 */
export const ME_AUTH_DISABLED = {
  user: null,
  authEnabled: false,
  signInUrl: null,
  emailSignInEnabled: false,
}

/**
 * SMTP configured, no GitHub App — `/signin`'s email-only state. There is no
 * direct link for email sign-in the way `signInUrl` is one for GitHub, so
 * this is also the one case where `AccountMenu`'s button has to go through
 * the page rather than straight to a URL.
 */
export const ME_EMAIL_ONLY = {
  user: null,
  authEnabled: false,
  signInUrl: null,
  emailSignInEnabled: true,
}

/** Both GitHub sign-in and SMTP configured — `/signin`'s "both" state, GitHub button plus the email form. */
export const ME_BOTH_SIGN_IN_METHODS = {
  user: null,
  authEnabled: true,
  signInUrl: GITHUB_SIGN_IN_URL,
  emailSignInEnabled: true,
}

/**
 * A member signed into an SMTP-only (or local-operator-only) instance — no
 * GitHub App configured at all (`authEnabled: false`, `signInUrl: null`),
 * but genuinely signed in via an invite link or a magic link
 * (`emailSignInEnabled: true`). Exists for viewer-membership Fix wave 4
 * (codex round-4): `authEnabled` means ONLY "GitHub sign-in is configured",
 * and a legacy consumer that checked it BEFORE `user` (`TokensPanel`,
 * `ProjectRepoPanel`) showed this person "Sign-in isn't configured" instead
 * of their own signed-in UI. This is the fixture that proves the fix — see
 * `settings.tsx`'s `settings/signed-in-email-only-instance` state and
 * `project-repo-panel.tsx`'s email-only signed-in state.
 */
export const SAMPLE_EMAIL_USER = {
  id: "user-dana-email",
  provider: "email" as const,
  email: "dana@example.com",
  displayName: "Dana Whitfield",
  avatarUrl: "",
  role: "editor" as const,
  createdAt: "2026-08-10T09:00:00.000Z",
}
export const ME_SIGNED_IN_EMAIL_ONLY = {
  user: SAMPLE_EMAIL_USER,
  authEnabled: false,
  signInUrl: null,
  emailSignInEnabled: true,
}

/**
 * The zero-config deployment, viewed by the person who booted it: signed in
 * as Admin through the local-operator boot link, with no GitHub App and no
 * SMTP behind it.
 *
 * This is the DEFAULT shape of a brand-new instance, not an edge case, and it
 * is the one where the Account section offers "Set up GitHub sign-in" — an
 * Admin is the only caller `requireOperator` will accept for the manifest
 * flow, so it is the only role that gets the button.
 *
 * The local operator's row is a real user row like any other
 * (`server/auth/local-operator.ts`): `provider: "github"` is a deliberate lie
 * of convenience over an unforgeable `local-operator` sentinel, the email is
 * the fixed `operator@localhost`, and there is no avatar because nothing ever
 * supplied one.
 */
export const SAMPLE_LOCAL_OPERATOR = {
  id: "user-local-operator",
  provider: "github" as const,
  email: "operator@localhost",
  displayName: "Local operator",
  avatarUrl: "",
  role: "admin" as const,
  createdAt: "2026-08-28T09:00:00.000Z",
}
export const ME_LOCAL_OPERATOR = {
  user: SAMPLE_LOCAL_OPERATOR,
  authEnabled: false,
  signInUrl: null,
  emailSignInEnabled: false,
}

export interface SampleProject {
  id: string
  slug: string
  name: string
  activeDeploymentId: string | null
  access: "all-members" | "invited" | "public-link"
  createdAt: string
  activeDeployment?: { status: "building" | "deployed" | "failed"; createdAt: string } | null
}

/**
 * An ISO timestamp `minutes` in the past, evaluated when this module loads.
 *
 * Deliberately relative rather than the fixed dates the other fixtures use.
 * The card renders these through `formatRelativeTime`, which switches to a
 * plain date past ~30 days — so a hard-coded 2026-06-01 would show every
 * deployment as "6/1/2026" and the gallery would never exercise the wording
 * the product actually ships. The cost is that these screens are not
 * byte-reproducible across days; that is the right trade for an instrument
 * whose job is to show how the copy reads.
 */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

/**
 * Five rows chosen so one screenshot shows every row variant the list can
 * produce: deployed + members, deployed + public link, the effectively-public
 * warning, a project with nothing deployed yet, and a name long enough to
 * truncate. The deployment states cover all four strip variants too —
 * deployed, building, failed, never.
 */
export const SAMPLE_PROJECTS: SampleProject[] = [
  {
    id: "proj-gateway",
    slug: "ai-gateway",
    name: "AI Gateway",
    activeDeploymentId: "dep-401",
    access: "invited",
    createdAt: "2026-05-02T09:00:00.000Z",
    activeDeployment: { status: "deployed", createdAt: minutesAgo(3 * 60) },
  },
  {
    id: "proj-checkout",
    slug: "checkout-redesign",
    name: "Checkout redesign",
    activeDeploymentId: "dep-402",
    access: "public-link",
    createdAt: "2026-06-11T09:00:00.000Z",
    activeDeployment: { status: "deployed", createdAt: minutesAgo(2 * 24 * 60) },
  },
  {
    id: "proj-onboarding",
    slug: "onboarding-flow",
    name: "Onboarding flow",
    activeDeploymentId: "dep-403",
    access: "all-members",
    createdAt: "2026-07-19T09:00:00.000Z",
    activeDeployment: { status: "building", createdAt: minutesAgo(1) },
  },
  {
    id: "proj-billing",
    slug: "billing-portal",
    name: "Billing portal",
    activeDeploymentId: null,
    access: "invited",
    createdAt: "2026-08-14T09:00:00.000Z",
    activeDeployment: null,
  },
  {
    id: "proj-long",
    slug: "quarterly-planning-workspace",
    name: "Quarterly planning workspace, Q4 concepts, revision 3 (do not share externally)",
    activeDeploymentId: "dep-404",
    access: "invited",
    createdAt: "2026-08-01T09:00:00.000Z",
    activeDeployment: { status: "failed", createdAt: minutesAgo(40) },
  },
]

export const SAMPLE_PROJECT = SAMPLE_PROJECTS[0]

/**
 * `ProjectMemberView` (`viewer/app/project-access.tsx`). The third row has NO
 * `email`: the server omits the field entirely for a caller who is not
 * themselves an insider, and the row has to read well without it.
 */
export const SAMPLE_MEMBERS = [
  {
    userId: "user-mo",
    createdAt: "2026-06-01T09:00:00.000Z",
    email: "mo@example.com",
    displayName: "Mo Chang",
    avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  },
  {
    userId: "user-rin",
    createdAt: "2026-06-14T13:20:00.000Z",
    email: "rin@example.com",
    displayName: "Rin Adeyemi",
    avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  },
  {
    userId: "user-sam",
    createdAt: "2026-07-02T16:45:00.000Z",
    displayName: "Sam Okafor",
    avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
  },
]

/** `ProjectRepoConfigView` (`viewer/app/project-repo-utils.ts`). */
export const SAMPLE_REPO_CONFIG = {
  installationId: 51234,
  owner: "acme",
  name: "ai-gateway-prototype",
  defaultBranch: "main",
  branch: "main",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDir: "dist",
  autoDeploy: true,
}

/** `GithubInstallationView` — one org, one personal account. */
export const SAMPLE_INSTALLATIONS = [
  { id: 51234, accountLogin: "acme" },
  { id: 51235, accountLogin: "mochang" },
]

/** `GithubRepoView`. One public repo, and one whose default branch is not `main`. */
export const SAMPLE_REPOS = [
  {
    id: 901,
    owner: "acme",
    name: "ai-gateway-prototype",
    fullName: "acme/ai-gateway-prototype",
    private: true,
    defaultBranch: "main",
  },
  {
    id: 902,
    owner: "acme",
    name: "checkout-redesign",
    fullName: "acme/checkout-redesign",
    private: true,
    defaultBranch: "main",
  },
  {
    id: 903,
    owner: "acme",
    name: "design-system",
    fullName: "acme/design-system",
    private: false,
    defaultBranch: "trunk",
  },
]

/** `GET /api/v1/github/installations` — the whole body, not just the list. */
export const SAMPLE_INSTALLATIONS_RESPONSE = {
  configured: true,
  appSlug: "desde-viewer",
  installations: SAMPLE_INSTALLATIONS,
  installationsSyncedAt: "2026-08-19T11:30:00.000Z",
  installationsStale: false,
}

export const SAMPLE_BUILD_LOG = [
  "$ git clone --depth 1 --branch main https://github.com/acme/ai-gateway-prototype",
  "Cloning into '/tmp/build-a91f'...",
  "$ npm ci",
  "added 812 packages in 21s",
  "$ npm run build",
  "vite v7.1.2 building for production...",
  "transforming...",
  "✓ 1284 modules transformed.",
  "dist/index.html                  0.62 kB │ gzip:  0.38 kB",
  "dist/assets/index-Ck2v9Qwq.css  41.20 kB │ gzip:  7.94 kB",
  "dist/assets/index-Bq7dP1nX.js  318.44 kB │ gzip: 98.11 kB",
  "✓ built in 6.42s",
  "Publishing 34 files to the asset store…",
  "Deployment dep-401 is live.",
].join("\n")

export const SAMPLE_FAILED_BUILD_LOG = [
  "$ git clone --depth 1 --branch main https://github.com/acme/ai-gateway-prototype",
  "Cloning into '/tmp/build-b13c'...",
  "$ npm ci",
  "added 812 packages in 19s",
  "$ npm run build",
  "vite v7.1.2 building for production...",
  "transforming...",
  "src/views/GatewayList.vue:42:18: ERROR: Expected \")\" but found \"}\"",
  "error during build:",
  "Build failed with 1 error.",
  "npm ERR! Lifecycle script `build` failed with error 1",
].join("\n")

/** `MachineTokenView` (`viewer/app/settings/token-utils.ts`). */
export const SAMPLE_TOKENS = [
  {
    id: "tok-ci",
    name: "Editor on the design desktop",
    scopes: ["read", "write"],
    createdAt: "2026-08-01T10:00:00.000Z",
    lastUsedAt: "2026-08-18T22:14:00.000Z",
    expiresAt: "2026-11-01T10:00:00.000Z",
  },
  {
    id: "tok-editor",
    name: "Editor on the review laptop",
    scopes: ["read"],
    createdAt: "2026-07-12T08:30:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
  },
  {
    id: "tok-old",
    name: "Old sync script",
    scopes: ["read"],
    createdAt: "2026-05-02T14:05:00.000Z",
    lastUsedAt: "2026-06-30T11:02:00.000Z",
    // Already past — the row renders its expiry as expired.
    expiresAt: "2026-07-01T00:00:00.000Z",
  },
]

/** Shown once at mint time and never again — see `machine-token.ts`. */
export const SAMPLE_PLAINTEXT_TOKEN = "dsv_9f2c41ba7d6e4c0fa8b35172e94d0c6a"

/** `ReviewParticipant` (`viewer/app/review/use-participants.ts`) — the @-mention directory. */
export const SAMPLE_PARTICIPANTS = [
  { id: "user-mo", email: "mo@example.com", displayName: "Mo Chang", status: "active" as const },
  { id: "user-rin", email: "rin@example.com", displayName: "Rin Adeyemi", status: "active" as const },
  { id: "user-sam", displayName: "Sam Okafor", status: "active" as const },
  { id: "user-dana", email: "dana@example.com", displayName: "Dana Whitfield", status: "pending" as const },
]

/**
 * `Comment` (`@/types/bridge`) — the review screen's comment threads.
 *
 * Typed against the real interface, unlike the rest of this file. `Comment`
 * has enough required fields — `position`, `author`, `replies`, `mentions`,
 * `participantEmails` — that a fixture missing one renders BLANK with no
 * error: the store's own runtime guard only checks that the top-level
 * response has a `comments` array, not that each comment is well-formed. The
 * compiler catching a missing field here is worth the import. It's safe to
 * import (unlike the server-only types this file otherwise avoids): `Comment`
 * lives in a browser-safe module with no `node:` imports, the same one
 * `review-shell.tsx` itself imports from.
 *
 * Three comments, chosen to cover the three thread shapes the rail row and
 * the popup card can each show: unresolved with a reply, unresolved with no
 * replies, and resolved with a reply. The second comment's author has no
 * `email` — an anonymous reviewer who only ever gave a name (see
 * `reviewer-identity.ts`), which is also why its `participantEmails` is
 * empty.
 */
export const SAMPLE_COMMENTS: Comment[] = [
  {
    id: "cmt-cta-copy",
    number: 1,
    position: { anchorSelector: ".hero-cta", page: "/", anchorX: 240, anchorY: 160 },
    body: "The CTA copy reads a little flat here. Can we try something with more urgency?",
    author: {
      uid: "user:user-rin",
      displayName: "Rin Adeyemi",
      email: "rin@example.com",
      photoURL: "https://avatars.githubusercontent.com/u/1?v=4",
    },
    createdAt: "2026-08-18T14:05:00.000Z",
    resolved: false,
    replies: [
      {
        id: "reply-cta-copy-1",
        body: "Agreed, I'll draft two alternatives.",
        author: {
          uid: "user:user-mo",
          displayName: "Mo Chang",
          email: "mo@example.com",
          photoURL: "https://avatars.githubusercontent.com/u/0?v=4",
        },
        createdAt: "2026-08-18T15:10:00.000Z",
        mentions: [],
      },
    ],
    mentions: [],
    participantEmails: ["rin@example.com", "mo@example.com"],
    projectId: "proj-gateway",
  },
  {
    id: "cmt-card-spacing",
    number: 2,
    position: {
      anchorSelector: ".pricing-cards",
      page: "/settings/billing/invoices/2026-q3",
      anchorX: 420,
      anchorY: 300,
    },
    body: "Spacing between the two cards feels tight on smaller viewports.",
    author: {
      uid: "viewer:9f2c41ba-7d6e-4c0f-a8b3-5172e94d0c6a",
      displayName: "Dana Okafor",
      email: "",
      photoURL: "",
    },
    createdAt: "2026-08-19T09:30:00.000Z",
    resolved: false,
    replies: [],
    mentions: [],
    participantEmails: [],
    projectId: "proj-gateway",
  },
  {
    id: "cmt-typo-receive",
    number: 3,
    position: { anchorSelector: ".confirmation-copy", page: "/checkout", anchorX: 180, anchorY: 92 },
    body: 'Typo: "recieve" should be "receive".',
    author: {
      uid: "user:user-rin",
      displayName: "Rin Adeyemi",
      email: "rin@example.com",
      photoURL: "https://avatars.githubusercontent.com/u/1?v=4",
    },
    createdAt: "2026-08-17T11:00:00.000Z",
    resolved: true,
    replies: [
      {
        id: "reply-typo-receive-1",
        body: "Fixed in the latest build, thanks!",
        author: {
          uid: "user:user-mo",
          displayName: "Mo Chang",
          email: "mo@example.com",
          photoURL: "https://avatars.githubusercontent.com/u/0?v=4",
        },
        createdAt: "2026-08-17T11:45:00.000Z",
        mentions: [],
      },
    ],
    mentions: [],
    participantEmails: ["rin@example.com", "mo@example.com"],
    projectId: "proj-gateway",
  },
]

/** Matches `DeploymentWarning` (`server/storage/types.ts` / `viewer/app/build-log-utils.ts`). */
export interface SampleDeploymentWarning {
  kind: "root-absolute-assets"
  summary: string
  findings: { file: string; kind: "html-attr" | "css-url" | "js-runtime-base"; sample: string }[]
}

/** A realistic root-absolute-asset warning, the shape the deploy-time scan records. */
export const SAMPLE_ROOT_ABSOLUTE_WARNING: SampleDeploymentWarning = {
  kind: "root-absolute-assets",
  summary: "3 root-absolute asset references found in 2 files",
  findings: [
    { file: "index.html", kind: "html-attr", sample: '<script type="module" src="/assets/index-a1b2c3.js">' },
    { file: "index.html", kind: "html-attr", sample: '<link rel="stylesheet" href="/assets/index-a1b2c3.css">' },
    { file: "assets/index-a1b2c3.css", kind: "css-url", sample: "url(/fonts/sans-d4e5f6.woff2)" },
  ],
}

/** One deployment row, shaped as `DeploymentView` (`viewer/app/build-log-utils.ts`). */
/** A step list, as a completed build records it. */
export type SampleBuildStep = {
  name: string
  status: "running" | "succeeded" | "failed"
  startedAt: string
  endedAt?: string
}

/** The four phases of a build that worked, with plausible durations. */
const SAMPLE_BUILD_STEPS: SampleBuildStep[] = [
  { name: "Clone", status: "succeeded", startedAt: "2026-08-19T11:42:00.000Z", endedAt: "2026-08-19T11:42:03.000Z" },
  { name: "Install", status: "succeeded", startedAt: "2026-08-19T11:42:03.000Z", endedAt: "2026-08-19T11:42:24.000Z" },
  { name: "Build", status: "succeeded", startedAt: "2026-08-19T11:42:24.000Z", endedAt: "2026-08-19T11:42:31.000Z" },
  { name: "Publish", status: "succeeded", startedAt: "2026-08-19T11:42:31.000Z", endedAt: "2026-08-19T11:42:33.000Z" },
]

/**
 * A build that died at Install.
 *
 * Stops at the failed phase rather than listing Build and Publish as pending:
 * the runner records a phase when it STARTS one, so a phase it never reached
 * is simply absent. A UI that padded the list would be inventing steps that
 * never ran.
 */
export const SAMPLE_FAILED_BUILD_STEPS: SampleBuildStep[] = [
  { name: "Clone", status: "succeeded", startedAt: "2026-08-19T11:42:00.000Z", endedAt: "2026-08-19T11:42:03.000Z" },
  { name: "Install", status: "failed", startedAt: "2026-08-19T11:42:03.000Z", endedAt: "2026-08-19T11:42:19.000Z" },
]

/**
 * A build mid-flight: two done, one running, the rest not yet started.
 *
 * A FUNCTION, unlike its two siblings, and that is the point. A running step
 * is measured against `Date.now()`, so a fixed `startedAt` drifts further from
 * now every day this fixture survives — it rendered "4833m 35s" three days
 * after it was written. The finished steps keep literal timestamps because
 * their duration is the gap between two recorded times and cannot drift.
 */
export function sampleRunningBuildSteps(now: number = Date.now()): SampleBuildStep[] {
  const iso = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString()
  return [
    { name: "Clone", status: "succeeded", startedAt: iso(38), endedAt: iso(35) },
    { name: "Install", status: "succeeded", startedAt: iso(35), endedAt: iso(14) },
    { name: "Build", status: "running", startedAt: iso(14) },
  ]
}

export function sampleDeployment(
  overrides: Partial<{
    id: string
    status: "building" | "deployed" | "failed"
    commitSha: string | null
    commitMessage: string | null
    buildLog: string
    warnings: SampleDeploymentWarning[] | null
    steps: SampleBuildStep[] | null
    createdAt: string
  }> = {},
) {
  return {
    id: "dep-401",
    status: "deployed" as "building" | "deployed" | "failed",
    commitSha: "4f1c9a2e7b30d5c81ea6f3927b04d5c1a8e2f6b9",
    commitMessage: "Tighten checkout summary spacing",
    buildLog: SAMPLE_BUILD_LOG,
    warnings: null as SampleDeploymentWarning[] | null,
    steps: SAMPLE_BUILD_STEPS as SampleBuildStep[] | null,
    createdAt: "2026-08-19T11:42:00.000Z",
    ...overrides,
  }
}

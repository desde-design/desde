import type { ViewerConfig } from "../../../server/config"

/**
 * Stands in for `viewer/server/config` inside the gallery (redirected by the
 * `viewer-gallery-shims` plugin in `../../vite.config.ts`).
 *
 * Three SERVER components call `loadConfig()` at render time — `app/page.tsx`
 * (the dashboard), `app/review/[slug]/not-found.tsx`, and `app/setup/page.tsx`.
 * All three are plain synchronous function components, so `react-dom/client`
 * renders them for real; the only thing stopping them is that the real
 * config module imports `node:crypto`, which no browser bundle can carry.
 *
 * The type import above is erased at build time, so nothing here reaches the
 * real module at runtime — but the fixture below stays bound to the real
 * `ViewerConfig`, and `tsc` fails the moment the two diverge.
 *
 * Deployment configuration is a real state axis for these screens, not
 * scenery: `serveDomain` decides whether the dashboard links prototypes at
 * `/p/{slug}/` or at an isolated subdomain, `githubAuth` decides whether the
 * not-found screen offers "Sign in with GitHub" or only "Back to projects",
 * and `githubAuth`/`githubApp`/`email` together decide what the setup screen
 * reports as done. So the value is mutable and a fixture picks it — see
 * `setGalleryConfig`.
 */

const DEFAULT_CONFIG: ViewerConfig = {
  profile: "selfhost",
  port: 3100,
  allowedEmailDomains: null,
  dataDir: ".desde-viewer",
  publicUrl: "http://localhost:3100",
  adminToken: null,
  serveDomain: null,
  devBundler: "turbopack",
  email: null,
  emailSource: null,
  unsubscribeSecret: null,
  sessionSecret: "0".repeat(64),
  githubAuth: null,
  githubApp: null,
  prototypeCsp: null,
  prototypeOrigin: null,
  seedDemoProject: true,
  trustProxy: false,
  loopbackListeners: "auto",
  loopbackAvailable: true,
}

let current: ViewerConfig = DEFAULT_CONFIG

/**
 * Point `loadConfig()` at a different deployment shape for the next render.
 *
 * Call it from a fixture's `render`, not from an effect: the components that
 * read it are server components which call `loadConfig()` during their own
 * render pass, so a value set afterwards arrives one paint too late.
 */
export function setGalleryConfig(overrides: Partial<ViewerConfig>): void {
  current = { ...DEFAULT_CONFIG, ...overrides }
}

export function loadConfig(): ViewerConfig {
  return current
}

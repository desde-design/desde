# editor-cli (D-0.5 milestone)

The standalone Editor CLI that supervises the user's local Vite, injects the bridge + source-tag plugins, serves the editor React UI, and dispatches edits to source files. This is the shell layer of the core/shell split.

**Status: D-0.5 milestone reached.** Boots end-to-end against the spike test-app. Auth, edit endpoint, source-tagging, bridge injection, AND the full visual chain (Tailwind-styled UI mounts under the CLI bundle, bridge handshake completes inside the iframe, PropEdit fires HMR end-to-end) all validated. Two automated test suites: 17 server-side parity tests via `npm test`, 2 browser-driven smoke tests via `npm run test:smoke` (require Chrome installed at `/Applications/Google Chrome.app`).

## What's working

- `npx tsx src/cli.ts <repo-path>` boots a Vite dev server (via JS API, not CLI spawn) against the user's repo, instruments it with two plugins, and exposes a localhost HTTP server with the editor UI bundle.
- **Vite supervisor** ([src/supervisor/vite-supervisor.ts](src/supervisor/vite-supervisor.ts)): uses `loadConfigFromFile` + `mergeConfig` + `createServer` to wrap the user's `vite.config.{ts,js,mjs}` and inject our plugins without modifying the user's source tree.
- **Bridge plugin** ([src/plugins/bridge-plugin.ts](src/plugins/bridge-plugin.ts)): `transformIndexHtml` injects the existing desde bridge runtime (`dist/bridge-bundle.js` at the repo root; overridable with `--bridge-bundle`) into every served HTML response. Replaces the serve-time injection.
- **Source-tag plugin** ([src/plugins/source-tag-plugin.ts](src/plugins/source-tag-plugin.ts)): a minimal Vue SFC stamper using `@vue/compiler-sfc`. Stamps `data-desde-src="<file>:<line>:<col>"` on every concrete opening tag in `<template>` blocks, skipping nested `<template>` slots and idempotent on re-runs. Production-grade replacement (the starter-kit's full plugin) lands V1.4+.
- **HTTP server** ([src/server/http-server.ts](src/server/http-server.ts)): serves the static UI bundle, hosts `POST /api/editor/edit` and `GET /api/health`. Path-aligned with the web app's API route, so the vue3 adapter doesn't need a per-mode endpoint.
- **Security boundary** ([src/server/auth.ts](src/server/auth.ts)): a per-session 256-bit bearer token (rotated on every supervisor start), plus a strict Origin header check. State-changing endpoints are all gated.
- **Edit handler** ([src/server/edit-handler.ts](src/server/edit-handler.ts)): runs path-traversal, symlink, and .vue checks, then dispatches into the pure applicators in `src/editor/edit-service/`.
- **Smoke check** ([src/core.ts](src/core.ts)): fetches `/` and a sample SFC from the supervised Vite, and verifies the bridge `<script>` AND `data-desde-src` are present in the served output. Surfaces a clear error if either is missing.
- **CLI client wiring** ([ui-src/src/main.tsx](ui-src/src/main.tsx)): installs a `fetch` interceptor that adds `Authorization: Bearer <token>` to every same-origin `/api/*` request. This means the vue3 adapter's existing `fetch('/api/editor/edit', ...)` call site works in CLI mode without modification.

## Validated end-to-end

Boot the CLI, all probes pass:
- Vite up on 5173, editor UI up on 4321
- Bridge tag present in served HTML (1 occurrence)
- `data-desde-src` present in compiled `App.vue` (3 occurrences)
- Missing/bad Origin → 403
- Missing/bad token → 401
- Invalid edit body → 400 with structured reason
- Valid PropEdit → file actually changes on disk; response `{ok:true, file}`
- `/api/health` → 200 with viteUrl

## D-0.5 closures (this milestone)

- **Tailwind v4 + shadcn theme CSS**: wired in [ui-src/vite.config.ts](ui-src/vite.config.ts) via `@tailwindcss/postcss`. The CLI bundle's entry CSS at [ui-src/src/editor-cli.css](ui-src/src/editor-cli.css) imports the parent's `globals.css`, and adds explicit `@source` directives. This lets Tailwind v4 scan the parent monorepo's component tree for utility-class usage. (Without those directives, Tailwind would scan only `editor-cli/ui-src/`, and miss every utility used by the editor panels themselves.) Coverage is regression-guarded by [ui-src/__tests__/tailwind-coverage.test.ts](ui-src/__tests__/tailwind-coverage.test.ts), which asserts representative utilities (`h-screen`, `flex`, `bg-muted`, etc.) actually appear in the built CSS. CSS chunk: ~51 KB / 9 KB gzip.
- **CSP-safe bundle delivery**: the bootstrap (token + viteUrl) and the bridge bundle are both served from external files now. The bootstrap is at `/__desde/bootstrap.js` with `Cache-Control: no-store`, so a stale token never gets reused after a CLI restart. It also sets `Cross-Origin-Resource-Policy: same-origin` and `X-Content-Type-Options: nosniff`, so a malicious page in the user's browser can't `<script src=…>` it cross-origin to read the token. The bridge bundle is served by the user's Vite dev server at `/@desde-bridge.js?v=<bridgeVersion>` via `configureServer` middleware: exact-pathname match, GET/HEAD only, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: max-age=300` (the version-prefixed URL is its own cache buster). Both injection points now produce single `<script src="…">` tags with no inline JavaScript, so the served HTML is policy-friendly under `script-src 'self'`. (The residual config inline tag from the earlier cut was dead code, consumed by nothing, and has been removed entirely.)
- **Browser-driven smoke**: [src/__smoke__/browser-smoke.test.ts](src/__smoke__/browser-smoke.test.ts) launches the CLI as a child process, and opens a real Chromium via Playwright (it uses the system Chrome at `/Applications/Google Chrome.app`, to skip the 150 MB Playwright cache download). It validates two scenarios end-to-end: (1) the shell mounts, the bridge handshake completes inside the iframe, and there are zero console errors; (2) a PropEdit through the authenticated CLI API triggers Vite HMR, and the iframe DOM re-renders with the new attribute. Closes the most important D-0 errata item.

## D-1 additions (Phase 1–5 of the early-access milestone)

- **Dual `originPolicy` auth.** `/api/*` keeps the strict CSRF defense; `/mcp/*` uses `"if-present"` so MCP clients without browser-style Origin headers can reach it while browser-originated calls with mismatched Origin still fail closed.
- **/mcp/status endpoint.** First MCP method on the `editor-local` scope. Backed by spawn-based git probes (`rev-parse`, `status --porcelain`, `log -1 --format=%cI HEAD`) with detached-HEAD / unborn-HEAD detection, 1-second TTL cache invalidated on edit. Returns the contract from `src/editor/mcp/status-schema.ts` with the `editor-mcp-status-version: 1` header.
- **No platform sign-in.** There is no platform sign-in, and the Editor holds no credentials of its own. AI features need a key from one supported model provider: set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, or add one from the settings gear in the app (one tab per provider). There is also a Claude-subscription path, but it is opt-in only (`EDITOR_USE_CLAUDE_SUBSCRIPTION=1`), for running Desde for yourself. It is opt-in because Anthropic's Agent SDK terms do not allow a distributed product to offer claude.ai login. Viewer access uses a `dsv_` personal access token: see `viewer-token-store.ts`.
- **Project association.** `.desde/config.json` (committed to the user's repo) carries `projectSlug` + optional `platformBaseUrl` override. The supervisor loads it at boot and threads it through to the platform API client.
- **Framework detection.** Validates Vue 3 + Vite + the design system at boot. Hard refusal (exit code 3) for Vue 2 / missing Vite / no `vite.config.{ts,js,mjs,cjs}`; soft warnings for the design system missing, Vite < 4, or unparseable Vue version. Multi-major ranges (`>=2.7.0 <4.0.0`, `^2 || ^3`, etc.) treated as ambiguous → warning, not refusal.
- **Multi-instance port allocation.** Requested ports are tried first; on EADDRINUSE the OS picks free ports. `pickTwoPorts` holds the first probe open while picking the second so OS-picked fallbacks can't collide.

161 unit + integration tests across 13 files; codex-clean on every commit.

## What's still NOT done (V1+ follow-ups)

- **JSON-RPC envelope + version header.** Lands when a third method appears that needs the RPC shape (status was REST-shaped, so the envelope wasn't strictly required at Phase 3).
- **Platform-side deployment-lookup endpoint.** No such integration exists yet. `/mcp/status` reports `ahead_of_deployment: "unknown"` until one is built against the viewer's API (`GET /api/v1/projects/{id}/deployments`, keyed by project id).
- **Production-grade source-tag plugin.** D-0's plugin is AST-based via `@vue/compiler-sfc`'s parser (correct on quoted-attr edge cases + first-line column offset, detects both static and `:data-desde-src`), but still Vue-only and lacks slot/JSX-in-Vue/custom-directive coverage. The starter-kit's full plugin replaces it V1.4+.
- **CI-runnable smoke.** The current browser smoke uses the system Chrome installation. The CI counterpart needs `npx playwright install chromium` first; not yet wired.

## Run it

```sh
# From repo root
cd editor-cli
npm install
npm run build:ui

# Then point at any Vue+Vite repo (with .desde/config.json for project association)
npx tsx src/cli.ts <repo-path>

# Open http://127.0.0.1:4321 in a browser
```

> After editing any editor source under `src/hooks/`, `src/components/editor/`, `src/bridge/`, etc., re-run `npm run build:editor` from the repo root (rebuilds both the UI bundle and the bridge bundle in one shot) and hard-refresh the browser.

Project config lives at `<repo>/.desde/config.json`:

```json
{
  "version": 1,
  "projectSlug": "example-app",
  "platformBaseUrl": "https://example-app.proto.desde.dev"
}
```

## Environment variables

Read at runtime, not documented elsewhere:

- **`EDITOR_CANVAS`**: set to `1` to restore the default-dormant Canvas / screenshot-plan surface. Same either-enables contract as `editor.canvas: true` in `.desde/config.json`. See [src/server/http-server.ts](src/server/http-server.ts) and [src/server/dormant-surfaces.ts](src/server/dormant-surfaces.ts), which reads the same flag on the server side so the API refuses the surface too, not just the UI.
- **`EDITOR_REVIEW_SURFACE`**: set to `bridge` (or `off`/`0`) to force the agent's self-review off the isolated Playwright review surface and back onto the live bridge. See [src/review-surface/index.ts](src/review-surface/index.ts).
- **`EDITOR_PROTOTYPE_ROOT`**: override for the prototype's root directory, used by manifest/token grounding and the design-tokens handler when it isn't otherwise configured. See [src/server/design-tokens-handler.ts](src/server/design-tokens-handler.ts) and `src/editor/edit-service/build-manifest-source.ts`.
- **`EDITOR_PROTOTYPE_TSCONFIG`**: override path to the prototype's `tsconfig.json`, for prototypes whose tsconfig isn't at the project root. See `src/editor/core/resolve-tsconfig.ts`.
- **`EDITOR_STORYBOOK_URLS`**: comma-separated Storybook URLs to pull component manifests from. See `src/editor/edit-service/parse-storybook-urls.ts`.
- **`EDITOR_STORYBOOK_HOST_ALLOWLIST`**: comma-separated hostnames to allow for `EDITOR_STORYBOOK_URLS`, when the URL resolves to a loopback, private, or link-local address (refused by default as an SSRF guard). See `src/editor/edit-service/parse-storybook-urls.ts`.

## Architecture decisions made overnight

- **Edit logic lives in shared pure modules.** The edit-handler at [src/server/edit-handler.ts](src/server/edit-handler.ts) handles transport concerns (path-resolution, auth, I/O); all edit logic lives in the pure applicators in `src/editor/edit-service/`. Path-traversal and symlink guards are duplicated in the handler because they're tied to the transport's notion of "where the prototype root is" and didn't extract cleanly alongside the applicators.
- **`tsx` shim instead of compiled output.** D-0 ships TypeScript source + a `tsx`-loader bin shim ([bin/desde.mjs](bin/desde.mjs)) rather than `tsc`-compiled `.js`. Keeps the CLI development loop fast (no rebuild step). When the CLI graduates to standalone npm distribution (V1.4+) this becomes a `tsc` build target.
- **Cross-package imports for the applicators.** `editor-cli/src/server/edit-handler.ts` imports from `../../../src/editor/edit-service/`. The relative path is ugly on purpose: the CLI lives inside the desde monorepo for D-0 specifically, so it can reach these without a publish step. When the CLI extracts to its own package, the applicators extract too.
- **Tailwind deferred.** D-0's bar is logic validation (audit's smoke-test gate). Visual styling deferred to V1.5 to keep this milestone scoped.
- **Path-aligned endpoint with web API.** CLI exposes `/api/editor/edit` (not the originally-planned `/api/edit`) so the vue3 adapter's existing fetch call works in both modes. No CLI-mode-specific code in the adapter.
- **Token over Origin via fetch interceptor in main.tsx.** The vue3 adapter doesn't carry the bearer token; the interceptor adds it for any `/api/*` request when running under the CLI bundle. Keeps the adapter agnostic.

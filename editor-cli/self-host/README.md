# Editor self-host harness

A plain Vite + React app that renders the **real** Editor chrome
(`src/components/editor/*`, `src/editor-ui/*`) with mock data, so
Editor can supervise and edit its own UI. The components are the real
source files (imported via the `@` alias → monorepo `src/`), so edits
land in real files: no clone, no port-back.

This exists because the **Next.js shell can't be supervised** (no
`vite.config`, no serve-time plugin hook), but the CLI Editor UI is a
Vite + React app and those chrome components are now consumed **only** by
the CLI (the web editor surface no longer exists).

## What it renders: the FULL chrome (mock boot)

`src/main.tsx` is a **mock boot of the real `EditorPage`**: the same
component `editor-cli/ui-src/src/main.tsx` mounts for the live CLI. So
the harness shows the *entire* Editor UI, not a gallery of pieces: the
top bar (Editor/Canvas, Navigate/Select, Screenshot, **Commit/Push**),
the live editing surface, the right rail with every tab (Edit + inspector,
Annotations, Flows, Activity with the session commit log, Checks,
Systems), the **chat session tab strip**, and the chat panel, all
populated with mock data.

It achieves this by swapping the live CLI backend for stubs:

- `index.html`: an inline `<script>` sets `window.__DESDE_CLI__`
  **before** the module script. This ordering is load-bearing: fields like
  `framework` / `stylingSystem` are read off the global at module-EVAL
  time, and ES imports are hoisted, so setting it inside `main.tsx` would
  be too late. Mirrors how the real CLI injects the bootstrap. (The mock
  bootstrap's `worktreePath` field is a vestige of the removed
  worktree-session mode. Branch mode, the only substrate today, ignores
  it.)
- `src/mock-backend.ts`: patches `window.fetch` and answers the ~30
  `/api/editor/*` routes from fixtures (sessions, commit/push state, a
  commit log, tokens, icon sets, …). Both `editorFetch` and bare `fetch`
  funnel through `window.fetch`, so this one hook covers everything;
  non-`/api` requests pass through.
- `src/main.tsx`: installs the mock backend, wires session id + CLI user
  identity, seeds `?url=prototype.html` (so the live `EditorSurface`
  mounts), renders `<EditorPage>`, and runs the boot nudges: seeds the
  inspector selection (`mock-selection`), seeds the Layers tree
  (`mock-layers`), and auto-fires one chat turn so the Chat tab shows a
  live "thinking" state.
- `src/mock-layers.ts`: a representative `OutlineNode[]` tree seeded into
  the **Layers** panel via `window.__DESDE_SELF_HOST_LAYERS__` (read
  by `useEditorEditing`'s `layersRoots` initializer). Mirrors how
  `mock-selection` seeds the inspector: with no live bridge the tree would
  sit on "Loading layers…" forever. A real bridge (CLI supervision)
  overwrites it with the live `prototype.html` tree on connect.
- `src/mock-chat.ts`: the **Chat** fixtures: persisted transcripts
  (`GET /chat/sessions/:id`, hydrated on tab click) plus a held-open SSE
  "thinking" stream (`POST /chat`) that emits a reasoning block + a `Grep`
  tool-use and never completes, so the panel parks on the pulsing
  "Thinking…" state. `main.tsx` selects an existing session tab (so the
  turn lands in an existing bucket: no new-chat re-key) then sends a
  prompt to trigger it.
- `prototype.html`: the inner prototype iframe target. There's no live
  prototype, so the surface shows its "Connecting to bridge…" affordance
  (expected); we're polishing chrome, not editing a live target.
- `vite.config.ts`: mirrors `ui-src/vite.config.ts` (`@` → monorepo
  `src/`, react plugin, Tailwind v4).
- `package.json`: declares react + vite so the CLI's framework detection
  resolves this as a React + Vite target.

Every component on screen is the **real** `src/components/editor/*` /
`src/editor-ui/*` source (imported via the `@` alias), so edits land in
real files: no clone, no port-back.

This exists because the **Next.js shell can't be supervised** (no
`vite.config`, no serve-time plugin hook), but the CLI Editor UI is a
Vite + React app and those chrome components are now consumed **only** by
the CLI (the web editor surface no longer exists).

### Adding/adjusting fixtures
If a panel renders empty or a tab throws after a UI change, it's almost
always a missing/again-shaped `/api/editor/*` fixture. Add it to the
route table in `src/mock-backend.ts`. The catch-all returns `{ ok: true }`
for unlisted routes; a caller that does `setX(body.field)` on a missing
field is the usual culprit (give it the real shape).

## Status: supervisable

Booting the CLI against this harness now works end-to-end:

```sh
node editor-cli/bin/desde.mjs editor-cli/self-host
```

Vite serves the harness, the bridge `<script>` is injected, and the real
`ChatSessionTabs` (imported across the `@`-alias boundary, so it lives
*outside* the Vite root) is transformed with **git-root-relative**
`data-desde-src` stamps (e.g. `data-desde-src="src/components/editor/chat-session-tabs.tsx:147:4"`),
which the edit handler resolves straight into the monorepo checkout.
Click→edit→commit lands in the real source, uncommitted, on whatever
branch is checked out (branch mode;
there is no per-session worktree and no auto-commit).

**How it works (the subdir supervision mode):** the CLI previously
assumed the supervised path *was* the git-repo root and 404'd on a
subdir (edits were scoped to that root). Now
([prototype-location.ts](../src/server/prototype-location.ts) +
[core.ts](../src/core.ts) + [vite-supervisor.ts](../src/supervisor/vite-supervisor.ts)):

- `repoRoot` resolves to the **git root** of the real checkout (the
  monorepo top, for this harness), so the `node_modules` symlink +
  `.desde/` scaffolding work, and all shared source
  (`src/components/editor/*`) is reachable and editable directly, with
  no worktree in between.
- Vite roots + loads `vite.config` from `<repoRoot>/<subdirOffset>` (the
  prototype subdir, `editor-cli/self-host` here) via the supervisor's
  `prototypeRoot`.
- The source-tag plugin + edit handler keep using `repoRoot`, so stamps
  stay repo-root-relative and resolve correctly, including the shared
  components above the subdir.

`subdirOffset === ""` (prototype IS the repo root) collapses to the prior
behavior, so single-package prototypes are unaffected.

### Caveat
The boot-time smoke check is Vue-specific (`data-desde-src not found in any
compiled .vue module`) and warns harmlessly for React prototypes. It
doesn't gate boot. Minor follow-up: make the smoke check framework-aware.

## Run (raw, no Editor supervision)

```sh
cd editor-cli/self-host
../node_modules/.bin/vite        # dev server
../node_modules/.bin/vite build  # static build (artifacts gitignored)
```

## Surface gallery

`npm run gallery` (from the repo root) serves this harness at
http://localhost:5199. Append `?gallery=` to open the surface picker: every
error/decision modal, inline conflict banner, and toast, rendered over the real
chrome with fixture data. `?gallery=<state-id>` opens one directly; `[` and `]`
step through the catalog.

The catalog lives in `src/components/editor/gallery/` (not here) so the root
vitest runner can render-test it. See
the surface-gallery design note, which is kept with the maintainer's internal notes rather than in this repository.

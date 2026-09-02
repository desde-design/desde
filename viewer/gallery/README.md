# Viewer surface gallery

Every screen, dialog and panel the viewer can render, on demand, with fixture
data: no server, no database, no GitHub App, no built prototype.

```bash
npm run gallery:viewer
```

Then open http://localhost:5281. Pick a surface from the rail on the right, or
open one directly with `?gallery=<state-id>`. `[` and `]` walk the whole
catalog.

## Why it exists

The viewer's screens are expensive to look at. Seeing the review screen with
real comments on it means running the server, signing in through a GitHub App,
connecting a repository, waiting for a build, and then writing comments. Seeing
its *failure* states means breaking one of those on purpose. Most of them have
therefore never been designed, only implemented.

This is the same instrument the Editor has (`npm run gallery`), pointed at the
other product surface.

## What it renders

The **real** components, imported from `viewer/app/**`. Nothing here re-creates
a screen's markup, so a fixture cannot drift into showing a viewer that does
not exist. Where a screen is a Server Component, it is imported and rendered
directly: `app/page.tsx`, `app/settings/page.tsx` and
`app/review/[slug]/not-found.tsx` are all synchronous, so `react-dom` renders
them for real.

The one screen that is NOT rendered as its own module is
`app/review/[slug]/page.tsx`. It is an `async` Server Component whose entire
job is resolving a project and handing it to `<ReviewShell project={…}>`; the
gallery renders `ReviewShell` directly with a fixture project, which is the
same thing the page does.

## Layout

```
viewer/gallery/
  index.html            dev-server entry
  vite.config.ts        root config: aliases, the two module shims
  postcss.config.mjs    Tailwind v4 (see the file for why it is not inline)
  registry.ts           THE CATALOG: one entry per surface
  fixtures/*.tsx        one module per surface, each exporting a SurfaceEntry
  harness/
    main.tsx            entry point: installs the fakes, mounts the shell
    gallery-shell.tsx   the picker rail + the stage
    gallery.css         Tailwind entry
    mock-backend.ts     baseline answers for every /api/v1 endpoint
    fake-event-source.ts    a drivable stand-in for SSE
    fixture-data.ts     the shared sample records
    scenario.tsx        Scenario / PanelFrame / DialogFrame
    shims/next-link.tsx     next/link -> <a>
    shims/server-config.ts  loadConfig() -> a fixture ViewerConfig
```

The generic machinery (the state types, the URL contract, the keyboard walk,
the action log) is shared with the Editor's gallery and lives in
`src/components/gallery/`.

## The three shims, and why each exists

This is a Next.js app booted by plain Vite, which needs exactly three things
replaced. Each is narrow and each is here for a measured reason.

| Shim | Replaces | Because |
| --- | --- | --- |
| `harness/shims/next-link.tsx` | `next/link` | Five viewer files import it for ordinary navigation. There is no router here, so the shim is an `<a>` that renders its href and suppresses the click. |
| `harness/shims/server-config.ts` | `viewer/server/config` | `app/page.tsx` and the review 404 call `loadConfig()`. The real module imports `node:crypto`, which no browser bundle can carry. |
| `harness/fake-event-source.ts` | `EventSource` | The build panel and the comment store each open an SSE stream on mount. The real one would connect, fail and retry forever. |

Plus `window.fetch`, which `harness/mock-backend.ts` owns.

`loadConfig` is not only a stand-in. It is a control. Deployment configuration
changes what these screens say: a configured serve domain changes where every
"Open" link points, and a configured GitHub App is the difference between the
404 offering sign-in and not. A fixture calls `setGalleryConfig({…})` to pick.

## Adding a state

1. Find the fixture module for the surface in `fixtures/`, or add one.
2. Add a `SurfaceState` with a stable `id` of the form `<entry id>/<slug>`.
3. Reach the state one of three ways, in order of preference:
   - **props**: pass them;
   - **a scenario**: wrap in `<Scenario routes={{…}}>` and answer the one or
     two endpoints that decide the state. `PENDING` is how you get a loading
     state; `NETWORK_ERROR` is how you get an offline one;
   - **a driven interaction**: for anything behind internal `useState` that no
     prop can set. Run the same clicks a user would from an effect, and set
     `readyWhen` to a selector that appears only once the state has arrived.
4. Wire every callback to `ctx.log(...)`. The rail's "Calls" panel is how a
   reviewer sees what a control actually invoked, which for decision UI is as
   much the subject as the layout.

Two things keep the catalog honest, and neither is a bespoke staleness check:
fixtures are typed against the real components, so `cd viewer && npx tsc
--noEmit -p tsconfig.json` fails the moment a prop changes; and
`registry.test.tsx` renders every state, so a fixture that typechecks but
throws is caught by `cd viewer && npx vitest run`.

## What it does not do

- **No screenshots.** The Editor's gallery has a Playwright contact-sheet
  script; this one deliberately does not. It is a thing to click through.
- **No dark mode review.** The theme toggle exists because the shared
  controller provides it. Dark mode has not been designed yet, so review
  only in light mode.
- **No toasts.** The viewer has none; every error it reports is inline. If that
  ever changes, the shared controller already supports a `fire`-style state.

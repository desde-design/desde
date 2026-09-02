# Contributing to Desde

Desde is a young project. It is pre-1.0, and the API and internal structure
can still change. If something in this guide turns out to be wrong, open an
issue or a pull request and it will get fixed.

Desde is a **prototype operations platform** with two main surfaces: the
**Editor**, a local CLI for live authoring, and the **Viewer**, a
self-hostable app for reviewing prototypes. `README.md` covers how to run
each one.

## License

Desde is licensed AGPL-3.0-or-later (see `LICENSE`). By contributing, you
agree that your contribution is licensed under the same terms.

## Setting up

You need Node.js 20 or later (this repo is developed on 25.x). The
`editor-cli` package additionally requires Node 22.12 or later, set in its
own `package.json`.

The root, `editor-cli`, and `viewer` are separate npm projects, so each
needs its own install:

```bash
npm install
npm --prefix editor-cli install
npm --prefix viewer install
```

The root `.env.example` documents one optional variable,
`ANTHROPIC_API_KEY`. The AI features (chat and the edit-repair lane) need it; the
inspector, direct edits, comments, Commit and Publish work without one. You can
also add the key from the settings gear in the app.

To run the Viewer locally, copy `viewer/.env.example` to
`viewer/.env.local`, fill in GitHub App credentials, then run
`cd viewer && npm run dev:local`. Full detail, including why to use
`dev:local` and not `start:local`, is in `README.md`.

To run the Editor CLI against a prototype repository:

```bash
cd editor-cli
npm run dev -- <repo-path>
```

### About the bundled font

The wordmark is set in Chillax, under the ITF Free Font License. The licence
text sits beside the file in `src/styles/fonts/`.

That licence grants what this project does with it: Section 01 permits
embedding the font in desktop applications and self-hosting it on your own
sites. Section 02 forbids redistributing the font itself, and lists a
repository as one of the ways you must not. Whether a source repository that
exists to build such an application counts as redistribution is a judgement
call, and it is being reviewed. If the file is removed later, the build will
warn and fall back to the body sans rather than failing, and this section will
say where to fetch your own copy.

## Before opening a pull request

Run the gates that apply to what you changed. Continuous integration on this repository is deliberately narrow: one workflow fails any push that tracks a private path, and one asks first-time contributors to sign the CLA. Neither builds or tests the code. The gates below run on your machine, and that is where a change is proven.

**Always run this from the repo root:**

```bash
npm run verify
```

In order, this runs: typecheck, lint, the root unit tests, the `editor-cli`
unit tests, a knip dead-code check, a check that the bridge version was
bumped if bridge code changed, and a browser smoke test. It is the closest
thing this repo has to one command that catches most problems.

**What `npm run verify` does not cover:**

- `editor-cli`'s own typecheck. If you touched anything under
  `editor-cli/`, also run:
  ```bash
  cd editor-cli && npm run typecheck
  ```
- Anything in `viewer/`. `npm run verify` does not run the Viewer's tests
  or typecheck at all. If you touched `viewer/`, run:
  ```bash
  cd viewer && npx vitest run && npx tsc --noEmit -p tsconfig.json
  ```

**Extra steps for specific changes:**

- Changed a route or layout in the Viewer's Next.js app? Run
  `cd viewer && npm run build`. Changed one in the website? Run
  `cd website && npm run build`. Either catches a Server/Client Component
  boundary problem that typecheck alone will not. There is no Next.js app
  at the repo root to build; the root `package.json` has no `build`
  script.
- Changed bridge code (any file under `src/bridge/`)? Bump
  `BRIDGE_VERSION` near the top of `src/bridge/comment-bridge.ts`, then run
  `npm run build:bridge` and commit the rebuilt `dist/bridge-bundle.js`
  alongside your source change. `npm run verify` checks that the version
  was bumped, but it cannot bump it for you.
- Does your change alter behaviour the documentation describes? The docs site
  lives in a separate, private tree and is not part of this repository, so its
  link and citation checkers do not run here. Say what changed in the pull
  request and the maintainer will update the docs alongside it.

## The lint bar

`npm run lint` runs `eslint --max-warnings 0` across the whole repository.
The bar is zero errors and zero warnings, not "no new ones." If a warning
is a deliberate, reasoned exception, silence it with a one-line
`eslint-disable-next-line` comment that explains why, placed directly above
the line it applies to. Do not use a file-level disable, and do not
promote a rule to `error` just to get around this.

## Code style

- React function components only. No class components.
- TypeScript strict mode. Avoid `any`.
- Named exports for components, hooks, and services.
- Props are defined with a TypeScript interface and destructured in the
  function signature.
- Hooks are prefixed with `use` and live in `/src/hooks`.
- Styling is Tailwind CSS plus the shadcn/ui theme tokens defined in
  `src/styles/globals.css` (`bg-muted`, `text-muted-foreground`, and so
  on, and they adapt to dark mode). Never hardcode a hex color or use
  `text-[#...]` / `bg-[#...]`. Use a token instead, or an opacity modifier
  on one (`bg-primary/10`).
- The type scale is named, not Tailwind's default one. `text-base` is
  13px, and the whole ramp is custom. `text-[Npx]` is banned and flagged
  by ESLint.
- Use shadcn/ui primitives for interactive UI (`Button`, `Dialog`,
  `Popover`, `Tooltip`, and so on) instead of raw HTML elements. ESLint
  flags a raw `<button>` under `src/components/**`.
- Use the `cn()` utility from `lib/utils.ts` for conditional classes,
  never string concatenation.
- Zustand stores use the slice pattern.
- Next.js App Router: Server Components by default, `'use client'` only
  when you need state, effects, or a browser API.
- Prefer `async`/`await` over `.then()` chains.

## Where the pieces live

The layout is mostly self-describing. Run `ls src/`, `ls editor-cli/src/`,
and `ls viewer/` rather than trusting a stale directory map in a doc. A few
things worth knowing up front:

- `src/editor/core/` and `src/types/` are framework-neutral. They must
  never import Vue or React.
- `dist/bridge-bundle.js` is a build output that is committed on purpose,
  so a fresh clone has a working bundle. See the bridge version note above
  for how to keep it current.
- `editor-cli/src/server/edit-handler.ts` is the single dispatcher for
  every editor edit. Do not add a second entry point.
- Desde is a generalized product, not a tool built for one framework or
  design system. Framework and design-system specifics belong behind an
  adapter in `src/editor/adapters/`, never in a core type or component.
  See `src/editor/adapters/README.md` for the adapter architecture.

## Contributor License Agreement

The first time you open a pull request, a bot will comment asking you to
sign the Contributor License Agreement. Read `CLA.md` at the repo root, then
reply to that comment with the exact sentence it asks for: "I have read the
CLA Document and I hereby sign the CLA." You only need to do this once;
later pull requests will not ask again.

## Opening the pull request

Use the pull request template. Say what changed, why, and which gates you
ran. Keep the change focused. A pull request that does one thing is easier
to review than one that does five.

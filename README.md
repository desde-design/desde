# Desde

A **prototype operations platform** with two surfaces: the Editor and the Viewer.
The Start-here section and the table below cover what each one is and how to run it.

A walkthrough in under three minutes: change a prototype in the Editor, share it in the
Viewer, get mentioned in a comment, and make the fix.

https://github.com/user-attachments/assets/cfbf4ae3-bdef-4f18-93c7-67a19c24e34a

- **Documentation:** [desde.design/docs](https://desde.design/docs)
- **Editor download (macOS, Apple silicon):** [releases](https://github.com/desde-design/desde-editor-releases/releases/latest)
- **Viewer Docker image:** `ghcr.io/desde-design/viewer`. The
  [Viewer quickstart](https://desde.design/docs/quickstart/viewer) runs it with one command,
  and the [deploy guide](https://desde.design/docs/viewer/deploy) sets it up for a team.

## Start here

Desde is in beta. Here are three ways in, depending on what you want to do.

- **Use the Editor.** Point it at your own prototype's repo and edit its source live.
  The Editor is a signed macOS app for Apple silicon, on the
  [releases page](https://github.com/desde-design/desde-editor-releases/releases/latest).
  It keeps itself up to date. Start with the
  [Editor quickstart](https://desde.design/docs/quickstart/editor). On any other machine,
  [run it from a checkout](https://desde.design/docs/reference/run-from-a-checkout).
- **Self-host the Viewer.** A self-hosted review app: one Node process, SQLite, local
  disk, a build pipeline, comments and mentions. Try it on your own machine with Docker:

  ```bash
  docker run --rm -p 3100:3100 -v desde-viewer:/data ghcr.io/desde-design/viewer:latest
  ```

  The [Viewer quickstart](https://desde.design/docs/quickstart/viewer) walks through
  signing in. The [deploy guide](https://desde.design/docs/viewer/deploy) sets it up for
  a team. To run it from this checkout instead, see [viewer/README.md](viewer/README.md).
- **Contribute.** Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the checks to
  run before a pull request. Read [SECURITY.md](SECURITY.md) to report a vulnerability.

| Surface | What it is | Install | From a checkout |
|---|---|---|---|
| **Editor** | A local app. Starts your prototype's own dev server (Vite, Next.js, Nuxt or React Router), injects the bridge, and edits source through a deterministic-first pipeline. | [Download for macOS](https://github.com/desde-design/desde-editor-releases/releases/latest/download/Desde-arm64.dmg) | `node editor-cli/bin/desde.mjs <repo-path>` |
| **Viewer** | Self-hostable review app: one Node process, SQLite and local disk, invite-only sign-in. | The Docker image, with the command above | `cd viewer && npm run dev` |

---

## Local Development

### Prerequisites

- Node.js 24 or newer. CI and the Viewer image run on 24, and the Viewer needs it for
  Node's built-in SQLite. The Editor on its own needs 22.12 or newer.
- npm and git
- A prototype repo of your own to point the Editor at (Vue 3 or React, on Vite, Nuxt,
  Next.js or React Router)

### Install dependencies

The root, `editor-cli` and `viewer` are separate npm projects, so each needs its own
install:

```bash
npm install
npm --prefix editor-cli install
npm --prefix viewer install
```

Then build the Editor's interface once. It is not committed, and the Editor refuses to
start without it:

```bash
npm --prefix editor-cli run build:ui
```

You do not need to build the bridge. Its bundle, `dist/bridge-bundle.js`, is committed,
and CI fails any commit where it does not match the source.

### Environment

The Editor's AI features, such as chat, need a key from Anthropic or OpenAI. Everything
else, including the inspector, direct edits, comments, Commit and Publish, works without
one. Add a key from the settings menu inside the app, or export `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` in the shell that starts the Editor. The root `.env.example` lists these
variables, but nothing loads a root `.env` file for you.

The **Viewer** needs no configuration to run locally:

```bash
cd viewer && npm run dev
```

It seeds a demo project and prints a sign-in link. To configure it, copy
`viewer/.env.example` to `viewer/.env.local`, set what you need, and run
`npm run dev:local` instead, which reads that file. `dev:local` stops at once with
`.env.local: not found` if the file does not exist.

Use `dev` or `dev:local` for development, **not** `start` or `start:local`. Those set
`NODE_ENV=production`, which makes the server hand requests to a prebuilt `.next` that may
be stale and missing whole routes, with no warning.

### Verify before pushing

```bash
npm run verify      # typecheck, lint, root and editor-cli tests, knip, bridge checks
```

Or run the stages one at a time:

```bash
npm run typecheck   # TypeScript strict mode check
npm run lint        # ESLint, zero errors and zero warnings
npm run test        # Vitest unit tests for the root src/ only
```

For the editor-cli (a sibling package with its own vitest config):

```bash
cd editor-cli
npm run typecheck   # TypeScript strict mode (CLI source)
npm run test        # Vitest unit + parity + Tailwind-coverage tests (fast)
npm run test:smoke  # Playwright browser smoke (~6s, requires Chrome at /Applications/Google Chrome.app)
```

For the Viewer, which `npm run verify` does not cover:

```bash
cd viewer && npx vitest run && npx tsc --noEmit -p tsconfig.json
```

### Run the Editor from this checkout

After the install steps above, from the repo root:

```bash
node editor-cli/bin/desde.mjs <repo-path>
```

It starts your prototype's own dev server and opens the Editor at
`http://127.0.0.1:4321`. If a port is taken it picks a free one, so use the URL it
prints. Use that exact URL, host and all: the Editor refuses actions from a page opened
at `localhost`.

Useful flags (all optional):
- `--shell-port <n>`: Editor UI port (default `4321`)
- `--vite-port <n>`: port for your prototype's dev server (default `5173`)
- `--attach <url>`: use a dev server you already started instead of booting one
- `--no-open`: don't open the browser
- `--bridge-bundle <path>` / `--ui-bundle-root <path>`: override the served bundle paths

`node editor-cli/bin/desde.mjs --help` prints the full usage. The
[CLI reference](https://desde.design/docs/reference/cli) documents every flag and exit
code. There is no platform sign-in; the Editor holds no credentials of its own.

### Rebuilding editor bundles after source changes

The Editor serves two prebuilt bundles that do **not** hot-reload when their source
changes:

- **Editor UI bundle**: `editor-cli/ui-src/dist/`. Built from `src/hooks/`,
  `src/components/editor/`, and the rest of the React surface imported via the `@/`
  alias. Rebuild it with `npm --prefix editor-cli run build:ui`.
- **Bridge bundle**: `dist/bridge-bundle.js` at the repo root. Injected into the
  prototype's HTML at serve time. Rebuild it with `npm run build:bridge`, after bumping
  `BRIDGE_VERSION` (see [CONTRIBUTING.md](CONTRIBUTING.md)).

`npm run build:all` rebuilds both, plus the CLI's server bundle. You do not need to
restart the Editor. It watches the bridge bundle and reloads the prototype when it
changes. It serves the UI's `index.html` uncached, so reloading the browser tab picks up
a new UI build.

---

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for the full text.

In short: you can self-host this, modify it, and use it commercially. The one AGPL-specific
rule is the network clause: if you modify it and run that modified version for other people
to use over a network, you have to make the modified source available to them. Running it
unmodified doesn't trigger this. This isn't legal advice; read the license for what it
actually requires.

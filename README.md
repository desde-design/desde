# Desde

A **prototype operations platform** with two surfaces: the Editor and the Viewer.
The surface table and the Start-here section below cover what each one is and how
to run it.

- **Documentation:** [desde.design/docs](https://desde.design/docs)
- **Editor download (macOS, Apple silicon):** [releases](https://github.com/desde-design/desde-editor-releases/releases)
- **Viewer Docker image:** `docker pull ghcr.io/desde-design/viewer:latest`, or build it
  from [viewer/Dockerfile](viewer/Dockerfile); the
  [deploy guide](https://desde.design/docs/viewer/deploy) walks through it

## Start here

This is a large monorepo. Here are three ways in, depending on what you want to do.

- **Self-host the Viewer.** A self-hosted review app: one Node process, SQLite, local
  disk, a build pipeline, comments and mentions. The image is published at
  `ghcr.io/desde-design/viewer`, or you build it from this checkout. See [viewer/README.md](viewer/README.md) or
  the [deploy guide](https://desde.design/docs/viewer/deploy).
- **Use the Editor.** Point it at your own prototype's repo and edit its source live.
  Desde is in beta. The desktop app is a signed macOS build on the
  [releases page](https://github.com/desde-design/desde-editor-releases/releases);
  it also runs from a checkout. Start with the
  [Editor quickstart](https://desde.design/docs/quickstart/editor).
- **Contribute.** Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the checks to
  run before a pull request. Read [SECURITY.md](SECURITY.md) to report a vulnerability.

| Surface | What it is | How to run it |
|---|---|---|
| **Editor** | Local authoring CLI. Supervises your Vite dev server, injects the bridge, edits source through a deterministic-first pipeline. | `node editor-cli/bin/desde.mjs <repo-path>` |
| **Viewer** | Self-hostable review app: one Node process, SQLite + local disk, GitHub App auth. | `cd viewer && npm run dev:local` (see [viewer/README.md](viewer/README.md)) |

User documentation is at [desde.design/docs](https://desde.design/docs). To
contribute to Desde itself, start with [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Local Development

### Prerequisites

- Node.js 20+ (developed on 25.x)
- npm
- A prototype repo of your own to point the Editor at (Vue or React, on Vite, Nuxt, Next.js or React Router)

### Install dependencies

```bash
npm install
npm --prefix editor-cli install
npm --prefix viewer install
```

### Environment

The root `.env.example` documents the model-provider keys: `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY`. The Editor's AI features (chat, the edit-repair lane) need one of them;
everything else, including the inspector, direct edits, comments, Commit and Publish, works
without any. You can also add a key from the settings gear inside the app. Viewer
configuration is in `viewer/.env.example`.

For the **viewer**, copy `viewer/.env.example` to `viewer/.env.local` and fill in the
GitHub App credentials. Then:

```bash
cd viewer && npm run dev:local
```

Use `dev:local`, **not** `start:local`: the latter sets `NODE_ENV=production`, which makes
the server hand requests to a prebuilt `.next` that may be stale and missing whole routes,
with no warning.

### Verify before pushing

```bash
npm run typecheck   # TypeScript strict mode check
npm run lint        # ESLint + Next.js rules
npm run test        # Vitest unit tests (web app only, see below for editor-cli)
```

For the editor-cli (sibling package; excluded from the parent's test crawl since it has its own vitest config):
```bash
cd editor-cli
npm run typecheck   # TypeScript strict mode (CLI source)
npm run test        # Vitest unit + parity + Tailwind-coverage tests (fast)
npm run test:smoke  # Playwright browser smoke (~6s, requires Chrome at /Applications/Google Chrome.app)
```

### Run the editor CLI locally

The editor CLI (`desde`) boots a Vite supervisor against a prototype repo and serves the editor UI on `http://localhost:4321`.

```bash
cd editor-cli
npm run dev -- <repo-path>
```

Useful flags (all optional):
- `--shell-port <n>`: editor UI HTTP port (default `4321`)
- `--vite-port <n>`: user's Vite dev server port (default `5173`)
- `--no-open`: don't auto-open the browser
- `--bridge-bundle <path>` / `--ui-bundle-root <path>`: override the served bundle paths

Other entry points:
- `npm start -- <repo-path>`: runs the CLI via the built `desde` bin
- `npm run dev -- --help`: full usage. There is no platform sign-in; the Editor holds no
  credentials of its own. See `editor-cli/README.md`.

### Rebuilding editor bundles after source changes

The editor CLI serves two pre-built bundles that do **not** hot-reload when their source files change:

- **Editor UI bundle**: `editor-cli/ui-src/dist/`. Built from `src/hooks/`, `src/components/editor/`, and the rest of the React surface imported via the `@/` alias.
- **Bridge bundle**: `dist/bridge-bundle.js` at the repo root. Injected into the user's prototype HTML at Vite serve-time by the editor plugin. Rebuilt by `npm run build:bridge`. Note: `npm run build:editor` below does **not** rebuild it.

After editing any source under those import graphs, run:

```bash
npm run build:editor
```

This rebuilds both bundles (~3s total). The editor CLI's HTTP server reads files from disk per-request, so a CLI restart is not required. **But** hard-refresh the browser (Cmd+Shift+R), since the bundle uses content-hashed filenames and the cached `index.html` may still point at the old hash.

---

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE) for the full text.

In short: you can self-host this, modify it, and use it commercially. The one AGPL-specific
rule is the network clause: if you modify it and run that modified version for other people
to use over a network, you have to make the modified source available to them. Running it
unmodified doesn't trigger this. This isn't legal advice; read the license for what it
actually requires.

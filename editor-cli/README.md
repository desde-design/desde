# editor-cli

The Editor's local server. It starts your prototype's own dev server (Vite, Next.js,
Nuxt or React Router), injects the bridge and the source-stamping plugins, serves the
Editor's React interface on localhost, and writes edits into your source files.

The macOS desktop app runs this same server inside it, so most people never touch this
package directly: see the [Editor quickstart](https://desde.design/docs/quickstart/editor).
This package is how you run the Editor from a checkout, on any machine.

## Run it

You need Node 22.12 or newer. Run these from the **repo root**, not from this directory.
The Editor's interface imports shared code from the root `src/`, so the root install
has to come first.

```bash
npm install
npm --prefix editor-cli install
npm --prefix editor-cli run build:ui
node editor-cli/bin/desde.mjs <repo-path>
```

`build:ui` writes `ui-src/dist/`, which is not committed. The Editor refuses to start
without it. The bridge bundle it injects, `dist/bridge-bundle.js` at the repo root, is
committed, so there is nothing to build for it.

The Editor opens at the URL it prints, normally `http://127.0.0.1:4321`. Use that exact
URL: the API refuses actions from a page opened at `localhost`.

More detail:

- [Run the Editor from a checkout](https://desde.design/docs/reference/run-from-a-checkout):
  the full walkthrough, and what the boot does.
- [CLI reference](https://desde.design/docs/reference/cli): every flag, invocation form
  and exit code. `node editor-cli/bin/desde.mjs --help` prints the same usage.
- [Editor configuration](https://desde.design/docs/reference/editor-config): the
  `.desde/config.json` and `desde.config.json` files, and the feature switches.

## How it runs

- **`bin/desde.mjs`** runs the TypeScript source through `tsx` when `src/` is present,
  as it is in a checkout. A packaged payload, like the one inside the desktop app, has
  no `src/` and runs the prebuilt `dist/cli.js` instead. Set `DESDE_EDITOR_USE_BUNDLE=1`
  to run the prebuilt bundle from a checkout.
- **`npm run build:ui`** builds the interface into `ui-src/dist/`. Rebuild it after
  changing anything under the root `src/hooks/`, `src/components/editor/`, or
  `ui-src/`, then reload the browser tab. No restart is needed.
- **`npm run build:server`** bundles the server into `dist/cli.js` and `dist/mcp.js`
  for packaging. A checkout does not need it.
- **[`src/server/edit-handler.ts`](src/server/edit-handler.ts)** is the single
  dispatcher for every edit. The edit logic itself lives in the pure applicators in the
  root `src/editor/edit-service/`.
- **There is no platform sign-in**, and the Editor holds no credentials of its own. AI
  features need a key from one supported model provider: set `ANTHROPIC_API_KEY` or
  `OPENAI_API_KEY` in the shell that starts the Editor, or add one from the settings
  menu in the app. A Claude-subscription path exists, but it is opt-in only
  (`EDITOR_USE_CLAUDE_SUBSCRIPTION=1`), for running Desde for yourself: Anthropic's
  Agent SDK terms do not allow a distributed product to offer claude.ai login.

## Tests

```bash
npm run typecheck   # TypeScript strict mode
npm test            # Vitest unit and integration tests
npm run test:smoke  # Playwright browser smoke; needs Chrome at /Applications/Google Chrome.app
```

## Environment variables

A few variables the server reads that the configuration docs do not cover:

- **`EDITOR_REVIEW_SURFACE`**: set to `bridge` (or `off`/`0`) to force the agent's
  self-review off the isolated Playwright review surface and back onto the live bridge.
  See [src/review-surface/index.ts](src/review-surface/index.ts).
- **`EDITOR_PROTOTYPE_ROOT`**: override for the prototype's root directory, used by
  manifest and token grounding and the design-tokens handler when it isn't otherwise
  configured. See [src/server/design-tokens-handler.ts](src/server/design-tokens-handler.ts)
  and `src/editor/edit-service/build-manifest-source.ts`.
- **`EDITOR_PROTOTYPE_TSCONFIG`**: override path to the prototype's `tsconfig.json`, for
  prototypes whose tsconfig isn't at the project root. See
  `src/editor/core/resolve-tsconfig.ts`.
- **`EDITOR_STORYBOOK_URLS`**: comma-separated Storybook URLs to pull component
  manifests from. See `src/editor/edit-service/parse-storybook-urls.ts`.
- **`EDITOR_STORYBOOK_HOST_ALLOWLIST`**: comma-separated hostnames to allow for
  `EDITOR_STORYBOOK_URLS` when the URL resolves to a loopback, private, or link-local
  address (refused by default as an SSRF guard). See
  `src/editor/edit-service/parse-storybook-urls.ts`.

The feature switches (`EDITOR_CANVAS`, `EDITOR_CODE_VIEW`, `EDITOR_NOTES`,
`EDITOR_VSCODE_LINK`) are documented in
[Editor configuration](https://desde.design/docs/reference/editor-config#feature-switches).

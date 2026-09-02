#!/usr/bin/env node
// `desde-mcp` — stdio MCP server bin for the local
// `claude` CLI. See `tasks/editor-mcp-proxy.md` and
// `../src/mcp-proxy/stdio-server.ts`.
//
// Same built-vs-dev split as `desde.mjs`, INCLUDING the same
// fix: preferring `../dist/mcp.js` merely because it happens to exist was a
// footgun — one `npm run build:server` in a checkout made every later run
// use a bundle that could be silently stale relative to edited `src/**`.
// The signal for "this is a packaged payload, not a checkout" is whether
// `../src/mcp-proxy/stdio-server.ts` exists BESIDE the bundle — a payload
// (per `scripts/build-server-package.mts`'s own copy list) never
// ships `src/` at all, a checkout always has it. See `desde.mjs`
// for the full reasoning; kept in sync here rather than re-derived.
//
// DESDE_EDITOR_USE_BUNDLE=1 is the same escape hatch as the other
// shim, for deliberately exercising the built bundle from a checkout.
//
// The respawn child inherits stdio so the MCP JSON-RPC framing on
// stdin/stdout reaches the real entry.

import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { dirname, resolve } from "node:path"

const binDir = dirname(fileURLToPath(import.meta.url))
const builtEntry = resolve(binDir, "..", "dist", "mcp.js")
const srcEntry = resolve(binDir, "..", "src", "mcp-proxy", "stdio-server.ts")

const forceBundle = process.env.DESDE_EDITOR_USE_BUNDLE === "1"
if (forceBundle && !existsSync(builtEntry)) {
  console.error(
    `DESDE_EDITOR_USE_BUNDLE=1 is set, but the built bundle is missing at ${builtEntry}. ` +
      "Run `npm run build:server` in editor-cli/ first, or unset DESDE_EDITOR_USE_BUNDLE to run from source.",
  )
  process.exit(1)
}
const useBundle = forceBundle || (existsSync(builtEntry) && !existsSync(srcEntry))

if (useBundle) {
  // Built bundle present (and, absent the escape hatch, no source beside
  // it — see above): import it directly in this same process. It is
  // already plain ESM JS (esbuild, `packages: "external"`), so there is no
  // CJS-interop trap to route around here — see the dev-path comment below
  // for what that trap is and why it forces a respawn there instead.
  await import(pathToFileURL(builtEntry).href)
} else {
  const RESPAWN_MARKER = "__DESDE_EDITOR_MCP_RESPAWNED__"

  if (process.env[RESPAWN_MARKER]) {
    await import("../src/mcp-proxy/stdio-server.ts")
  } else {
    const here = dirname(fileURLToPath(import.meta.url))
    const tsxLoader = resolve(here, "..", "node_modules", "tsx", "dist", "loader.mjs")
    const child = spawn(
      process.execPath,
      [
        "--import",
        `file://${tsxLoader}`,
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
      ],
      {
        // IMPORTANT: inherit stdio so the MCP transport sees raw
        // stdin/stdout. The parent's `claude` CLI is the peer.
        stdio: "inherit",
        env: {
          ...process.env,
          [RESPAWN_MARKER]: "1",
          // Same pin as bin/desde.mjs: tsx discovers the alias tsconfig from
          // the process CWD, and an MCP server is launched from wherever the
          // `claude` CLI happens to run. Without this, any launch cwd outside
          // the checkout crashes on the first `@/` import.
          TSX_TSCONFIG_PATH:
            process.env.TSX_TSCONFIG_PATH ?? resolve(here, "..", "..", "tsconfig.json"),
        },
      },
    )
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal)
      else process.exit(code ?? 0)
    })
  }
}

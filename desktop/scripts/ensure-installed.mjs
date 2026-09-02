#!/usr/bin/env node
// Preflight for every desktop/ script that eventually shells out to
// desktop/node_modules/.bin/electron directly (the root "desktop" script,
// and desktop/package.json's own "dev"/"start"). desktop/ is a SEPARATE
// package — like editor-cli/ and viewer/, root's `npm install` does not
// cascade into it (no npm workspaces are configured) — so a truly fresh
// checkout's root install alone leaves desktop/node_modules missing
// entirely. Without this check, that surfaces as an opaque ENOENT on the
// electron binary; this turns it into the one-line fix.
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const desktopRoot = resolve(scriptDir, "..")

if (!existsSync(resolve(desktopRoot, "node_modules"))) {
  console.error(
    "desktop/ is a separate package (like editor-cli/) — root's `npm install` does not install its " +
      "dependencies. Run this first:\n\n  cd desktop && npm install\n",
  )
  process.exit(1)
}

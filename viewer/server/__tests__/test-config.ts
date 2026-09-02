import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A fresh, private data directory for a test-side `loadConfig(...)` call.
 *
 * `loadConfig` is effectful now: it reads, and on first call CREATES,
 * `$VIEWER_DATA_DIR/config.json` (via `runtime-config.ts`, so it can
 * generate a stable `sessionSecret`). A test that calls `loadConfig({})`
 * with no `VIEWER_DATA_DIR` would therefore write
 * `viewer/.desde-viewer/config.json` on disk — gitignored, but shared
 * mutable state across the entire test suite, since every such call reads
 * and writes the SAME file. Every test-side `loadConfig` call should pass
 * `VIEWER_DATA_DIR: tmpViewerDataDir()` (or another directory it fully
 * controls) instead.
 *
 * One temp directory per call — call it fresh for each `loadConfig`, not
 * once per file, unless a test specifically wants two `loadConfig` calls to
 * share (and therefore agree on) the same generated `sessionSecret`.
 */
export function tmpViewerDataDir(): string {
  return mkdtempSync(join(tmpdir(), "viewer-test-config-"))
}

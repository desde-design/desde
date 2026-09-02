import { resolve } from "node:path"
import { realpathSync } from "node:fs"
import type { ViteDevServer } from "vite"

/**
 * Deterministically replay an editor file-write into Vite's dev pipeline,
 * instead of waiting on the OS file watcher (fsevents/chokidar) to notice it.
 *
 * Editor writes edited/scaffolded files straight into the edit root (the
 * user's working tree — branch mode is the only edit substrate, see
 * `applyEdit`) and relies on Vite to HMR them into the iframe. That relies
 * entirely on Vite's watcher firing — there is no explicit invalidation
 * anywhere. Under load (rapid edits, macOS fsevents coalescing) the watcher
 * event for a written file can be dropped or delayed past the point a caller
 * polls, so the dev server keeps serving the STALE module. This surfaced as
 * an intermittent "vite serves the new route" failure after a chat scaffold:
 * the router file on disk had the new route, but Vite kept serving its
 * cached transform.
 *
 * Vite registers `watcher.on('change', ...)` to invalidate the module graph and
 * push the HMR update. Emitting that event ourselves runs the exact same path
 * for the file we just wrote — making the dev server reflect the write
 * immediately and deterministically, independent of the OS watcher (which stays
 * as a redundant backstop; a double event is idempotent).
 *
 * `files` are relative to the edit root (`repoRoot`) — the dir `applyEdit`
 * writes into — which is NOT necessarily Vite's `root` (a user `vite.config`
 * may set `root: 'app'`, a subdir). So resolve against `repoRoot`, not
 * `server.config.root`. We also emit the realpath'd path: `applyEdit` writes
 * through `fs.realpath`, and Vite may key its module graph by the resolved real
 * path, so a symlinked source would otherwise keep its stale transform. Both
 * emits are idempotent — at most one matches a loaded module.
 *
 * **It lives under `hosts/`, not `server/`.** It sat in `server/` from the days
 * when the HTTP layer held a `viteServer` and called this itself. It no longer
 * does: every caller is now a Vite-family host wiring up its own
 * `HostBoot.hmr.invalidate`, and `server/` — the framework-neutral half that has
 * to work on a host with no Vite anywhere — must name no Vite type at all
 * (§ 4, S12). The move is what makes that invariant checkable rather than
 * special-cased.
 */
export function invalidateViteModules(
  server: ViteDevServer | undefined,
  repoRoot: string,
  files: ReadonlyArray<string> | undefined,
): void {
  if (!server || !files || files.length === 0) return
  for (const file of files) {
    const abs = resolve(repoRoot, file)
    emitChange(server, abs)
    let real: string | null = null
    try {
      real = realpathSync(abs)
    } catch {
      // File may be gone (deleted edit) — nothing to realpath; `abs` stands.
    }
    if (real && real !== abs) emitChange(server, real)
  }
}

function emitChange(server: ViteDevServer, path: string): void {
  try {
    // Vite registers `watcher.on('change', ...)` to invalidate + push HMR.
    server.watcher.emit("change", path)
  } catch {
    // Best-effort: a bad path or a watcher mid-teardown must never fail the
    // edit response. The OS watcher remains the backstop.
  }
}

/**
 * Where the bundled demo lands, and the one flag that outlives it.
 *
 * The repo goes to `~/Documents/Desde Demo/`. It is a project the user is
 * expected to open, edit and find again, so it sits where every other tool
 * puts its sample projects: somewhere visible. Until 2026-09-07 it was the
 * hidden `~/.desde-demo/`, which nobody could find without reading source.
 *
 * Wherever it lands, its path MUST NOT contain a `.desde` segment.
 * `vite-supervisor.ts` denies `[".desde", "**\/.desde/**"]` from HTTP serving
 * (audit S15). That control is what stops a default-config boot serving
 * `GET /.desde/chat-sessions/<id>.json` with a 200, i.e. the agent chat
 * transcripts, the per-edit source backup journal, and the design-system
 * registry. A demo placed at `~/.desde/demo/` matched that glob on its own
 * PATH, so every file in it was denied and the prototype could not be served
 * at all. MEASURED: the Editor booted, then answered every request with
 * `The request id "…/.desde/demo/index.html" is outside of Vite serving allow
 * list`, and the bridge smoke reported the script tag missing. Unit tests all
 * passed; only a live boot found it. Exempting the demo from that deny would
 * trade a real security control for a convenience, so the path moved instead.
 * The demo's OWN `.desde/` stays correctly denied.
 *
 * Still app-managed, still disposable: it ships with no git `origin` so it
 * cannot be pushed, and Mo's ruling (2026-08-31) is that nobody wants to keep
 * the changes of a random demo repo.
 * See `docs/superpowers/specs/2026-08-31-editor-bundled-demo-design.md`.
 *
 * The flag lives in the CLI's state directory (`state-dir.ts`).
 *
 * `home` is a parameter on every function, defaulting to `homedir()`, so a test
 * never touches the real home directory. Same shape as `projects-registry.ts`
 * and the credential stores.
 *
 * `triedAt` survives deletion on purpose. It never SUPPRESSES the demo, it only
 * demotes it out of the launcher's empty state, so someone who deleted it
 * deliberately is not nagged and someone who deleted it by accident is one click
 * from having it back.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { cliStateDir, ensureCliStateDir } from "../state-dir.js"

/**
 * The demo's `node_modules`, shipped as ONE gzipped tarball beside the demo
 * source instead of as ~4,900 loose files. Every file in the app bundle is
 * a file Squirrel.Mac has to unzip, verify and move on every update, and
 * the demo's dependency tree was a third of the bundle's file count for 6%
 * of its bytes (measured 2026-09-02). `build-server-package.mts` packs it
 * after the staged `npm install`; `materialize.ts` unpacks it into the
 * user's copy on first open. A dev checkout's fixture has a real
 * `node_modules/` and no archive, and is copied as-is.
 */
export const DEMO_NODE_MODULES_ARCHIVE = "node_modules.tgz"

export interface DemoState {
  /** ISO timestamp of the first time the demo was materialized. */
  triedAt?: string
}

export function demoRepoPath(home: string = homedir()): string {
  return join(home, "Documents", "Desde Demo")
}

/**
 * Written by `materializeDemo` once the copy and the seed commit are done,
 * and read by everything that would otherwise trust the PATH alone. The path
 * is a folder in the user's Documents with an ordinary name, so "something
 * exists there" no longer means "the demo exists there". Without this,
 * a folder the user made themselves would be listed as the demo, reported as
 * untouched, and recursively deleted by the demo's own Delete.
 */
export const DEMO_MARKER_FILE = join(".desde", "demo-marker.json")

export function demoMarkerPath(repoPath: string): string {
  return join(repoPath, DEMO_MARKER_FILE)
}

/** True only for a directory this code materialized. */
export async function isManagedDemo(repoPath: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(demoMarkerPath(repoPath), "utf8"))
    return parsed !== null && typeof parsed === "object" && (parsed as { desdeDemo?: unknown }).desdeDemo === true
  } catch {
    return false
  }
}

export async function writeDemoMarker(repoPath: string): Promise<void> {
  const file = demoMarkerPath(repoPath)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ desdeDemo: true, materializedAt: new Date().toISOString() }, null, 2)}\n`, "utf8")
}

export function demoStatePath(home: string = homedir()): string {
  return join(cliStateDir(home), "demo-state.json")
}

/**
 * Absent or corrupt reads as empty. A flag about a demo must never be able to
 * block boot, which is the same posture `projects-registry.ts` takes for the
 * recents cache and for the same reason.
 */
export async function readDemoState(home: string = homedir()): Promise<DemoState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(demoStatePath(home), "utf8"))
    if (parsed === null || typeof parsed !== "object") return {}
    const triedAt = (parsed as DemoState).triedAt
    return typeof triedAt === "string" ? { triedAt } : {}
  } catch {
    return {}
  }
}

/** Idempotent: the FIRST try is the one worth remembering. */
export async function markDemoTried(home: string = homedir()): Promise<void> {
  if ((await readDemoState(home)).triedAt !== undefined) return
  const file = demoStatePath(home)
  await ensureCliStateDir(home)
  await writeFile(file, `${JSON.stringify({ triedAt: new Date().toISOString() }, null, 2)}\n`, "utf8")
}

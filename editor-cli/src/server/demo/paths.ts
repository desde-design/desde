/**
 * Where the bundled demo lands, and the one flag that outlives it.
 *
 * `~/.desde-demo/`, a SIBLING of the CLI's state directory rather than a child
 * of it. That is not a style choice and it must not be "tidied" back.
 *
 * `vite-supervisor.ts` denies `[".desde", "**\/.desde/**"]` from HTTP serving
 * (audit S15). That control is what stops a default-config boot serving
 * `GET /.desde/chat-sessions/<id>.json` with a 200, i.e. the agent chat
 * transcripts, the per-edit source backup journal, and the design-system
 * registry. A demo placed at `~/.desde/demo/` matches that glob on its own
 * PATH, so every file in it is denied and the prototype cannot be served at
 * all. MEASURED: the Editor booted, then answered every request with
 * `The request id "…/.desde/demo/index.html" is outside of Vite serving allow
 * list`, and the bridge smoke reported the script tag missing. Unit tests all
 * passed; only a live boot found it.
 *
 * The alternative was exempting the demo from that deny, which trades a real
 * security control for a convenience. Not worth it. A sibling directory costs
 * nothing and keeps the demo's OWN `.desde/` correctly denied.
 *
 * Still hidden, still app-managed, still disposable: it ships with no git
 * `origin` so it cannot be pushed, and Mo's ruling (2026-08-31) is that nobody
 * wants to keep the changes of a random demo repo.
 * See `docs/superpowers/specs/2026-08-31-editor-bundled-demo-design.md`.
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

export interface DemoState {
  /** ISO timestamp of the first time the demo was materialized. */
  triedAt?: string
}

export function demoRepoPath(home: string = homedir()): string {
  return join(home, ".desde-demo")
}

export function demoStatePath(home: string = homedir()): string {
  return join(home, ".desde", "demo-state.json")
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
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ triedAt: new Date().toISOString() }, null, 2)}\n`, "utf8")
}

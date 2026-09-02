/**
 * The desktop shell's app-scoped settings store — `~/.desde/settings.json`.
 *
 * Copies the house pattern from `editor-cli/src/server/viewer-token-store.ts`
 * (and `projects-registry.ts`, same shape): atomic temp+rename write, 0600
 * file / 0700 dir, corrupt-or-missing reads degrade to typed defaults and
 * never throw. **Electron main is the sole writer** — the renderer only ever
 * reaches this through the `desktop:settings:*` IPC handlers in `main.ts`,
 * never directly (it has no filesystem access — `contextIsolation: true`, no
 * `nodeIntegration`).
 *
 * App-scoped, not repo-scoped: this file is readable with zero repos open
 * (unlike `desde.config.json` / `.desde/config.json`, which
 * live inside a project), because the update-checker and its toggle need
 * somewhere to live before any project is picked. `~/.desde/` already
 * holds the project registry and per-session info — this is a sibling file,
 * not a new directory.
 *
 * Phase 4 (`tasks/electron-app.md` §4) is the actual consumer — the updater
 * reads `updates.autoDownload` to decide silent-download vs.
 * available-badge-only. Built now because the preload API's
 * `getAutoDownload`/`setAutoDownload` need somewhere real to read and write.
 */

import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve as resolvePath } from "node:path"
import { randomUUID } from "node:crypto"

const SETTINGS_VERSION = 1
const FILE_MODE = 0o600
const DIR_MODE = 0o700

export interface DesktopSettings {
  version: 1
  updates: {
    autoDownload: boolean
  }
}

export function defaultDesktopSettings(): DesktopSettings {
  return { version: SETTINGS_VERSION, updates: { autoDownload: true } }
}

export function settingsFilePath(home: string = homedir()): string {
  return resolvePath(home, ".desde", "settings.json")
}

/**
 * Read the settings file, degrading to typed defaults on ANY failure — file
 * absent, unreadable (permissions), malformed JSON, or shaped wrong (a
 * future/older schema, a field of the wrong type). A settings read must never
 * be the reason the app fails to start; the cost of a corrupt file is
 * silently falling back to defaults, not a crash.
 */
export async function readDesktopSettings(home: string = homedir()): Promise<DesktopSettings> {
  let raw: string
  try {
    raw = await fs.readFile(settingsFilePath(home), "utf8")
  } catch {
    return defaultDesktopSettings()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return defaultDesktopSettings()
  }

  if (typeof parsed !== "object" || parsed === null) return defaultDesktopSettings()
  const obj = parsed as Record<string, unknown>
  const updates = obj.updates as Record<string, unknown> | undefined
  return {
    version: SETTINGS_VERSION,
    updates: {
      autoDownload: typeof updates?.autoDownload === "boolean" ? updates.autoDownload : true,
    },
  }
}

/**
 * Write the settings file atomically: a temp file in the same directory,
 * written with the file's final permissions, then renamed over the real
 * path. The temp name embeds this process's pid and a random suffix (not
 * just the pid) so two concurrent writers in the SAME process — unlikely
 * here (main is the sole writer) but cheap to make impossible rather than
 * merely unlikely — can never collide on the same temp file.
 */
export async function writeDesktopSettings(
  settings: DesktopSettings,
  home: string = homedir(),
): Promise<void> {
  const path = settingsFilePath(home)
  const dir = dirname(path)
  await fs.mkdir(dir, { recursive: true, mode: DIR_MODE })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: FILE_MODE })
    await fs.rename(tmp, path)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
  // `rename` preserves the temp file's mode, but a destination written by an
  // older version of this file (or created some other way) may predate
  // FILE_MODE — set it explicitly rather than trusting the temp file's mode
  // alone to have carried through.
  await fs.chmod(path, FILE_MODE).catch(() => {})
}

export async function getAutoDownload(home: string = homedir()): Promise<boolean> {
  return (await readDesktopSettings(home)).updates.autoDownload
}

export async function setAutoDownload(value: boolean, home: string = homedir()): Promise<void> {
  const current = await readDesktopSettings(home)
  await writeDesktopSettings({ ...current, updates: { ...current.updates, autoDownload: value } }, home)
}

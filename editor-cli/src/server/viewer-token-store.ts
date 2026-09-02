import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Per-machine storage for **viewer** personal access tokens (`dsv_…`).
 *
 * Once one of two credential stores: `token-store-fs.ts` held the JWT for a
 * hosted platform. That platform and its store were removed with the Firebase
 * auth surface (2026-08-08) — the token it obtained was never read by anything
 * — so this is now the only credential store, and the separation it was named
 * for no longer exists. The file is kept separate anyway: a viewer token is
 * scoped to a viewer origin, which is not a shape a general token store would
 * want to grow into.
 *
 * **Keyed by viewer ORIGIN, not a single value.** A person can plausibly
 * review against more than one viewer — a team instance and a local one, or
 * two teams — and each issues its own token. Storing one token flat would
 * make switching viewers silently send the wrong credential, which the viewer
 * answers with a 401 that looks like "your token expired" rather than "that
 * token is for a different server."
 *
 * **Why a file, not the OS keychain**, and **why `chmod 600` is accepted**:
 * same reasoning as `token-store-fs.ts` — a Node CLI can't reach the OS
 * keychain without native modules, and a machine that can read this file can
 * already read the user's git credentials.
 *
 * A viewer PAT has no embedded expiry we can read (it is an opaque
 * `dsv_<id>_<secret>`), so nothing here tries to pre-empt expiry. The viewer
 * is the authority: a revoked or expired token comes back as a 401, which is
 * exactly the signal the caller should act on.
 */

const CONFIG_DIR_RELATIVE = join(".config", "desde")
const TOKEN_FILE_NAME = "viewer-tokens.json"
const FILE_MODE = 0o600
const DIR_MODE = 0o700
const SCHEMA_VERSION = 1

interface ViewerTokenFile {
  version: number
  /** Keyed by normalized origin — see `normalizeOrigin`. */
  tokens: Record<string, string>
  /**
   * The one viewer this machine reviews against by default, as a normalized
   * origin. Absent until the user sets it.
   *
   * Added 2026-08-26 for auto-linking: a repo that has never been through the
   * connect dialog can still be resolved against this viewer at boot, so the
   * common case ("I have a viewer, and these are my prototypes") needs no
   * per-repo setup at all.
   *
   * It is a DEFAULT, not a replacement for the map above. Keeping both costs
   * nothing — this is one string beside a dictionary that already exists —
   * and a person with a team viewer and a local one keeps working. Collapsing
   * to a single viewer would be work that buys nothing.
   *
   * Optional on purpose, and the schema version is NOT bumped: an older file
   * simply has no default, and an older CLI reading a newer file ignores a
   * key it does not know. Neither direction needs a migration.
   */
  defaultOrigin?: string
}

export function viewerTokenFilePath(home = homedir()): string {
  return join(home, CONFIG_DIR_RELATIVE, TOKEN_FILE_NAME)
}

/**
 * Reduces a base URL to a bare origin so the same viewer is one key however
 * it was typed: `https://v.example.com/`, `https://v.example.com/review/x`
 * and `https://V.Example.com` are the same server. Without this, a trailing
 * slash silently creates a second entry and the user is asked to log in
 * again for a viewer they already have a token for.
 */
export function normalizeOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin.toLowerCase()
  } catch {
    // Not a parseable URL — fall back to a trimmed lowercase string rather
    // than throwing, so a malformed config can't crash the Editor at boot.
    return baseUrl.trim().replace(/\/+$/, "").toLowerCase()
  }
}

async function readFile(path: string): Promise<ViewerTokenFile> {
  try {
    const raw = await fs.readFile(path, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as ViewerTokenFile).version !== SCHEMA_VERSION ||
      typeof (parsed as ViewerTokenFile).tokens !== "object"
    ) {
      // A file from a future/older schema is ignored rather than thrown on:
      // the cost is re-authenticating, versus the Editor refusing to start.
      return { version: SCHEMA_VERSION, tokens: {} }
    }
    return parsed as ViewerTokenFile
  } catch {
    return { version: SCHEMA_VERSION, tokens: {} }
  }
}

export async function readViewerToken(baseUrl: string, home = homedir()): Promise<string | null> {
  const file = await readFile(viewerTokenFilePath(home))
  return file.tokens[normalizeOrigin(baseUrl)] ?? null
}

/**
 * Read, mutate, write atomically. One implementation, because every writer
 * here needs the same temp-file-and-rename dance: a crash mid-write must not
 * leave a truncated file that reads as "no tokens at all" and silently signs
 * the user out of every viewer.
 */
async function mutateFile(
  home: string,
  mutate: (file: ViewerTokenFile) => void,
): Promise<void> {
  const path = viewerTokenFilePath(home)
  await fs.mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  const file = await readFile(path)
  mutate(file)
  const tmp = `${path}.${process.pid}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: FILE_MODE })
  await fs.rename(tmp, path)
  // `rename` preserves the temp file's mode, but an existing destination
  // created by an older version may predate FILE_MODE — set it explicitly.
  await fs.chmod(path, FILE_MODE).catch(() => {})
}

export async function writeViewerToken(baseUrl: string, token: string, home = homedir()): Promise<void> {
  await mutateFile(home, (file) => {
    file.tokens[normalizeOrigin(baseUrl)] = token
  })
}

/**
 * The machine's default viewer origin, or null.
 *
 * Returns the origin only — the token for it is a separate lookup, because
 * the two can legitimately disagree: a default can outlive a token that was
 * revoked on the viewer, and the caller needs to tell "no viewer set" from
 * "viewer set, credential gone" to say anything useful about it.
 */
export async function readDefaultViewerOrigin(home = homedir()): Promise<string | null> {
  const file = await readFile(viewerTokenFilePath(home))
  return typeof file.defaultOrigin === "string" && file.defaultOrigin.length > 0
    ? file.defaultOrigin
    : null
}

/** Set the machine's default viewer. Stores the NORMALIZED origin. */
export async function writeDefaultViewerOrigin(baseUrl: string, home = homedir()): Promise<void> {
  await mutateFile(home, (file) => {
    file.defaultOrigin = normalizeOrigin(baseUrl)
  })
}

/** Forget the machine's default viewer. Leaves its token alone. */
export async function clearDefaultViewerOrigin(home = homedir()): Promise<void> {
  // Same reasoning as `clearViewerToken`: do not create the file to record
  // the absence of something that was already absent.
  const existing = await readFile(viewerTokenFilePath(home))
  if (existing.defaultOrigin === undefined) return
  await mutateFile(home, (file) => {
    delete file.defaultOrigin
  })
}

export async function clearViewerToken(baseUrl: string, home = homedir()): Promise<void> {
  // Read first: clearing a token that was never stored must not CREATE a
  // credentials file as a side effect. `mutateFile` would.
  const key = normalizeOrigin(baseUrl)
  const existing = await readFile(viewerTokenFilePath(home))
  if (!(key in existing.tokens)) return
  await mutateFile(home, (file) => {
    delete file.tokens[key]
  })
}

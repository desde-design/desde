/**
 * Machine-generated configuration that has to SURVIVE a restart but that no
 * operator should have to type.
 *
 * It exists because two things need to be persisted that the environment
 * cannot carry. The session secret must be stable across boots or every
 * restart silently signs everyone out, and a viewer that has never been
 * configured still needs one so that sessions can exist at all. The GitHub
 * App Manifest flow (Task 10) receives an App id, private key and client
 * secret from GitHub at RUNTIME, long after the process read `process.env`.
 *
 * **The environment always wins.** This file is a FALLBACK source, never an
 * override, and `loadConfig` never writes an env-supplied value back here.
 * The rule matters because the two disagreeing silently is exactly the
 * "looks configured, behaves oddly" failure the README already warns about
 * for stale OAuth App credentials.
 *
 * Synchronous on purpose: `loadConfig()` is called from Next Server
 * Components (`app/page.tsx`) which cannot await a config read, and this
 * runs once per call against a file measured in hundreds of bytes.
 */

import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const FILE_NAME = "config.json"

/** 32 bytes of CSPRNG as hex. Same shape the README tells operators to generate with `openssl rand -hex 32`. */
const SECRET_PATTERN = /^[0-9a-f]{64}$/

export interface RuntimeConfigFile {
  /** HMAC key for the session cookie. Generated on first boot; stable thereafter. */
  sessionSecret: string
  /**
   * Written ONLY by the GitHub App Manifest callback (`setup-routes.ts`).
   * Absent until an operator runs that flow, and ignored entirely when the
   * equivalent env vars are set.
   */
  githubApp?: {
    appId: string
    slug: string
    privateKeyPem: string
    clientId: string
    clientSecret: string
    webhookSecret?: string
  }
  /**
   * SMTP for mention and sign-in mail, set from the instance settings page.
   *
   * Written ONLY by `PUT /api/v1/instance/email` (`instance-routes.ts`).
   * Absent until an admin fills that form, and ignored entirely when
   * `VIEWER_SMTP_HOST` is set — the same env-wins rule as `githubApp`, for
   * the same reason: two sources disagreeing silently is the "looks
   * configured, behaves oddly" failure this file exists to avoid.
   *
   * `pass` is a live credential at rest here, which is why the file is the
   * right home and the API is not: it is written by the server, into the data
   * directory, and NEVER returned to a client. The settings page is told
   * whether a password exists, never what it is.
   */
  email?: {
    host: string
    port: number
    user: string
    pass: string
    from: string
  }
  /** ISO timestamp of the demo seed. Presence means "do not seed again", even if the demo was since deleted. */
  demoSeededAt?: string
  /**
   * The parent pid this data directory last opened a browser for.
   *
   * Not a boolean, and not a timestamp, because the question is not "have we
   * ever" but "have we already, in THIS run". `npm run dev` is `tsx watch`,
   * which respawns the server on every file save under one supervisor whose
   * pid is stable, so comparing against it distinguishes a restart (no tab)
   * from a fresh run (a tab). See `open-browser.ts`.
   */
  browserOpenedForPpid?: number
}

function filePath(dataDir: string): string {
  return join(dataDir, FILE_NAME)
}

function write(dataDir: string, value: RuntimeConfigFile): RuntimeConfigFile {
  mkdirSync(dataDir, { recursive: true })
  // Write-then-rename, never in place. Once Task 10 lands, this file holds
  // the GitHub App's private key and client secret, and a torn in-place
  // write would parse as corrupt — which the recovery in `loadRuntimeConfig`
  // answers by REGENERATING, silently discarding those credentials and
  // forcing the operator to recreate the App on GitHub. A same-filesystem
  // rename is atomic: readers see the old file or the new one, never a
  // prefix. `mode` applies when the temp file is created, so the final file
  // carries 0600 through the rename.
  const target = filePath(dataDir)
  writeFileSync(`${target}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(`${target}.tmp`, target)
  return value
}

/**
 * Reads the file, creating it with a fresh session secret when absent.
 *
 * A corrupt or truncated file REGENERATES rather than throwing. The trade
 * is deliberate: the only cost is that existing sessions stop verifying
 * (everyone signs in again), whereas throwing would make an unparseable
 * byte on disk permanently un-bootable — a worse outcome for a file no
 * human is expected to edit.
 */
export function loadRuntimeConfig(dataDir: string): RuntimeConfigFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath(dataDir), "utf8"))
  } catch {
    parsed = null
  }

  const existing = parsed !== null && typeof parsed === "object" ? (parsed as Partial<RuntimeConfigFile>) : {}
  if (typeof existing.sessionSecret === "string" && SECRET_PATTERN.test(existing.sessionSecret)) {
    return existing as RuntimeConfigFile
  }

  return write(dataDir, { ...existing, sessionSecret: randomBytes(32).toString("hex") })
}

/** Read-merge-write. Shallow merge: a patch key replaces its whole value. */
export function updateRuntimeConfig(
  dataDir: string,
  patch: Partial<RuntimeConfigFile>,
): RuntimeConfigFile {
  return write(dataDir, { ...loadRuntimeConfig(dataDir), ...patch })
}

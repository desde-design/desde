import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { dirname, join } from "node:path"
import type {
  StoredCredentials,
  StoredProviderCredentials,
} from "../../../src/editor/llm-providers/credential-probe.js"

/**
 * Per-machine storage for provider API keys and the hidden dev-mode flag.
 *
 * **Why a file and not the OS keychain**, and **why `chmod 600` is accepted**:
 * the same reasoning `viewer-token-store.ts` already gives. A Node CLI cannot
 * reach the OS keychain without native modules, and a machine that can read
 * this file can already read the user's git credentials. Electron's
 * `safeStorage` was rejected for a second reason on top of that: it would
 * secure the desktop case only, and terminal users run the same CLI serving
 * the same UI, so they could not read what it wrote. One secret with two
 * incompatible stores is a bug factory.
 *
 * **Why `~/.config/desde/` and not `~/.desde/`:** both exist today,
 * and the split is by kind. `~/.desde/` holds the project registry,
 * per-session info and the desktop settings file. `~/.config/desde/`
 * holds secrets (`viewer-tokens.json`). This is a secret.
 *
 * Every read degrades to typed defaults — absent, unreadable, malformed, or
 * shaped wrong. A credential read must never be the reason the CLI fails to
 * start; the cost of a corrupt file is re-entering a key, not a crash.
 *
 * Every reader and writer takes an explicit `home`, `llmCredentialFilePath`
 * included: a defaulted home let a test with the wrong argument order write
 * into a real user's file on 2026-09-04, and that default was the last one
 * left in this module.
 */

const CONFIG_DIR_RELATIVE = join(".config", "desde")
const CREDENTIAL_FILE_NAME = "llm-credentials.json"
const FILE_MODE = 0o600
const DIR_MODE = 0o700
const SCHEMA_VERSION = 2

interface LlmCredentialFile {
  version: number
  /** Open string keys, so a new vendor is a descriptor and not a schema bump. */
  providers: Record<string, StoredProviderCredentials>
  devMode: boolean
  /**
   * Whether the user dismissed the first-run prompt.
   *
   * Machine-level rather than `localStorage` because the editor's origin is
   * not stable: the launcher and the desktop app pick a free port per project,
   * and `localStorage` is scoped by origin INCLUDING the port. A dismissal
   * stored in the browser would be forgotten every time a project reopened on
   * a different port.
   */
  promptDismissed: boolean
}

/** The v1 shape, kept so the migration below can read it by name. */
interface LlmCredentialFileV1 {
  version: 1
  apiKey?: string
  devMode: boolean
  promptDismissed?: boolean
}

export function llmCredentialFilePath(home: string): string {
  return join(home, CONFIG_DIR_RELATIVE, CREDENTIAL_FILE_NAME)
}

/**
 * Thrown when a writer finds an on-disk `version` GREATER than this build's
 * {@link SCHEMA_VERSION}.
 *
 * The 2026-09-04 incident is the reason. A still-running Editor from before
 * the multi-provider work (`SCHEMA_VERSION = 1`) read the v2 file, could not
 * understand it, degraded to empty defaults, and its next write serialised
 * that emptiness over both of the user's API keys. That binary cannot be
 * fixed. This is the same failure in the direction this code owns: rather
 * than flattening a file a newer Desde wrote, refuse and say so. The message
 * names no key value — it can reach a terminal.
 */
export class CredentialFileNewerError extends Error {
  constructor(public readonly onDiskVersion: number) {
    super(
      "This machine's Desde credential file was written by a newer version of Desde. Update Desde, or move that file aside, before saving credentials from this one.",
    )
    this.name = "CredentialFileNewerError"
  }
}

function defaults(): LlmCredentialFile {
  return { version: SCHEMA_VERSION, providers: {}, devMode: false, promptDismissed: false }
}

/**
 * v1 held ONE unlabelled key, and it was always Anthropic's. Lift it into that
 * slot rather than discarding the file.
 *
 * The result is NOT written back here. A read must stay a read; the migrated
 * shape lands on the next ordinary write, which every setter performs from a
 * fresh read anyway.
 */
function migrateV1(file: LlmCredentialFileV1): LlmCredentialFile {
  // Each field migrates on its own. A v1 file with a valid key and a missing
  // or malformed `devMode`/`promptDismissed` must still keep the key: the old
  // code discarded the WHOLE file (via `return defaults()`) the moment any
  // one field looked wrong, which silently deleted a real user's key on the
  // very next read after upgrade.
  const apiKey =
    typeof file.apiKey === "string" && file.apiKey.trim().length > 0 ? file.apiKey : undefined
  return {
    version: SCHEMA_VERSION,
    providers: apiKey === undefined ? {} : { anthropic: { apiKey } },
    devMode: file.devMode === true,
    promptDismissed: file.promptDismissed === true,
  }
}

/**
 * Provider ids already warned about for a malformed slot, this process.
 *
 * `readFile` runs on every credential read, and a malformed slot stays
 * malformed until the user re-enters that provider's key — so without this,
 * one bad slot would print the same warning to a real user's terminal on
 * every single read for the rest of the process's life. De-duplicated by
 * provider id, not by read, since the point is "tell them once, not never
 * again" rather than "tell them once per corrupt value".
 */
const warnedMalformedProviders = new Set<string>()

function warnMalformedProviderOnce(id: string): void {
  if (warnedMalformedProviders.has(id)) return
  warnedMalformedProviders.add(id)
  // Never log the value itself, only the provider id: this warning can
  // reach a real user's terminal, and the value may be (a fragment of) a
  // secret.
  console.warn(`[llm-credentials] ignoring a malformed entry for provider '${id}'`)
}

/**
 * Test-only reset for {@link warnedMalformedProviders}. The set is
 * module-level and persists for the life of the process (by design — see
 * the de-duplication comment above), so a test file that exercises the
 * "warn once" behavior must reset it in `beforeEach`, or an earlier test's
 * warning silently suppresses a later test's assertion.
 */
export function resetMalformedProviderWarningsForTests(): void {
  warnedMalformedProviders.clear()
  warnedNewerFile = false
}

/**
 * Every slot must be an object of optional strings. A malformed slot is
 * dropped on its own, not treated as a reason to discard the whole file: one
 * corrupt provider must not destroy every other provider's valid key. Only
 * the top-level shape (not an object, or an array) still fails the whole
 * read, since there is no per-slot structure to salvage from that.
 */
function sanitizeProviders(raw: unknown): Record<string, StoredProviderCredentials> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const out: Record<string, StoredProviderCredentials> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      warnMalformedProviderOnce(id)
      continue
    }
    const slot = value as Record<string, unknown>
    const malformed =
      (slot.apiKey !== undefined && typeof slot.apiKey !== "string") ||
      (slot.baseUrl !== undefined && typeof slot.baseUrl !== "string")
    if (malformed) {
      warnMalformedProviderOnce(id)
      continue
    }
    // A slot that reads clean ends the warning episode for that provider.
    // Without this, a slot that was corrupt, got fixed, and was then
    // corrupted a second time would never warn again for the life of the
    // process — "tell them once" was meant per corruption, not per process.
    warnedMalformedProviders.delete(id)
    out[id] = {
      ...(typeof slot.apiKey === "string" ? { apiKey: slot.apiKey } : {}),
      ...(typeof slot.baseUrl === "string" ? { baseUrl: slot.baseUrl } : {}),
    }
  }
  return out
}

/** Top-level fields THIS version authors. Anything else is carried through. */
const KNOWN_TOP_LEVEL_FIELDS = new Set([
  "version",
  "providers",
  "devMode",
  "promptDismissed",
  // v1's single unlabelled key. Known, because `migrateV1` consumes it.
  "apiKey",
])

/** Warned once per process that the file on disk is newer than this build. */
let warnedNewerFile = false

interface CredentialFileSnapshot {
  file: LlmCredentialFile
  /** The on-disk `version` was GREATER than {@link SCHEMA_VERSION}. */
  newerThanUs: boolean
  /**
   * The RAW `version` read off disk, before `file.version` is normalised to
   * {@link SCHEMA_VERSION}. Only meaningful when `newerThanUs` is true — it
   * is what {@link CredentialFileNewerError} reports, so the refusal names
   * the version that was actually on disk (a hypothetical v99 file) rather
   * than the version this build understands (2).
   */
  onDiskVersion: number
  /**
   * Top-level fields this version did not author, kept so a write from this
   * build does not silently drop what another build stored beside it.
   */
  unknownFields: Record<string, unknown>
}

function snapshot(
  file: LlmCredentialFile,
  unknownFields: Record<string, unknown> = {},
): CredentialFileSnapshot {
  return { file, newerThanUs: false, onDiskVersion: file.version, unknownFields }
}

/**
 * Read the file AND everything a writer needs to know about it: whether it
 * came from a newer Desde, and which top-level fields this version does not
 * author.
 */
async function readSnapshot(path: string): Promise<CredentialFileSnapshot> {
  try {
    const raw = await fs.readFile(path, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null) return snapshot(defaults())
    const file = parsed as Partial<LlmCredentialFile> & Partial<LlmCredentialFileV1>
    const unknownFields = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([key]) => !KNOWN_TOP_LEVEL_FIELDS.has(key),
      ),
    )
    // The migration branch sits BEFORE the mismatch discard. Reversed, the
    // discard would delete every existing user's key on first read.
    if (file.version === 1) {
      return {
        file: migrateV1(file as LlmCredentialFileV1),
        newerThanUs: false,
        onDiskVersion: 1,
        unknownFields,
      }
    }
    const newerThanUs = typeof file.version === "number" && file.version > SCHEMA_VERSION
    // An OLDER unrecognised schema is still ignored: there is no shape to
    // salvage `providers` from, and the cost is re-entering a key rather
    // than the CLI refusing to start. A top-level field neither build
    // claims still survives (`unknownFields`, passed through here) — only
    // `providers` itself has nothing to salvage. A NEWER one is different —
    // its `providers` shape is this one plus whatever was added — so read
    // what we understand and mark it, rather than degrading to empty
    // defaults and letting a later write serialise that emptiness over the
    // user's keys.
    if (!newerThanUs && file.version !== SCHEMA_VERSION) return snapshot(defaults(), unknownFields)
    if (newerThanUs && !warnedNewerFile) {
      warnedNewerFile = true
      console.warn(
        "[llm-credentials] this file was written by a newer version of Desde; reading what this version understands and refusing to overwrite it",
      )
    }
    const providers = sanitizeProviders(file.providers) ?? {}
    return {
      file: {
        version: SCHEMA_VERSION,
        providers,
        // Tolerated rather than rejected, same as `promptDismissed` below: a
        // malformed or missing `devMode` used to discard the WHOLE file (via
        // `return defaults()`), which silently deleted a real user's key —
        // the same data-loss class CX1 removed from the v1 migration path.
        devMode: file.devMode === true,
        // Tolerated rather than rejected: a file written before this field
        // existed is otherwise valid, and discarding it would drop the key.
        promptDismissed: typeof file.promptDismissed === "boolean" ? file.promptDismissed : false,
      },
      newerThanUs,
      onDiskVersion: typeof file.version === "number" ? file.version : SCHEMA_VERSION,
      unknownFields,
    }
  } catch {
    return snapshot(defaults())
  }
}

async function readFile(path: string): Promise<LlmCredentialFile> {
  return (await readSnapshot(path)).file
}

/**
 * Write via temp file + rename. A crash mid-write must not leave a truncated
 * file that reads as "no credentials at all" and silently signs the user out.
 *
 * The temp name carries a UUID, not just the pid: two writes racing inside one
 * process shared a filename and could truncate each other's staging file.
 */
async function writeFile(
  path: string,
  file: LlmCredentialFile,
  unknownFields: Record<string, unknown> = {},
): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  // Unknown fields first, so this version's own fields always win. They are
  // carried rather than dropped: a field this build does not author still
  // belongs to whoever wrote it.
  const body = { ...unknownFields, ...file }
  await fs.writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: FILE_MODE })
  await fs.rename(tmp, path)
  // `rename` preserves the temp file's mode, but an existing destination from
  // an older version may predate FILE_MODE — set it explicitly. Same for the
  // directory: `mkdir`'s `mode` is subject to the process umask, so a 0022
  // umask silently yields 0755.
  await fs.chmod(path, FILE_MODE).catch(() => {})
  await fs.chmod(dirname(path), DIR_MODE).catch(() => {})
}

/**
 * Serializes every read-modify-write in this process.
 *
 * Each setter changes ONE field but rewrites the whole file, so two
 * overlapping updates could each read the same snapshot and the second
 * rewrite would erase the first's change — saving a key while toggling dev
 * mode could lose the key. Chaining the transactions removes that window.
 *
 * **Honest bound: this is per-process.** Two editor processes writing the
 * same machine-wide file within the same few milliseconds can still interleave.
 * Closing that needs a cross-process lock file, which is not worth its failure
 * modes (stale locks after a crash) for a file a human edits by hand a few
 * times. The residual window is microseconds wide and both writers are the
 * same user acting deliberately.
 */
let writeChain: Promise<unknown> = Promise.resolve()

function serialize<T>(work: () => Promise<T>): Promise<T> {
  // `.then(work, work)` so a rejected predecessor cannot wedge the chain.
  const next = writeChain.then(work, work)
  writeChain = next.catch(() => {})
  return next
}

/** The probe-shaped view. Never exposes the schema version to callers. */
export async function readLlmCredentials(home: string): Promise<StoredCredentials> {
  const file = await readFile(llmCredentialFilePath(home))
  return { providers: file.providers, devMode: file.devMode }
}

/** Whether the first-run prompt has been dismissed on this machine. */
export async function readPromptDismissed(home: string): Promise<boolean> {
  return (await readFile(llmCredentialFilePath(home))).promptDismissed
}

/**
 * The one read-modify-write every setter goes through, inside the
 * `serialize()` chain.
 *
 * Two rules live here so no setter can forget one. A file whose on-disk
 * version is NEWER than this build's is never overwritten — see
 * {@link CredentialFileNewerError}. And top-level fields this build does not
 * author are carried through the write rather than dropped.
 */
async function mutate(
  home: string,
  apply: (file: LlmCredentialFile) => LlmCredentialFile,
): Promise<void> {
  const path = llmCredentialFilePath(home)
  await serialize(async () => {
    const snap = await readSnapshot(path)
    if (snap.newerThanUs) throw new CredentialFileNewerError(snap.onDiskVersion)
    await writeFile(path, { ...apply(snap.file), version: SCHEMA_VERSION }, snap.unknownFields)
  })
}

export async function setPromptDismissed(
  dismissed: boolean,
  home: string,
): Promise<void> {
  await mutate(home, (file) => ({ ...file, promptDismissed: dismissed }))
}

export async function setLlmDevMode(devMode: boolean, home: string): Promise<void> {
  await mutate(home, (file) => ({ ...file, devMode }))
}

/**
 * One read-modify-write for every provider-scoped setter, through the same
 * `serialize()` chain the old singular writers used. Two overlapping updates
 * could otherwise each read the same snapshot and the second rewrite would
 * erase the first's provider.
 */
async function updateProvider(
  providerId: string,
  home: string,
  update: (slot: StoredProviderCredentials) => StoredProviderCredentials,
): Promise<void> {
  await mutate(home, (file) => ({
    ...file,
    providers: { ...file.providers, [providerId]: update(file.providers[providerId] ?? {}) },
  }))
}

export async function writeLlmApiKey(
  providerId: string,
  apiKey: string,
  home: string,
): Promise<void> {
  await updateProvider(providerId, home, (slot) => ({ ...slot, apiKey }))
}

export async function clearLlmApiKey(
  providerId: string,
  home: string,
): Promise<void> {
  await updateProvider(providerId, home, ({ apiKey: _drop, ...rest }) => rest)
}

export async function writeLlmBaseUrl(
  providerId: string,
  baseUrl: string | undefined,
  home: string,
): Promise<void> {
  await updateProvider(providerId, home, ({ baseUrl: _drop, ...rest }) =>
    baseUrl === undefined ? rest : { ...rest, baseUrl },
  )
}

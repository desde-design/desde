import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { homedir } from "node:os"
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

export function llmCredentialFilePath(home = homedir()): string {
  return join(home, CONFIG_DIR_RELATIVE, CREDENTIAL_FILE_NAME)
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
  if (file.apiKey !== undefined && typeof file.apiKey !== "string") return defaults()
  if (typeof file.devMode !== "boolean") return defaults()
  return {
    version: SCHEMA_VERSION,
    providers: file.apiKey === undefined ? {} : { anthropic: { apiKey: file.apiKey } },
    devMode: file.devMode,
    promptDismissed: typeof file.promptDismissed === "boolean" ? file.promptDismissed : false,
  }
}

/** Every slot must be an object of optional strings, or the file is not trusted. */
function sanitizeProviders(raw: unknown): Record<string, StoredProviderCredentials> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const out: Record<string, StoredProviderCredentials> = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null
    const slot = value as Record<string, unknown>
    if (slot.apiKey !== undefined && typeof slot.apiKey !== "string") return null
    if (slot.baseUrl !== undefined && typeof slot.baseUrl !== "string") return null
    out[id] = {
      ...(typeof slot.apiKey === "string" ? { apiKey: slot.apiKey } : {}),
      ...(typeof slot.baseUrl === "string" ? { baseUrl: slot.baseUrl } : {}),
    }
  }
  return out
}

async function readFile(path: string): Promise<LlmCredentialFile> {
  try {
    const raw = await fs.readFile(path, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null) return defaults()
    const file = parsed as Partial<LlmCredentialFile> & Partial<LlmCredentialFileV1>
    // The migration branch sits BEFORE the mismatch discard. Reversed, the
    // discard would delete every existing user's key on first read.
    if (file.version === 1) return migrateV1(file as LlmCredentialFileV1)
    // A file from a future/older schema is ignored rather than thrown on: the
    // cost is re-entering a key, versus the CLI refusing to start.
    if (file.version !== SCHEMA_VERSION) return defaults()
    if (typeof file.devMode !== "boolean") return defaults()
    const providers = sanitizeProviders(file.providers)
    if (providers === null) return defaults()
    return {
      version: SCHEMA_VERSION,
      providers,
      devMode: file.devMode,
      // Tolerated rather than rejected: a file written before this field
      // existed is otherwise valid, and discarding it would drop the key.
      promptDismissed: typeof file.promptDismissed === "boolean" ? file.promptDismissed : false,
    }
  } catch {
    return defaults()
  }
}

/**
 * Write via temp file + rename. A crash mid-write must not leave a truncated
 * file that reads as "no credentials at all" and silently signs the user out.
 *
 * The temp name carries a UUID, not just the pid: two writes racing inside one
 * process shared a filename and could truncate each other's staging file.
 */
async function writeFile(path: string, file: LlmCredentialFile): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: FILE_MODE })
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
export async function readLlmCredentials(home = homedir()): Promise<StoredCredentials> {
  const file = await readFile(llmCredentialFilePath(home))
  return { providers: file.providers, devMode: file.devMode }
}

/** Whether the first-run prompt has been dismissed on this machine. */
export async function readPromptDismissed(home = homedir()): Promise<boolean> {
  return (await readFile(llmCredentialFilePath(home))).promptDismissed
}

export async function setPromptDismissed(
  dismissed: boolean,
  home = homedir(),
): Promise<void> {
  const path = llmCredentialFilePath(home)
  await serialize(async () => {
    const file = await readFile(path)
    await writeFile(path, { ...file, version: SCHEMA_VERSION, promptDismissed: dismissed })
  })
}

export async function setLlmDevMode(devMode: boolean, home = homedir()): Promise<void> {
  const path = llmCredentialFilePath(home)
  await serialize(async () => {
    const file = await readFile(path)
    await writeFile(path, { ...file, version: SCHEMA_VERSION, devMode })
  })
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
  const path = llmCredentialFilePath(home)
  await serialize(async () => {
    const file = await readFile(path)
    await writeFile(path, {
      ...file,
      version: SCHEMA_VERSION,
      providers: { ...file.providers, [providerId]: update(file.providers[providerId] ?? {}) },
    })
  })
}

export async function writeLlmApiKey(
  providerId: string,
  apiKey: string,
  home = homedir(),
): Promise<void> {
  await updateProvider(providerId, home, (slot) => ({ ...slot, apiKey }))
}

export async function clearLlmApiKey(
  providerId: string,
  home = homedir(),
): Promise<void> {
  await updateProvider(providerId, home, ({ apiKey: _drop, ...rest }) => rest)
}

export async function writeLlmBaseUrl(
  providerId: string,
  baseUrl: string | undefined,
  home = homedir(),
): Promise<void> {
  await updateProvider(providerId, home, ({ baseUrl: _drop, ...rest }) =>
    baseUrl === undefined ? rest : { ...rest, baseUrl },
  )
}

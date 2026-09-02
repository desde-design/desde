import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Per-machine storage for the API keys that extensions need.
 *
 * Figma is the one today: `figma-developer-mcp` reads `FIGMA_API_KEY`, and
 * before this existed the only way to supply it was `export FIGMA_API_KEY=…`
 * in the shell that launched the editor. That is not a setting a designer who
 * opened a folder in a window can reach (Mo, 2026-08-18: "there should be no
 * text that refers to env, or variables — every major setting that a user
 * needs to set should be available in the GUI"). The variable did not go away;
 * it moved behind a form.
 *
 * **Why a second file rather than a field on `llm-credentials.json`.** That
 * file's reader discards the whole thing on a version mismatch, by design, so
 * growing its schema means either a bump that throws away the user's Anthropic
 * key or a second tolerated-optional field on a file whose invariant is
 * strictness. These are also different lifetimes: one is the tool's own
 * credential, these belong to extensions that come and go with the catalog.
 *
 * Everything else — the directory, the 0600/0700 modes, temp-file-plus-rename,
 * degrade-to-empty on any read problem, the per-process write chain — is the
 * same reasoning `llm-credential-store.ts` writes out at length, and is not
 * repeated here.
 */

const CONFIG_DIR_RELATIVE = join(".config", "desde")
const SECRET_FILE_NAME = "extension-secrets.json"
const FILE_MODE = 0o600
const DIR_MODE = 0o700
const SCHEMA_VERSION = 1

interface ExtensionSecretFile {
  version: number
  /** Keyed by the env var name the extension reads. */
  secrets: Record<string, string>
}

export function extensionSecretFilePath(home = homedir()): string {
  return join(home, CONFIG_DIR_RELATIVE, SECRET_FILE_NAME)
}

function defaults(): ExtensionSecretFile {
  return { version: SCHEMA_VERSION, secrets: {} }
}

async function readFile(path: string): Promise<ExtensionSecretFile> {
  try {
    const raw = await fs.readFile(path, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== "object" || parsed === null) return defaults()
    const file = parsed as ExtensionSecretFile
    if (file.version !== SCHEMA_VERSION) return defaults()
    if (typeof file.secrets !== "object" || file.secrets === null) return defaults()
    // One bad entry discards only itself. A single non-string value must not
    // cost the user every other key they had saved.
    const secrets: Record<string, string> = {}
    for (const [name, value] of Object.entries(file.secrets)) {
      if (typeof value === "string") secrets[name] = value
    }
    return { version: SCHEMA_VERSION, secrets }
  } catch {
    return defaults()
  }
}

async function writeFile(path: string, file: ExtensionSecretFile): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: DIR_MODE })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: FILE_MODE })
  await fs.rename(tmp, path)
  await fs.chmod(path, FILE_MODE).catch(() => {})
  await fs.chmod(dirname(path), DIR_MODE).catch(() => {})
}

let writeChain: Promise<unknown> = Promise.resolve()

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = writeChain.then(work, work)
  writeChain = next.catch(() => {})
  return next
}

/** Every stored secret, by env var name. Values included — callers are trusted. */
export async function readExtensionSecrets(
  home = homedir(),
): Promise<Record<string, string>> {
  return (await readFile(extensionSecretFilePath(home))).secrets
}

/** The names that have a value. This is what the HTTP layer may return. */
export async function readExtensionSecretNames(home = homedir()): Promise<string[]> {
  return Object.keys(await readExtensionSecrets(home)).sort()
}

export async function writeExtensionSecret(
  name: string,
  value: string,
  home = homedir(),
): Promise<void> {
  const path = extensionSecretFilePath(home)
  await serialize(async () => {
    const file = await readFile(path)
    await writeFile(path, {
      version: SCHEMA_VERSION,
      secrets: { ...file.secrets, [name]: value },
    })
  })
}

export async function clearExtensionSecret(name: string, home = homedir()): Promise<void> {
  const path = extensionSecretFilePath(home)
  await serialize(async () => {
    const file = await readFile(path)
    const secrets = { ...file.secrets }
    delete secrets[name]
    await writeFile(path, { version: SCHEMA_VERSION, secrets })
  })
}

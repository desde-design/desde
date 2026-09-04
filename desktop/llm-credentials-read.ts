/**
 * READ-ONLY view of the CLI's credential file, for Electron main.
 *
 * `editor-cli/src/server/llm-credential-store.ts` owns this file: its path, its
 * schema, its atomic write, its 0600 mode. Nothing here writes, migrates, or
 * repairs anything -- a second writer for one secret is a bug factory, which is
 * the same argument that file makes for having one store in the first place.
 *
 * Why a copy rather than an import: `desktop/` is a self-contained package
 * whose tsconfig includes `*.ts` and `__tests__/**` and which imports no repo
 * source at all. Reaching into `editor-cli/` would pull its module graph into
 * the Electron main bundle for the sake of two field names. Asking the CLI
 * child instead is not available either: the caller that matters runs during
 * boot(), BEFORE the child exists.
 *
 * The drift that copy risks is closed from the other side, by
 * `src/editor/llm-providers/desktop-gate-env-vars.test.ts`.
 *
 * EVERY failure returns "nothing stored". That direction is deliberate: the one
 * caller uses this to decide whether to SKIP a download, so an unreadable file
 * must land on today's behaviour (download) rather than on skipping something
 * the user needs.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface StoredProviderCredential {
  apiKey?: string
  baseUrl?: string
}

function credentialFilePath(home: string): string {
  return join(home, ".config", "desde", "llm-credentials.json")
}

function readRaw(home: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(credentialFilePath(home), "utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Per-provider stored keys. Understands the v2 shape and the v1 shape that
 * preceded it, because a user who upgrades keeps a v1 file until the CLI next
 * writes, and this process may read it long before that happens.
 */
export function readStoredProviderKeys(
  home: string = homedir(),
): Record<string, StoredProviderCredential> {
  const file = readRaw(home)
  if (!file) return {}
  if (file.version === 1) {
    const apiKey = typeof file.apiKey === "string" ? file.apiKey : undefined
    return apiKey ? { anthropic: { apiKey } } : {}
  }
  if (file.version !== 2) return {}
  const providers = file.providers
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return {}
  const out: Record<string, StoredProviderCredential> = {}
  for (const [id, value] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue
    const record = value as { apiKey?: unknown; baseUrl?: unknown }
    out[id] = {
      ...(typeof record.apiKey === "string" ? { apiKey: record.apiKey } : {}),
      ...(typeof record.baseUrl === "string" ? { baseUrl: record.baseUrl } : {}),
    }
  }
  return out
}

/** The global dev-mode flag. Anthropic-only in meaning; see the store's doc. */
export function readStoredDevMode(home: string = homedir()): boolean {
  const file = readRaw(home)
  return file?.devMode === true
}

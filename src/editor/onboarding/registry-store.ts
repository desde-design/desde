/**
 * Local (editor) implementation of the per-project design-system
 * {@link RegistryStore}, backed by `.desde/design-systems.json` under the
 * prototype root (same `.desde/` convention as the manifest cache).
 *
 * Fail-soft by design: a missing or malformed file reads as an EMPTY registry
 * (the registry is purely additive over the static defaults, so a corrupt
 * file must never break manifest serving — it just falls back to defaults).
 * Writes are atomic (temp-then-rename) so a concurrent read never sees a torn
 * file. The cloud (viewer) impl is a separate Firestore-backed class (6.6).
 */

import { promises as fs } from 'node:fs'
import { desdePath, desdePathOrNull } from '@/editor/worktree/desde-dir'
import type { RegisteredDesignSystem, RegistryStore } from './types'

/** Prototype-root-relative path of the registry file. */
export const REGISTRY_FILE_PATH = '.desde/design-systems.json'

/** On-disk shape. Versioned so a format change can migrate rather than break. */
interface RegistryFile {
  version: 1
  designSystems: RegisteredDesignSystem[]
}

export class LocalRegistryStore implements RegistryStore {
  private readonly prototypeRoot: string

  constructor(prototypeRoot: string) {
    this.prototypeRoot = prototypeRoot
  }

  /**
   * The registry file, through the `.desde` guard (see
   * `src/editor/worktree/desde-dir.ts`). Resolved per call rather than in
   * the constructor: this store is built on the serving path, and a
   * constructor that threw there would take manifest serving down with it.
   * `null` means `.desde` (or the file itself) is a symbolic link — the
   * read then reports an empty registry, its documented fail-soft.
   */
  private pathOrNull(): string | null {
    return desdePathOrNull(this.prototypeRoot, 'design-systems.json')
  }

  async list(): Promise<RegisteredDesignSystem[]> {
    const filePath = this.pathOrNull()
    if (filePath === null) return [] // linked away → empty registry
    let raw: string
    try {
      raw = await fs.readFile(filePath, 'utf8')
    } catch {
      return [] // no file yet → empty registry
    }
    try {
      const parsed = JSON.parse(raw) as Partial<RegistryFile>
      return Array.isArray(parsed?.designSystems)
        ? parsed.designSystems.filter(isRegisteredDesignSystem)
        : []
    } catch {
      // Malformed JSON → fail soft to empty. The registry is additive over the
      // static defaults; a corrupt file must not break manifest serving.
      return []
    }
  }

  /** Add or replace by `id` (idempotent re-add). */
  async add(entry: RegisteredDesignSystem): Promise<void> {
    const existing = await this.list()
    await this.write([...existing.filter((e) => e.id !== entry.id), entry])
  }

  async remove(id: string): Promise<void> {
    const existing = await this.list()
    const next = existing.filter((e) => e.id !== id)
    // Avoid a pointless rewrite when nothing matched.
    if (next.length !== existing.length) await this.write(next)
  }

  /**
   * Throws `DesdeDirSymlinkError` when `.desde` is a symbolic link, rather
   * than writing the registry outside the working tree. The read above
   * fails soft; a WRITE cannot, and every caller of `add`/`remove` is a
   * route that reports the refusal.
   */
  private async write(entries: RegisteredDesignSystem[]): Promise<void> {
    const filePath = desdePath(this.prototypeRoot, 'design-systems.json')
    const body: RegistryFile = { version: 1, designSystems: entries }
    await fs.mkdir(desdePath(this.prototypeRoot), { recursive: true })
    const tmp = `${filePath}.${process.pid}.tmp`
    await fs.writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
    await fs.rename(tmp, filePath)
  }
}

export function createLocalRegistryStore(prototypeRoot: string): RegistryStore {
  return new LocalRegistryStore(prototypeRoot)
}

/**
 * Defensive shape guard for entries read off disk — a hand-edited or
 * partially-written file shouldn't surface a half-formed entry into the
 * manifest pipeline (which would build a broken source). Each must carry the
 * fields `build-manifest-source.ts` reads.
 */
function isRegisteredDesignSystem(value: unknown): value is RegisteredDesignSystem {
  if (!value || typeof value !== 'object') return false
  const e = value as Record<string, unknown>
  // `dtsRoots` is optional, but when present it's spliced/`.map`ped downstream
  // — a non-array (or non-string element) would crash manifest building, so
  // reject the whole entry rather than let it through the fail-soft net.
  if (
    e.dtsRoots !== undefined &&
    (!Array.isArray(e.dtsRoots) || !e.dtsRoots.every((r) => typeof r === 'string'))
  ) {
    return false
  }
  if (e.packageRoot !== undefined && typeof e.packageRoot !== 'string') return false
  if (e.tsconfigPath !== undefined && typeof e.tsconfigPath !== 'string') return false
  return (
    typeof e.id === 'string' &&
    typeof e.package === 'string' &&
    typeof e.version === 'string' &&
    typeof e.framework === 'string' &&
    typeof e.designSystem === 'string' &&
    typeof e.importPath === 'string' &&
    !!e.source &&
    typeof e.source === 'object'
  )
}

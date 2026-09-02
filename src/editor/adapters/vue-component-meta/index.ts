/**
 * `VueComponentMetaManifestSource` — Volar-powered live extractor for the
 * customer's prototype tree.
 *
 * Why this exists: `LocalVueManifestSource` only handles the type-form
 * `defineProps<{...}>()` against types declared in the same SFC. Real
 * customer code uses imported types, generics, `withDefaults`, JSDoc on
 * imported props, slots, and emits — none of which the regex-light SFC
 * walker resolves. `vue-component-meta` (the extractor Volar itself
 * uses for IntelliSense) handles all of these via a real TS checker.
 *
 * Scope: this adapter targets a customer's prototype repo at request
 * time. The Acme DS adapter ships pre-extracted JSON because it
 * doesn't have access to the Acme DS source at runtime; this
 * adapter has the source on disk (under `EDITOR_PROTOTYPE_ROOT`) and
 * runs the extractor live.
 *
 * Performance: `createChecker` builds a TS Program (1–2s for a typical
 * prototype) and is cached at module level keyed by `tsconfigPath`.
 * Per-component `getComponentMeta` calls are 50–200ms and are
 * cached per source instance. The `manifest` route is dev-only;
 * caching at request granularity is fine for the inspector-click cadence.
 *
 * Failure modes: a single component that can't be analyzed (broken
 * types, unsupported syntax) is skipped — the rest still emit. The
 * route's composite falls through to `LocalVueManifestSource` for any
 * skipped component name.
 */
import {
  createChecker,
  type ComponentMeta,
  type Declaration,
  type EventMeta,
  type ExposeMeta,
  type PropertyMeta,
  type PropertyMetaSchema,
  type SlotMeta,
} from 'vue-component-meta'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type {
  ComponentManifest,
  ComponentManifestSource,
  DesignSystemId,
  FrameworkId,
} from '../../core'
import { normalizeComponentMeta } from '../component-meta/normalize'
import type {
  RawComponentMeta,
  RawEventMeta,
  RawPropertyMeta,
  RawSlotMeta,
} from '../component-meta/raw-manifest'

export interface VueComponentMetaManifestSourceOptions {
  /**
   * Absolute path to the tsconfig.json that includes the prototype's
   * `.vue` files. For Vite scaffolds this is typically
   * `tsconfig.app.json`; the adapter accepts whatever the caller hands
   * it and discovers nothing on its own.
   */
  tsconfigPath: string
  /** Absolute paths of `.vue` files to ingest. */
  componentFiles: string[]
  /** Framework id stamped on produced manifests. Defaults to `'vue3'`. */
  framework?: FrameworkId
  /**
   * Design-system id stamped on produced manifests. Defaults to
   * `'first-party'` to match `LocalVueManifestSource` so the two
   * sources collide cleanly in the composite (first-source-wins).
   */
  designSystem?: DesignSystemId
  /** Optional import path baked into manifests. */
  importPath?: string
  /**
   * Override component-name resolution. Default precedence:
   *   1. `componentNameResolver` if supplied
   *   2. `meta.name` (set by `defineOptions({ name: ... })` or the
   *      script options API `name:` field — same name the bridge
   *      resolves selections against)
   *   3. file basename minus `.vue`
   * Returning `null` skips the file silently.
   */
  componentNameResolver?: (
    filePath: string,
    meta: ComponentMeta,
  ) => string | null
}

type Checker = ReturnType<typeof createChecker>

const checkerCache = new Map<string, Checker>()

function getChecker(tsconfigPath: string): Checker | null {
  if (!existsSync(tsconfigPath)) return null
  const cached = checkerCache.get(tsconfigPath)
  if (cached) return cached
  const checker = createChecker(tsconfigPath, {
    schema: {
      // Skip declarations from `node_modules` so DOM/Vue/router types
      // don't recurse through hundreds of transitive types. Without
      // this the Acme DS `UiInput` manifest blew up to 71 MB during
      // the spike — the same hazard applies to any customer prototype
      // that imports framework types into its public props.
      ignore: [
        (_name, type) => {
          const sym = type.aliasSymbol ?? type.getSymbol()
          const decl = sym?.declarations?.[0]
          const sourceFile = decl?.getSourceFile()
          if (!sourceFile) return false
          return sourceFile.fileName.includes('/node_modules/')
        },
      ],
    },
    printer: { newLine: 1 },
  })
  checkerCache.set(tsconfigPath, checker)
  return checker
}

/**
 * Test-only: drop the cached checker for a given tsconfig path so the
 * next `populate()` rebuilds. Production code should not need this.
 */
export function _resetCheckerCacheForTests(): void {
  checkerCache.clear()
}

export class VueComponentMetaManifestSource implements ComponentManifestSource {
  readonly id = 'vue-component-meta'
  readonly framework: FrameworkId
  readonly designSystem: DesignSystemId

  private readonly options: VueComponentMetaManifestSourceOptions
  private cache: Map<string, ComponentManifest> | null = null

  constructor(options: VueComponentMetaManifestSourceOptions) {
    this.options = options
    this.framework = options.framework ?? 'vue3'
    this.designSystem = options.designSystem ?? 'first-party'
  }

  async listComponents(): Promise<ComponentManifest[]> {
    return Array.from(this.populate().values())
  }

  async getComponent(name: string): Promise<ComponentManifest | null> {
    return this.populate().get(name) ?? null
  }

  invalidate(): void {
    this.cache = null
  }

  private populate(): Map<string, ComponentManifest> {
    if (this.cache) return this.cache
    const cache = new Map<string, ComponentManifest>()

    const checker = getChecker(this.options.tsconfigPath)
    if (!checker) {
      // No tsconfig means no checker; emit nothing and let the next
      // composite source take over. Logging is the caller's job — we
      // stay pure so tests don't have to silence console.
      this.cache = cache
      return cache
    }

    for (const filePath of this.options.componentFiles) {
      let meta: ComponentMeta
      try {
        meta = checker.getComponentMeta(filePath)
      } catch {
        // A single broken file must not poison the rest of the listing.
        continue
      }

      const componentName =
        this.options.componentNameResolver?.(filePath, meta) ??
        meta.name ??
        defaultName(filePath)
      if (!componentName) continue

      const raw: RawComponentMeta = {
        name: meta.name ?? componentName,
        description: meta.description,
        type: meta.type,
        // Drop `global: true` props inside normalize; pass them through
        // here so the raw shape stays faithful to the extractor output.
        props: meta.props.map(materializeProperty) as RawPropertyMeta[],
        events: meta.events.map(materializeEvent) as RawEventMeta[],
        slots: meta.slots.map(materializeSlot) as RawSlotMeta[],
        exposed: meta.exposed.map(materializeExpose) as RawComponentMeta['exposed'],
      }

      const manifest = normalizeComponentMeta(raw, {
        componentName,
        framework: this.framework,
        designSystem: this.designSystem,
        // Distinct from `'vue-component-meta'` (used by the design system
        // adapter that consumes pre-extracted JSON) so logs can tell
        // the live and bundled extraction paths apart.
        extractor: 'vue-component-meta-live',
        importPath: this.options.importPath,
        declarations: [{ file: filePath }],
      })

      // Last-writer-wins on duplicate names. Stable input order is the
      // caller's responsibility (the manifest route walks the tree
      // alphabetically by readdir, which is good enough).
      cache.set(manifest.name, manifest)
    }

    this.cache = cache
    return cache
  }
}

function defaultName(filePath: string): string | null {
  const base = basename(filePath).replace(/\.vue$/i, '')
  return base || null
}

// ──────────────── Materialization helpers ────────────────
// Strip non-serializable bits (function methods, raw TS Type refs) from
// vue-component-meta output so the structural shape matches
// `RawComponentMeta`. Mirrors the logic in
// `acme-ds/scripts/extract-meta.ts`; kept duplicated rather than
// shared because that script's lifecycle is offline JSON generation
// while this adapter runs at request time.

function getDeclarations(
  meta: PropertyMeta | EventMeta | SlotMeta | ExposeMeta,
): Declaration[] {
  try {
    return meta.getDeclarations()
  } catch {
    return meta.declarations
  }
}

function materializeSchema(schema: PropertyMetaSchema): PropertyMetaSchema {
  if (typeof schema !== 'object' || schema === null) return schema
  if (schema.kind === 'object') {
    const fields = Object.fromEntries(
      Object.entries(schema.schema ?? {}).map(([key, prop]) => [
        key,
        materializeProperty(prop),
      ]),
    )
    return { ...schema, schema: fields }
  }
  return {
    ...schema,
    schema: schema.schema?.map(materializeSchema),
  }
}

function materializeProperty(prop: PropertyMeta): PropertyMeta {
  return {
    ...prop,
    declarations: getDeclarations(prop),
    schema: materializeSchema(prop.schema),
  }
}

function materializeEvent(event: EventMeta): EventMeta {
  return {
    ...event,
    declarations: getDeclarations(event),
    schema: event.schema.map(materializeSchema),
  }
}

function materializeSlot(slot: SlotMeta): SlotMeta {
  return {
    ...slot,
    declarations: getDeclarations(slot),
    schema: materializeSchema(slot.schema),
  }
}

function materializeExpose(exposed: ExposeMeta): ExposeMeta {
  return {
    ...exposed,
    declarations: getDeclarations(exposed),
    schema: materializeSchema(exposed.schema),
  }
}

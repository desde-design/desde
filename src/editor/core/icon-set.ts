/**
 * Substrate-neutral model for icon sets surfaced to editor's inspector.
 * An "icon set" is any collection of icons the user can pick from — an npm
 * package (`@acme/icons`, `lucide-react`, `@heroicons/react`), a folder of
 * project-local SVGs, an Iconify collection, a sprite sheet. Adapters in
 * {@link ../adapters/icon-sets/} produce `IconSetSource` instances; the
 * inspector picker and the swap applicator consume them without caring
 * which adapter produced them.
 *
 * The load-bearing abstraction is {@link IconUsagePattern} on the source +
 * {@link IconRef} on each icon. Together they tell the swap pipeline both
 * *how* icons in this set are referenced in source (component tag, string
 * prop, CSS class, sprite href) and *what* the specific reference is.
 *
 * Substrate-neutrality rule: no file outside `adapters/icon-sets/<name>/`
 * may mention a specific icon package (`@acme/icons`, `lucide-react`, …).
 * The picker UI, the registry, and the swap dispatcher work against the
 * interfaces in this file only.
 */

import type { FrameworkId } from './manifest'

/**
 * How icons in a given set are referenced in source code. The swap
 * pipeline keys its emit strategy off this discriminator: each `kind`
 * maps to a different applicator (component-tag rename + import update,
 * literal prop edit, class-token swap, attribute edit).
 *
 * `'any'` framework on the parent {@link IconSetSource} means the set's
 * icons can be consumed by any framework adapter; framework-specific
 * sets (Vue SFCs, React components) MUST set `framework` accordingly.
 */
export type IconUsagePattern =
  | { kind: 'named-component-import'; packageName: string }
  | { kind: 'default-component-import'; from: 'package' | 'project-path'; baseDir?: string }
  | { kind: 'string-prop'; tagName: string; nameProp: string }
  | { kind: 'css-class'; tagName: string; classPrefix: string }
  | { kind: 'sprite-ref'; spriteUrl: string }

/**
 * The reference data needed to write a specific icon into source. The
 * `kind` discriminator MUST match the parent {@link IconSetSource}'s
 * `usagePattern.kind` — a set with `usagePattern.kind = 'css-class'`
 * may only produce icons with `ref.kind = 'css-class'`.
 *
 * This separation (pattern on the set, ref on the icon) means the
 * source declares the emit strategy once while each icon carries only
 * its own identifier (export name, class token, sprite id, …).
 */
export type IconRef =
  | { kind: 'named-component-import'; exportName: string; importPath: string }
  | { kind: 'default-component-import'; importPath: string }
  | { kind: 'string-prop'; value: string }
  | { kind: 'css-class'; className: string }
  | { kind: 'sprite-ref'; href: string }

/**
 * A preview the picker can render directly. Adapters that work against
 * component libraries produce `'svg'` previews by running the prototype's
 * own renderer (see `src/editor/icon-preview/`) at adapter init.
 * Adapters that work against static files (`project-svg-folder`) read
 * SVG markup off disk.
 */
export type IconPreview =
  | { kind: 'svg'; markup: string }
  | { kind: 'image'; url: string }

export interface IconManifest {
  /** Set-scoped identifier, stable across runs (e.g. `'DataObjectIcon'`, `'trash'`). */
  id: string
  /** Human-readable label for the picker (`'Data object'`). */
  displayName: string
  /** Optional set-curated grouping (`'AI providers'`, `'Cloud'`). Picker degrades to flat-by-set when absent. */
  category?: string
  /** Search/aliasing terms — `['key', 'lock', 'secret']`. Empty array if none. */
  tags: string[]
  /** What to write into source to reference this icon. `kind` MUST match the source's `usagePattern.kind`. */
  ref: IconRef
  /** Renderable preview for the picker. */
  preview: IconPreview
}

/**
 * One concrete icon set registered against an open project. Adapters in
 * `src/editor/adapters/icon-sets/<adapter-id>/` implement this.
 *
 * Adapters MUST:
 *  - Resolve their source data from the user's prototype repo
 *    (`node_modules/<pkg>`, in-repo folders, network metadata). NEVER
 *    bundle icon data into editor itself.
 *  - Produce previews up front (build-time extraction or static-file
 *    read) so the picker can render synchronously.
 *  - Keep `id` stable across runs — the registry uses it as a primary
 *    key and the swap pipeline records it for traceability.
 */
export interface IconSetSource {
  /** Stable registry key. Use kebab-case (`'acme-icons'`, `'project-svgs'`). */
  id: string
  /** Label shown in the picker's set grouping. */
  displayName: string
  /** Framework this set's icons target; `'any'` for framework-agnostic sets (sprite refs, CSS classes). */
  framework: FrameworkId | 'any'
  /** How icons in this set are referenced in source — drives the swap applicator. */
  usagePattern: IconUsagePattern
  /** Full icon enumeration. Adapters may cache internally; the registry calls this lazily. */
  listIcons(): Promise<IconManifest[]>
  /** Single-icon lookup by `IconManifest.id`. Returns `null` if not in this set. */
  getIcon(id: string): Promise<IconManifest | null>
}

/**
 * A search hit across all registered sets. The picker uses this for
 * cross-set search; the swap dispatcher uses `(sourceId, icon.id)` to
 * route to the right applicator via the originating set's
 * `usagePattern`.
 */
export interface IconSearchHit {
  sourceId: string
  icon: IconManifest
}

/**
 * Runtime registry of icon sets for one open project. Owned by the
 * editor CLI process; exposed to the inspector via the HTTP server
 * and (eventually) to the chat agent as a tool surface.
 *
 * The registry is the only object the picker UI and the swap
 * dispatcher import — they never reach into specific adapters.
 */
export interface IconSetRegistry {
  register(source: IconSetSource): void
  list(): IconSetSource[]
  get(sourceId: string): IconSetSource | null
  /**
   * Detection helper for the framework adapter: given an import the
   * inspector observed at the call-site, return the set that owns it
   * (or `null` if no registered set claims this package). Used to
   * decide whether to surface the icon picker for a selection.
   */
  findOwnerOfPackage(packageName: string): IconSetSource | null
  /** Cross-set search by `displayName`, `tags`, `category`, or `id` substring. */
  searchIcons(query: string): Promise<IconSearchHit[]>
}

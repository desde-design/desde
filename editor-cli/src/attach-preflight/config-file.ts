import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { AttachHost } from './types.js'

/**
 * Locating the file the user has to edit, and working out what module syntax
 * to generate for it.
 *
 * Getting the syntax wrong is not cosmetic: an `import` statement pasted into
 * a CJS `next.config.js` is a hard boot failure, and a `require` pasted into an
 * ESM config is the same in the other direction. The extension answers it for
 * every case except a bare `.js`, where `package.json#type` decides.
 */

/**
 * Extension order per host, copied from each host's OWN resolution order.
 *
 * This matters when a project has two config files with different extensions:
 * we must name the one the framework actually reads, or the user pastes a block
 * into a file nothing loads and then watches the preflight fail again. The
 * intuitive order (TypeScript first) is wrong for all three — every one of them
 * prefers `.js`.
 *
 * - `next`: MEASURED from `next/dist/shared/lib/constants.js` (16.3.0) —
 *   `CONFIG_FILES`. Note there is **no `.cjs` or `.cts`**: Next does not read
 *   `next.config.cjs` at all, so offering to edit one would be a dead end.
 *   `.mts` is conditional on Node's type-stripping being available.
 * - `vite` / `react-router`: MEASURED from Vite 8's `DEFAULT_CONFIG_FILES`.
 * - `nuxt`: MEASURED from c12 3.3.4's `SUPPORTED_EXTENSIONS` (the loader Nuxt
 *   uses), minus the data formats (`.json`, `.yaml`, …) — a plugin import needs
 *   a code config.
 * - `astro`: NOT verified against Astro's source (no Astro fixture to hand);
 *   it uses the Vite order, which covers the same extension set.
 */
const CONFIG_EXTENSIONS: Record<AttachHost, readonly string[]> = {
  next: ['.js', '.mjs', '.ts', '.mts'],
  nuxt: ['.js', '.ts', '.mjs', '.cjs', '.mts', '.cts'],
  astro: ['.js', '.mjs', '.ts', '.cjs', '.mts', '.cts'],
  'react-router': ['.js', '.mjs', '.ts', '.cjs', '.mts', '.cts'],
  vite: ['.js', '.mjs', '.ts', '.cjs', '.mts', '.cts'],
}

const CONFIG_BASENAMES: Record<AttachHost, string> = {
  next: 'next.config',
  nuxt: 'nuxt.config',
  astro: 'astro.config',
  'react-router': 'vite.config',
  vite: 'vite.config',
}

/**
 * A host whose config file we are willing to create from nothing.
 *
 * Next, Nuxt and Astro all boot happily with no config file at all, so writing
 * a complete one is additive and cannot contradict anything. A root
 * `vite.config` is different: if it is missing from a React Router project,
 * the project is not the shape we detected, and synthesizing one without the
 * framework's own plugin would produce a config that boots and serves the
 * wrong thing. Refuse instead.
 */
const CAN_CREATE: Record<AttachHost, boolean> = {
  next: true,
  nuxt: true,
  astro: true,
  'react-router': false,
  vite: false,
}

export function canCreateConfig(host: AttachHost): boolean {
  return CAN_CREATE[host]
}

export type ModuleSyntax = 'esm' | 'cjs'

export interface ConfigFileLocation {
  /** Absolute path. */
  path: string
  /** Path relative to the prototype root. */
  relative: string
  exists: boolean
  syntax: ModuleSyntax
  /** True when the block has to typecheck (a `.ts`/`.mts`/`.cts` config). */
  typed: boolean
}

export function candidateConfigPaths(prototypeRoot: string, host: AttachHost): string[] {
  const base = CONFIG_BASENAMES[host]
  return CONFIG_EXTENSIONS[host].map((ext) => join(prototypeRoot, base + ext))
}

/**
 * Find the host's config file, or describe the one we would create.
 *
 * Returns `null` only when nothing exists and the host is one we refuse to
 * synthesize a config for.
 */
export async function locateConfigFile(
  prototypeRoot: string,
  host: AttachHost,
): Promise<ConfigFileLocation | null> {
  const base = CONFIG_BASENAMES[host]
  const packageIsModule = await readPackageTypeIsModule(prototypeRoot)

  for (const ext of CONFIG_EXTENSIONS[host]) {
    const path = join(prototypeRoot, base + ext)
    if (await fileExists(path)) {
      return {
        path,
        relative: base + ext,
        exists: true,
        syntax: syntaxForExtension(ext, packageIsModule),
        typed: ext === '.ts' || ext === '.mts' || ext === '.cts',
      }
    }
  }

  if (!CAN_CREATE[host]) return null

  // Nothing on disk. Match the project: a TypeScript project gets a `.ts`
  // config (all three creatable hosts support one), everything else gets
  // `.mjs`, which is unambiguous regardless of `package.json#type`.
  const typed = await fileExists(join(prototypeRoot, 'tsconfig.json'))
  const ext = typed ? '.ts' : '.mjs'
  return {
    path: join(prototypeRoot, base + ext),
    relative: base + ext,
    exists: false,
    syntax: 'esm',
    typed,
  }
}

function syntaxForExtension(ext: string, packageIsModule: boolean): ModuleSyntax {
  if (ext === '.mjs' || ext === '.mts') return 'esm'
  if (ext === '.cjs' || ext === '.cts') return 'cjs'
  // A `.ts` config is written ESM-style by every one of these frameworks;
  // their loaders (jiti / vite-node / Next's own) transpile it. A bare `.js`
  // is whatever package.json says.
  if (ext === '.ts') return 'esm'
  return packageIsModule ? 'esm' : 'cjs'
}

async function readPackageTypeIsModule(prototypeRoot: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(join(prototypeRoot, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { type?: unknown }
    return parsed.type === 'module'
  } catch {
    // No package.json, or malformed. Detection upstream already refused those
    // cases; defaulting to CJS for a bare `.js` matches Node's own default.
    return false
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

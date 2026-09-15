/**
 * What a prototype ALREADY has, for the New Project design-system step.
 *
 * `suggest.ts` answers "which npm packages could be registered". That is the
 * right question for the step's list, and the wrong one for its empty state:
 * a repo whose design system is copied in as source (the shadcn/ui
 * distribution model) has nothing to register, and the step used to say
 * "Nothing found to add". Designers read that as "nothing was detected", and
 * from there as "the variants will not work" (Mo, 2026-09-15). They do work:
 * first-party files are catalogued on every boot with nothing to set up. The
 * screen just never showed the evidence.
 *
 * So this module reports two facts the step can put in front of a designer:
 *
 *  1. **A named system, when a marker proves it.** shadcn/ui writes
 *     `components.json` at the repo root, with a `$schema` on `ui.shadcn.com`.
 *     Nothing else writes that file, so its presence is a fact, not a guess,
 *     and the step can say "shadcn/ui detected" outright. One marker today;
 *     `FirstPartySystem` is a union so the next copy-in system is a new
 *     branch in `readNamedSystem`, not a new code path.
 *  2. **How many components the catalog will carry.** Counted with the same
 *     walk and the same adapters the boot uses (`walkFiles` +
 *     `LocalReactManifestSource` / `LocalVueManifestSource`), so the number on
 *     the screen is the number the agent gets. A file count would be wrong
 *     twice over: shadcn's `card.tsx` is one file and seven components.
 *
 * Pure read-only over the filesystem. The adapters are lazy-imported for the
 * reason `build-manifest-source.ts` gives: the Vue one needs compiler devDeps
 * a React prototype never carries, and a missing one must count as zero, not
 * throw.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

interface FirstPartySystem {
  id: 'shadcn'
  /** The name a designer knows it by. */
  label: 'shadcn/ui'
  /** shadcn's `style` field, when present (`radix-nova`, `new-york`, …). Informational. */
  style?: string
}

export interface FirstPartyDetection {
  /** A named system a marker file proves, or null when only first-party files were found. */
  system: FirstPartySystem | null
  /** Components the boot catalog will extract from first-party files. */
  componentCount: number
}

const SHADCN_MARKER = 'components.json'
const SHADCN_SCHEMA_HOST = 'ui.shadcn.com'

/**
 * A marker file that only one system writes. `components.json` is shadcn's
 * (the CLI writes it on `init` and reads it on every `add`), and its `$schema`
 * names the vendor, so a same-named file from some other tool does not match.
 */
async function readNamedSystem(root: string): Promise<FirstPartySystem | null> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(root, SHADCN_MARKER), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const rec = parsed as { $schema?: unknown; style?: unknown }
  if (typeof rec.$schema !== 'string' || !rec.$schema.includes(SHADCN_SCHEMA_HOST)) return null
  return {
    id: 'shadcn',
    label: 'shadcn/ui',
    ...(typeof rec.style === 'string' && rec.style ? { style: rec.style } : {}),
  }
}

async function countFirstPartyComponents(root: string): Promise<number> {
  const { walkFiles } = await import('@/editor/edit-service/build-manifest-source')
  const { components, reactComponents } = await walkFiles(root)

  let total = 0
  if (reactComponents.length > 0) {
    const { LocalReactManifestSource } = await import('@/editor/adapters/local-react')
    const source = new LocalReactManifestSource({ componentFiles: reactComponents })
    total += (await source.listComponents()).length
  }
  if (components.length > 0) {
    try {
      const { LocalVueManifestSource } = await import('@/editor/adapters/local-vue')
      const source = new LocalVueManifestSource({ componentFiles: components })
      total += (await source.listComponents()).length
    } catch {
      // No Vue compiler in this prototype: the boot skips these files too.
    }
  }
  return total
}

/**
 * `null` means there is genuinely nothing to report: no marker file and no
 * first-party components. The step keeps its plain empty state for that case.
 */
export async function detectFirstParty(prototypeRoot: string): Promise<FirstPartyDetection | null> {
  const [system, componentCount] = await Promise.all([
    readNamedSystem(prototypeRoot),
    countFirstPartyComponents(prototypeRoot),
  ])
  if (!system && componentCount === 0) return null
  return { system, componentCount }
}

/**
 * Framework-dispatched icon preview renderer. Adapters call
 * {@link renderIconPreviews} with the framework + package + list of
 * export names and get back SVG markup for each successfully rendered
 * icon, plus a `failures` map for the rest.
 *
 * Implementation: spawn a child `node` process with `cwd` set to the
 * prototype repo, so module resolution picks up the prototype's
 * installed framework runtime (`vue`, `react`/`react-dom`, …) and the
 * target icon package. The child reads `{ packageName, iconExports }`
 * from stdin and writes `{ previews, failures }` to stdout. Per-icon
 * failures never abort the batch.
 *
 * V1 ships the Vue renderer only. Add React in Phase 3 by writing
 * `render-react.mjs` alongside and adding a case to {@link scriptForFramework}.
 */

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { FrameworkId } from '../core'

export interface RenderIconPreviewsInput {
  framework: FrameworkId | 'any'
  packageName: string
  iconExports: string[]
  /** cwd for the child process — set to the open prototype root. */
  prototypeRoot: string
  /** Override the bundled renderer scripts (tests only). */
  scriptPath?: string
  /** Max ms before SIGTERM. Default 30s — enough for 500+ icons. */
  timeoutMs?: number
}

export interface RenderIconPreviewsResult {
  /** Successfully rendered icons, keyed by export name. SVG markup. */
  previews: Record<string, string>
  /** Per-icon failure reasons, keyed by export name. */
  failures: Record<string, string>
}

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * The packaged-app candidate directory, from `EDITOR_PAYLOAD_ROOT` — or
 * `null` when that's unset/empty, meaning "no packaged candidate; keep
 * probing." Throws on a relative value, same as the sibling below.
 *
 * This is a LOCAL COPY of `editor-cli/src/payload-paths.ts`'s
 * `payloadRoot()` validation — not an import of it. Root `src/` must not
 * import from `editor-cli/`; the dependency runs the other way (`editor-cli`
 * depends on root `src/`, never the reverse), so importing would invert it.
 * Duplicating one `process.env.EDITOR_PAYLOAD_ROOT` read is the correct
 * trade against that. Keep the validation rules identical to the sibling
 * implementation — emptiness is tested with `raw.trim() === ''`, but the
 * value that's validated and used is `raw` itself, UNTRIMMED — so the same
 * env var behaves the same way regardless of which module reads it.
 *
 * Do not reintroduce `.trim()` on `raw` before validating/using it. A
 * directory name with a leading or trailing space is legal on macOS and
 * Linux; trimming would silently rewrite such a path into a different one
 * that may not exist, and the failure that surfaces (a missing
 * `render-vue.mjs`) would point nowhere near the real cause. See
 * `payload-paths.ts`'s `payloadRoot()` doc comment for the full reasoning —
 * this function existed for a while with the trim still in place after that
 * one was fixed, which is exactly the divergence this comment exists to
 * prevent from happening again.
 */
function payloadIconPreviewDir(): string | null {
  const raw = process.env.EDITOR_PAYLOAD_ROOT
  if (raw === undefined) return null
  if (raw.trim() === '') return null
  if (!isAbsolute(raw)) {
    throw new Error(`EDITOR_PAYLOAD_ROOT must be an absolute path, got: ${JSON.stringify(raw)}`)
  }
  return resolve(raw, 'icon-preview')
}

/**
 * Ordered candidate directories to search for this module's sibling
 * renderer scripts (`render-vue.mjs`, …), given `here` — this file's own
 * resolved directory. Pure string math, no filesystem access, so a test can
 * pass a SIMULATED `here` (e.g. a fake `editor-cli/dist` directory) without
 * an actual bundle and assert what the candidate list looks like from
 * there — see {@link iconPreviewScriptPath} for why a candidate LIST, and
 * not a single computed path, is what this module needs.
 *
 * Exported for that test only; `iconPreviewScriptPath` is the real API.
 */
export function iconPreviewCandidateDirs(here: string): string[] {
  const candidates: string[] = []
  const payloadDir = payloadIconPreviewDir()
  if (payloadDir !== null) candidates.push(payloadDir)
  candidates.push(here)
  // Correct specifically when `here` is the DIST location this file bundles
  // to (`editor-cli/dist`, per the doc comment below): two pops reaches
  // `editor-cli/`'s parent (the repo root), then back down into the source
  // tree the script actually lives in. When `here` is instead the real
  // source directory (unbundled dev), this candidate is simply wrong and the
  // probe below never reaches it — candidate 2 already matched.
  candidates.push(resolve(here, '..', '..', 'src', 'editor', 'icon-preview'))
  return candidates
}

async function candidateFileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Find `<icon-preview dir>/<scriptFilename>` by probing
 * {@link iconPreviewCandidateDirs} for the actual file, first hit wins.
 *
 * **Why a probe, and not a computed path like `payload-paths.ts` uses.**
 * This module cannot know its own location once bundled — `import.meta.url`
 * collapses to the bundle's URL for every module the bundler pulls in, and
 * this one IS pulled in: `core.ts` → `icon-sets/auto-detect.ts` →
 * `adapters/icon-sets/npm-named-exports/index.ts` → here. The trick
 * `editor-cli/src/payload-paths.ts` uses — anchor on the repo root via a
 * FIXED walk-up count, because every location that resolves paths there sits
 * at the SAME depth under `editor-cli/` (`src/payload-paths.ts` and
 * `dist/cli.js` are both one segment down) — does not transfer here, because
 * this file does NOT sit at one fixed depth. Unbundled, it runs from
 * `<repo>/src/editor/icon-preview/render.ts` (three segments below the repo
 * root). Bundled, it runs from `editor-cli/dist/cli.js` (one segment below
 * `editor-cli/`). No single walk-up count is correct from both — so instead
 * of computing where the file OUGHT to be, this checks where it ACTUALLY IS:
 * try the directories it could plausibly be under, in priority order, and
 * use whichever one has it.
 *
 * A candidate that doesn't exist is expected, not a bug — the earlier
 * `iconPreviewDir()` implementation this replaced computed exactly one
 * candidate (the `HERE`-relative one) and returned it unconditionally,
 * so a bundled-in-checkout run silently pointed at a directory with no
 * `render-vue.mjs` in it, `loadPreviews()` caught the resulting spawn
 * failure, and the user saw placeholder icons with nothing louder than a
 * console warning. Throwing here — listing every path tried — is strictly
 * better: still caught by the same call site, but with an error a developer
 * can act on instead of a silent degradation.
 */
export async function iconPreviewScriptPath(scriptFilename: string, here: string = HERE): Promise<string> {
  const dirs = iconPreviewCandidateDirs(here)
  for (const dir of dirs) {
    const candidate = resolve(dir, scriptFilename)
    if (await candidateFileExists(candidate)) return candidate
  }
  const tried = dirs.map((dir) => resolve(dir, scriptFilename))
  throw new Error(
    `icon preview renderer script "${scriptFilename}" was not found in any candidate location. Tried:\n` +
      tried.map((path) => `  ${path}`).join('\n'),
  )
}

export async function renderIconPreviews(
  input: RenderIconPreviewsInput,
): Promise<RenderIconPreviewsResult> {
  if (input.iconExports.length === 0) {
    return { previews: {}, failures: {} }
  }

  const sourceScript = input.scriptPath ?? (await scriptForFramework(input.framework))
  // Node ESM resolves `import(name)` relative to the importing file's
  // location, not the cwd. To make `import('@acme/icons')` and
  // `import('vue')` resolve against the prototype's installs, we
  // stage the renderer script inside the prototype's node_modules
  // cache so module-resolution walks up through the prototype's deps.
  const scriptPath = await stageScriptInsidePrototype(sourceScript, input.prototypeRoot)
  const timeoutMs = input.timeoutMs ?? 30_000

  return await new Promise<RenderIconPreviewsResult>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: input.prototypeRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let killed = false

    const timeout = setTimeout(() => {
      killed = true
      child.kill('SIGTERM')
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`icon preview renderer failed to spawn: ${err.message}`))
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (killed) {
        reject(new Error(`icon preview renderer timed out after ${timeoutMs}ms (stderr: ${stderr.slice(0, 200)})`))
        return
      }
      if (code !== 0) {
        reject(
          new Error(
            `icon preview renderer exited with code ${code} (stderr: ${stderr.slice(0, 500)})`,
          ),
        )
        return
      }
      try {
        const parsed = JSON.parse(stdout) as RenderIconPreviewsResult
        resolvePromise({
          previews: parsed.previews ?? {},
          failures: parsed.failures ?? {},
        })
      } catch (err) {
        reject(
          new Error(
            `icon preview renderer produced invalid JSON: ${err instanceof Error ? err.message : String(err)} (stdout head: ${stdout.slice(0, 200)})`,
          ),
        )
      }
    })

    const payload = JSON.stringify({
      packageName: input.packageName,
      iconExports: input.iconExports,
    })
    child.stdin.end(payload)
  })
}

/**
 * Copy the renderer script into the prototype's node_modules cache so
 * that ESM `import()` from inside the script resolves against the
 * prototype's installed packages (`@acme/icons`, `vue`, …) rather than
 * editor's own node_modules. Returns the staged path. Idempotent:
 * re-copies on every call so edits to the source script during dev
 * propagate (cost is negligible).
 */
async function stageScriptInsidePrototype(
  sourceScript: string,
  prototypeRoot: string,
): Promise<string> {
  const cacheDir = join(prototypeRoot, 'node_modules', '.cache', 'desde-icon-preview')
  await fs.mkdir(cacheDir, { recursive: true })
  const stagedPath = join(cacheDir, basename(sourceScript))
  const contents = await fs.readFile(sourceScript)
  await fs.writeFile(stagedPath, contents)
  return stagedPath
}

async function scriptForFramework(framework: FrameworkId | 'any'): Promise<string> {
  switch (framework) {
    case 'vue3':
      return iconPreviewScriptPath('render-vue.mjs')
    case 'react':
      throw new Error(
        'icon preview renderer for React is not implemented yet (Phase 3). ' +
          'See tasks/_archive/one-shot-tasks/icon-picker.md.',
      )
    case 'any':
      throw new Error(
        'icon preview renderer requires a concrete framework; sets with `framework: "any"` ' +
          'must supply previews through their own pipeline.',
      )
    default:
      throw new Error(`icon preview renderer has no implementation for framework "${framework}"`)
  }
}

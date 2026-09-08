/**
 * Tier 2 LLM-assisted-repair handler for the editor-cli HTTP server
 * (`POST /api/editor/llm-fallback`). Input validation,
 * path-containment checks, and response shape for the repair lane:
 * reads the source for the failed edit, calls `applyRepairEdit`,
 * returns the LLM's proposed full-file rewrite. Bound through
 * `http-server.ts`.
 */

import { promises as fs } from "node:fs"
import path from "node:path"
import type { RepairIntent } from "../../../src/editor/edit-service/repair-edit-prompt"
import type {
  IterationDataIntent,
  IterationDataPromptFile,
} from "../../../src/editor/edit-service/iteration-data-prompt"
import type { ProjectKnowledgeConfig } from "../../../src/editor/edit-service/load-project-knowledge"
import type { CompletionProvider } from "../../../src/editor/llm-providers/types"
import {
  resolvePrototypeRoot,
  resolveCandidateWithinRoot,
  resolveRealpathWithinRoot,
  type ResolvedRoot,
} from "./resolve-editable-path"
import { resolveRelativeModule } from "./resolve-relative-module.js"
import { dormantLaneRefusal, type DormantLaneId } from "./enabled-lanes"

export interface LLMFallbackRequestBody {
  file: string
  intent: RepairIntent | IterationDataIntent
  /**
   * The applicator's refusal reason. Required for the structural-repair
   * kinds; ABSENT for `iteration-data`, whose client dispatches to this
   * lane directly when the static resolver soft-refuses (the 422 reason
   * never leaves the static endpoint).
   */
  errorReason?: string
}

export interface LLMFallbackResult {
  status: number
  ok: boolean
  reason?: string
  /**
   * Iteration lane only. `unavailable` means the model never ran (no
   * credentials, transport failure); `refused` means it ran and declined.
   * The client shows the deterministic resolver's reason for the first and
   * the model's for the second — a lane that never ran cannot supply one.
   */
  kind?: "unavailable" | "refused"
  proposal?: {
    newSource: string
    explanation?: string
    /** SHA-256 of original source — Phase E guard at commit time. */
    baseHash?: string
    /**
     * Which file the rewrite targets. Set by the iteration-data lane, whose
     * cross-component case rewrites the PAGE file rather than the template
     * file the click landed in; the client falls back to the template file
     * when absent.
     */
    file?: string
  }
}

export interface LLMFallbackLoaders {
  loadApplyRepairEdit: () => Promise<
    typeof import("../../../src/editor/edit-service/repair-edit")
  >
  /**
   * Loads the project-knowledge digest (the prototype repo's documented
   * conventions). Optional — when unconfigured the repair runs without the
   * conventions block.
   */
  loadProjectKnowledge?: () => Promise<
    typeof import("../../../src/editor/edit-service/load-project-knowledge")
  >
  /**
   * Loads the iteration-data LLM lane. Optional for the same dynamic-import
   * reason as the others; an `iteration-data` request with no loader
   * configured is a 500 naming the gap, mirroring the JSX flatten shape in
   * edit-handler.ts.
   */
  loadApplyIterationDataLlm?: () => Promise<
    typeof import("../../../src/editor/edit-service/iteration-data-llm")
  >
}

/**
 * File extensions the repair lane can rewrite. `.vue` goes through the Vue-SFC
 * repair prompt; `.tsx`/`.jsx` through the React/JSX prompt (selected by
 * `buildRepairPrompt` on the file extension). The applied rewrite is validated
 * per-framework by `validateOverwriteSource` in the edit-handler's overwrite lane.
 */
function isRepairableSource(filePath: string): boolean {
  return (
    filePath.endsWith(".vue") ||
    filePath.endsWith(".tsx") ||
    filePath.endsWith(".jsx")
  )
}

const ALLOWED_INTENT_KINDS: ReadonlySet<RepairIntent["kind"]> = new Set([
  "move",
  "delete",
  "detach",
  "insert",
  "swap",
  "unwrap",
  "flatten-conditional",
])

function validate(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Body must be an object"
  const b = body as Record<string, unknown>
  if (typeof b.file !== "string" || b.file.length === 0) return "body.file required"
  const intent = b.intent as Record<string, unknown> | undefined
  if (!intent || typeof intent !== "object") return "body.intent required"
  if (intent.kind === "iteration-data") {
    // The iteration lane's client dispatches here directly when the static
    // resolver soft-refuses; there is no applicator errorReason to carry.
    if (typeof intent.description !== "string" || intent.description.length === 0) {
      return "body.intent.description required"
    }
    const tloc = intent.templateLocation as Record<string, unknown> | undefined
    if (
      !tloc ||
      typeof tloc.file !== "string" ||
      typeof tloc.line !== "number" ||
      typeof tloc.column !== "number"
    ) {
      return "body.intent.templateLocation must carry file, line and column"
    }
    const iter = intent.iterationContext as Record<string, unknown> | undefined
    if (!iter || typeof iter !== "object") return "body.intent.iterationContext required"
    const payload = intent.payload as Record<string, unknown> | undefined
    if (!payload || typeof payload.operation !== "string") {
      return "body.intent.payload.operation required"
    }
    return null
  }
  if (typeof b.errorReason !== "string" || b.errorReason.length === 0) {
    return "body.errorReason required"
  }
  if (
    typeof intent.kind !== "string" ||
    !ALLOWED_INTENT_KINDS.has(intent.kind as RepairIntent["kind"])
  ) {
    return `body.intent.kind must be one of ${[...ALLOWED_INTENT_KINDS].join(" | ")}`
  }
  if (typeof intent.description !== "string" || intent.description.length === 0) {
    return "body.intent.description required"
  }
  // Lines are 1-based in both frameworks; columns are 1-based for Vue but
  // 0-based for React/JSX (Babel `loc.start.column`), so a column-0 element
  // (top-level, no indentation) is valid and must not 400 here.
  for (const name of ["sourceLine", "destParentLine"] as const) {
    const v = intent[name]
    if (v === undefined) continue
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      return `body.intent.${name} must be a positive integer when provided`
    }
  }
  for (const name of ["sourceColumn", "destParentColumn"] as const) {
    const v = intent[name]
    if (v === undefined) continue
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      return `body.intent.${name} must be a non-negative integer when provided`
    }
  }
  if (
    intent.destIndex !== undefined &&
    (typeof intent.destIndex !== "number" || !Number.isInteger(intent.destIndex))
  ) {
    return "body.intent.destIndex must be an integer when provided"
  }
  return null
}

/**
 * Read one extra file for the iteration bundle, under the same guards as the
 * request's own `file`: lexically inside the root, a rewritable extension,
 * realpath inside the root. Any failure drops the file from the bundle
 * silently — the page hint is best-effort, and the model is told which files
 * it has.
 */
async function readBundleFile(
  relativePath: string,
  root: ResolvedRoot,
): Promise<IterationDataPromptFile | null> {
  const candidate = resolveCandidateWithinRoot(relativePath, root)
  if (!candidate.ok || !isRepairableSource(candidate.candidate)) return null
  if (hasNodeModulesSegment(candidate.candidate)) return null
  const real = await resolveRealpathWithinRoot(candidate.candidate, root)
  if (!real.ok || !isRepairableSource(real.targetPath)) return null
  // A dependency is never a page, and never a legal rewrite target. The
  // import chain refuses node_modules in `resolveRelativeModule`; the page
  // hint has to refuse it here or a hand-built request could bundle a
  // package's `.vue` and have the model rewrite it (codex round 1).
  if (hasNodeModulesSegment(real.targetPath)) return null
  try {
    return {
      path: path.relative(root.rootReal, real.targetPath).split(path.sep).join("/"),
      source: await fs.readFile(real.targetPath, "utf8"),
    }
  } catch {
    return null
  }
}

function hasNodeModulesSegment(p: string): boolean {
  return p.split(path.sep).includes("node_modules")
}

/**
 * The name of the list the loop iterates, read from the LOOP FILE at the
 * template location by the same resolver the deterministic lane uses. This
 * is deliberately not `intent.iterationContext.expression`: the bridge sends
 * that as null for every native-element loop (`tracer-attribution.ts`), so a
 * chain keyed on it would never be built in real use, and a hand-built
 * request could set it to any other import in the file and have that file
 * bundled as a rewrite target (codex round 1, both). Null when the loop
 * itself cannot be found: the bundle is then just the loop file (and page).
 */
async function iterateeRootOfLoop(
  relativePath: string,
  source: string,
  templateLocation: { line: number; column: number },
): Promise<string | null> {
  const isJsx = relativePath.endsWith(".tsx") || relativePath.endsWith(".jsx")
  if (isJsx) {
    const { resolveIterationDataJsxSameFile } = await import(
      "../../../src/editor/edit-service/resolve-iteration-data-jsx.js"
    )
    const r = resolveIterationDataJsxSameFile({ source, templateLocation })
    return r.iterateeRoot ?? null
  }
  const { resolveIterationDataVueSameFile } = await import(
    "../../../src/editor/edit-service/resolve-iteration-data-vue.js"
  )
  const r = resolveIterationDataVueSameFile({ source, templateLocation })
  return r.iterateeRoot ?? null
}

export async function handleLLMFallback(
  body: LLMFallbackRequestBody,
  repoRoot: string,
  loaders: LLMFallbackLoaders,
  conventions?: ProjectKnowledgeConfig,
  enabledLanes?: ReadonlySet<DormantLaneId>,
  getLlmProvider?: () => CompletionProvider,
): Promise<LLMFallbackResult> {
  // No API-key gate here — the provider registry falls back to whichever
  // provider `resolveLlmConfig` names for this project (the Claude Agent SDK,
  // via the bundled `claude` binary's subscription auth, when that's the
  // resolved provider and no API key is set). If the resolved provider has
  // neither a key nor a logged-in `claude`, the call itself fails with a
  // useful auth error rather than a stale "no env var" message.
  const validation = validate(body)
  if (validation) return { status: 400, ok: false, reason: validation }

  // The repair lane is the SECOND dispatch surface for a structural edit kind:
  // it takes the same `intent.kind` and returns an LLM full-file rewrite when
  // the deterministic applicator refused. Gating only `POST /api/editor/edit`
  // would leave a dormant lane reachable here — and reachable in its most
  // permissive form, since this path rewrites the whole file rather than
  // splicing at a coordinate. Same fail-closed default as the edit handler.
  const laneRefusal = dormantLaneRefusal(body.intent.kind, enabledLanes)
  if (laneRefusal) return { status: 400, ok: false, reason: laneRefusal }

  const rootResolution = await resolvePrototypeRoot(repoRoot)
  if (!rootResolution.ok) return rootResolution
  const { rootReal } = rootResolution
  const candidateResolution = resolveCandidateWithinRoot(body.file, rootResolution)
  if (!candidateResolution.ok) return candidateResolution
  const { candidate } = candidateResolution
  if (!isRepairableSource(candidate)) {
    return {
      status: 400,
      ok: false,
      reason: "Only .vue, .tsx, and .jsx files are supported",
    }
  }
  const realpathResolution = await resolveRealpathWithinRoot(candidate, rootResolution)
  if (!realpathResolution.ok) return realpathResolution
  const { targetPath } = realpathResolution
  if (!isRepairableSource(targetPath)) {
    return {
      status: 400,
      ok: false,
      reason: "Resolved target is not a .vue, .tsx, or .jsx file",
    }
  }
  // Both lanes here return a FULL-FILE rewrite of `file`. A dependency is
  // never a legal target: the write broker would refuse it at save time, but
  // by then the file has been shown to the model and the user has a
  // proposal that cannot land (codex round 2). Same wording rule as the edit
  // handler: the designer reads this, so name the package, not the directory.
  if (hasNodeModulesSegment(candidate) || hasNodeModulesSegment(targetPath)) {
    return {
      status: 400,
      ok: false,
      reason: "This file belongs to an installed library, which the Editor does not edit",
    }
  }

  let source: string
  try {
    source = await fs.readFile(targetPath, "utf8")
  } catch (err) {
    return {
      status: 404,
      ok: false,
      reason: `Could not read file: ${(err as Error).message}`,
    }
  }

  let projectKnowledge:
    | import("../../../src/editor/core/project-knowledge").ProjectKnowledge
    | undefined
  if (
    loaders.loadProjectKnowledge &&
    conventions?.useRepoConventions !== false
  ) {
    const { loadCachedProjectKnowledge } = await loaders.loadProjectKnowledge()
    projectKnowledge = loadCachedProjectKnowledge({
      prototypeRoot: rootReal,
      excludeFiles: conventions?.excludeFiles,
    })
  }

  const { applyRepairEdit } = await loaders.loadApplyRepairEdit()
  // Key the repair prompt off the RESOLVED target, not the requested `body.file`:
  // an allowed symlink whose suffix differs from its target (e.g. `Alias.vue` →
  // `App.tsx`) would otherwise send TSX bytes to the Vue SFC prompt. The resolved
  // relative path matches the bytes in `source` and is identical to `body.file`
  // in the common (non-symlink) case.
  const resolvedRelPath = path.relative(rootReal, targetPath)

  if (body.intent.kind === "iteration-data") {
    if (!loaders.loadApplyIterationDataLlm) {
      return {
        status: 500,
        ok: false,
        reason: "iteration-data LLM lane loader not configured",
      }
    }
    const intent = body.intent

    // The model is shown a BUNDLE and rewrites exactly one file of it: the
    // loop file first (where `templateLocation` points), the page that
    // renders it when known, and then the modules the iteratee's name is
    // imported from, followed hop by hop. Every path here has passed the
    // same containment guards as `body.file`; the lane refuses a response
    // naming any other file. One prompt serves Vue and JSX alike, so there
    // is no per-framework gate in front of this lane any more (the `.vue`
    // gate that stood here until 2026-09-08 is what the React demo hit).
    const files: IterationDataPromptFile[] = [{ path: resolvedRelPath, source }]
    const seen = new Set<string>([resolvedRelPath])
    const addFile = (file: IterationDataPromptFile | null): void => {
      if (!file || seen.has(file.path)) return
      seen.add(file.path)
      files.push(file)
    }

    if (intent.pageSourceFile && intent.pageSourceFile !== resolvedRelPath) {
      // The page hint comes from the client (the route's current source
      // file). It only becomes a legal rewrite target if it actually renders
      // the loop file — i.e. imports it. Any in-root rewritable file could
      // otherwise be claimed as "the page" and handed to the model as a file
      // it may overwrite (codex round 2).
      const page = await readBundleFile(intent.pageSourceFile, rootResolution)
      if (page) {
        const [{ importsRelativeFile }, { moduleSourceOfFile }] = await Promise.all([
          import("../../../src/editor/edit-service/import-binding.js"),
          import("../../../src/editor/edit-service/vue-script-content.js"),
        ])
        const pageModule = moduleSourceOfFile(page.path, page.source)
        if (importsRelativeFile(pageModule, page.path, resolvedRelPath)) addFile(page)
      }
    }

    const iterateeRoot = await iterateeRootOfLoop(
      resolvedRelPath,
      source,
      intent.templateLocation,
    )
    if (iterateeRoot) {
      const [{ collectImportChain }, { moduleSourceOfFile }] = await Promise.all([
        import("../../../src/editor/edit-service/import-binding.js"),
        import("../../../src/editor/edit-service/vue-script-content.js"),
      ])
      const chain = await collectImportChain({
        startPath: resolvedRelPath,
        startSource: source,
        name: iterateeRoot,
        resolve: async (fromPath, specifier) => {
          const mod = await resolveRelativeModule(
            path.resolve(rootReal, fromPath),
            specifier,
            rootResolution,
          )
          return mod.ok ? { path: mod.relativePath, source: mod.source } : null
        },
        moduleSourceOf: (file) => moduleSourceOfFile(file.path, file.source),
      })
      for (const file of chain) addFile(file)
    }

    const { applyIterationDataLlm } = await loaders.loadApplyIterationDataLlm()
    const iteration = await applyIterationDataLlm({
      files,
      intent,
      projectKnowledge,
      ...(getLlmProvider ? { resolveProvider: getLlmProvider } : {}),
    })
    if (!iteration.ok) {
      return { status: 422, ok: false, reason: iteration.reason, kind: iteration.kind }
    }
    return {
      status: 200,
      ok: true,
      proposal: {
        newSource: iteration.newSource,
        explanation: iteration.explanation,
        baseHash: iteration.originalSourceHash,
        // The file the MODEL chose out of the bundle — the data module, the
        // page, or the loop file itself. The client writes this path.
        file: iteration.file,
      },
    }
  }

  const result = await applyRepairEdit({
    source,
    file: resolvedRelPath,
    intent: body.intent,
    errorReason: body.errorReason as string,
    projectKnowledge,
    ...(getLlmProvider ? { resolveProvider: getLlmProvider } : {}),
  })
  if (!result.ok) {
    return { status: 422, ok: false, reason: result.reason }
  }
  return {
    status: 200,
    ok: true,
    proposal: {
      newSource: result.newSource,
      explanation: result.explanation,
      baseHash: result.originalSourceHash,
    },
  }
}

export const defaultLLMFallbackLoaders: LLMFallbackLoaders = {
  loadApplyRepairEdit: () => import("../../../src/editor/edit-service/repair-edit"),
  loadProjectKnowledge: () =>
    import("../../../src/editor/edit-service/load-project-knowledge"),
  loadApplyIterationDataLlm: () =>
    import("../../../src/editor/edit-service/iteration-data-llm"),
}

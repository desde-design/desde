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
import type { IterationDataIntent } from "../../../src/editor/edit-service/iteration-data-prompt"
import type { ProjectKnowledgeConfig } from "../../../src/editor/edit-service/load-project-knowledge"
import {
  resolvePrototypeRoot,
  resolveCandidateWithinRoot,
  resolveRealpathWithinRoot,
} from "./resolve-editable-path"
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

export async function handleLLMFallback(
  body: LLMFallbackRequestBody,
  repoRoot: string,
  loaders: LLMFallbackLoaders,
  conventions?: ProjectKnowledgeConfig,
  enabledLanes?: ReadonlySet<DormantLaneId>,
): Promise<LLMFallbackResult> {
  // No API-key gate here — the provider registry falls back to the
  // Claude Agent SDK (subscription auth via the bundled `claude`
  // binary) when ANTHROPIC_API_KEY is unset. If the user has neither
  // a key nor a logged-in `claude`, the SDK call itself fails with a
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
    // Vue only, for now, and the refusal is the honest outcome rather than a
    // limitation nobody stated.
    //
    // `isRepairableSource` above admits `.vue`, `.tsx` and `.jsx`, because the
    // REPAIR lane below handles all three and picks its prompt by extension.
    // This lane has one prompt, and it opens "You are a Vue 3 SFC
    // iteration-aware editor" and tells the model to find `v-for` and
    // `<script setup>`. Handing it TSX would not fail loudly: the likely
    // outcomes are a refusal the user cannot act on, or a rewrite of a file
    // the prompt misread, and this lane returns a FULL-FILE replacement.
    //
    // The repair lane two functions down already carries a comment about
    // keying its prompt off the resolved path so TSX bytes cannot reach the
    // Vue prompt. This lane shipped without the equivalent (found by a codex
    // review the same day). A React iteration prompt is the real fix and is
    // its own piece of work; until it exists, refusing beats guessing.
    if (!resolvedRelPath.endsWith(".vue")) {
      return {
        status: 422,
        ok: false,
        reason:
          "Editing an iteration as data is only supported in Vue single-file components right now. " +
          "Edit the array in the source file instead.",
      }
    }
    if (!loaders.loadApplyIterationDataLlm) {
      return {
        status: 500,
        ok: false,
        reason: "iteration-data LLM lane loader not configured",
      }
    }
    const { applyIterationDataLlm } = await loaders.loadApplyIterationDataLlm()
    const iteration = await applyIterationDataLlm({
      source,
      file: resolvedRelPath,
      intent: body.intent,
      projectKnowledge,
    })
    if (!iteration.ok) {
      return { status: 422, ok: false, reason: iteration.reason }
    }
    return {
      status: 200,
      ok: true,
      proposal: {
        newSource: iteration.newSource,
        explanation: iteration.explanation,
        baseHash: iteration.originalSourceHash,
        // Cross-component data edits rewrite the PAGE file, not the template
        // file the click landed in — the client prefers this declared path.
        file: resolvedRelPath,
      },
    }
  }

  const result = await applyRepairEdit({
    source,
    file: resolvedRelPath,
    intent: body.intent,
    errorReason: body.errorReason as string,
    projectKnowledge,
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

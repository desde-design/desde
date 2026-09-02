/**
 * Read-only endpoint backing the Editor UI's "project knowledge"
 * indicator. `GET /api/editor/project-knowledge` returns the digest the
 * edit/chat tiers would inject for the current repo, plus the effective
 * "Use repo conventions" config — so the shell can show "Following rules
 * from CLAUDE.md…", a truncation warning, or "Repo conventions: off".
 *
 * This mirrors how the four edit/chat handlers decide whether to ground the
 * LLM: when `useRepoConventions` is false, no digest is loaded and
 * `knowledge` is `null`; otherwise the digest is loaded with `excludeFiles`
 * applied. The loader is injected for testability, defaulting to the
 * in-tree `load-project-knowledge` module.
 *
 * SDK-runtime parity: the chat handler drops CLAUDE.md from the injected
 * digest because the SDK loads it natively via `settingSources: ['project']`
 * (see `chat-handler.ts`). This badge endpoint mirrors that so the indicator
 * reflects what the agent actually receives — otherwise it inlines
 * CLAUDE.md, counts it toward the size budget, and reports a truncation the
 * SDK agent never sees. `sdkRuntime` is surfaced so the UI can explain the
 * absence of CLAUDE.md rather than have it silently vanish.
 *
 * The SDK runtime is the CLI's only chat runtime (the legacy in-house
 * orchestrator was removed 2026-07-21), so `sdkRuntime` always defaults to
 * `true` — kept as a parameter for test injection.
 */

import type { ProjectKnowledgeConfig } from "../../../src/editor/edit-service/load-project-knowledge"

/**
 * Rule files the SDK runtime loads itself (via `settingSources: ['project']`)
 * rather than through the Editor digest. Kept in sync with the chat
 * handlers' SDK-mode exclusion. Surfaced to the UI as `nativeFiles` so a
 * CLAUDE.md-only repo still shows a grounding indicator in SDK mode instead
 * of the badge vanishing.
 */
export const SDK_NATIVE_RULE_FILES = ["CLAUDE.md"] as const

export interface ProjectKnowledgeLoaders {
  loadProjectKnowledge: () => Promise<
    typeof import("../../../src/editor/edit-service/load-project-knowledge")
  >
}

export const defaultProjectKnowledgeLoaders: ProjectKnowledgeLoaders = {
  loadProjectKnowledge: () =>
    import("../../../src/editor/edit-service/load-project-knowledge"),
}

export interface ProjectKnowledgeQueryResult {
  status: number
  body: unknown
}

/**
 * Resolve the project-knowledge digest for `repoRoot` under the given
 * `conventions` config. Never throws — discovery failures become a 500
 * with a reason so the indicator can degrade gracefully.
 *
 * `sdkRuntime` defaults to `true` (the CLI's only chat runtime) and is
 * injectable for tests. When true, CLAUDE.md is excluded from the loaded
 * digest so the truncation/size-budget reported here matches the digest
 * the SDK agent actually receives; the config `excludeFiles` echoed in the
 * body is left untouched so the UI's "Excluded by config" line stays correct.
 */
export async function handleProjectKnowledgeQuery(
  repoRoot: string,
  conventions: ProjectKnowledgeConfig | undefined,
  loaders: ProjectKnowledgeLoaders,
  sdkRuntime: boolean = true,
): Promise<ProjectKnowledgeQueryResult> {
  const useRepoConventions = conventions?.useRepoConventions !== false
  const excludeFiles = conventions?.excludeFiles ?? []

  if (!useRepoConventions) {
    return {
      status: 200,
      body: {
        ok: true,
        useRepoConventions: false,
        excludeFiles,
        sdkRuntime,
        nativeFiles: [],
        knowledge: null,
      },
    }
  }

  // SDK loads CLAUDE.md natively — keep it out of the budgeted digest so the
  // reported truncation reflects what the agent's digest actually contains.
  const digestExcludes = sdkRuntime
    ? [...excludeFiles, ...SDK_NATIVE_RULE_FILES]
    : excludeFiles

  try {
    const { loadCachedProjectKnowledge } = await loaders.loadProjectKnowledge()
    const knowledge = loadCachedProjectKnowledge({
      prototypeRoot: repoRoot,
      excludeFiles: digestExcludes,
    })
    // In SDK mode, detect which native rule files the repo actually has (and
    // weren't config-excluded) from the full digest — config excludes are
    // already applied, so a config-excluded CLAUDE.md won't appear here. Lets
    // the UI list them as "loaded by the agent" instead of vanishing.
    const nativeFiles = sdkRuntime
      ? presentNativeFiles(
          loadCachedProjectKnowledge({ prototypeRoot: repoRoot, excludeFiles }),
        )
      : []
    return {
      status: 200,
      body: {
        ok: true,
        useRepoConventions: true,
        excludeFiles,
        sdkRuntime,
        nativeFiles,
        knowledge,
      },
    }
  } catch (err) {
    return {
      status: 500,
      body: {
        ok: false,
        reason: `Failed to load project knowledge: ${(err as Error).message}`,
      },
    }
  }
}

/** Native rule files (e.g. CLAUDE.md) actually present in the full digest. */
function presentNativeFiles(full: {
  rulesFiles: readonly { path: string }[]
}): string[] {
  const present = new Set(full.rulesFiles.map((f) => f.path))
  return SDK_NATIVE_RULE_FILES.filter((p) => present.has(p))
}

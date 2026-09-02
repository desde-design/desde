/**
 * Load a prototype's `ProjectKnowledge` digest — the editor-side entry
 * point, analogous to `load-style-grounding.ts` and
 * `build-manifest-source.ts`. Composes the registered
 * `ProjectKnowledgeSource`s (today just `ConventionalRulesSource`) and
 * returns the merged digest.
 *
 * `loadProjectKnowledge` is pure (filesystem read, no caching) so tests can
 * exercise discovery against a temp tree without cache surprises. Route
 * handlers use `loadCachedProjectKnowledge`, which memoizes per
 * `prototypeRoot` for the process lifetime — the digest only changes when
 * the repo's rules / docs files change, which is rare next to the per-save
 * edit cadence.
 */

import * as fs from 'fs'
import { ConventionalRulesSource } from '../adapters/conventional-rules'
import type { ProjectKnowledge } from '../core/project-knowledge'

/**
 * The project's "Use repo conventions" config — the off-switch + exclusion
 * list. Sourced from `.desde/config.json` (`conventions` section) by
 * the editor-cli handlers (the only editor surface — the web Next.js
 * routes were deleted 2026-06-04, see tasks/web-editor-removal.md). When
 * `useRepoConventions` is `false`, the handlers skip digest loading
 * entirely (this type is informational for them).
 */
export interface ProjectKnowledgeConfig {
  /** Whether to ground the Editor's AI tiers in repo conventions. Default true. */
  useRepoConventions?: boolean
  /** Repo-relative POSIX paths to exclude from discovery. */
  excludeFiles?: readonly string[]
}

export interface LoadProjectKnowledgeOptions {
  /** Absolute path to the prototype root. */
  prototypeRoot: string
  /** Repo-relative POSIX paths to exclude from discovery (rules + docs). */
  excludeFiles?: readonly string[]
}

/** Run discovery against the prototype tree. No caching — see module docs. */
export function loadProjectKnowledge(
  opts: LoadProjectKnowledgeOptions,
): ProjectKnowledge {
  // One source today. When a second lands (e.g. a remote-hosted rules
  // source for the served/production path), merge here: concat rulesFiles
  // in priority order, re-run `assembleRulesDigest`, union the docs.
  const source = new ConventionalRulesSource()
  return source.discover({
    prototypeRoot: opts.prototypeRoot,
    excludeFiles: opts.excludeFiles,
  })
}

let cacheKey: string | null = null
let cached: ProjectKnowledge | null = null

/**
 * Cached variant — computes once per prototype root for the process
 * lifetime. The editor-cli handlers (`edit-handler.ts`,
 * `llm-fallback-handler.ts`, `chat-handler.ts`, `project-knowledge-handler.ts`,
 * and `create-grounding-service.ts`) use this so the digest's filesystem
 * walk doesn't run on every save.
 *
 * The cache key is the *realpath* of `prototypeRoot` plus the (sorted)
 * `excludeFiles` set, so callers that pass a raw path and callers that pass
 * an already-realpath'd one resolve to the same entry for the same physical
 * repo + exclusion set, and a changed exclusion list never returns a stale
 * digest. JSON-array encoding keeps the key collision-free without a
 * delimiter that could appear in a path.
 *
 * Staleness note: this is a process-lifetime cache, matching the CLI edit
 * handler's module-level `ProjectStyleContext` memo. Editing the repo's
 * rules / docs files
 * mid-session does not take effect until the server restarts — the
 * documented refresh. Phase 2's deploy-time extraction (keyed by
 * `commitSha`) handles freshness for the served/production path.
 */
export function loadCachedProjectKnowledge(
  opts: LoadProjectKnowledgeOptions,
): ProjectKnowledge {
  let rootKey: string
  try {
    rootKey = fs.realpathSync(opts.prototypeRoot)
  } catch {
    // Root missing / unreadable — discovery will return an empty digest
    // anyway; key on the raw path so a later valid call still caches.
    rootKey = opts.prototypeRoot
  }
  const canonicalKey = JSON.stringify([
    rootKey,
    [...(opts.excludeFiles ?? [])].sort(),
  ])
  if (cacheKey === canonicalKey && cached) return cached
  const knowledge = loadProjectKnowledge(opts)
  cacheKey = canonicalKey
  cached = knowledge
  return knowledge
}

/** Test hook — drop the cache so a test can re-run discovery on a mutated tree. */
export function __clearProjectKnowledgeCache(): void {
  cacheKey = null
  cached = null
}

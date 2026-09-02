/**
 * Project Knowledge — a prototype repo's own documented conventions
 * (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `docs/`, `README.md`) surfaced
 * to the Editor's AI editing tiers so generated edits respect what the
 * project already documents about itself.
 *
 * Parallel to `ComponentManifestSource` and `ProjectStyleContext`: a named
 * interface with one concrete impl per discovery convention. Deliberately
 * NOT hardcoded to a single filename — a React + Material UI prototype that
 * keeps its rules in `AGENTS.md` is picked up by the same source.
 *
 * This module is pure: types, the interface, and a pure digest assembler.
 * Filesystem discovery lives in the adapter (`adapters/conventional-rules`);
 * prompt rendering (which wraps the digest in an untrusted-source fence)
 * lives in `edit-service/render-project-knowledge.ts`. Keeping `editor/
 * core` dependency-free mirrors the rest of the directory.
 */

/** Byte budget for the concatenated `rules` digest. ~16k chars ≈ ~4k tokens. */
export const RULES_DIGEST_BUDGET = 16_000

/**
 * Minimum body chars worth inlining. When less than this much budget is
 * left, the remaining (lower-priority) files are dropped rather than
 * emitted as near-empty stub sections.
 */
const MIN_SECTION_BODY = 200

/** Appended to a file's body when it had to be cut to fit the budget. */
const TRUNCATION_MARKER = '\n\n…[truncated to fit the rules-digest budget]'

/** A documentation file discovered but NOT inlined — indexed for retrieval. */
export interface DocEntry {
  /** Repo-relative path, POSIX separators. */
  path: string
  /** First markdown heading in the file, or the basename when none. */
  title: string
}

/** Provenance for one rules file that contributed to the digest. */
export interface RulesFileRef {
  /** Repo-relative path, POSIX separators. */
  path: string
  /**
   * Char length this file's section contributed to the digest — the
   * inter-section separator (for every file after the first) plus the path
   * header plus the (possibly truncated) body.
   */
  chars: number
  /** True when this file's body was cut to fit the budget. */
  truncated: boolean
}

/**
 * The digest handed to the Editor's editing tiers. `rules` is inlined into
 * prompts wholesale; `docIndex` is retrieval-only — the chat agent can
 * `read_file` those paths, the single-shot tiers just see that they exist.
 */
export interface ProjectKnowledge {
  /** Concatenated, budget-capped rules-file contents. `''` when none found. */
  rules: string
  /** Per-file provenance for everything that contributed to `rules`. */
  rulesFiles: readonly RulesFileRef[]
  /** Docs discovered but not inlined. */
  docIndex: readonly DocEntry[]
  /** True when the digest hit the budget — a file was cut or dropped. */
  truncated: boolean
}

/** The shape callers get when discovery finds nothing. */
export const EMPTY_PROJECT_KNOWLEDGE: ProjectKnowledge = {
  rules: '',
  rulesFiles: [],
  docIndex: [],
  truncated: false,
}

export interface ProjectKnowledgeQuery {
  /** Absolute path to the prototype root. */
  prototypeRoot: string
  /**
   * Repo-relative POSIX paths to exclude from discovery — both rules
   * files and doc-index entries. Sourced from the project's "Use repo
   * conventions" config (`conventions.excludeFiles`). Empty / omitted =
   * exclude nothing.
   */
  excludeFiles?: readonly string[]
}

/**
 * Discovers a prototype's project-knowledge digest. One concrete impl per
 * discovery convention (today: `ConventionalRulesSource`).
 */
export interface ProjectKnowledgeSource {
  /** Stable id, for provenance / logging. */
  readonly id: string
  discover(query: ProjectKnowledgeQuery): ProjectKnowledge
}

/** One rules file, in priority order (earlier = kept first under budget pressure). */
export interface RulesFileInput {
  /** Repo-relative path, POSIX separators. */
  path: string
  /** Raw file content. Callers should drop empty / whitespace-only files. */
  content: string
}

/**
 * Assemble the rules digest from priority-ordered files, enforcing
 * `RULES_DIGEST_BUDGET`. Files are concatenated in order; when the budget is
 * exhausted the current file is truncated (with a marker) and every
 * lower-priority file is dropped. Pure — no I/O.
 */
export function assembleRulesDigest(
  files: readonly RulesFileInput[],
  budget: number = RULES_DIGEST_BUDGET,
): { rules: string; rulesFiles: RulesFileRef[]; truncated: boolean } {
  const sections: string[] = []
  const rulesFiles: RulesFileRef[] = []
  let used = 0
  let truncated = false

  for (const file of files) {
    const separator = sections.length > 0 ? '\n\n' : ''
    const header = `----- ${file.path} -----\n`
    const overhead = separator.length + header.length
    const remaining = budget - used

    let body = file.content
    let fileTruncated = false

    if (overhead + body.length > remaining) {
      // The whole file does not fit. Truncate it — but only when there is
      // room for a meaningful chunk; otherwise drop it (and every
      // lower-priority file after it). A small file that *does* fit whole
      // skips this branch entirely and is kept regardless of how little
      // budget remains.
      if (remaining < overhead + MIN_SECTION_BODY) {
        truncated = true
        break
      }
      const bodyBudget = remaining - overhead
      body =
        body.slice(0, Math.max(0, bodyBudget - TRUNCATION_MARKER.length)) +
        TRUNCATION_MARKER
      fileTruncated = true
      truncated = true
    }

    const section = separator + header + body
    sections.push(section)
    used += section.length
    rulesFiles.push({
      path: file.path,
      chars: section.length,
      truncated: fileTruncated,
    })

    // A truncated file means the budget is exhausted — nothing left for
    // the rest.
    if (fileTruncated) break
  }

  return { rules: sections.join(''), rulesFiles, truncated }
}

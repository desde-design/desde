/**
 * `ConventionalRulesSource` — discovers a prototype's documented conventions
 * from the filenames the ecosystem already uses for agent / AI rules. The
 * one concrete `ProjectKnowledgeSource` shipped today.
 *
 * Rules files (inlined into the digest, priority order — earlier wins under
 * budget pressure):
 *   1. CLAUDE.md
 *   2. AGENTS.md
 *   3. .cursorrules
 *   4. .windsurfrules
 *   5. .github/copilot-instructions.md
 *   6. .cursor/rules/*.{md,mdc}   (sorted by filename, lowest priority)
 *
 * Docs (indexed only — retrieval-only, never inlined):
 *   - README.md at the repo root
 *   - docs/**\/*.{md,mdx}
 *
 * Synchronous filesystem access, mirroring `loadStyleGrounding`. The
 * walk is scoped: known rule paths are resolved directly, and only
 * `.cursor/rules` and `docs/` are enumerated — the whole tree is never
 * walked.
 *
 * Security: the prototype repo can be adversarial. Every path is
 * `realpathSync`'d and checked for containment under the (realpath'd)
 * prototype root *before* it is read or enumerated — so a symlinked
 * `CLAUDE.md` or `docs/` entry pointing at `/etc/passwd` is rejected, not
 * inlined into an LLM prompt. Reads are bounded (`MAX_FILE_BYTES` via a
 * head-only `readSync`) and the `.cursor/rules` enumeration is count-capped,
 * so a pathological repo cannot OOM or stall the server.
 */

import * as fs from 'fs'
import * as path from 'path'
import {
  assembleRulesDigest,
  EMPTY_PROJECT_KNOWLEDGE,
  type DocEntry,
  type ProjectKnowledge,
  type ProjectKnowledgeQuery,
  type ProjectKnowledgeSource,
  type RulesFileInput,
} from '../../core/project-knowledge'

/**
 * Per-file hard cap on bytes read into memory. A rules file larger than
 * this is pathological; only the head is read and the digest assembler
 * truncates further.
 */
const MAX_FILE_BYTES = 1_000_000

/** Cap on the number of non-empty `.cursor/rules` files inlined. */
const MAX_CURSOR_RULES_FILES = 50

/**
 * Cap on the number of `.cursor/rules` entries *read* (vs. inlined) — so a
 * directory full of empty `.md` files cannot trigger thousands of reads
 * before the inline cap is reached.
 */
const MAX_CURSOR_RULES_SCANNED = 200

/** Depth + count caps for the `docs/` enumeration — defensive bounds. */
const DOCS_SCAN_DEPTH = 8
const MAX_DOC_ENTRIES = 200

/** Repo-root rules files, in priority order (earlier = higher priority). */
const ROOT_RULES_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  '.windsurfrules',
  '.github/copilot-instructions.md',
] as const

const CURSOR_RULES_DIR = '.cursor/rules'
const CURSOR_RULES_EXT = /\.mdc?$/i

const DOCS_DIR = 'docs'
const DOC_EXT = /\.mdx?$/i

/** First ATX-style markdown heading (`#`..`######`) on any line. */
const HEADING_RE = /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m

export class ConventionalRulesSource implements ProjectKnowledgeSource {
  readonly id = 'conventional-rules'

  discover({ prototypeRoot, excludeFiles }: ProjectKnowledgeQuery): ProjectKnowledge {
    // Anchor every subsequent containment check on the realpath'd root.
    let rootReal: string
    try {
      rootReal = fs.realpathSync(path.resolve(prototypeRoot))
    } catch {
      // Root missing / unreadable — nothing to discover.
      return EMPTY_PROJECT_KNOWLEDGE
    }
    const rootWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep

    // Repo-relative POSIX paths the project config asked to exclude.
    // Normalized so config authors don't have to be byte-exact — Windows
    // separators, duplicate slashes, leading `./` or `/`, and trailing
    // slashes are all folded to the same canonical form the discovered
    // paths use. A non-matching entry (e.g. `../escape`) is harmless: it
    // simply excludes nothing. Applied to rules files AND doc-index entries.
    const excluded = new Set(
      (excludeFiles ?? []).map(normalizeExcludePath).filter((p) => p.length > 0),
    )
    const isExcluded = (rel: string): boolean => excluded.has(rel)

    const ruleInputs: RulesFileInput[] = []

    // 1. Root-level rules files, in declared priority order.
    for (const rel of ROOT_RULES_FILES) {
      if (isExcluded(rel)) continue
      const content = readContainedFile(rel, rootReal, rootWithSep)
      if (content !== null && content.trim().length > 0) {
        ruleInputs.push({ path: rel, content })
      }
    }

    // 2. .cursor/rules/*.{md,mdc} — sorted by filename for determinism,
    //    appended after the root files (lowest priority). Two independent
    //    caps: `MAX_CURSOR_RULES_FILES` bounds the *non-empty* files
    //    inlined; `MAX_CURSOR_RULES_SCANNED` bounds the files *read*, so a
    //    directory of empty `.md` files can't trigger unbounded reads. If
    //    either cap is hit with eligible names left over, the digest is
    //    marked truncated so provenance doesn't claim completeness.
    const cursorRuleNames = listFiles(CURSOR_RULES_DIR, rootReal, rootWithSep)
      .filter((name) => CURSOR_RULES_EXT.test(name))
      .sort()
    let cursorRulesTruncated = false
    let cursorInlined = 0
    let cursorScanned = 0
    for (const name of cursorRuleNames) {
      const rel = `${CURSOR_RULES_DIR}/${name}`
      // Excluded files don't burn the scan/inline budget.
      if (isExcluded(rel)) continue
      if (
        cursorInlined >= MAX_CURSOR_RULES_FILES ||
        cursorScanned >= MAX_CURSOR_RULES_SCANNED
      ) {
        cursorRulesTruncated = true
        break
      }
      cursorScanned++
      const content = readContainedFile(rel, rootReal, rootWithSep)
      if (content !== null && content.trim().length > 0) {
        ruleInputs.push({ path: rel, content })
        cursorInlined++
      }
    }

    const digest = assembleRulesDigest(ruleInputs)
    const { rules, rulesFiles } = digest
    const truncated = digest.truncated || cursorRulesTruncated

    // 3. Docs index — retrieval-only. Root README + docs/** markdown.
    const docIndex: DocEntry[] = []
    if (!isExcluded('README.md')) {
      const rootReadme = readContainedFile('README.md', rootReal, rootWithSep)
      if (rootReadme !== null) {
        docIndex.push({
          path: 'README.md',
          title: firstHeading(rootReadme, 'README.md'),
        })
      }
    }
    collectDocs(DOCS_DIR, DOCS_SCAN_DEPTH, rootReal, rootWithSep, isExcluded, docIndex)

    return { rules, rulesFiles, docIndex, truncated }
  }
}

/**
 * Resolve `relPosix` (POSIX-relative to the prototype root) to a realpath
 * and verify it stays inside the root. Returns the resolved absolute path,
 * or `null` when it is missing or escapes the root via a symlink.
 */
function containedRealPath(
  relPosix: string,
  rootReal: string,
  rootWithSep: string,
): string | null {
  const candidate = path.join(rootReal, ...relPosix.split('/'))
  let real: string
  try {
    real = fs.realpathSync(candidate)
  } catch {
    return null
  }
  if (real !== rootReal && !real.startsWith(rootWithSep)) return null
  return real
}

/**
 * Read a contained file as UTF-8, head-capped at `MAX_FILE_BYTES`. Returns
 * `null` when the path is missing, escapes the root, or is not a regular
 * file.
 */
function readContainedFile(
  relPosix: string,
  rootReal: string,
  rootWithSep: string,
): string | null {
  const real = containedRealPath(relPosix, rootReal, rootWithSep)
  if (real === null) return null

  let fd: number | null = null
  try {
    fd = fs.openSync(real, 'r')
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return null
    const len = Math.min(stat.size, MAX_FILE_BYTES)
    if (len <= 0) return ''
    const buf = Buffer.alloc(len)
    let offset = 0
    while (offset < len) {
      const read = fs.readSync(fd, buf, offset, len - offset, offset)
      if (read === 0) break
      offset += read
    }
    return buf.subarray(0, offset).toString('utf-8')
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* already closed / never opened */
      }
    }
  }
}

/**
 * List regular-file names directly under a contained directory. Returns
 * `[]` when the directory is missing or escapes the root.
 *
 * Note: `readdirSync` materializes the *entire* directory listing — the
 * caller's caps (`MAX_CURSOR_RULES_SCANNED`, `MAX_DOC_ENTRIES`) bound the
 * files *read* and *inlined*, not the enumeration itself. A directory with
 * an absurd number of entries still pays the readdir + sort cost. For a
 * git-cloned prototype repo that is not a realistic attack surface (the
 * clone would choke first); revisit with `opendirSync` streaming if a
 * repo-size threat model ever requires it.
 */
function listFiles(
  relPosix: string,
  rootReal: string,
  rootWithSep: string,
): string[] {
  const real = containedRealPath(relPosix, rootReal, rootWithSep)
  if (real === null) return []
  try {
    return fs
      .readdirSync(real, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * Fold a config-supplied exclusion path into the canonical repo-relative
 * POSIX form the discovered paths use: Windows separators → `/`, collapsed
 * duplicate slashes, leading `./` / `/` stripped, trailing `/` stripped.
 * Does not resolve `..` — a traversal entry just won't match any discovered
 * (always-repo-relative) path, which is the harmless no-op we want.
 */
function normalizeExcludePath(p: string): string {
  return p
    .replace(/\\/g, '/') // Windows separators → POSIX
    .replace(/\/+/g, '/') // collapse duplicate slashes
    .replace(/^(?:\.\/)+/, '') // strip leading `./` (repeated)
    .replace(/^\/+/, '') // strip leading `/`
    .replace(/\/+$/, '') // strip trailing `/`
}

/** First markdown heading in `content`, or the basename of `fallbackPath`. */
function firstHeading(content: string, fallbackPath: string): string {
  const m = HEADING_RE.exec(content)
  if (m) return m[1].trim()
  return path.posix.basename(fallbackPath)
}

/**
 * Recursively collect markdown docs under `relDir` (POSIX-relative to the
 * prototype root) into `out`. Depth- and count-bounded (`DOCS_SCAN_DEPTH`,
 * `MAX_DOC_ENTRIES`); skips dotfiles and `node_modules`; every directory
 * and file is realpath-contained before it is enumerated or read. Entries
 * are visited in sorted order for deterministic output.
 *
 * As with `listFiles`, the per-directory `readdirSync` materializes the
 * full listing — `MAX_DOC_ENTRIES` caps the indexed output, not the
 * enumeration cost of a single pathological directory.
 */
function collectDocs(
  relDir: string,
  depthLeft: number,
  rootReal: string,
  rootWithSep: string,
  isExcluded: (rel: string) => boolean,
  out: DocEntry[],
): void {
  if (depthLeft < 0 || out.length >= MAX_DOC_ENTRIES) return
  const dirReal = containedRealPath(relDir, rootReal, rootWithSep)
  if (dirReal === null) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirReal, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= MAX_DOC_ENTRIES) return
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const childRel = `${relDir}/${entry.name}`
    if (entry.isDirectory()) {
      collectDocs(childRel, depthLeft - 1, rootReal, rootWithSep, isExcluded, out)
    } else if (entry.isFile() && DOC_EXT.test(entry.name)) {
      if (isExcluded(childRel)) continue
      const content = readContainedFile(childRel, rootReal, rootWithSep)
      if (content === null) continue // missing or escapes the root
      out.push({ path: childRel, title: firstHeading(content, childRel) })
    }
  }
}

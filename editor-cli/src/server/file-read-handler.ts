import { promises as fs } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import {
  resolvePrototypeRoot,
  resolveCandidateWithinRoot,
  resolveRealpathWithinRoot,
} from "./resolve-editable-path"

/**
 * Read a single file from the prototype root for the in-app code editor.
 *
 * Scope match with the `overwrite` edit kind in edit-handler.ts: only
 * `.vue`, `.ts`, `.tsx`, and `.jsx` files are readable here, because those
 * are the only extensions the save path will accept. Letting the editor open
 * a `.css` or `.json` file just to refuse the save would be a confusing UX.
 *
 * Extension match is **case-sensitive** to mirror edit-handler.ts's
 * `.endsWith(...)` checks exactly — otherwise the read endpoint would accept
 * `Foo.VUE` but the save would reject it.
 *
 * Path-traversal guard mirrors the edit handler exactly: lexical resolve
 * + boundary check, then `realpath` + boundary check, then re-validate
 * the extension after symlink resolution so a `foo.vue` → `/etc/passwd`
 * symlink can't sneak through.
 *
 * The returned `sha` is SHA-256 hex of the on-disk contents. The editor
 * sends it back as `baseHash` on save so the existing overwrite-lane
 * conflict guard (edit-handler.ts:441–453) catches a concurrent write
 * between open and save.
 */

export interface FileReadResult {
  ok: boolean
  status: number
  reason?: string
  relativePath?: string
  content?: string
  sha?: string
}

function isAllowedExtension(p: string): boolean {
  return (
    p.endsWith(".vue") ||
    p.endsWith(".ts") ||
    p.endsWith(".tsx") ||
    p.endsWith(".jsx")
  )
}

export async function readPrototypeFile(
  repoRoot: string,
  relativePath: string | null,
): Promise<FileReadResult> {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return { ok: false, status: 400, reason: "`path` query parameter required" }
  }
  const rootResolution = await resolvePrototypeRoot(repoRoot)
  if (!rootResolution.ok) return rootResolution
  const { rootReal } = rootResolution
  const candidateResolution = resolveCandidateWithinRoot(relativePath, rootResolution)
  if (!candidateResolution.ok) return candidateResolution
  const { candidate } = candidateResolution
  if (!isAllowedExtension(candidate)) {
    return {
      ok: false,
      status: 400,
      reason: "Only .vue, .ts, .tsx, and .jsx files are supported",
    }
  }
  const realpathResolution = await resolveRealpathWithinRoot(candidate, rootResolution)
  if (!realpathResolution.ok) return realpathResolution
  const { targetPath: target } = realpathResolution
  if (!isAllowedExtension(target)) {
    return {
      ok: false,
      status: 400,
      reason: "Resolved target is not a .vue, .ts, .tsx, or .jsx file",
    }
  }
  let content: string
  try {
    content = await fs.readFile(target, "utf8")
  } catch (err) {
    return {
      ok: false,
      status: 404,
      reason: `Could not read file: ${(err as Error).message}`,
    }
  }
  const sha = createHash("sha256").update(content, "utf8").digest("hex")
  const rel = path.relative(rootReal, target)
  return { ok: true, status: 200, relativePath: rel, content, sha }
}

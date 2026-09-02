/**
 * Locate the prototype's router config file on disk — the shared I/O probe
 * behind both `scaffold_route` (register a new route) and route-enumeration
 * screenshot plans (read existing routes).
 *
 * Probes conventional locations (or an explicit path), requires EXACTLY ONE
 * that actually looks like a router config for the given `framework`, and
 * reads its source. Refuses on 0 / >1 matches so a caller never guess-operates
 * on the wrong file. Path resolution goes through {@link resolveRepoPath}
 * (realpath + traversal/symlink guard), so the returned absolute path is
 * always inside the repo root.
 *
 * `framework` defaults to `vue3` (back-compat with the original Vue-only
 * probe) and selects both the candidate location list and the cheap
 * pre-filter marker: Vue Router configs call `createRouter`; React Router
 * configs either call a `createBrowserRouter`-family function or declare a
 * `<Routes>` JSX block (see `scaffold-react-route.ts`'s `enumerateReactRoutes`
 * for what's parsed from the source this returns).
 *
 * Pure-ish: filesystem reads only, no writes. The framework-specific parsing
 * (Vue Router / React Router AST) lives in the pure planners
 * (`scaffold-vue-route.ts`, `scaffold-react-route.ts`).
 */

import { existsSync } from "node:fs"
import { readFile, realpath } from "node:fs/promises"
import { relative as pathRelative } from "node:path"
import { resolveRepoPath } from "./read-tools"

/** Conventional Vue Router config locations probed when no explicit path is given. */
export const ROUTER_FILE_CANDIDATES = [
  "src/router/index.ts",
  "src/router/index.js",
  "src/router.ts",
  "src/router.js",
  "src/router/routes.ts",
  "src/router/routes.js",
]

/** Conventional React Router config locations. React projects don't share a
 * single dominant convention the way Vue+vue-router does — routes commonly
 * live in a dedicated router file OR inline in App/main — so this list is
 * wider than the Vue one. Data-router projects (`createBrowserRouter`)
 * frequently keep the route TABLE in plain `.ts`/`.js` — `Component:`/`lazy:`
 * reference components instead of embedding JSX element literals, so the
 * file itself never needs `.tsx` — hence both extensions are probed for the
 * dedicated router/routes locations. `App`/`main` are JSX-form entry points
 * (they render `<Routes>`/`<Route>`), so only `.tsx`/`.jsx` make sense there. */
export const REACT_ROUTER_FILE_CANDIDATES = [
  "src/router.tsx",
  "src/router.jsx",
  "src/router.ts",
  "src/router.js",
  "src/router/index.tsx",
  "src/router/index.jsx",
  "src/router/index.ts",
  "src/router/index.js",
  "src/routes.tsx",
  "src/routes.jsx",
  "src/routes.ts",
  "src/routes.js",
  "src/App.tsx",
  "src/App.jsx",
  "src/main.tsx",
  "src/main.jsx",
]

export interface LocatedRouterFile {
  ok: true
  /** Canonical absolute path on disk (inside the repo root). */
  absolute: string
  /** Repo-relative path (POSIX separators, e.g. `src/router/index.ts`). */
  repoRel: string
  /** Full source text of the router file. */
  source: string
}

export interface LocateRouterFileError {
  ok: false
  reason: string
}

export type LocateRouterFileResult = LocatedRouterFile | LocateRouterFileError

/** Cheap pre-filter marker check, run before the caller's AST parse. Vue
 * configs call `createRouter`; React configs call a `createBrowserRouter`-
 * family function OR declare a `<Routes>` block (JSX form — see
 * `scaffold-react-route.ts`). */
function looksLikeRouterSource(source: string, framework: "vue3" | "react"): boolean {
  if (framework === "react") {
    return (
      /\bcreate(Browser|Hash|Memory)Router\s*\(/.test(source) || /<Routes[\s/>]/.test(source)
    )
  }
  return source.includes("createRouter")
}

/**
 * Find the single router config under `worktreeRoot` for the given
 * `framework` (defaults to `vue3`). When `explicit` is given, only that path
 * is considered (still must exist + look like a router config).
 */
export async function locateRouterFile(
  worktreeRoot: string,
  explicit?: string,
  framework: "vue3" | "react" = "vue3",
): Promise<LocateRouterFileResult> {
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(worktreeRoot)
  } catch (err) {
    return { ok: false, reason: `router root not accessible: ${(err as Error).message}` }
  }

  const defaultCandidates =
    framework === "react" ? REACT_ROUTER_FILE_CANDIDATES : ROUTER_FILE_CANDIDATES
  const candidates = explicit ? [explicit] : defaultCandidates
  const found: LocatedRouterFile[] = []
  for (const cand of candidates) {
    const safe = await resolveRepoPath(worktreeRoot, cand)
    if (!safe.ok || !existsSync(safe.absolute)) continue
    let source: string
    try {
      source = await readFile(safe.absolute, "utf8")
    } catch {
      continue
    }
    if (!looksLikeRouterSource(source, framework)) continue
    const repoRel = pathRelative(canonicalRoot, safe.absolute).split("\\").join("/")
    found.push({ ok: true, absolute: safe.absolute, repoRel, source })
  }

  if (found.length === 0) {
    const label = framework === "react" ? "React Router config" : "Vue Router config"
    return {
      ok: false,
      reason: explicit
        ? `'${explicit}' was not found or does not look like a ${label}.`
        : `could not auto-detect a ${label} (looked in ${defaultCandidates.join(", ")}). Pass an explicit router file.`,
    }
  }
  if (found.length > 1) {
    return {
      ok: false,
      reason: `multiple router files found (${found.map((f) => f.repoRel).join(", ")}). Pass an explicit router file to disambiguate.`,
    }
  }
  return found[0]
}

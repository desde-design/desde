import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveViewerLink } from "../viewer-resolve.js"
import { writeDefaultViewerOrigin, writeViewerToken } from "../viewer-token-store.js"

/**
 * The auto-link path against a REAL viewer.
 *
 * Skipped unless the environment names one, so `npm test` stays hermetic.
 * `tasks/scripts/viewer-sandbox.mts --check` boots a throwaway viewer, seeds
 * it, and runs this file with those variables set — that is the intended way
 * in, and it is one command.
 *
 * ## Why this lives in editor-cli's suite and not in a tsx harness
 *
 * MEASURED 2026-08-26. The repo root's `package.json` has no `"type"`, so
 * everything under root `src/` loads as CommonJS, while `editor-cli` is
 * `"type": "module"`. A root-level `.mts` script importing
 * `viewer-resolve.ts` therefore pulls `src/core/project-identity.ts` in
 * through CJS interop and gets `['default', 'module.exports']` — every named
 * import from it fails with "does not provide an export named 'deriveSlug'".
 *
 * Vitest transforms both sides to ESM, so the same import works here. Any
 * future harness that needs editor-cli server modules has the same choice:
 * run it under this suite, or don't import them.
 */
const LIVE_URL = process.env.LIVE_VIEWER_URL
const LIVE_TOKEN = process.env.LIVE_VIEWER_TOKEN
const LIVE_EMBEDDED_ID = process.env.LIVE_EMBEDDED_ID
const LIVE_PROJECT_ID = process.env.LIVE_PROJECT_ID

const live = Boolean(LIVE_URL && LIVE_TOKEN && LIVE_EMBEDDED_ID && LIVE_PROJECT_ID)

// Not part of `live`: an older sandbox that has not been re-run yet still has
// this unset, and the tests above must keep running without it.
const LIVE_AMBIGUOUS_REMOTE = process.env.LIVE_AMBIGUOUS_REMOTE

function repoWithIdentity(id: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "live-repo-"))
  mkdirSync(join(root, ".desde"), { recursive: true })
  writeFileSync(
    join(root, ".desde", "config.json"),
    JSON.stringify(
      id ? { version: 2, project: { id, name: "Sandbox prototype" } } : { version: 1 },
    ),
    "utf8",
  )
  return root
}

/**
 * A checkout with a git `origin` and no committed identity.
 *
 * A real `git init` because `readOriginRemoteUrl` shells out to
 * `git remote get-url origin`; there is nothing to stub.
 */
function repoWithRemote(remoteUrl: string): string {
  const root = mkdtempSync(join(tmpdir(), "live-remote-repo-"))
  execFileSync("git", ["init", "-q"], { cwd: root })
  execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: root })
  return root
}

function homeWithViewer(): string {
  return mkdtempSync(join(tmpdir(), "live-home-"))
}

describe.skipIf(!live)("resolveViewerLink against a live viewer", () => {
  it("links a repo whose embedded id the viewer has adopted", async () => {
    const home = homeWithViewer()
    await writeDefaultViewerOrigin(LIVE_URL!, home)
    await writeViewerToken(LIVE_URL!, LIVE_TOKEN!, home)

    const result = await resolveViewerLink(repoWithIdentity(LIVE_EMBEDDED_ID!), { home })

    expect(result.status).toBe("linked")
    if (result.status !== "linked") return
    expect(result.projectId).toBe(LIVE_PROJECT_ID)
  })

  it("reports an unknown id as unlinked, and creates nothing", async () => {
    const home = homeWithViewer()
    await writeDefaultViewerOrigin(LIVE_URL!, home)
    await writeViewerToken(LIVE_URL!, LIVE_TOKEN!, home)

    const result = await resolveViewerLink(
      repoWithIdentity("00000000-0000-4000-8000-000000000000"),
      { home },
    )

    // `mint` is the viewer's answer here. The Editor reports it as "not
    // linked" and stops — creating a prototype from the Editor is not built.
    expect(result.status).toBe("unlinked")
  })

  it("reports no-viewer when this machine has none set", async () => {
    const result = await resolveViewerLink(repoWithIdentity(LIVE_EMBEDDED_ID!), {
      home: homeWithViewer(),
    })
    expect(result).toEqual({ status: "no-viewer" })
  })

  it("reports no-token, not an error, when the viewer rejects the credential", async () => {
    const home = homeWithViewer()
    await writeDefaultViewerOrigin(LIVE_URL!, home)
    await writeViewerToken(LIVE_URL!, "dsv_0000000000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", home)

    const result = await resolveViewerLink(repoWithIdentity(LIVE_EMBEDDED_ID!), { home })

    // The remedy differs from "the viewer is down", so the states must not
    // collapse into one.
    expect(result.status).toBe("no-token")
  })

  it.skipIf(!LIVE_AMBIGUOUS_REMOTE)(
    "reports ambiguous when two prototypes are connected to one repo",
    async () => {
      // MEASURED against a live viewer, not an injected fetch. This path turns
      // on `/projects/resolve` (public-read) and `/projects` (permission-
      // checked) disagreeing about what the caller can see, and a mock agrees
      // with itself by construction.
      const home = homeWithViewer()
      await writeDefaultViewerOrigin(LIVE_URL!, home)
      await writeViewerToken(LIVE_URL!, LIVE_TOKEN!, home)

      const result = await resolveViewerLink(repoWithRemote(LIVE_AMBIGUOUS_REMOTE!), { home })

      expect(result.status).toBe("ambiguous")
      if (result.status !== "ambiguous") return
      expect(result.candidates.map((c) => c.slug).sort()).toEqual([
        "ambiguous-main",
        "ambiguous-review",
      ])
      // Branch is what makes the chooser answerable, and it has to arrive for
      // an ordinary token rather than only for an admin one.
      expect(result.candidates.map((c) => c.branch).sort()).toEqual([
        "design-review",
        "main",
      ])
    },
  )
})

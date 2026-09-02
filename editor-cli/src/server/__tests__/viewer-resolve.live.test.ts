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
})

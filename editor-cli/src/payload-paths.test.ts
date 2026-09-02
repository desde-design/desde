/**
 * Tests for `payload-paths.ts` — the single seam every asset-path lookup in
 * the CLI goes through, built ahead of the esbuild bundler (Phase 1 task 2)
 * so nothing downstream can silently miscompute a walk-up once bundling
 * collapses every `import.meta.url` in the module graph to one value.
 *
 * Coverage: each resolver in both runtime layouts (payload / dev checkout),
 * the `EDITOR_PAYLOAD_ROOT` unset/empty/whitespace/relative edge cases, and
 * — the test that actually protects the bundle — that the dev fallback for
 * every asset agrees whether computed from this file's own location
 * (`editor-cli/src/payload-paths.ts`) or from its post-bundle location
 * (`editor-cli/dist/cli.js`).
 */
import { afterEach, describe, expect, it } from "vitest"
import { resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"

import {
  devPathsFrom,
  payloadRoot,
  resolveBridgeBundlePath,
  resolveEditorCliPackageJson,
  resolveHtml2canvasPath,
  resolveDemoFixtureDir,
  resolveIconPreviewDir,
  resolveStampersDir,
  resolveUiBundleRoot,
} from "./payload-paths.js"

/**
 * This test file lives at `editor-cli/src/payload-paths.test.ts` — the SAME
 * depth as `payload-paths.ts` itself (both direct children of
 * `editor-cli/src/`) — so walking up three levels from either lands on the
 * same repo root. Deriving it this way keeps the expected values below
 * portable across checkouts instead of hardcoding an absolute path.
 */
const REPO_ROOT = resolvePath(fileURLToPath(import.meta.url), "..", "..", "..")

const PAYLOAD = "/tmp/payload"

/** Run `fn` with `EDITOR_PAYLOAD_ROOT` set to `value` (or deleted), restoring
 * whatever was there before — every case gets a clean slate. */
function withEnv(value: string | undefined, fn: () => void): void {
  const prior = process.env.EDITOR_PAYLOAD_ROOT
  if (value === undefined) delete process.env.EDITOR_PAYLOAD_ROOT
  else process.env.EDITOR_PAYLOAD_ROOT = value
  try {
    fn()
  } finally {
    if (prior === undefined) delete process.env.EDITOR_PAYLOAD_ROOT
    else process.env.EDITOR_PAYLOAD_ROOT = prior
  }
}

// Belt-and-suspenders: also clear after every test in case an assertion
// throws mid-case and skips withEnv's own finally (it doesn't, but a global
// backstop costs nothing and protects the next file's tests too).
afterEach(() => {
  delete process.env.EDITOR_PAYLOAD_ROOT
})

describe("payloadRoot", () => {
  it("is null when EDITOR_PAYLOAD_ROOT is unset", () => {
    withEnv(undefined, () => {
      expect(payloadRoot()).toBeNull()
    })
  })

  it("returns the absolute value as given", () => {
    withEnv(PAYLOAD, () => {
      expect(payloadRoot()).toBe(PAYLOAD)
    })
  })

  it("treats an empty string as unset", () => {
    withEnv("", () => {
      expect(payloadRoot()).toBeNull()
    })
  })

  it("treats a whitespace-only value as unset", () => {
    withEnv("   \t  \n", () => {
      expect(payloadRoot()).toBeNull()
    })
  })

  /**
   * Regression coverage for the corruption `raw.trim()` used to cause: a
   * directory whose real name ends in a space is valid on macOS and Linux,
   * and trimming the env value rewrote it to a DIFFERENT, non-existent path
   * with no error — every resolver then silently pointed outside the real
   * payload. `payloadRoot()` must return the value byte-for-byte, trailing
   * space included, not a "corrected" version of it.
   */
  it("preserves a trailing space in the path exactly, rather than trimming it away", () => {
    const withTrailingSpace = `${PAYLOAD} `
    withEnv(withTrailingSpace, () => {
      expect(payloadRoot()).toBe(withTrailingSpace)
    })
  })

  /** Same defect, other end of the string. */
  it("preserves a trailing space on the deepest path segment, not just a bare directory name", () => {
    const nested = "/tmp/payload/My Directory "
    withEnv(nested, () => {
      expect(payloadRoot()).toBe(nested)
    })
  })

  it("resolveUiBundleRoot resolves under a payload root with a trailing space in its name", () => {
    const withTrailingSpace = `${PAYLOAD} `
    withEnv(withTrailingSpace, () => {
      expect(resolveUiBundleRoot()).toBe(resolvePath(withTrailingSpace, "ui"))
      // Confirms the join preserved the space rather than the trim it used
      // to get silently rewritten to.
      expect(resolveUiBundleRoot()).toContain("/tmp/payload /ui")
    })
  })

  it("throws on a relative value, naming the variable and the value", () => {
    withEnv("relative/payload", () => {
      expect(() => payloadRoot()).toThrow(/EDITOR_PAYLOAD_ROOT/)
      expect(() => payloadRoot()).toThrow(/relative\/payload/)
    })
  })

  it("reads process.env fresh on every call rather than caching at module load", () => {
    withEnv(undefined, () => {
      expect(payloadRoot()).toBeNull()
      process.env.EDITOR_PAYLOAD_ROOT = PAYLOAD
      expect(payloadRoot()).toBe(PAYLOAD)
      delete process.env.EDITOR_PAYLOAD_ROOT
      expect(payloadRoot()).toBeNull()
    })
  })
})

describe("resolvers — EDITOR_PAYLOAD_ROOT set", () => {
  it("resolveUiBundleRoot -> <payload>/ui", () => {
    withEnv(PAYLOAD, () => {
      expect(resolveUiBundleRoot()).toBe(resolvePath(PAYLOAD, "ui"))
    })
  })

  it("resolveBridgeBundlePath -> <payload>/assets/bridge-bundle.js", () => {
    withEnv(PAYLOAD, () => {
      expect(resolveBridgeBundlePath()).toBe(resolvePath(PAYLOAD, "assets", "bridge-bundle.js"))
    })
  })

  it("resolveHtml2canvasPath -> <payload>/assets/html2canvas.min.js", () => {
    withEnv(PAYLOAD, () => {
      expect(resolveHtml2canvasPath()).toBe(
        resolvePath(PAYLOAD, "assets", "html2canvas.min.js"),
      )
    })
  })

  it("resolveStampersDir -> <payload>/attach/stampers", () => {
    withEnv(PAYLOAD, () => {
      expect(resolveStampersDir()).toBe(resolvePath(PAYLOAD, "attach", "stampers"))
    })
  })

  it("resolveEditorCliPackageJson -> <payload>/package.json", () => {
    withEnv(PAYLOAD, () => {
      expect(resolveEditorCliPackageJson()).toBe(resolvePath(PAYLOAD, "package.json"))
    })
  })

  it("resolveDemoFixtureDir -> <payload>/demo", () => {
    withEnv(PAYLOAD, () => {
      expect(resolveDemoFixtureDir()).toBe(resolvePath(PAYLOAD, "demo"))
    })
  })

  it("resolveIconPreviewDir -> <payload>/icon-preview", () => {
    withEnv(PAYLOAD, () => {
      expect(resolveIconPreviewDir()).toBe(resolvePath(PAYLOAD, "icon-preview"))
    })
  })
})

describe("resolvers — EDITOR_PAYLOAD_ROOT unset (dev checkout)", () => {
  it("resolveUiBundleRoot -> <repo>/editor-cli/ui-src/dist", () => {
    withEnv(undefined, () => {
      expect(resolveUiBundleRoot()).toBe(
        resolvePath(REPO_ROOT, "editor-cli", "ui-src", "dist"),
      )
    })
  })

  it("resolveBridgeBundlePath -> <repo>/dist/bridge-bundle.js", () => {
    withEnv(undefined, () => {
      expect(resolveBridgeBundlePath()).toBe(resolvePath(REPO_ROOT, "dist", "bridge-bundle.js"))
    })
  })

  it("resolveHtml2canvasPath -> <repo>/public/vendor/html2canvas.min.js", () => {
    withEnv(undefined, () => {
      expect(resolveHtml2canvasPath()).toBe(
        resolvePath(REPO_ROOT, "public", "vendor", "html2canvas.min.js"),
      )
    })
  })

  it("resolveStampersDir -> <repo>/editor-cli/src/attach/stampers", () => {
    withEnv(undefined, () => {
      expect(resolveStampersDir()).toBe(
        resolvePath(REPO_ROOT, "editor-cli", "src", "attach", "stampers"),
      )
    })
  })

  it("resolveEditorCliPackageJson -> <repo>/editor-cli/package.json", () => {
    withEnv(undefined, () => {
      expect(resolveEditorCliPackageJson()).toBe(
        resolvePath(REPO_ROOT, "editor-cli", "package.json"),
      )
    })
  })

  it("resolveDemoFixtureDir -> <repo>/editor-cli/demo", () => {
    withEnv(undefined, () => {
      expect(resolveDemoFixtureDir()).toBe(resolvePath(REPO_ROOT, "editor-cli", "demo"))
    })
  })

  it("resolveIconPreviewDir -> <repo>/src/editor/icon-preview", () => {
    withEnv(undefined, () => {
      expect(resolveIconPreviewDir()).toBe(
        resolvePath(REPO_ROOT, "src", "editor", "icon-preview"),
      )
    })
  })
})

describe("depth invariance — the check that protects the bundle", () => {
  // editor-cli/src/payload-paths.ts and editor-cli/dist/cli.js are both
  // exactly one path segment under editor-cli/ — same depth. A walk-up
  // correct for one must produce the SAME dev-fallback values from the
  // other, or bundling (Phase 1 task 2) starts silently serving from the
  // wrong tree with no error, just a 404 or a stale asset.
  const fromSrc = resolvePath(REPO_ROOT, "editor-cli", "src", "payload-paths.ts")
  const fromDist = resolvePath(REPO_ROOT, "editor-cli", "dist", "cli.js")

  it("agrees on the three repo-root-relative assets (bridge, html2canvas, ui)", () => {
    const viaSrc = devPathsFrom(fromSrc)
    const viaDist = devPathsFrom(fromDist)
    expect(viaDist.bridgeBundlePath).toBe(viaSrc.bridgeBundlePath)
    expect(viaDist.html2canvasPath).toBe(viaSrc.html2canvasPath)
    expect(viaDist.uiBundleRoot).toBe(viaSrc.uiBundleRoot)
  })

  it("agrees on every field, not just the three called out in the brief", () => {
    // devPathsFrom anchors everything on one repo-root walk-up and then
    // extends it with a fixed dev-relative path, so stampers/package.json/
    // icon-preview are depth-invariant for the same structural reason the
    // three repo-root assets are — this pins that down too.
    expect(devPathsFrom(fromSrc)).toEqual(devPathsFrom(fromDist))
  })

  it("the src-location result matches the real dev-fallback values", () => {
    // Cross-check devPathsFrom's own math against the same repo-root-derived
    // expectations used above, so a bug shared between devPathsFrom and this
    // describe block's hand-derived REPO_ROOT can't hide.
    expect(devPathsFrom(fromSrc)).toEqual({
      uiBundleRoot: resolvePath(REPO_ROOT, "editor-cli", "ui-src", "dist"),
      bridgeBundlePath: resolvePath(REPO_ROOT, "dist", "bridge-bundle.js"),
      html2canvasPath: resolvePath(REPO_ROOT, "public", "vendor", "html2canvas.min.js"),
      stampersDir: resolvePath(REPO_ROOT, "editor-cli", "src", "attach", "stampers"),
      editorCliPackageJson: resolvePath(REPO_ROOT, "editor-cli", "package.json"),
      iconPreviewDir: resolvePath(REPO_ROOT, "src", "editor", "icon-preview"),
      demoFixtureDir: resolvePath(REPO_ROOT, "editor-cli", "demo"),
    })
  })
})

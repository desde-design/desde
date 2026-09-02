/**
 * The containment rules behind every `data-desde-src` stamp.
 *
 * These are cheap string tests for an expensive failure: a stamp the edit
 * server will not accept produces a selectable element whose every edit 400s
 * with "File path escapes prototype root" — minutes after boot, mid-click, with
 * a healthy 200-serving dev server and nothing in the logs. Each case below is
 * a way the shipped `id.includes("/node_modules/")` guard gets that wrong.
 */
import path from "node:path"
import { describe, expect, it } from "vitest"
import { buildStampPolicy, isStampPolicy, isStampable, stampPathFor } from "../stamp-policy.js"
import type { StampPolicy } from "../types.js"

const REPO = "/repo"

function policy(overrides: Partial<Parameters<typeof buildStampPolicy>[0]> = {}): StampPolicy {
  return buildStampPolicy({ repoRoot: REPO, ...overrides })
}

describe("buildStampPolicy", () => {
  it("anchors stamps at repoRoot when the checkout is not symlinked", () => {
    const p = policy()
    expect(p.stampRoot).toBe(REPO)
    expect(p.roots).toEqual([REPO])
  })

  it("carries BOTH roots when the checkout is reached through a symlink, and stamps against the real one", () => {
    // The edit server realpaths the repo root before resolving any stamped path
    // against it (`resolvePrototypeRoot`), so the canonical root is the one the
    // two guards have to agree on.
    const p = policy({ repoRootReal: "/private/repo" })
    expect(p.stampRoot).toBe("/private/repo")
    expect(p.roots).toEqual(["/private/repo", REPO])
  })

  it("keeps stampRoot inside roots — the field is explicit so nothing depends on ordering", () => {
    for (const p of [policy(), policy({ repoRootReal: "/private/repo" })]) {
      expect(p.roots).toContain(p.stampRoot)
    }
  })

  it("resolves buildDirs against prototypeRoot, not the repo root", () => {
    const p = policy({ prototypeRoot: "/repo/apps/web", buildDirs: [".nuxt", "dist"] })
    expect(p.denyDirs).toEqual(["/repo/apps/web/.nuxt", "/repo/apps/web/dist"])
  })

  it("anchors buildDirs under BOTH root aliases on a symlinked checkout", () => {
    // The regression this exists for: `denyDirs` was resolved against the typed
    // root only, while `roots` carried both aliases. Vite hands the stamper ids
    // anchored at the RESOLVED path, so containment admitted
    // `/private/tmp/x/.nuxt/foo.js` through the resolved root while the denial
    // compared it against `/tmp/x/.nuxt` and missed — build output stamped on
    // exactly the layout the symlink handling was written for.
    const p = policy({ repoRoot: "/tmp/x", repoRootReal: "/private/tmp/x", buildDirs: [".nuxt"] })
    expect(p.denyDirs).toContain("/private/tmp/x/.nuxt")
    expect(p.denyDirs).toContain("/tmp/x/.nuxt")
  })

  it("denies build output reached through the resolved alias", () => {
    const p = policy({ repoRoot: "/tmp/x", repoRootReal: "/private/tmp/x", buildDirs: [".nuxt"] })
    // The end-to-end statement of the bug above: this is the id shape Vite
    // actually produces on a symlinked checkout.
    expect(isStampable(p, "/private/tmp/x/.nuxt/dist/entry.mjs")).toBe(false)
    expect(isStampable(p, "/tmp/x/.nuxt/dist/entry.mjs")).toBe(false)
    // …while ordinary source under either alias still stamps.
    expect(isStampable(p, "/private/tmp/x/src/App.vue")).toBe(true)
  })

  it("normalises roots so containment compares like with like", () => {
    expect(policy({ repoRoot: "/repo/" }).roots).toEqual([REPO])
  })
})

describe("isStampable — root containment", () => {
  it("stamps a file inside the root", () => {
    expect(isStampable(policy(), "/repo/src/App.vue")).toBe(true)
  })

  it("refuses a file outside every root", () => {
    // The gap the substring guard leaves wide open: a linked or sibling
    // first-party file has no `node_modules` segment, so it stamps today —
    // as `../outside-lib/Card.tsx:6:4`, which the edit server refuses.
    expect(isStampable(policy(), "/outside-lib/Card.tsx")).toBe(false)
    expect(stampPathFor(policy(), "/outside-lib/Card.tsx")).toBeNull()
  })

  it("refuses /repo-backup for root /repo — containment is path.relative, not startsWith", () => {
    expect(isStampable(policy(), "/repo-backup/src/App.vue")).toBe(false)
  })

  it("stamps a dotfile whose name merely begins with `..`", () => {
    // A bare `rel.startsWith("..")` would reject this; the `..` test is
    // segment-aware. The file is inside the root, so refusing it would cost a
    // real edit target for nothing.
    expect(stampPathFor(policy(), "/repo/..rc.tsx")).toBe("..rc.tsx")
  })

  it("refuses the root itself and anything not absolute", () => {
    expect(isStampable(policy(), REPO)).toBe(false)
    // Relative ids and virtual module ids must not be resolved against
    // process.cwd() — inside the repo, that would silently admit them.
    expect(isStampable(policy(), "src/App.vue")).toBe(false)
    expect(isStampable(policy(), "\0virtual:my-plugin")).toBe(false)
  })

  it("accepts an id anchored at EITHER alias of a symlinked checkout, with the same stamp", () => {
    // Vite defaults to `preserveSymlinks: false`, so ids arrive realpathed
    // while repoRoot is what the user typed — the macOS /tmp case exactly.
    const p = policy({ repoRootReal: "/private/repo" })
    expect(stampPathFor(p, "/private/repo/src/App.vue")).toBe("src/App.vue")
    expect(stampPathFor(p, "/repo/src/App.vue")).toBe("src/App.vue")
  })
})

describe("isStampable — segment denial", () => {
  it("refuses a dependency inside the repo", () => {
    expect(isStampable(policy(), "/repo/node_modules/@vendor/ui/Card.vue")).toBe(false)
  })

  it("still stamps a repo whose OWN path contains a node_modules segment", () => {
    // Substring matching would skip every file in this checkout. Segment-exact
    // matching is applied to the ROOT-RELATIVE path, so the root's own
    // directory names are none of its business.
    const p = policy({ repoRoot: "/Users/me/node_modules/my-repo" })
    expect(stampPathFor(p, "/Users/me/node_modules/my-repo/src/App.vue")).toBe("src/App.vue")
    expect(isStampable(p, "/Users/me/node_modules/my-repo/node_modules/dep/Card.vue")).toBe(false)
  })

  it("matches whole segments only", () => {
    // `node_modules_backup` is a first-party directory that a substring test
    // would silently swallow.
    expect(isStampable(policy(), "/repo/node_modules_backup/App.vue")).toBe(true)
  })
})

describe("isStampable — build-dir denial", () => {
  const nuxt = policy({ buildDirs: [".nuxt"] })

  it("refuses generated output that sits inside the root", () => {
    // Root containment alone admits `.nuxt/` — it IS inside the repo. Its
    // contents are regenerated, so a stamp there points at a file that will not
    // exist by the time anyone edits it.
    expect(isStampable(nuxt, "/repo/.nuxt/dist/client/entry.vue")).toBe(false)
    expect(isStampable(nuxt, "/repo/.nuxt/app.vue")).toBe(false)
  })

  it("does not deny a sibling whose name shares the prefix", () => {
    expect(isStampable(nuxt, "/repo/.nuxtrc.tsx")).toBe(true)
  })

  it("denies build output only for the host that declared it", () => {
    expect(isStampable(policy(), "/repo/.nuxt/app.vue")).toBe(true)
  })
})

describe("stampPathFor", () => {
  it("returns a path exactly when isStampable agrees", () => {
    const p = policy({ repoRootReal: "/private/repo", buildDirs: [".nuxt"] })
    const cases = [
      "/repo/src/App.vue",
      "/private/repo/src/App.vue",
      "/repo/node_modules/dep/Card.vue",
      "/repo/.nuxt/app.vue",
      "/repo-backup/src/App.vue",
      "/outside-lib/Card.tsx",
    ]
    for (const abs of cases) {
      expect(stampPathFor(p, abs) === null).toBe(!isStampable(p, abs))
    }
  })

  it("emits a repo-relative path, never an absolute one", () => {
    const stamp = stampPathFor(policy(), "/repo/src/components/Card.vue")
    expect(stamp).toBe(path.join("src", "components", "Card.vue"))
    expect(path.isAbsolute(stamp!)).toBe(false)
  })
})

/**
 * The guard on the far side of a process boundary. The Next lane's stamper is a
 * Turbopack loader running in a forked worker, so its policy arrives as JSON
 * and the type annotation on it is a claim nothing checked.
 */
describe("isStampPolicy", () => {
  it("accepts what buildStampPolicy produces, after a JSON round trip", () => {
    for (const p of [policy(), policy({ repoRootReal: "/private/repo", buildDirs: [".next"] })]) {
      expect(isStampPolicy(JSON.parse(JSON.stringify(p)))).toBe(true)
    }
  })

  it("rejects anything that is not an object", () => {
    for (const value of [null, undefined, "policy", 7, [], true]) {
      expect(isStampPolicy(value)).toBe(false)
    }
  })

  it("rejects a policy missing any field, because a missing one throws mid-transform", () => {
    const complete = policy({ buildDirs: [".next"] })
    for (const key of Object.keys(complete) as (keyof StampPolicy)[]) {
      const partial: Record<string, unknown> = { ...complete }
      delete partial[key]
      expect(isStampPolicy(partial)).toBe(false)
    }
  })

  it("rejects relative roots, which path.relative would resolve against the worker's cwd", () => {
    expect(isStampPolicy({ ...policy(), roots: ["repo"], stampRoot: "repo" })).toBe(false)
    expect(isStampPolicy({ ...policy(), denyDirs: [".next"] })).toBe(false)
  })

  it("rejects an empty root set, which would make containment vacuous", () => {
    expect(isStampPolicy({ ...policy(), roots: [] })).toBe(false)
  })

  it("rejects a stampRoot that is not one of the roots", () => {
    // The shape that stamps against a tree containment never checked: every
    // file passes through a root in `roots`, and the emitted path is relative
    // to a directory nothing validated it is inside.
    expect(isStampPolicy({ ...policy(), stampRoot: "/elsewhere" })).toBe(false)
  })

  it("rejects non-string members inside the arrays", () => {
    expect(isStampPolicy({ ...policy(), denySegments: ["node_modules", 3] })).toBe(false)
    expect(isStampPolicy({ ...policy(), roots: [REPO, null], stampRoot: REPO })).toBe(false)
  })
})

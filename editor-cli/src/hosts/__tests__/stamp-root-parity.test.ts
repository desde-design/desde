/**
 * S9 — stamping never promises an edit that cannot land.
 *
 * A `data-desde-src` stamp is a PROMISE: the bridge offers every stamped element
 * as an edit target, and the edit server resolves the stamped path back through
 * `resolve-editable-path.ts`'s containment guard. The two sides therefore have
 * to canonicalise the repo root the same way. When they don't, the failure is
 * the worst shape this project has: a healthy dev server, a fully inspectable
 * page, and a 400 on every edit, discovered mid-click with nothing in the logs.
 *
 * This file holds them to it on a REAL symlinked checkout rather than on a
 * string fixture, because the disagreement only exists once a filesystem is
 * involved: Vite defaults to `preserveSymlinks: false`, so it hands the stamper
 * ids anchored at the resolved path while `repoRoot` is whatever the user
 * typed. macOS does this to anything under `/tmp` (`/tmp` → `/private/tmp`),
 * which is why it reproduces in temp-dir fixtures and was READ-only until now
 * (spec § 8, open question 9).
 */
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildStampPolicy } from "../stamp-policy.js"
import { jsxSourceTagPlugin } from "../../plugins/jsx-source-tag-plugin.js"
import { sourceTagPlugin } from "../../plugins/source-tag-plugin.js"
import {
  resolveCandidateWithinRoot,
  resolvePrototypeRoot,
  resolveRealpathWithinRoot,
  type ResolvedRoot,
} from "../../server/resolve-editable-path.js"

/** The real checkout on disk. */
let realRoot: string
/** The same checkout reached through a symlink — what the user typed. */
let linkRoot: string
/** Scratch parent, removed in `afterAll`. */
let base: string

const VUE = "<template>\n  <div class=\"card\">hi</div>\n</template>\n"
const JSX = "export const Card = () => (\n  <div className=\"card\">hi</div>\n)\n"

beforeAll(async () => {
  // `realpath` the scratch parent first, so the ONLY symlink hop in `linkRoot`
  // is the one this test makes. Without it, macOS's own `/var` → `/private/var`
  // indirection would be doing the work and the fixture would prove less than
  // it claims.
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pt-stamp-parity-")))
  realRoot = path.join(base, "checkout")
  linkRoot = path.join(base, "typed-path")
  await fs.mkdir(path.join(realRoot, "src"), { recursive: true })
  await fs.writeFile(path.join(realRoot, "src", "Card.vue"), VUE, "utf8")
  await fs.writeFile(path.join(realRoot, "src", "Card.tsx"), JSX, "utf8")
  await fs.symlink(realRoot, linkRoot, "dir")
})

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

/** Mirrors `core.ts`: `undefined` when the checkout is not symlinked. */
async function repoRootRealOf(repoRoot: string): Promise<string | undefined> {
  const resolved = await fs.realpath(repoRoot)
  return resolved === repoRoot ? undefined : resolved
}

type TransformHook = (this: unknown, code: string, id: string) => { code: string } | null

/** Every `data-desde-src` value the stamper emitted, in source order. */
function stamps(out: { code: string } | null): string[] {
  return [...(out?.code ?? "").matchAll(/data-desde-src="([^"]*)"/g)].map((m) => m[1])
}

/** `file:line:col` → the file portion (a path may itself contain no colons here). */
function fileOf(stamp: string): string {
  return stamp.slice(0, stamp.lastIndexOf(":", stamp.lastIndexOf(":") - 1))
}

describe("stamp root parity", () => {
  it("the fixture really is a symlinked checkout", async () => {
    // Guard against a vacuous pass: on a platform where the two paths
    // coincided, every assertion below would hold for the wrong reason.
    expect(await repoRootRealOf(linkRoot)).toBe(realRoot)
    expect(linkRoot).not.toBe(realRoot)
  })

  it("anchors stamps at the SAME canonical root the edit server resolves against", async () => {
    // Not "both call realpath" — that is a coincidence a refactor can break.
    // The claim is that `policy.stampRoot` and `ResolvedRoot.rootReal` are the
    // same string for the same input, which is what makes a stamp resolvable.
    const policy = buildStampPolicy({
      repoRoot: linkRoot,
      repoRootReal: await repoRootRealOf(linkRoot),
    })
    const root = await resolvePrototypeRoot(linkRoot)
    expect(root.ok).toBe(true)
    expect(policy.stampRoot).toBe(root.ok ? root.rootReal : null)
    expect(policy.roots).toContain(policy.stampRoot)
  })

  it("would have escaped with `..` under the pre-fix derivation", async () => {
    // The RED witness, kept in the suite rather than in a commit message: this
    // is the exact expression both plugins used before milestone 1
    // (`relative(opts.repoRoot, cleanId)`), and it is what the assertions below
    // are the counter-example to. If this ever stops producing an escape, the
    // fixture stopped exercising the bug and the rest of this file is theatre.
    const viteId = path.join(realRoot, "src", "Card.vue")
    expect(path.relative(linkRoot, viteId).startsWith("..")).toBe(true)
    expect(await repoRootRealOf(linkRoot)).toBeDefined()
  })
})

describe.each([
  { name: "vue", file: "Card.vue", source: VUE, plugin: sourceTagPlugin },
  { name: "jsx", file: "Card.tsx", source: JSX, plugin: jsxSourceTagPlugin },
])("$name stamps on a symlinked checkout", ({ file, source, plugin }) => {
  let root: ResolvedRoot
  let emitted: string[]

  beforeAll(async () => {
    const policy = buildStampPolicy({
      repoRoot: linkRoot,
      repoRootReal: await repoRootRealOf(linkRoot),
    })
    // The id Vite hands a `transform` hook: resolved, because
    // `preserveSymlinks` defaults to false.
    const viteId = path.join(realRoot, "src", file)
    const hook = plugin({ policy }).transform as TransformHook
    emitted = stamps(hook.call({}, source, viteId))

    const resolved = await resolvePrototypeRoot(linkRoot)
    if (!resolved.ok) throw new Error(resolved.reason)
    root = resolved
  })

  it("emits at least one stamp", () => {
    // Everything below is vacuously true over an empty list.
    expect(emitted.length).toBeGreaterThan(0)
  })

  it("emits repo-relative paths with no `..` escape", () => {
    for (const stamp of emitted) {
      const relPath = fileOf(stamp)
      expect(path.isAbsolute(relPath)).toBe(false)
      expect(relPath.split(path.sep)).not.toContain("..")
      expect(relPath).toBe(path.join("src", file))
    }
  })

  it("round-trips every stamp through the edit server's containment guard", async () => {
    // S9 stated as an executable check: for every stamp emitted, the same path
    // passes `resolveCandidateWithinRoot` — and then actually exists, so the
    // promise is not merely lexically survivable but real.
    //
    // MEASURED while proving this suite red: the containment guard ALONE does
    // not catch the symlink bug on this fixture. `../checkout/src/Card.vue`
    // resolves back inside the root, because the alias and the real directory
    // are siblings — so the guard says yes and the stamp is still garbage
    // relative to what the user typed. That is why the sibling assertion above
    // tests for the absence of `..` directly rather than trusting this one.
    for (const stamp of emitted) {
      const candidate = resolveCandidateWithinRoot(fileOf(stamp), root)
      expect(candidate.ok).toBe(true)
      if (!candidate.ok) continue
      const target = await resolveRealpathWithinRoot(candidate.candidate, root)
      expect(target.ok).toBe(true)
      if (target.ok) expect(target.targetPath).toBe(path.join(realRoot, "src", file))
    }
  })
})

/**
 * Both stampers route their "may I stamp this, and what path do I write?"
 * decision through `hosts/stamp-policy.ts`.
 *
 * `stamp-policy.test.ts` proves the RULE. This file proves the WIRING — that
 * the Vue and JSX plugins actually ask it, agree with each other, and emit the
 * path it returns. The two are separable failures: the rule was already
 * correct in milestone 0 while both plugins still carried their own
 * `id.includes("/node_modules/")` substring test and their own
 * `relative(repoRoot, id)`.
 *
 * Why the cases below and not others: each is a shape where the substring test
 * and the policy DISAGREE, so a plugin that quietly kept the old guard fails
 * here rather than passing on an easy input.
 */
import path from "node:path"
import { describe, expect, it } from "vitest"
import { buildStampPolicy } from "../../hosts/stamp-policy.js"
import { jsxSourceTagPlugin } from "../jsx-source-tag-plugin.js"
import { sourceTagPlugin } from "../source-tag-plugin.js"
import type { StampScope } from "../../hosts/stamp-policy.js"

const VUE = "<template><div>hi</div></template>"
const JSX = "export const A = () => <div>hi</div>"

type TransformHook = (this: unknown, code: string, id: string) => { code: string } | null

function runVue(scope: StampScope, id: string): string | null {
  const hook = sourceTagPlugin(scope).transform as TransformHook
  return hook.call({}, VUE, id)?.code ?? null
}

function runJsx(scope: StampScope, id: string): string | null {
  const hook = jsxSourceTagPlugin(scope).transform as TransformHook
  return hook.call({}, JSX, id)?.code ?? null
}

/** The first `data-desde-src` value in transformed output, or null when unstamped. */
function stamp(out: string | null): string | null {
  return out?.match(/data-desde-src="([^"]*)"/)?.[1] ?? null
}

/** `file:line:col` → the file portion. Only the path may contain a colon-free tail. */
function stampFile(value: string): string {
  return value.slice(0, value.lastIndexOf(":", value.lastIndexOf(":") - 1))
}

/**
 * Every case runs against BOTH lanes. A rule enforced in one stamper and not
 * the other is the exact drift this module exists to prevent, and it would be
 * invisible to a Vue-only or React-only test.
 */
const LANES = [
  { name: "vue", run: runVue, ext: ".vue" },
  { name: "jsx", run: runJsx, ext: ".tsx" },
] as const

describe.each(LANES)("$name stamper honours the stamp policy", ({ run, ext }) => {
  const repoRoot = "/repo"
  const scope: StampScope = { repoRoot }

  it("stamps a file inside the root, with a repo-relative path", () => {
    const value = stamp(run(scope, `${repoRoot}/src/App${ext}`))
    expect(value).not.toBeNull()
    expect(stampFile(value!)).toBe(path.join("src", `App${ext}`))
  })

  it("refuses a first-party file OUTSIDE the root instead of stamping it `../`", () => {
    // The gap the substring guard leaves open. A linked or sibling module has
    // no `node_modules` segment, so it used to be stamped — as
    // `../outside-lib/Card.tsx`, which the edit server refuses. Leaving it
    // unstamped is strictly better: the bridge walks up to the nearest stamped
    // ancestor, which is an edit target that works.
    expect(run(scope, `/outside-lib/Card${ext}`)).toBeNull()
  })

  it("refuses /repo-backup for root /repo", () => {
    // Containment is `path.relative`, not `startsWith`.
    expect(run(scope, `/repo-backup/src/App${ext}`)).toBeNull()
  })

  it("refuses a dependency, and keeps refusing it with a query suffix attached", () => {
    // The query case is the reason the check moved onto `cleanId`: the old Vue
    // guard tested the RAW id, so it happened to work here, but pairing a
    // raw-id denial with a clean-id relativisation is how two guards drift.
    expect(run(scope, `${repoRoot}/node_modules/dep/Card${ext}`)).toBeNull()
    expect(run(scope, `${repoRoot}/node_modules/dep/Card${ext}?t=123`)).toBeNull()
  })

  it("still stamps a repo whose OWN path contains a node_modules segment", () => {
    // Substring matching would skip every file in this checkout. The segment
    // test applies to the ROOT-RELATIVE path, so the root's own directory
    // names are none of its business.
    const nested = "/Users/me/node_modules/my-repo"
    const value = stamp(run({ repoRoot: nested }, `${nested}/src/App${ext}`))
    expect(value).not.toBeNull()
    expect(stampFile(value!)).toBe(path.join("src", `App${ext}`))
  })

  it("refuses a declared build dir, which root containment alone would admit", () => {
    // `.nuxt/` IS inside the repo, and its contents are regenerated — a stamp
    // there points at a file that will not exist when anyone edits it.
    const policy = buildStampPolicy({ repoRoot, buildDirs: [".nuxt"] })
    expect(run({ policy }, `${repoRoot}/.nuxt/dist/App${ext}`)).toBeNull()
    // A sibling that merely shares the prefix is a real source file.
    expect(run({ policy }, `${repoRoot}/.nuxtrc/App${ext}`)).not.toBeNull()
  })

  it("treats `{ repoRoot }` as exactly `buildStampPolicy({ repoRoot })`", () => {
    // The shorthand is a shorter way to SAY the policy, not a second
    // implementation of it — attach mode's generated wrappers use it.
    const id = `${repoRoot}/src/App${ext}`
    expect(run({ repoRoot }, id)).toBe(run({ policy: buildStampPolicy({ repoRoot }) }, id))
  })
})

/**
 * Pins the tracer path-prefix math on the BRIDGE side.
 *
 * `tasks/scripts/.../tracer-path-prefix.test.ts` covers the CLI half — how the
 * offset is COMPUTED. This covers how it is APPLIED, which is where a separate
 * bug lived: the prepend was guarded by `!file.startsWith(prefix)`, so a path
 * that merely began with the same text as the offset was assumed to be
 * repo-relative already and left unprefixed.
 *
 * Both halves matter for the same reason and it is worth being blunt about it:
 * every wrong answer here still names a real, existing file, so nothing
 * throws — the edit simply lands somewhere else. Found by codex review
 * 2026-08-09.
 */
import { afterEach, describe, expect, it } from "vitest"
import { tracer } from "./tracer-attribution"

const w = window as unknown as Record<string, unknown>

function withPrefix(prefix: string | undefined) {
  if (prefix === undefined) delete w.__DESDE_TRACER_PATH_PREFIX__
  else w.__DESDE_TRACER_PATH_PREFIX__ = prefix
}

/** Shape of what `vite-plugin-vue-tracer` hands back. */
const info = (file: string, line = 3, col = 5) => ({ pos: [file, line, col] as [string, number, number] })

afterEach(() => withPrefix(undefined))

describe("tracer.locFromInfo — repo-relative path reconstruction", () => {
  it("returns the tracer path unchanged when there is no offset", () => {
    // The normal single-package prototype: Vite root IS the repo root.
    withPrefix("")
    expect(tracer.locFromInfo(info("src/App.vue"))?.file).toBe("src/App.vue")
  })

  it("prepends the offset for a prototype nested in a larger repo", () => {
    withPrefix("app/")
    expect(tracer.locFromInfo(info("src/App.vue"))?.file).toBe("app/src/App.vue")
  })

  it("prepends even when the path already BEGINS with the offset text", () => {
    // The regression. `viteRoot = <repo>/app`, and the prototype happens to
    // contain its own `app/` directory, so the tracer emits `app/Foo.vue`.
    // The old `!startsWith(prefix)` guard skipped the prepend and resolved to
    // `<repo>/app/Foo.vue` — a DIFFERENT file that may well exist, so the
    // edit lands silently in the wrong place.
    withPrefix("app/")
    expect(tracer.locFromInfo(info("app/Foo.vue"))?.file).toBe("app/app/Foo.vue")
  })

  it("prepends for a deeper offset whose first segment repeats", () => {
    withPrefix("packages/app/")
    expect(tracer.locFromInfo(info("packages/thing.vue"))?.file).toBe("packages/app/packages/thing.vue")
  })

  it("converts the tracer's 0-based column to the 1-based data-desde-src convention", () => {
    withPrefix("")
    const loc = tracer.locFromInfo(info("src/App.vue", 12, 4))
    expect(loc).toEqual({ file: "src/App.vue", line: 12, column: 5 })
  })

  it("returns null rather than a half-built location for unusable input", () => {
    withPrefix("app/")
    expect(tracer.locFromInfo(undefined)).toBeNull()
    expect(tracer.locFromInfo({ pos: undefined } as never)).toBeNull()
    expect(tracer.locFromInfo({ pos: ["", 1, 1] } as never)).toBeNull()
  })
})

import { describe, expect, it } from "vitest"
import type { StyleOrigin } from "@/types/bridge"
import {
  resolveTokenScopeFile,
  resolveTokenSourceFile,
} from "./resolve-token-source-file"
import { availableScopes } from "./style-scope-decision"

describe("resolveTokenSourceFile", () => {
  it("maps a first-party Vite href to a root-relative path", () => {
    expect(
      resolveTokenSourceFile({ href: "http://localhost:5173/src/styles/tokens.css" }),
    ).toBe("src/styles/tokens.css")
  })

  it("strips Vite's ?v=hash cache-buster (it lands in search, not pathname)", () => {
    expect(
      resolveTokenSourceFile({
        href: "http://localhost:5173/src/tokens.css?v=8f3a1b2c",
      }),
    ).toBe("src/tokens.css")
  })

  it("accepts a bare root-relative href (no origin)", () => {
    expect(resolveTokenSourceFile({ href: "/assets/theme.css" })).toBe(
      "assets/theme.css",
    )
  })

  it("refuses a library sheet flagged by ref.package", () => {
    expect(
      resolveTokenSourceFile({
        href: "http://localhost:5173/node_modules/@acme/design-tokens/dist/tokens.css",
        package: "@acme/design-tokens",
      }),
    ).toBeNull()
  })

  it("refuses a node_modules path SEGMENT even without ref.package", () => {
    expect(
      resolveTokenSourceFile({
        href: "http://localhost:5173/node_modules/@acme/design-tokens/dist/tokens.css",
      }),
    ).toBeNull()
  })

  it("does NOT refuse a path that merely contains 'node_modules' as a substring", () => {
    // `my-node_modules-helper` is a legit dir name; only a true segment is library code.
    expect(
      resolveTokenSourceFile({
        href: "http://localhost:5173/src/my-node_modules-helper/tokens.css",
      }),
    ).toBe("src/my-node_modules-helper/tokens.css")
  })

  it("refuses Vite-internal virtual paths (/@fs, /@id, /@vite)", () => {
    expect(
      resolveTokenSourceFile({ href: "http://localhost:5173/@fs/etc/passwd.css" }),
    ).toBeNull()
    expect(
      resolveTokenSourceFile({ href: "http://localhost:5173/@id/virtual:tokens.css" }),
    ).toBeNull()
    expect(
      resolveTokenSourceFile({ href: "http://localhost:5173/@vite/client.css" }),
    ).toBeNull()
  })

  it("refuses a non-.css target", () => {
    expect(
      resolveTokenSourceFile({ href: "http://localhost:5173/src/App.vue" }),
    ).toBeNull()
    expect(
      resolveTokenSourceFile({ href: "http://localhost:5173/src/main.ts" }),
    ).toBeNull()
  })

  it("refuses an uppercase .CSS target — matches the server's case-sensitive gate", () => {
    // The server's edit-handler uses case-sensitive `endsWith('.css')`, so a
    // `.CSS` href would be refused there; the shell mustn't offer it.
    expect(
      resolveTokenSourceFile({ href: "http://localhost:5173/src/Tokens.CSS" }),
    ).toBeNull()
  })

  it("refuses an empty/root href", () => {
    expect(resolveTokenSourceFile({ href: "http://localhost:5173/" })).toBeNull()
    expect(resolveTokenSourceFile({ href: "" })).toBeNull()
  })

  describe("Vite base path", () => {
    it("strips a non-root base so the path is prototype-root-relative", () => {
      expect(
        resolveTokenSourceFile(
          { href: "http://localhost:5173/app/src/tokens.css" },
          { basePath: "/app/" },
        ),
      ).toBe("src/tokens.css")
    })

    it("accepts a base without a trailing slash", () => {
      expect(
        resolveTokenSourceFile(
          { href: "http://localhost:5173/app/src/tokens.css" },
          { basePath: "/app" },
        ),
      ).toBe("src/tokens.css")
    })

    it("is a no-op for the root base '/'", () => {
      expect(
        resolveTokenSourceFile(
          { href: "http://localhost:5173/src/tokens.css" },
          { basePath: "/" },
        ),
      ).toBe("src/tokens.css")
    })

    it("leaves the path unchanged when the href isn't under the base", () => {
      // Defensive: a stylesheet served outside the declared base keeps its
      // pathname (still refused later if it's not a writable first-party .css).
      expect(
        resolveTokenSourceFile(
          { href: "http://localhost:5173/src/tokens.css" },
          { basePath: "/app/" },
        ),
      ).toBe("src/tokens.css")
    })

    it("still refuses node_modules under a base path", () => {
      expect(
        resolveTokenSourceFile(
          { href: "http://localhost:5173/app/node_modules/@acme/x/tokens.css" },
          { basePath: "/app/" },
        ),
      ).toBeNull()
    })
  })

  // N3 — Vite dev serves every first-party stylesheet as an injected `<style>`
  // (href null, synthetic `'<style>'` marker), so before the bridge reported the
  // owner node's `data-vite-dev-id` NONE of these resolved and the token scope
  // was unreachable on the only substrate Editor supports.
  describe("bundler source hint (href-less <style>)", () => {
    const REPO = "/Users/mo/proto"

    it("falls back to the source hint when there is no usable href", () => {
      expect(
        resolveTokenSourceFile(
          { href: "<style>", sourceHint: `${REPO}/src/style.css` },
          { repoRoot: REPO },
        ),
      ).toBe("src/style.css")
    })

    it("strips a bundler query suffix from the hint", () => {
      expect(
        resolveTokenSourceFile(
          { href: "<style>", sourceHint: `${REPO}/src/tokens.css?used` },
          { repoRoot: REPO },
        ),
      ).toBe("src/tokens.css")
      expect(
        resolveTokenSourceFile(
          { href: "<style>", sourceHint: `${REPO}/src/tokens.css?v=8f3a1b2c` },
          { repoRoot: REPO },
        ),
      ).toBe("src/tokens.css")
    })

    it("tolerates a trailing slash on repoRoot", () => {
      expect(
        resolveTokenSourceFile(
          { href: "<style>", sourceHint: `${REPO}/src/style.css` },
          { repoRoot: `${REPO}/` },
        ),
      ).toBe("src/style.css")
    })

    it("prefers a real href over the hint", () => {
      // A `<link>`ed sheet that also (hypothetically) carries a hint must resolve
      // from the served URL — the authoritative answer.
      expect(
        resolveTokenSourceFile(
          {
            href: "http://localhost:5173/src/linked.css",
            sourceHint: `${REPO}/src/hinted.css`,
          },
          { repoRoot: REPO },
        ),
      ).toBe("src/linked.css")
    })

    it("refuses a hint when no repoRoot is known (web shell / older bootstrap)", () => {
      expect(
        resolveTokenSourceFile({
          href: "<style>",
          sourceHint: `${REPO}/src/style.css`,
        }),
      ).toBeNull()
      expect(
        resolveTokenSourceFile(
          { href: "<style>", sourceHint: `${REPO}/src/style.css` },
          { repoRoot: "" },
        ),
      ).toBeNull()
    })

    it("refuses a hint outside repoRoot — a wrong root means writing the wrong file", () => {
      expect(
        resolveTokenSourceFile(
          { href: "<style>", sourceHint: "/etc/evil.css" },
          { repoRoot: REPO },
        ),
      ).toBeNull()
      // Sibling directory that merely shares a prefix.
      expect(
        resolveTokenSourceFile(
          { href: "<style>", sourceHint: "/Users/mo/proto-other/src/style.css" },
          { repoRoot: REPO },
        ),
      ).toBeNull()
    })

    it("refuses a traversal that escapes the root inside the hint", () => {
      expect(
        resolveTokenSourceFile(
          { href: "<style>", sourceHint: `${REPO}/src/../../secrets.css` },
          { repoRoot: REPO },
        ),
      ).toBeNull()
    })

    // A symlinked checkout is the one case where BOTH paths are legitimate roots
    // of the same repo: `repoRoot` comes from the CLI's git root (the path the
    // user typed) while Vite resolves module ids through the filesystem
    // (`preserveSymlinks: false` by default), so a dev id can be anchored at the
    // real path. Prefix-matching one root silently withheld the token scope —
    // the same class of silent unavailability N3 closed.
    describe("a symlinked root must not withhold the scope", () => {
      const LINK = "/Users/mo/link-to-proto"
      const REAL = "/Volumes/work/proto"

      it("resolves a hint anchored at the resolved real path", () => {
        expect(
          resolveTokenSourceFile(
            { href: "<style>", sourceHint: `${REAL}/src/style.css` },
            { repoRoot: LINK, repoRootReal: REAL },
          ),
        ).toBe("src/style.css")
      })

      it("still resolves a hint anchored at the path the user typed", () => {
        expect(
          resolveTokenSourceFile(
            { href: "<style>", sourceHint: `${LINK}/src/style.css` },
            { repoRoot: LINK, repoRootReal: REAL },
          ),
        ).toBe("src/style.css")
      })

      it("normalises trailing and duplicated separators on either side", () => {
        expect(
          resolveTokenSourceFile(
            { href: "<style>", sourceHint: `${REAL}//src///style.css` },
            { repoRoot: `${LINK}//`, repoRootReal: `${REAL}/` },
          ),
        ).toBe("src/style.css")
      })

      it("still refuses a hint under neither root", () => {
        expect(
          resolveTokenSourceFile(
            { href: "<style>", sourceHint: "/Volumes/work/other/src/style.css" },
            { repoRoot: LINK, repoRootReal: REAL },
          ),
        ).toBeNull()
        // A sibling that merely shares a string prefix with the real root.
        expect(
          resolveTokenSourceFile(
            { href: "<style>", sourceHint: `${REAL}-other/src/style.css` },
            { repoRoot: LINK, repoRootReal: REAL },
          ),
        ).toBeNull()
      })

      it("does not treat a case difference as a match", () => {
        // On a case-INSENSITIVE volume these are the same file; on a sensitive
        // one they are different files, and the shell cannot tell which it is.
        // Refusing is the safe answer — the CLI's realpath normalises casing on
        // the volumes where it matters, which is why that is where fs work goes.
        expect(
          resolveTokenSourceFile(
            { href: "<style>", sourceHint: `/Volumes/work/PROTO/src/style.css` },
            { repoRoot: LINK, repoRootReal: REAL },
          ),
        ).toBeNull()
      })

      it("refuses a traversal that escapes even a matched root", () => {
        expect(
          resolveTokenSourceFile(
            { href: "<style>", sourceHint: `${REAL}/src/../../secrets.css` },
            { repoRoot: LINK, repoRootReal: REAL },
          ),
        ).toBeNull()
      })

      it("ignores a blank repoRootReal instead of matching everything", () => {
        expect(
          resolveTokenSourceFile(
            { href: "<style>", sourceHint: `${REAL}/src/style.css` },
            { repoRoot: LINK, repoRootReal: "  " },
          ),
        ).toBeNull()
        expect(
          resolveTokenSourceFile(
            { href: "<style>", sourceHint: `${REAL}/src/style.css` },
            { repoRootReal: "/" },
          ),
        ).toBeNull()
      })
    })

    it("refuses a non-absolute hint", () => {
      expect(
        resolveTokenSourceFile(
          { href: "<style>", sourceHint: "src/style.css" },
          { repoRoot: REPO },
        ),
      ).toBeNull()
    })

    it("refuses a node_modules hint — you cannot write into a package", () => {
      // Vite injects LIBRARY css as a `<style>` too, so this is the shape that
      // must not become a write target. Both with and without ref.package (the
      // bridge now parses the package out of the hint as well).
      expect(
        resolveTokenSourceFile(
          {
            href: "<style>",
            sourceHint: `${REPO}/node_modules/@acme/design-system/dist/style.css`,
            package: "@acme/design-system",
          },
          { repoRoot: REPO },
        ),
      ).toBeNull()
      expect(
        resolveTokenSourceFile(
          {
            href: "<style>",
            sourceHint: `${REPO}/node_modules/normalize.css/normalize.css`,
          },
          { repoRoot: REPO },
        ),
      ).toBeNull()
    })

    it("refuses an SFC <style> block (Vite dev id is the .vue file)", () => {
      // `<style scoped>` inside an SFC gets a dev id of
      // `…/App.vue?vue&type=style&index=0&lang.css` — after the query is cut the
      // target is a .vue file, which the `.css`-only token lane can't patch.
      expect(
        resolveTokenSourceFile(
          {
            href: "<style>",
            sourceHint: `${REPO}/src/App.vue?vue&type=style&index=0&scoped=abc&lang.css`,
          },
          { repoRoot: REPO },
        ),
      ).toBeNull()
    })
  })
})

describe("resolveTokenScopeFile", () => {
  const REPO = "/Users/mo/proto"
  const origin = (
    definedAt: { href: string; sourceHint?: string; package?: string },
  ) => ({
    varChain: [
      {
        name: "--brand-alias",
        value: "var(--acme-color-background)",
        definedAt: { selector: ":root", stylesheet: { href: "<style>" } },
      },
      {
        name: "--acme-color-background",
        value: "#ffffff",
        definedAt: { selector: ":root", stylesheet: definedAt },
      },
    ],
  })

  it("resolves the ROOT definition of the chain, not the first hop", () => {
    expect(
      resolveTokenScopeFile(origin({ href: "<style>", sourceHint: `${REPO}/src/t.css` }), {
        repoRoot: REPO,
      }),
    ).toBe("src/t.css")
  })

  it("returns null when the value isn't token-backed", () => {
    expect(resolveTokenScopeFile({ varChain: [] }, { repoRoot: REPO })).toBeNull()
  })

  it("refuses a library-defined root token", () => {
    expect(
      resolveTokenScopeFile(
        origin({
          href: "<style>",
          sourceHint: `${REPO}/node_modules/@acme/design-tokens/dist/tokens.css`,
          package: "@acme/design-tokens",
        }),
        { repoRoot: REPO },
      ),
    ).toBeNull()
  })
})

/**
 * The exact condition `computeEnabledScopes` (inspector-panel.tsx) applies for
 * the "The token" tile: the scope must be OFFERED by `availableScopes` and its
 * root definition must resolve to a writable file. Asserted as a composition
 * here because the panel closure isn't reachable without a live provenance
 * round-trip — and because before N3 the two halves disagreed: `availableScopes`
 * offered `token` for an href-less first-party sheet while the resolver refused
 * it, so the tile was silently withheld on every Vite dev substrate.
 */
describe("the token scope's enabling condition (inline <style> sheets)", () => {
  const REPO = "/Users/mo/proto"
  const tokenOrigin = (stylesheet: {
    href: string
    sourceHint?: string
    package?: string
  }): StyleOrigin => ({
    property: "background-color",
    computedValue: "rgb(255, 255, 255)",
    winningRule: {
      selector: ".input",
      stylesheet: { href: "<style>" },
      declaration: "background-color: var(--acme-color-background)",
      specificity: [0, 1, 0],
    },
    varChain: [
      {
        name: "--acme-color-background",
        value: "#ffffff",
        definedAt: { selector: ":root", stylesheet },
      },
    ],
  })
  const enabled = (origin: StyleOrigin) =>
    availableScopes(origin).includes("token") &&
    resolveTokenScopeFile(origin, { repoRoot: REPO }) !== null

  it("enables the token scope for a FIRST-PARTY inline <style> sheet", () => {
    expect(
      enabled(tokenOrigin({ href: "<style>", sourceHint: `${REPO}/src/style.css` })),
    ).toBe(true)
  })

  it("still refuses a PACKAGE inline <style> sheet (can't write node_modules)", () => {
    expect(
      enabled(
        tokenOrigin({
          href: "<style>",
          sourceHint: `${REPO}/node_modules/@acme/design-system/dist/style.css`,
          package: "@acme/design-system",
        }),
      ),
    ).toBe(false)
  })

  it("still refuses an inline sheet with no source hint at all", () => {
    expect(enabled(tokenOrigin({ href: "<style>" }))).toBe(false)
  })
})

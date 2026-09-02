/**
 * `resolveProbeCssImports` — the isolation page's stylesheet discovery.
 *
 * Replaces a hardcoded one-vendor map. The rules under test are the two
 * gates (component library / concrete CSS entry) and the one-per-package
 * ordering; see the doc comment on the function itself for why each exists.
 */
import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { resolveProbeCssImports } from "../../core.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

async function mkPrototype(deps: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "probe-css-"))
  roots.push(root)
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", version: "0.0.0", dependencies: deps }),
  )
  return root
}

async function installPackage(
  root: string,
  name: string,
  pkgJson: Record<string, unknown>,
  /**
   * Files the package actually SHIPS, relative to its own directory.
   *
   * Not decoration. Until 2026-08-16 this helper wrote a package.json and
   * nothing else, so every fixture described stylesheets that did not exist
   * on disk — which is precisely the condition the discovery failed to
   * reject, and precisely why these tests passed while the real thing was
   * broken. `@kong/icons@1.48.0` declares `"./dist/style.css":
   * "./dist/kong-icons.css"` and ships `dist/icons.css`; Vite resolved the
   * export map, found no file, and 500'd the isolation page, which took the
   * whole hint-generation lane down with it. A fixture that never creates a
   * file cannot tell a shipped stylesheet from a dangling one.
   */
  files: string[] = [],
): Promise<void> {
  const dir = join(root, "node_modules", ...name.split("/"))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...pkgJson }))
  for (const file of files) {
    const target = join(dir, file)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, "/* fixture */")
  }
}

describe("resolveProbeCssImports", () => {
  it("returns nothing for a prototype with no package.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "probe-css-"))
    roots.push(root)
    expect(resolveProbeCssImports(root)).toEqual([])
  })

  it("resolves a component library's CSS export key to an importable specifier", async () => {
    const root = await mkPrototype({ "@acme/design-system": "^1.0.0" })
    await installPackage(root, "@acme/design-system", {
      peerDependencies: { vue: "^3.0.0" },
      exports: { ".": "./dist/index.js", "./dist/style.css": "./dist/acme.css" },
    }, ["dist/acme.css"])

    // The export KEY is the importable specifier — NOT the value it maps to.
    expect(resolveProbeCssImports(root)).toEqual(["@acme/design-system/dist/style.css"])
  })

  it("prefers a `style` field over an exports key", async () => {
    const root = await mkPrototype({ "@acme/design-system": "^1.0.0" })
    await installPackage(root, "@acme/design-system", {
      peerDependencies: { react: "^18.0.0" },
      style: "./dist/from-style-field.css",
      exports: { "./dist/other.css": "./dist/other.css" },
    }, ["dist/from-style-field.css", "dist/other.css"])

    expect(resolveProbeCssImports(root)).toEqual([
      "@acme/design-system/dist/from-style-field.css",
    ])
  })

  it("skips a package that publishes CSS but is not a component library", async () => {
    // The gate that matters most: a CSS framework and a font package both
    // publish stylesheets, and injecting either into the isolation page is
    // wrong. Neither declares vue/react as a dependency or peer.
    const root = await mkPrototype({ tailwindcss: "^4.0.0", "@fontsource/inter": "^5.0.0" })
    await installPackage(root, "tailwindcss", {
      exports: { "./index.css": "./index.css" },
    })
    await installPackage(root, "@fontsource/inter", {
      exports: { "./index.css": "./index.css" },
    })

    expect(resolveProbeCssImports(root)).toEqual([])
  })

  it("skips a component library that publishes no CSS at all", async () => {
    const root = await mkPrototype({ "@acme/headless": "^1.0.0" })
    await installPackage(root, "@acme/headless", {
      peerDependencies: { vue: "^3.0.0" },
      exports: { ".": "./dist/index.js" },
    })

    expect(resolveProbeCssImports(root)).toEqual([])
  })

  it("rejects wildcard CSS export keys — they are not importable specifiers", async () => {
    const root = await mkPrototype({ "@acme/icons": "^1.0.0" })
    await installPackage(root, "@acme/icons", {
      peerDependencies: { vue: "^3.0.0" },
      exports: { "./*.css": "./*.css" },
    })

    expect(resolveProbeCssImports(root)).toEqual([])
  })

  it("rejects an export key whose target file is not shipped", async () => {
    // The regression that motivated gate 3, reproduced from the real thing:
    // `@kong/icons@1.48.0` maps "./dist/style.css" to "./dist/kong-icons.css"
    // and ships neither — it ships `dist/icons.css`. The specifier passes
    // gate 1 (a Vue component library) and gate 2 (names a concrete,
    // non-wildcard .css entry), then fails to resolve in Vite, and the
    // isolation page 500s.
    //
    // The cost is wildly out of proportion to the cause: ONE unrelated
    // dependency naming a stylesheet it does not ship took hint generation
    // from 68 components to zero, every run, reported only as "mount
    // container (.variant-cell-mount) not found". A package with NO
    // stylesheet is harmless here — the probe reads text and attribute
    // values, never paint — but a dangling one is strictly worse than none.
    const root = await mkPrototype({ "@acme/icons": "^1.0.0" })
    await installPackage(
      root,
      "@acme/icons",
      {
        peerDependencies: { vue: "^3.0.0" },
        exports: { "./dist/style.css": "./dist/renamed.css" },
      },
      ["dist/actually-shipped.css"],
    )

    expect(resolveProbeCssImports(root)).toEqual([])
  })

  it("rejects a `style` field naming a file that is not shipped", async () => {
    const root = await mkPrototype({ "@acme/design-system": "^1.0.0" })
    await installPackage(root, "@acme/design-system", {
      peerDependencies: { vue: "^3.0.0" },
      style: "./dist/missing.css",
    })

    expect(resolveProbeCssImports(root)).toEqual([])
  })

  it("skips a dangling entry and still takes a sibling that IS shipped", async () => {
    // Gate 3 filters candidates BEFORE the preference rule runs. Order
    // matters: `style.css` is the preferred name, so a package whose
    // preferred entry dangles must not lose the working one behind it.
    const root = await mkPrototype({ "@acme/design-system": "^1.0.0" })
    await installPackage(
      root,
      "@acme/design-system",
      {
        peerDependencies: { vue: "^3.0.0" },
        exports: {
          "./dist/style.css": "./dist/missing.css",
          "./dist/theme.css": "./dist/theme.css",
        },
      },
      ["dist/theme.css"],
    )

    expect(resolveProbeCssImports(root)).toEqual(["@acme/design-system/dist/theme.css"])
  })

  it("follows a condition object down to the file it names", async () => {
    // Export targets are not always bare strings.
    const root = await mkPrototype({ "@acme/design-system": "^1.0.0" })
    await installPackage(
      root,
      "@acme/design-system",
      {
        peerDependencies: { vue: "^3.0.0" },
        exports: { "./dist/style.css": { default: "./dist/real.css" } },
      },
      ["dist/real.css"],
    )

    expect(resolveProbeCssImports(root)).toEqual(["@acme/design-system/dist/style.css"])
  })

  it("takes ONE stylesheet from a package that ships a theme matrix", async () => {
    // A calendar/theme package can export 25 palette stylesheets. Splicing
    // all of them into the isolation page is both wrong and slow.
    const root = await mkPrototype({ "@acme/calendar": "^1.0.0" })
    await installPackage(root, "@acme/calendar", {
      peerDependencies: { react: "^18.0.0" },
      exports: {
        "./themes/blue.css": "./themes/blue.css",
        "./themes/red.css": "./themes/red.css",
        "./dist/style.css": "./dist/style.css",
      },
    }, ["themes/blue.css", "themes/red.css", "dist/style.css"])

    // `style.css` is preferred over the theme variants.
    expect(resolveProbeCssImports(root)).toEqual(["@acme/calendar/dist/style.css"])
  })

  it("skips a declared dependency that is not installed", async () => {
    const root = await mkPrototype({ "@acme/design-system": "^1.0.0" })
    expect(resolveProbeCssImports(root)).toEqual([])
  })
})

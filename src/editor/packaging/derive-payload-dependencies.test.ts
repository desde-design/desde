import { describe, expect, it } from "vitest"
import { derivePayloadDependencies } from "./derive-payload-dependencies"

/**
 * A minimal but shape-accurate esbuild metafile: real ones (`editor-cli/dist/
 * metafile.json`) run to hundreds of KB, but `derivePayloadDependencies` only
 * ever reads `outputs[*].imports[].{path,external}` — everything else is
 * along for the ride and irrelevant here.
 */
function metafileWith(
  outputs: Record<string, { imports?: Array<{ path: string; external?: boolean }> }>,
): { inputs: Record<string, unknown>; outputs: Record<string, unknown> } {
  return { inputs: {}, outputs }
}

describe("derivePayloadDependencies", () => {
  it("keeps only external imports, resolving each to its pinned version", () => {
    const metafile = metafileWith({
      "dist/cli.js": {
        imports: [
          { path: "vite", external: true },
          { path: "zod", external: true },
          // Non-external: esbuild inlined it — must not appear in the payload.
          { path: "./local-module.js", external: false },
        ],
      },
    })
    const deps = derivePayloadDependencies(metafile, (pkg) =>
      pkg === "vite" ? "8.2.1" : "4.4.3",
    )
    expect(deps).toEqual({ vite: "8.2.1", zod: "4.4.3" })
  })

  it("drops Node builtins, both `node:`-prefixed and legacy unprefixed", () => {
    const metafile = metafileWith({
      "dist/cli.js": {
        imports: [
          { path: "node:fs", external: true },
          { path: "node:child_process", external: true },
          { path: "fs", external: true },
          { path: "path", external: true },
          { path: "vite", external: true },
        ],
      },
    })
    const deps = derivePayloadDependencies(metafile, () => "0.0.0")
    expect(deps).toEqual({ vite: "0.0.0" })
  })

  it("collapses a scoped subpath import to its owning package", () => {
    // The real mcp.js output imports `@modelcontextprotocol/sdk/server/mcp.js`
    // and `.../server/stdio.js` — two distinct specifiers, one npm package.
    // A payload installs the package, not either subpath.
    const metafile = metafileWith({
      "dist/mcp.js": {
        imports: [
          { path: "@modelcontextprotocol/sdk/server/mcp.js", external: true },
          { path: "@modelcontextprotocol/sdk/server/stdio.js", external: true },
        ],
      },
    })
    const resolved: string[] = []
    const deps = derivePayloadDependencies(metafile, (pkg) => {
      resolved.push(pkg)
      return "1.29.0"
    })
    expect(deps).toEqual({ "@modelcontextprotocol/sdk": "1.29.0" })
    // resolveVersion called exactly once per PACKAGE, not once per specifier.
    expect(resolved).toEqual(["@modelcontextprotocol/sdk"])
  })

  it("unions externals across every output — cli.js and mcp.js both count", () => {
    const metafile = metafileWith({
      "dist/cli.js": { imports: [{ path: "vite", external: true }] },
      "dist/mcp.js": { imports: [{ path: "zod", external: true }] },
      // A .map output carries no `imports` field at all — must not throw.
      "dist/cli.js.map": {},
    })
    const deps = derivePayloadDependencies(metafile, () => "x")
    expect(deps).toEqual({ vite: "x", zod: "x" })
  })

  it("sorts dependency keys — a stable, reviewable generated package.json", () => {
    const metafile = metafileWith({
      "dist/cli.js": {
        imports: [
          { path: "zod", external: true },
          { path: "@anthropic-ai/sdk", external: true },
          { path: "vite", external: true },
        ],
      },
    })
    const deps = derivePayloadDependencies(metafile, () => "x")
    expect(Object.keys(deps)).toEqual(["@anthropic-ai/sdk", "vite", "zod"])
  })

  /**
   * The finding that motivated this whole module (see the file's own doc
   * comment): `typescript` and `vue-component-meta` are devDependencies in
   * BOTH `editor-cli/package.json` and root `package.json`, yet
   * `build-manifest-source.ts` imports both at runtime with no try/catch. If
   * either is missing from the payload, the manifest/grounding panel throws
   * the first time anyone opens it — not a degraded experience, a crash. This
   * test is the regression guard: it fails the instant a future refactor of
   * the derivation logic starts filtering by "is this a devDependency
   * somewhere" instead of "did esbuild mark this external."
   */
  it("carries typescript and vue-component-meta through, same as any other external", () => {
    const metafile = metafileWith({
      "dist/cli.js": {
        imports: [
          { path: "typescript", external: true },
          { path: "vue-component-meta", external: true },
        ],
      },
    })
    const deps = derivePayloadDependencies(metafile, (pkg) =>
      pkg === "typescript" ? "5.9.3" : "3.2.7",
    )
    expect(deps).toEqual({ typescript: "5.9.3", "vue-component-meta": "3.2.7" })
  })

  it("returns an empty object for a metafile with no externals", () => {
    const metafile = metafileWith({ "dist/cli.js": { imports: [] } })
    expect(derivePayloadDependencies(metafile, () => "x")).toEqual({})
  })
})

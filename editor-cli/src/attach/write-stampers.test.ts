/**
 * The stampers the CLI writes into a prototype's `.desde/stamp/`.
 *
 * These tests LOAD the generated files and run them, rather than asserting on
 * their text. That is the only assertion that means anything here: the whole
 * failure mode this module exists to prevent is a stamper that the user's dev
 * server cannot import or that stamps the wrong coordinates, and neither shows
 * up in a snapshot of the bytes.
 */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterAll, describe, expect, it } from "vitest"
import type { RequiredStamperFile } from "../attach-preflight/index.js"
import { nextLoaderFiles, vitePluginFiles } from "../attach-preflight/index.js"
import { buildStampPolicy } from "../hosts/stamp-policy.js"
import { writeStamperFiles } from "./write-stampers.js"

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterAll(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

async function mkRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "editor-cli-stamp-"))
  roots.push(root)
  await mkdir(join(root, "src"), { recursive: true })
  return root
}

/**
 * Load the written stampers in a SEPARATE node process, from the prototype
 * directory, with no help from this test's own module graph. That is how the
 * user's dev server will load them, and it is the only way to catch an import
 * that only resolves because vitest happens to have the package already.
 */
async function runInPrototype(root: string, script: string): Promise<string> {
  const path = join(root, "probe.mjs")
  await writeFile(path, script)
  const { stdout } = await execFileAsync(process.execPath, [path], { cwd: root })
  return stdout.trim()
}

describe("writeStamperFiles — vite lanes", () => {
  it("writes a plugin that loads standalone and stamps repo-relative coordinates", async () => {
    const root = await mkRoot()
    await writeFile(
      join(root, "src/Page.tsx"),
      "export function Page() {\n  return <div className='p'><span>hi</span></div>\n}\n",
    )
    const result = await writeStamperFiles({
      destDir: root,
      files: vitePluginFiles("react"),
    })
    expect(result.written).toEqual([
      ".desde/stamp/jsx-source-tag.mjs",
      ".desde/stamp/jsx-source-tag.d.mts",
    ])

    const out = await runInPrototype(
      root,
      `import { readFileSync } from "node:fs"
import factory from "./.desde/stamp/jsx-source-tag.mjs"
const p = factory()
const r = p.transform(readFileSync("src/Page.tsx", "utf8"), process.cwd() + "/src/Page.tsx")
console.log(JSON.stringify({
  name: p.name, enforce: p.enforce, apply: p.apply,
  stamps: [...r.code.matchAll(/data-desde-src="([^"]+)"/g)].map((m) => m[1]),
}))`,
    )
    const probe = JSON.parse(out) as {
      name: string
      enforce: string
      apply: string
      stamps: string[]
    }
    expect(probe.enforce).toBe("pre")
    // `apply: 'serve'` is this lane's ONLY production gate. Without it a
    // `nuxt build` / `astro build` stamps the output and ships internal source
    // paths to end users.
    expect(probe.apply).toBe("serve")
    // Relative to the directory holding `.desde/`, derived from the
    // bundle's own location — nothing is passed in.
    expect(probe.stamps).toEqual(["src/Page.tsx:2:9", "src/Page.tsx:2:28"])
  })

  it("emits a self-contained declaration beside the plugin", async () => {
    const root = await mkRoot()
    await writeStamperFiles({ destDir: root, files: vitePluginFiles("vue3") })
    const dts = await readFile(join(root, ".desde/stamp/vue-source-tag.d.mts"), "utf8")
    // A `.ts` config importing a bare `.mjs` fails with TS7016, which breaks
    // `nuxt typecheck` for anyone who runs it.
    expect(dts).toMatch(/export default desdeSourceTag/)
    // Importing Vite's types here would be unresolvable in a prototype that
    // has no Vite dependency of its own (the Nuxt dashboard template has none).
    expect(dts).not.toMatch(/from ['"]vite['"]/)
  })

  it("keeps the Vue compiler out of the React bundle", async () => {
    const root = await mkRoot()
    await writeStamperFiles({ destDir: root, files: vitePluginFiles("react") })
    const code = await readFile(join(root, ".desde/stamp/jsx-source-tag.mjs"), "utf8")
    expect(code).not.toContain("@vue/compiler-sfc")
  })
})

describe("writeStamperFiles — next lane", () => {
  it("writes a CommonJS loader that is the function itself, not a namespace", async () => {
    const root = await mkRoot()
    await writeFile(join(root, "src/Page.jsx"), "export const P = () => <div><b>x</b></div>\n")
    const result = await writeStamperFiles({ destDir: root, files: nextLoaderFiles() })
    expect(result.written).toEqual([".desde/stamp/next-loader.cjs"])

    const out = await runInPrototype(
      root,
      `import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const loader = require("./.desde/stamp/next-loader.cjs")
const src = readFileSync("src/Page.jsx", "utf8")
const stamped = loader.call({ resourcePath: process.cwd() + "/src/Page.jsx" }, src)
console.log(JSON.stringify({
  type: typeof loader,
  stamps: [...stamped.matchAll(/data-desde-src="([^"]+)"/g)].map((m) => m[1]),
  // A throwing loader breaks the user's dev server outright; an unstamped file
  // only makes one file inspect-only. It must always choose the second.
  survivesGarbage: loader.call({ resourcePath: "/x/y.jsx" }, "not { valid (jsx") === "not { valid (jsx",
  survivesNoContext: loader.call({}, "const a = 1") === "const a = 1",
}))`,
    )
    const probe = JSON.parse(out) as Record<string, unknown>
    expect(probe.type).toBe("function")
    // Hand-checked against the source line: `<div>` opens at index 23 and
    // `<b>` at 28, and Babel reports 1-based lines with 0-based columns.
    expect(probe.stamps).toEqual(["src/Page.jsx:1:23", "src/Page.jsx:1:28"])
    expect(probe.survivesGarbage).toBe(true)
    expect(probe.survivesNoContext).toBe(true)
  })

  it("stamps identically to the Vite lane, because it wraps the same transform", async () => {
    const root = await mkRoot()
    await writeFile(join(root, "src/Page.jsx"), "export const P = () => <div><b>x</b></div>\n")
    await writeStamperFiles({ destDir: root, files: nextLoaderFiles() })
    await writeStamperFiles({ destDir: root, files: vitePluginFiles("react") })
    const out = await runInPrototype(
      root,
      `import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import factory from "./.desde/stamp/jsx-source-tag.mjs"
const require = createRequire(import.meta.url)
const src = readFileSync("src/Page.jsx", "utf8")
const id = process.cwd() + "/src/Page.jsx"
const viaVite = factory().transform(src, id).code
const viaNext = require("./.desde/stamp/next-loader.cjs").call({ resourcePath: id }, src)
console.log(JSON.stringify({ identical: viaVite === viaNext }))`,
    )
    expect(JSON.parse(out)).toEqual({ identical: true })
  })
})

/**
 * The Next loader is the one stamper with two homes: attach mode writes it into
 * the user's repository, and the in-process Next host writes it into a per-user
 * cache dir so the repository is never touched. Everything below is about the
 * second home, and about the fact that the first one's `__dirname` derivation
 * cannot serve it.
 */
describe("writeStamperFiles — the Next loader outside the repo", () => {
  /**
   * What the in-process host asks for: the same declared loader, at the root of
   * a directory it owns. `path` is the caller's choice — attach mode's
   * `.desde/stamp/` prefix exists because its generated config block
   * imports the file relative to the user's config, and nothing in the
   * in-process lane does.
   */
  function inProcessLoaderFiles(): RequiredStamperFile[] {
    return nextLoaderFiles().map((file) => ({ ...file, path: "next-loader.cjs" }))
  }

  it("takes its scope from loader options, so the bundle can live anywhere", async () => {
    const root = await mkRoot()
    await writeFile(join(root, "src/Page.jsx"), "export const P = () => <div><b>x</b></div>\n")

    // A sibling temp dir, NOT under the repo — standing in for the per-user
    // cache dir the in-process host materializes into.
    const cacheDir = await mkdtemp(join(tmpdir(), "editor-cli-stamp-cache-"))
    roots.push(cacheDir)
    const result = await writeStamperFiles({ destDir: cacheDir, files: inProcessLoaderFiles() })
    expect(result.written).toEqual(["next-loader.cjs"])
    const loaderPath = join(cacheDir, "next-loader.cjs")

    // Both aliases, exactly as `core.ts` computes them: on macOS a `tmpdir()`
    // path is reached through the `/var` → `/private/var` symlink, and the
    // child process reports the resolved one from `process.cwd()`.
    const policy = buildStampPolicy({ repoRoot: root, repoRootReal: await realpath(root) })

    const out = await runInPrototype(
      root,
      `import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const loader = require(${JSON.stringify(loaderPath)})
const src = readFileSync("src/Page.jsx", "utf8")
const id = process.cwd() + "/src/Page.jsx"
// Interpolated as JSON because that is how it really arrives: Turbopack runs
// loaders in a forked worker and only structured-cloneable options survive.
const policy = ${JSON.stringify(policy)}
const stamps = (code) => [...code.matchAll(/data-desde-src="([^"]+)"/g)].map((m) => m[1])
const withOptions = loader.call({ resourcePath: id, getOptions: () => ({ repoRoot: process.cwd(), policy }) }, src)
const noOptions = loader.call({ resourcePath: id }, src)
const emptyOptions = loader.call({ resourcePath: id, getOptions: () => ({}) }, src)
const badPolicy = loader.call(
  { resourcePath: id, getOptions: () => ({ policy: { ...policy, roots: ["not-absolute"] } }) },
  src,
)
console.log(JSON.stringify({
  withOptions: stamps(withOptions),
  noOptions: stamps(noOptions),
  emptyMatchesNoOptions: emptyOptions === noOptions,
  badPolicyUnchanged: badPolicy === src,
}))`,
    )
    const probe = JSON.parse(out) as {
      withOptions: string[]
      noOptions: string[]
      emptyMatchesNoOptions: boolean
      badPolicyUnchanged: boolean
    }

    // Same coordinates the in-repo copy produces — the file moved, the stamps
    // did not.
    expect(probe.withOptions).toEqual(["src/Page.jsx:1:23", "src/Page.jsx:1:28"])

    // WHY the options channel is not optional. From a cache dir the `__dirname`
    // fallback derives a root two levels above the bundle, which has nothing to
    // do with the project: depending on where the OS put the temp dirs that is
    // either no stamps at all (containment refuses) or stamps carrying the
    // wrong prefix. Both are failures and neither is asserted specifically —
    // the durable claim is that the fallback cannot answer for a bundle outside
    // the repo, which is why the host passes a policy.
    expect(probe.noOptions).not.toEqual(probe.withOptions)

    // Webpack hands `{}` to a loader registered with no options, and that is
    // the ABSENCE of a scope, not a broken one — it has to reach the
    // `__dirname` fallback that every attach-mode installation depends on.
    expect(probe.emptyMatchesNoOptions).toBe(true)

    // A malformed policy is refused outright rather than silently downgraded to
    // the `__dirname` guess. Stamping against a root nobody chose is the one
    // failure worse than not stamping: the edit server resolves the path
    // against the prototype root and can land on a different existing file.
    expect(probe.badPolicyUnchanged).toBe(true)
  })
})

describe("writeStamperFiles — freshness", () => {
  it("re-bundles once, then recognises the output as current", async () => {
    const root = await mkRoot()
    const files = vitePluginFiles("react")
    expect((await writeStamperFiles({ destDir: root, files })).rebuilt).toBe(true)
    expect((await writeStamperFiles({ destDir: root, files })).rebuilt).toBe(false)
  })

  it("rebuilds when the bundle is gone, so a deleted file cannot stay deleted", async () => {
    const root = await mkRoot()
    const files = vitePluginFiles("react")
    await writeStamperFiles({ destDir: root, files })
    await rm(join(root, ".desde/stamp/jsx-source-tag.mjs"))
    expect((await writeStamperFiles({ destDir: root, files })).rebuilt).toBe(true)
  })

  it("rebuilds when a first-party source file behind the bundle changes", async () => {
    const root = await mkRoot()
    const files = vitePluginFiles("react")
    await writeStamperFiles({ destDir: root, files })

    // The cache key is the CONTENT of the modules the bundler actually pulled
    // in, recorded from its own `moduleIds`. Touching one of them by rewriting
    // the recorded hash simulates a source edit without mutating this repo.
    const infoPath = join(root, ".desde/stamp/.build-info.json")
    const info = JSON.parse(await readFile(infoPath, "utf8")) as {
      outputs: Record<string, { sources: string[]; hash: string }>
    }
    expect(info.outputs["jsx-source-tag.mjs"].sources.length).toBeGreaterThan(1)
    info.outputs["jsx-source-tag.mjs"].hash = "stale"
    await writeFile(infoPath, JSON.stringify(info))

    expect((await writeStamperFiles({ destDir: root, files })).rebuilt).toBe(true)
  })
})

describe("writeStamperFiles — the one external", () => {
  it("warns when @vue/compiler-sfc will not resolve from the prototype", async () => {
    const root = await mkRoot()
    const result = await writeStamperFiles({ destDir: root, files: vitePluginFiles("vue3") })
    // A temp dir with no node_modules anywhere above it — the same shape a
    // pnpm project presents, where `@vue/compiler-sfc` is a transitive dep and
    // is not linked at the top level. Without this warning the user's dev
    // server fails to load its config with no explanation of why.
    const joined = result.warnings.join("\n")
    expect(joined).toMatch(/@vue\/compiler-sfc/)
    expect(joined).toMatch(/npm i -D/)
  })

  it("says nothing about the external on the React lane, which has none", async () => {
    const root = await mkRoot()
    const result = await writeStamperFiles({ destDir: root, files: vitePluginFiles("react") })
    expect(result.warnings).toEqual([])
  })
})

describe("writeStamperFiles — a symlinked .desde", () => {
  it("FX4 item 2: writes nothing outside the working tree, and says why in a warning", async () => {
    const root = await mkRoot()
    const outside = await mkdtemp(join(tmpdir(), "editor-cli-stamp-outside-"))
    roots.push(outside)
    await symlink(outside, join(root, ".desde"))

    const result = await writeStamperFiles({ destDir: root, files: vitePluginFiles("react") })

    expect(result.written).toEqual([])
    expect(result.warnings.join(" ")).toMatch(/symbolic link/i)
    expect(await readdir(outside)).toEqual([])
    expect(existsSync(join(outside, "stamp"))).toBe(false)
  })
})

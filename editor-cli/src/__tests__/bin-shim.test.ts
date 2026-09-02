/**
 * `editor-cli/bin/desde.mjs` and `editor-cli/bin/desde-
 * editor-mcp.mjs` each decide, on every invocation, whether to import the
 * built bundle (`../dist/cli.js` / `../dist/mcp.js`) directly or respawn
 * under the tsx loader to run the TS source live. Until this fix, the rule
 * was "prefer the bundle whenever it happens to exist" — which meant the
 * FIRST `npm run build:server` in a checkout made every later run silently
 * use that (possibly stale) bundle forever after, including runs right
 * after editing `src/**`. The fixed rule: prefer the bundle only when there
 * is no source file beside it — the shape of a packaged payload
 * (`scripts/build-server-package.mts` never copies `src/`), not a
 * checkout. `DESDE_EDITOR_USE_BUNDLE=1` is the explicit override.
 *
 * These tests run the REAL shim files (copied byte-for-byte into a scratch
 * directory, not reimplemented) against constructed `dist/` / `src/`
 * layouts, so they exercise the actual decision logic rather than a
 * restatement of it. They don't need a working tsx/TypeScript pipeline —
 * only to prove WHICH branch fires — so the scratch `dist/*.js` and the
 * scratch `node_modules/tsx/dist/loader.mjs` are each a one-line script
 * that prints a distinguishing marker and exits immediately. `--import`
 * runs a preloaded module for its side effects before the main entry is
 * ever reached, so `process.exit()` inside the fake loader is enough to
 * prove the respawn happened without any real TS transpilation involved.
 */
import { execFile } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve as resolvePath } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

const EDITOR_CLI_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "..")

const BUNDLE_MARKER = "BUNDLE_PATH_TAKEN"
const TSX_MARKER = "TSX_RESPAWN_PATH_TAKEN"

interface ShimFixture {
  /** Human-readable label for the describe block. */
  label: string
  /** The real shim file to copy into the scratch bin/. */
  realShim: string
  /** Name to give the copied shim under `<scratch>/bin/`. */
  shimBasename: string
  /** `dist/<name>` — the built bundle this shim looks for. */
  distBasename: string
  /** `src/<...>` — the source file whose presence should make source win. */
  srcRelPath: string[]
}

const SHIMS: ShimFixture[] = [
  {
    label: "desde.mjs",
    realShim: join(EDITOR_CLI_ROOT, "bin", "desde.mjs"),
    shimBasename: "desde.mjs",
    distBasename: "cli.js",
    srcRelPath: ["cli.ts"],
  },
  {
    label: "desde-mcp.mjs",
    realShim: join(EDITOR_CLI_ROOT, "bin", "desde-mcp.mjs"),
    shimBasename: "desde-mcp.mjs",
    distBasename: "mcp.js",
    srcRelPath: ["mcp-proxy", "stdio-server.ts"],
  },
]

/**
 * Builds `<scratch>/bin/<shim>` (the real file, copied) plus a fake
 * `dist/<bundle>`, and — when `withSrc` — a fake source file at the shim's
 * expected path and a fake `node_modules/tsx/dist/loader.mjs` standing in
 * for the real tsx loader the respawn path would otherwise `--import`.
 */
function setupScratch(fixture: ShimFixture, withSrc: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "bin-shim-test-"))
  mkdirSync(join(root, "bin"), { recursive: true })
  copyFileSync(fixture.realShim, join(root, "bin", fixture.shimBasename))

  mkdirSync(join(root, "dist"), { recursive: true })
  writeFileSync(
    join(root, "dist", fixture.distBasename),
    `console.log(${JSON.stringify(BUNDLE_MARKER)});\nprocess.exit(0);\n`,
  )

  if (withSrc) {
    const srcPath = join(root, "src", ...fixture.srcRelPath)
    mkdirSync(dirname(srcPath), { recursive: true })
    // Never actually loaded by these tests — the fake loader below exits
    // before Node would ever reach it. Its mere EXISTENCE on disk is what
    // the shim's `useBundle` check is testing.
    writeFileSync(srcPath, `export {}\n`)

    mkdirSync(join(root, "node_modules", "tsx", "dist"), { recursive: true })
    writeFileSync(
      join(root, "node_modules", "tsx", "dist", "loader.mjs"),
      // Also prints the tsconfig pin so the alias-resolution test below can
      // assert what the respawn actually exported, not a restatement of it.
      `console.log(${JSON.stringify(TSX_MARKER)});\n` +
        `console.log("TSX_TSCONFIG_PATH=" + (process.env.TSX_TSCONFIG_PATH ?? ""));\n` +
        `process.exit(0);\n`,
    )
  }

  return root
}

/** Runs the scratch shim, tolerating a non-zero exit (some cases expect one). */
async function runShim(
  root: string,
  shimBasename: string,
  env: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [join(root, "bin", shimBasename)], {
      cwd: root,
      env: { ...process.env, ...env },
    })
    return { stdout, stderr, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 }
  }
}

describe.each(SHIMS)("editor-cli bin shim — bundle vs. source ($label)", (fixture) => {
  const scratches: string[] = []
  afterEach(() => {
    for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it(`takes the bundle path when dist/${fixture.distBasename} exists with no source beside it (the payload shape)`, async () => {
    const root = setupScratch(fixture, false)
    scratches.push(root)

    const { stdout, code } = await runShim(root, fixture.shimBasename)

    expect(code).toBe(0)
    expect(stdout).toContain(BUNDLE_MARKER)
    expect(stdout).not.toContain(TSX_MARKER)
  })

  it("pins TSX_TSCONFIG_PATH to the checkout root tsconfig on respawn, so a launch cwd outside the checkout still resolves @/ aliases", async () => {
    const root = setupScratch(fixture, true)
    scratches.push(root)
    const outsideCwd = mkdtempSync(join(tmpdir(), "bin-shim-outside-"))
    scratches.push(outsideCwd)

    // tsx discovers the alias tsconfig from the PROCESS CWD. Before the pin,
    // launching the dev shim from a directory outside the checkout (a user's
    // own prototype dir is the natural case) crashed on the first `@/` import
    // with MODULE_NOT_FOUND. The respawn must export the checkout's root
    // tsconfig instead of leaving discovery to whatever cwd the OS handed us.
    const { stdout: pinned, code } = await (async () => {
      try {
        const r = await execFileAsync(
          process.execPath,
          [join(root, "bin", fixture.shimBasename)],
          { cwd: outsideCwd, env: { ...process.env, TSX_TSCONFIG_PATH: undefined } },
        )
        return { stdout: r.stdout, code: 0 }
      } catch (err) {
        const e = err as { stdout?: string; code?: number }
        return { stdout: e.stdout ?? "", code: e.code ?? 1 }
      }
    })()
    expect(code).toBe(0)
    // realpath: mkdtemp hands back the /var symlink on macOS while the shim
    // resolves through import.meta.url, which is already under /private/var.
    expect(pinned).toContain(`TSX_TSCONFIG_PATH=${resolvePath(realpathSync(root), "..", "tsconfig.json")}`)

    // A caller-set value still wins: the pin is a default, not an override.
    const { stdout: custom } = await runShim(root, fixture.shimBasename, {
      TSX_TSCONFIG_PATH: "/custom/tsconfig.json",
    })
    expect(custom).toContain("TSX_TSCONFIG_PATH=/custom/tsconfig.json")
  })

  it("takes the tsx dev path when the source file exists beside the bundle (the checkout shape) — this is the behavior change", async () => {
    const root = setupScratch(fixture, true)
    scratches.push(root)

    const { stdout, code } = await runShim(root, fixture.shimBasename)

    expect(code).toBe(0)
    expect(stdout).toContain(TSX_MARKER)
    // The whole point of the fix: a stale bundle beside current source must
    // NOT be what runs.
    expect(stdout).not.toContain(BUNDLE_MARKER)
  })

  it("DESDE_EDITOR_USE_BUNDLE=1 forces the bundle path even with source present", async () => {
    const root = setupScratch(fixture, true)
    scratches.push(root)

    const { stdout, code } = await runShim(root, fixture.shimBasename, { DESDE_EDITOR_USE_BUNDLE: "1" })

    expect(code).toBe(0)
    expect(stdout).toContain(BUNDLE_MARKER)
    expect(stdout).not.toContain(TSX_MARKER)
  })

  it("DESDE_EDITOR_USE_BUNDLE=1 with no built bundle fails loudly instead of silently falling back", async () => {
    const root = setupScratch(fixture, true)
    scratches.push(root)
    rmSync(join(root, "dist", fixture.distBasename))

    const { stderr, code } = await runShim(root, fixture.shimBasename, { DESDE_EDITOR_USE_BUNDLE: "1" })

    expect(code).not.toBe(0)
    expect(stderr).toContain("DESDE_EDITOR_USE_BUNDLE=1")
    // Deliberately just the filename, not the full scratch path — robust to
    // where the OS put the temp dir.
    expect(stderr).toContain(`dist/${fixture.distBasename}`)
  })
})

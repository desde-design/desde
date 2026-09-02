/**
 * Attach-mode boot wiring: the `--attach` URL contract and the refusal a user
 * hits when they open a repo Editor cannot supervise.
 *
 * The pure helpers are tested directly because their OUTPUT is the product —
 * `buildAttachRequiredMessage` is the only thing standing between a Next user
 * and a dead end, and `parseAttachUrl` is what keeps a malformed upstream from
 * reaching the proxy as a silently-wrong origin.
 *
 * `startCore` itself is exercised for the refusal path only. That is
 * deliberate: the refusal fires before any port is bound, any plugin built or
 * any dev server started, so the assertion "a Next repo refuses" costs nothing
 * and proves the gate sits early. Booting the success path would need a real
 * running upstream and belongs in the live harness.
 */
import { afterEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  AttachRequiredError,
  HostAmbiguousError,
  StampingRequiredError,
  assertStampableLayout,
  buildAttachRequiredMessage,
  formatStampingRefusal,
  parseAttachUrl,
  runAttachStampingGate,
  startCore,
} from "../core.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

async function mkNextRepo(config = "export default {}"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "editor-cli-attach-"))
  roots.push(root)
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { next: "^16.3.0", react: "^19.2.8" } }),
  )
  await writeFile(join(root, "next.config.mjs"), config)
  return root
}

function gate(root: string, over: Partial<Parameters<typeof runAttachStampingGate>[0]> = {}) {
  return runAttachStampingGate({
    prototypeRoot: root,
    // ONE host parameter now. `attachHostFor(host, metaFramework)` was deleted
    // with the boot-path tiers it translated; the caller passes
    // `attachConfigHostFor(detection)`, which is a ranked read of evidence.
    host: "next",
    framework: "react",
    proxyOrigin: "http://127.0.0.1",
    ...over,
  })
}

describe("parseAttachUrl", () => {
  it("normalises a dev server URL to its origin", () => {
    expect(parseAttachUrl("http://localhost:3000")).toBe("http://localhost:3000")
    expect(parseAttachUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000")
    expect(parseAttachUrl("https://dev.internal:8443/")).toBe("https://dev.internal:8443")
  })

  it("refuses a URL carrying a path, and names the value to pass instead", () => {
    // The proxy joins each incoming path onto the upstream origin, so a path
    // here would be dropped or double-joined. Neither failure is visible to
    // the user, which is why this refuses instead of guessing.
    // `[\s\S]` not the `s` flag: the ROOT tsconfig targets below ES2018 and
    // rejects dotAll, even though editor-cli's own target is ES2022.
    expect(() => parseAttachUrl("http://localhost:3000/app")).toThrow(
      /origin only[\s\S]*http:\/\/localhost:3000/,
    )
    expect(() => parseAttachUrl("http://localhost:3000/?x=1")).toThrow(/origin only/)
  })

  it("refuses a non-http protocol", () => {
    expect(() => parseAttachUrl("ws://localhost:3000")).toThrow(/http:\/\/ and https:\/\//)
    expect(() => parseAttachUrl("file:///tmp/x")).toThrow(/http:\/\/ and https:\/\//)
  })

  it("refuses a bare host:port and suggests the exact corrected URL", () => {
    // `new URL("localhost:3000")` parses — protocol `localhost:`, path `3000`
    // — so this case reaches the scheme branch looking valid. It is also the
    // likeliest thing a user pastes, so the message has to name the fix.
    expect(() => parseAttachUrl("localhost:3000")).toThrow(
      /did you mean 'http:\/\/localhost:3000'/,
    )
    expect(() => parseAttachUrl("")).toThrow(/full URL/)
  })
})

describe("buildAttachRequiredMessage", () => {
  it("names the framework, the reason, and both commands to run", () => {
    const msg = buildAttachRequiredMessage("next", "./my-app")
    expect(msg).toMatch(/Next\.js/)
    expect(msg).toMatch(/npm run dev/)
    expect(msg).toMatch(/desde \.\/my-app --attach/)
  })

  it("names the user's actual framework, not 'your dev command'", () => {
    // One argument now, not two. `vite-meta` + a marker was the old shape; the
    // host id IS the framework name, so there is nothing to unpack.
    expect(buildAttachRequiredMessage("nuxt", ".")).toMatch(/Nuxt/)
    expect(buildAttachRequiredMessage("astro", ".")).toMatch(/Astro/)
    expect(buildAttachRequiredMessage("react-router", ".")).toMatch(/React Router/)
  })

  it("says Editor will not start the dev server, because it will not", () => {
    expect(buildAttachRequiredMessage("next", ".")).toMatch(/does not start your dev server/i)
  })

  it("names no framework, and adds the stamper caveat, on the unknown downgrade", () => {
    // Detection matched no in-process host. There is no framework to name, and
    // the honest caveat is a different one: `--attach` gets you a session, and
    // whether that session can EDIT is a second, independent fact.
    const msg = buildAttachRequiredMessage(null, ".")
    expect(msg).toMatch(/found no dev server it can boot/i)
    expect(msg).toMatch(/inspected but not edited/)
    expect(msg).toMatch(/--attach/)
  })
})

describe("startCore — attach gate", () => {
  /**
   * These two asserted `AttachRequiredError` on a plain Next repo until the
   * 2026-08-11 milestone-13 flip, which put `next` (with `nuxt` and
   * `react-router`) into `DEFAULT_ENABLED`. A Next repo that configures nothing
   * now boots in-process, so the gate they were written against no longer
   * fires on this input — the expectation changed because the product decision
   * did, not because the gate weakened.
   *
   * The gate itself is unchanged and is still worth an integration test, so
   * both are retargeted onto `{"hosts": {"next": false}}` — the opt-OUT, which
   * is the input that reaches it now and is the escape hatch a user reaches
   * for when an in-process boot goes wrong for them.
   */
  it("no longer refuses a plain Next repo — next is default-on since the flip", async () => {
    const root = await mkNextRepo()
    const err = await startCore({ repoPath: root }).catch((e: unknown) => e)
    // It fails LATER, on the canonical-state preflight, because this fixture is
    // not a git repo. Asserting that specific error is the point: it proves the
    // run got PAST the host gate rather than being refused by it.
    expect(err).not.toBeInstanceOf(AttachRequiredError)
    expect((err as Error).message).toMatch(/\.git directory/)
  })

  it("still refuses when the repo opts OUT, and carries the host on the error", async () => {
    const root = await mkNextRepo()
    await writeFile(
      join(root, "desde.config.json"),
      JSON.stringify({ hosts: { next: false } }),
    )
    const err = await startCore({ repoPath: root }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AttachRequiredError)
    expect((err as AttachRequiredError).host).toBe("next")
    expect((err as AttachRequiredError).message).toMatch(/--attach/)
  })

  it("rejects a malformed --attach URL instead of proxying a wrong origin", async () => {
    const root = await mkNextRepo()
    await expect(
      startCore({ repoPath: root, attachUrl: "http://localhost:3000/app" }),
    ).rejects.toThrow(/origin only/)
  })

  // The whole point of the gate: `--attach` against an unwired config must not
  // reach the proxy. Before it was wired, this boot SUCCEEDED and the user got
  // a prototype that refused every edit.
  it("refuses an unwired config before starting the proxy", async () => {
    const root = await mkNextRepo()
    // `startCore` runs the canonical-state preflight before the stamping gate,
    // and that one needs a real repo.
    await promisify(execFile)("git", ["init", "-q"], { cwd: root })
    const err = await startCore({
      repoPath: root,
      attachUrl: "http://127.0.0.1:7599",
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StampingRequiredError)
    expect((err as StampingRequiredError).message).toMatch(/withDesde/)
  })
})

describe("startCore — the host gate a project has opted out of", () => {
  /**
   * Renamed from "…a project has not opted into" by the 2026-08-11 flip. The
   * gate used to fire on a repo that said NOTHING; `nuxt` is default-on now, so
   * the input that reaches it is a repo that said `false`. The assertions on
   * what the user SEES are unchanged and deliberately so — the refusal prose is
   * the shipped attach path, and the flip must not have altered it for the
   * users who still land on it.
   */
  it("keeps exactly the shipped refusal for a Nuxt repo that opted out", async () => {
    const root = await mkdtemp(join(tmpdir(), "editor-cli-attach-"))
    roots.push(root)
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { nuxt: "^4.5.1", vue: "^3.5.40" } }),
    )
    await writeFile(join(root, "nuxt.config.ts"), "export default {}")
    await writeFile(
      join(root, "desde.config.json"),
      JSON.stringify({ hosts: { nuxt: false } }),
    )

    const err = await startCore({ repoPath: root }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AttachRequiredError)
    expect((err as AttachRequiredError).host).toBe("nuxt")
    expect((err as AttachRequiredError).message).toMatch(/Nuxt/)
    expect((err as AttachRequiredError).message).toMatch(/npm run dev/)
    expect((err as AttachRequiredError).message).toMatch(/--attach/)
  })

  it("lets the same repo through when it says nothing at all", async () => {
    // The flip, asserted from the other side: identical fixture, no config
    // file. Without this the suite would still pass if `DEFAULT_ENABLED` were
    // reverted to `["vite"]`, because every remaining assertion above is about
    // a repo that opted out.
    const root = await mkdtemp(join(tmpdir(), "editor-cli-attach-"))
    roots.push(root)
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { nuxt: "^4.5.1", vue: "^3.5.40" } }),
    )
    await writeFile(join(root, "nuxt.config.ts"), "export default {}")

    const err = await startCore({ repoPath: root }).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(AttachRequiredError)
    expect((err as Error).message).toMatch(/\.git directory/)
  })

  it("refuses an ambiguous repo on BOTH lanes, before anything else runs", async () => {
    // Two frameworks, each with its own config file on disk. Attach mode cannot
    // guess which config to wire any better than in-process boot can guess which
    // server to start, so `--attach` does not clear it — only `--host` does.
    const root = await mkdtemp(join(tmpdir(), "editor-cli-attach-"))
    roots.push(root)
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { nuxt: "^4.5.1", astro: "^7.2.0", vue: "^3.5.40" } }),
    )
    await writeFile(join(root, "nuxt.config.ts"), "export default {}")
    await writeFile(join(root, "astro.config.mjs"), "export default {}")

    for (const attachUrl of [undefined, "http://127.0.0.1:7599"]) {
      const err = await startCore({ repoPath: root, attachUrl }).catch((e: unknown) => e)
      expect(err, `attachUrl=${String(attachUrl)}`).toBeInstanceOf(HostAmbiguousError)
      expect((err as HostAmbiguousError).message).toMatch(/--host nuxt/)
    }
  })

  it("boots the named host when --host clears the ambiguity", async () => {
    // Not asserted by booting — the point is that resolution stops refusing.
    // With `--host astro` the run gets past the ambiguity gate and lands on the
    // NEXT gate, which is the one that says astro is not enabled for this repo.
    const root = await mkdtemp(join(tmpdir(), "editor-cli-attach-"))
    roots.push(root)
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { nuxt: "^4.5.1", astro: "^7.2.0", vue: "^3.5.40" } }),
    )
    await writeFile(join(root, "nuxt.config.ts"), "export default {}")
    await writeFile(join(root, "astro.config.mjs"), "export default {}")

    const err = await startCore({ repoPath: root, host: "astro" }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AttachRequiredError)
    expect((err as AttachRequiredError).host).toBe("astro")
  })
})

describe("assertStampableLayout", () => {
  it("passes when the prototype IS the repo root", () => {
    expect(() => assertStampableLayout("", "./app")).not.toThrow()
  })

  // The stamper derives the repo root from its own location, so a subdir
  // prototype would stamp package-relative paths that resolve to nothing. This
  // fails loudly rather than producing stamps that point at missing files.
  it("refuses a monorepo subdirectory and names it", () => {
    expect(() => assertStampableLayout("packages/web", "./packages/web")).toThrow(
      /subdirectory \(packages\/web\)/,
    )
  })
})

describe("runAttachStampingGate", () => {
  it("refuses an unwired config, and writes the stamper the block imports anyway", async () => {
    const root = await mkNextRepo()
    const err = await gate(root).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StampingRequiredError)
    expect((err as StampingRequiredError).result.status).toBe("needs-config")
    // Load-bearing: the printed steps say to restart the dev server BEFORE
    // re-running this CLI, so the imported file has to exist already.
    const loader = await readFile(join(root, ".desde/stamp/next-loader.cjs"), "utf8")
    expect(loader.length).toBeGreaterThan(1000)
  })

  it("accepts a wired config and reports what it wrote", async () => {
    const root = await mkNextRepo(
      "const L = './.desde/stamp/next-loader.cjs'\nexport default { turbopack: { rules: { '*.tsx': { loaders: [L] }, '*.jsx': { loaders: [L] } } } }",
    )
    const result = await gate(root)
    expect(result.status).toBe("already-wired")
    expect(result.configFile).toBe("next.config.mjs")
    expect(result.stamperFiles).toEqual([".desde/stamp/next-loader.cjs"])
    expect(result.rebuilt).toBe(true)
  })

  it("does not re-bundle when the stamper is already current", async () => {
    const root = await mkNextRepo(
      "const L = './.desde/stamp/next-loader.cjs'\nexport default { turbopack: { rules: { '*.tsx': { loaders: [L] }, '*.jsx': { loaders: [L] } } } }",
    )
    expect((await gate(root)).rebuilt).toBe(true)
    expect((await gate(root)).rebuilt).toBe(false)
  })

  it("surfaces a wired-but-wrong config as a warning rather than silence", async () => {
    // A `*.tsx`-only rule leaves every `.jsx` file unstamped — the app boots,
    // the element is inspectable, and only the edit is refused.
    const root = await mkNextRepo(
      "const L = './.desde/stamp/next-loader.cjs'\nexport default { turbopack: { rules: { '*.tsx': { loaders: [L] } } } }",
    )
    const result = await gate(root)
    expect(result.status).toBe("already-wired")
    expect(result.warnings.join("\n")).toMatch(/jsx/i)
  })

  it("refuses a host with no config file to modify, without writing stampers", async () => {
    const root = await mkdtemp(join(tmpdir(), "editor-cli-attach-"))
    roots.push(root)
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { vue: "^3.5.0" } }))
    const err = await gate(root, { host: "vite", framework: "vue3" }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StampingRequiredError)
    expect((err as StampingRequiredError).result.status).toBe("no-config-file")
    await expect(readFile(join(root, ".desde/stamp/vue-source-tag.mjs"))).rejects.toThrow()
  })
})

describe("formatStampingRefusal", () => {
  it("says why, names the file, and prints the block verbatim", () => {
    const text = formatStampingRefusal({
      status: "needs-config",
      host: "next",
      framework: "react",
      configFile: "/repo/next.config.ts",
      configFileRelative: "next.config.ts",
      configFileExists: true,
      block: "// THE BLOCK",
      steps: ["Paste it", "Restart your dev server"],
      requiredStamperFiles: [],
    })
    expect(text).toMatch(/inspect-only/)
    expect(text).toMatch(/next\.config\.ts/)
    expect(text).toMatch(/1\. Paste it/)
    expect(text).toContain("// THE BLOCK")
  })

  it("lists what it searched when there is no config to edit", () => {
    const text = formatStampingRefusal({
      status: "no-config-file",
      host: "vite",
      framework: "react",
      searched: ["/repo/vite.config.js", "/repo/vite.config.ts"],
      message: "No vite config.",
    })
    expect(text).toMatch(/\/repo\/vite\.config\.ts/)
  })
})

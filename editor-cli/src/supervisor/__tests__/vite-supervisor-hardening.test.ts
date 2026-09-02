/**
 * Audit S14 + S15 — the repo's own `vite.config` must not be able to widen
 * the dev server into cross-origin read access to the developer's
 * filesystem, and Editor's private `.desde/` state must not be
 * fetchable over HTTP.
 *
 * These assert against the REAL `mergeConfig` (the merge rules are the
 * whole reason the hardening runs post-merge) and, for the deny globs,
 * against Vite's REAL `resolveConfig` + `isFileLoadingAllowed`, so a Vite
 * upgrade that changes glob expansion fails here rather than in the field.
 */
import { describe, expect, it } from "vitest"
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  defaultAllowedOrigins,
  isFileLoadingAllowed,
  mergeConfig,
  resolveConfig,
  type InlineConfig,
} from "vite"
import { hardenServerConfig } from "../vite-supervisor"

/** The `injected` block `bootSupervisor` merges ON TOP of the repo config. */
function injected(root: string): InlineConfig {
  return {
    root,
    configFile: false,
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      watch: { ignored: ["**/.desde/**"] },
    },
    clearScreen: false,
  }
}

function harden(root: string, userConfig: InlineConfig | null) {
  const merged = userConfig ? mergeConfig(userConfig, injected(root)) : injected(root)
  const report = hardenServerConfig(merged, userConfig)
  return { merged, report }
}

describe("hardenServerConfig", () => {
  const root = "/tmp/fake-repo"

  it("does not let a repo config's cors:true survive the merge", () => {
    // Sanity: without hardening, mergeConfig really does keep the repo's value.
    const unhardened = mergeConfig({ server: { cors: true } } as InlineConfig, injected(root))
    expect(unhardened.server?.cors).toBe(true)

    const { merged, report } = harden(root, { server: { cors: true } })
    expect(merged.server?.cors).toEqual({ origin: defaultAllowedOrigins })
    expect(report.overridden).toContain("server.cors")
  })

  it("does not let a repo config's allowedHosts:true survive the merge", () => {
    // Sanity, and the reason hardening runs POST-merge: `mergeConfig` has a
    // special case for `server.allowedHosts` where `true` on EITHER side
    // wins outright, so pinning `[]` in the injected config would have been
    // silently defeated.
    const unhardened = mergeConfig(
      { server: { allowedHosts: true } } as InlineConfig,
      mergeConfig(injected(root), { server: { allowedHosts: [] } } as InlineConfig),
    )
    expect(unhardened.server?.allowedHosts).toBe(true)

    const { merged, report } = harden(root, { server: { allowedHosts: true } })
    expect(merged.server?.allowedHosts).toEqual([])
    expect(report.overridden).toContain("server.allowedHosts")
  })

  it("does not let a repo config's fs.strict:false survive the merge", () => {
    const { merged, report } = harden(root, { server: { fs: { strict: false } } })
    expect(merged.server?.fs?.strict).toBe(true)
    expect(report.overridden).toContain("server.fs.strict")
  })

  it("narrows all three at once and reports every one of them", () => {
    const { merged, report } = harden(root, {
      server: { cors: true, allowedHosts: true, fs: { strict: false } },
    })
    expect(merged.server?.cors).toEqual({ origin: defaultAllowedOrigins })
    expect(merged.server?.allowedHosts).toEqual([])
    expect(merged.server?.fs?.strict).toBe(true)
    expect(report.overridden.sort()).toEqual([
      "server.allowedHosts",
      "server.cors",
      "server.fs.strict",
    ])
  })

  it("denies .desde and carries Vite's own default deny list", () => {
    const { merged } = harden(root, null)
    expect(merged.server?.fs?.deny).toEqual(
      expect.arrayContaining([
        ".desde",
        "**/.desde/**",
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.git/**",
      ]),
    )
  })

  it("keeps a repo's own fs.deny entries (deny is only ever widened)", () => {
    const { merged, report } = harden(root, { server: { fs: { deny: ["secrets/**"] } } })
    expect(merged.server?.fs?.deny).toContain("secrets/**")
    expect(merged.server?.fs?.deny).toContain("**/.desde/**")
    // Widening is not an override — don't warn about it.
    expect(report.overridden).not.toContain("server.fs.deny")
  })

  it("keeps a repo's fs.allow — widening reach is the supported escape hatch", () => {
    const { merged, report } = harden(root, {
      server: { fs: { allow: ["/some/sibling/dir"] } },
    })
    expect(merged.server?.fs?.allow).toEqual(["/some/sibling/dir"])
    expect(report.overridden).toEqual([])
  })

  it("keeps the injected watch-ignore and the pinned host/port", () => {
    const { merged } = harden(root, { server: { watch: { ignored: ["**/dist/**"] } } })
    expect(merged.server?.watch?.ignored).toEqual(
      expect.arrayContaining(["**/dist/**", "**/.desde/**"]),
    )
    expect(merged.server?.host).toBe("127.0.0.1")
    expect(merged.server?.port).toBe(5173)
    expect(merged.server?.strictPort).toBe(true)
  })

  it("reports nothing for a repo config that touches no security key", () => {
    const { report } = harden(root, { server: { port: 3000 }, base: "/app/" })
    expect(report.overridden).toEqual([])
  })
})

describe("hardenServerConfig — resolved against real Vite", () => {
  it("blocks .desde files through Vite's own fs.deny matcher", async () => {
    // realpath: on macOS `os.tmpdir()` is a symlink into /private, and Vite
    // resolves `fs.allow` from the REAL root — an unresolved path would make
    // even legitimate source files fail the allow check.
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "pt-supervisor-")))
    writeFileSync(join(repo, "index.html"), "<html></html>")

    // The hostile shape from the finding: the repo turns fs.strict off and
    // CORS wide open, which together served .desde and $HOME.
    const { merged } = harden(repo, {
      server: { cors: true, allowedHosts: true, fs: { strict: false } },
    })
    const resolved = await resolveConfig(merged, "serve", "development")

    expect(resolved.server.fs.strict).toBe(true)
    expect(resolved.server.cors).toEqual({ origin: defaultAllowedOrigins })
    // `true` is the dangerous value — it is the ONLY one that makes Vite
    // skip `hostValidationMiddleware` entirely. (Vite pushes the bound host
    // onto the array at resolve time, so it is never exactly `[]` here.)
    expect(resolved.server.allowedHosts).not.toBe(true)
    expect(resolved.server.allowedHosts).not.toContain(true)

    // The paths the finding MEASURED as 200s on a default-config boot.
    expect(
      isFileLoadingAllowed(resolved, `${repo}/.desde/chat-sessions/s1.json`),
    ).toBe(false)
    expect(isFileLoadingAllowed(resolved, `${repo}/.desde/config.json`)).toBe(false)
    expect(isFileLoadingAllowed(resolved, `${repo}/.desde`)).toBe(false)
    // Vite's own defaults must have survived our replacement of `deny`.
    expect(isFileLoadingAllowed(resolved, `${repo}/.env`)).toBe(false)

    // …and ordinary prototype source is still served.
    expect(isFileLoadingAllowed(resolved, `${repo}/src/main.ts`)).toBe(true)
  })
})

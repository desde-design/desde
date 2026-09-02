/**
 * The attach host's declarations, and the one thing that keeps them true.
 *
 * `attach` is a registry entry as of the detection rewrite, but `core.ts` still
 * runs the attach lane directly rather than dispatching it through `runHost`
 * (see `hosts/attach/host.ts` for which three call sites have to move first). So
 * for now there are two statements of what an attached session is: this object,
 * and that branch. The last block below pins them to each other — if they drift,
 * `--doctor` starts describing a session the CLI does not produce.
 */
import { describe, expect, it } from "vitest"
import {
  ATTACH_SECURITY_GAPS,
  DISPLAY_NAME,
  STAMP_EXPECTATION,
  createAttachHost,
} from "../host.js"
import { stampVerifyFor } from "../../../core.js"
import type { HostContext } from "../../types.js"

const UPSTREAM = "http://localhost:48123"

function context(attachUrl: string | undefined): HostContext {
  return { attachUrl } as HostContext
}

describe("the attach host declares itself", () => {
  const host = createAttachHost()

  it("stands on NO seams, which is why it is the fallback for every host failure", () => {
    // Every other host's failure message ends "attach mode does not use this
    // seam and covers your framework fully". That sentence is only true because
    // there is nothing here to break.
    expect(host.seams).toEqual([])
    expect(host.stamperSeam).toBeUndefined()
  })

  it("declares no versionGate, because no package of ours resolves from the prototype", () => {
    // The honest alternative to `packageName: ""`, which would put a lie in the
    // seam table `--doctor` prints.
    expect(host.versionGate).toBeUndefined()
  })

  it("gets its bridge tags from the proxy, never from transformIndexHtml", () => {
    // We never load the user's Vite config, so there is no hook to register.
    expect(host.bridgeTags).toBe("proxy-response-injection")
  })

  it("builds nothing, so it denies no build directory", () => {
    expect(host.buildDirs).toEqual([])
  })

  it("claims both stampable dialects, unfiltered by ctx.languages", () => {
    // Unlike the Vite-family hosts, attach did not inject the stampers and
    // cannot see what the user's own config wired. Both is the honest ceiling;
    // the stamping preflight is what actually establishes coverage, by reading
    // the config rather than guessing at it.
    expect(host.stampLanguages(context(UPSTREAM), new Set())).toEqual(["vue-sfc", "jsx"])
  })

  it("probes nothing and refuses nothing", async () => {
    // Deliberately NOT the stamping preflight: that refusal is a rendered
    // artifact with its own exit code (5) and has to run before `core.ts`
    // chdirs. As a `ProbeResult` it would become exit 4 with "start your dev
    // server" advice, for a user whose dev server is already running.
    await expect(host.probe(context(UPSTREAM))).resolves.toMatchObject({ ok: true })
  })
})

describe("the attach host's boot is the upstream, and nothing else", () => {
  it("declares the --attach origin as an http-upstream transport", async () => {
    const boot = await createAttachHost().boot(
      context(UPSTREAM),
      { channel: "vite-plugin", plugins: [] },
      null,
    )
    expect(boot.transport).toEqual({ kind: "http-upstream", origin: UPSTREAM })
    // The proxy is the front door and serves at the root. Whatever base the
    // upstream uses internally is invisible from out here.
    expect(boot.base).toBe("/")
  })

  it("discloses the upstream as a side door rather than pretending it away", async () => {
    const boot = await createAttachHost().boot(
      context(UPSTREAM),
      { channel: "vite-plugin", plugins: [] },
      null,
    )
    expect(boot.sideDoorOrigins).toEqual([UPSTREAM])
  })

  it("reports a non-empty security gap list (§ 4, S11)", async () => {
    // A host that cannot narrow the dev server's own config must say so at boot.
    // Attach narrows nothing at all, so silence here would be the largest lie of
    // any host.
    const boot = await createAttachHost().boot(
      context(UPSTREAM),
      { channel: "vite-plugin", plugins: [] },
      null,
    )
    expect(boot.security.narrowedServerConfig).toBe(false)
    expect(boot.security.gaps.length).toBeGreaterThan(0)
    expect(boot.security.gaps).toEqual([...ATTACH_SECURITY_GAPS])
  })

  it("owns no HMR lane, and its invalidate is a no-op that cannot throw", async () => {
    // MEASURED end to end on Next: an edit Editor wrote hot-updated the running
    // page with the stamp intact, because the user's own dev server was already
    // watching the file. There is no event of ours to replay.
    const boot = await createAttachHost().boot(
      context(UPSTREAM),
      { channel: "vite-plugin", plugins: [] },
      null,
    )
    expect(boot.hmr.lanes).toEqual([])
    expect(() => boot.hmr.invalidate(["/repo/src/App.vue"])).not.toThrow()
  })

  it("closes nothing — we did not start this server and must not stop it", async () => {
    const boot = await createAttachHost().boot(
      context(UPSTREAM),
      { channel: "vite-plugin", plugins: [] },
      null,
    )
    await expect(boot.close()).resolves.toBeUndefined()
  })

  it("throws rather than fronting an origin of `undefined`", async () => {
    // Unreachable through `resolveHost`, which refuses `--host attach` with no
    // URL. Loud rather than a cast, because the failure it prevents is a proxy
    // pointed at the string "undefined".
    await expect(
      createAttachHost().boot(context(undefined), { channel: "vite-plugin", plugins: [] }, null),
    ).rejects.toThrow(/no --attach URL/)
  })
})

describe("the declaration and the live attach lane cannot drift", () => {
  it("is what stampVerifyFor uses for an attached session", () => {
    // `core.ts` reads both of these from `hosts/attach/host.ts` instead of
    // writing them a second time. `post-hydration` is the load-bearing one: it
    // makes zero stamps `indeterminate` rather than `unstamped`, and the
    // `unstamped` verdict tears the server down and tells the user to switch to
    // attach mode — which they are already in.
    const verify = stampVerifyFor(
      { url: "http://127.0.0.1:48124", base: "/", close: async () => {} },
      null,
    )
    expect(verify.stampExpectation).toBe(STAMP_EXPECTATION)
    expect(verify.hostDisplayName).toBe(DISPLAY_NAME)
    expect(STAMP_EXPECTATION).toBe("post-hydration")
  })
})

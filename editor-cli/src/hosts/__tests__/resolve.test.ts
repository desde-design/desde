/**
 * Detection evidence → a host id, and the three answers that are not one.
 *
 * The property worth protecting is that a WRONG host never wins quietly. Booting
 * a Nuxt repo on the plain Vite supervisor produces a server that serves 200s
 * and stamps nothing — the exact failure class this design is organised around —
 * so every path that cannot name the right host has to say so out loud:
 *
 *  - two frameworks equally corroborated → refuse and name `--host`;
 *  - nothing matched → downgrade to attach, do not refuse the project;
 *  - a host id with no implementation → refuse, never fall back to one that
 *    happens to exist.
 */
import { describe, expect, it } from "vitest"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { attachConfigHostFor, resolveHost } from "../resolve.js"
import { getHostFactory, inProcessHostIds, registeredHostIds } from "../registry.js"
import type { HostDetection, HostEvidence, HostId } from "../types.js"

function detection(candidates: HostEvidence[], over: Partial<HostDetection> = {}): HostDetection {
  return {
    candidates,
    languages: ["vue-sfc"],
    framework: "vue3",
    warnings: [],
    ...over,
  }
}

function candidate(
  hostId: HostId,
  confidence: HostEvidence["confidence"] = "certain",
): HostEvidence {
  return { hostId, confidence, because: [`"${hostId}" is a dependency`, "its config is present"] }
}

describe("resolveHost — the ordinary answer", () => {
  it("takes the top-ranked candidate and quotes what decided it", () => {
    const result = resolveHost(detection([candidate("vite")]))
    expect(result).toMatchObject({ ok: true, hostId: "vite" })
    expect(result.ok && result.because.join(" ")).toContain('"vite" is a dependency')
  })

  it("ranks, rather than refuses, when only one candidate is certain", () => {
    // A Next repo that also carries `astro` for a docs sub-package. Detection
    // ranks next first by rule; ambiguity is about two META hosts, and next
    // beats every other candidate outright.
    const result = resolveHost(detection([candidate("next"), candidate("astro")]))
    expect(result).toMatchObject({ ok: true, hostId: "next" })
  })
})

describe("resolveHost — ambiguity refuses instead of guessing", () => {
  const ambiguous = detection([candidate("nuxt"), candidate("astro")])

  it("refuses two equally-certain meta-frameworks", () => {
    const result = resolveHost(ambiguous)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.failure.code).toBe("ambiguous-host")
    expect(result.failure.summary).toMatch(/nuxt AND astro/)
  })

  it("prints BOTH evidence lists verbatim, so the user can check the guess we did not make", () => {
    const result = resolveHost(ambiguous)
    if (result.ok) throw new Error("unreachable")
    expect(result.failure.cause).toContain("nuxt (certain)")
    expect(result.failure.cause).toContain("astro (certain)")
    expect(result.failure.cause).toContain("its config is present")
  })

  it("names --host for each candidate, because that is the whole remedy", () => {
    const result = resolveHost(ambiguous)
    if (result.ok) throw new Error("unreachable")
    expect(result.failure.remediation.join("\n")).toContain("--host nuxt")
    expect(result.failure.remediation.join("\n")).toContain("--host astro")
  })

  it("does NOT offer attach mode, because attach cannot guess either", () => {
    // The stamping preflight reads ONE config file and generates a block for
    // ONE framework. "Start your dev server and pass --attach" would leave the
    // user at the same fork one step later.
    const result = resolveHost(ambiguous)
    if (result.ok) throw new Error("unreachable")
    expect(result.failure.attachCovers).toBe(false)
  })

  it("refuses on the ATTACH lane too — the preflight has to pick a config as well", () => {
    const result = resolveHost(ambiguous, { attachUrl: "http://localhost:3000" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.failure.code).toBe("ambiguous-host")
  })

  it("is cleared by --host, which is the only thing that clears it", () => {
    expect(resolveHost(ambiguous, { hostId: "astro" })).toMatchObject({ ok: true, hostId: "astro" })
  })

  it("does not fire on one certain plus one merely likely", () => {
    // `astro` in a devDependency with no astro.config is a docs sub-package, not
    // a claim on the dev server. Refusing there would refuse a working repo.
    const result = resolveHost(detection([candidate("nuxt"), candidate("astro", "likely")]))
    expect(result).toMatchObject({ ok: true, hostId: "nuxt" })
  })
})

describe("resolveHost — the unknown downgrade", () => {
  it("downgrades an unrecognised project to attach instead of refusing it", () => {
    const result = resolveHost(detection([]))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.failure.code).toBe("no-in-process-host")
    // A downgrade: the project is fine, we just have no dev server to offer it.
    expect(result.failure.attachCovers).toBe(true)
    expect(result.failure.remediation.join("\n")).toContain("--attach")
  })

  it("states the stamper caveat in the same breath, rather than leaving it to be discovered", () => {
    // Two independent gaps, reported independently: `--attach` gets you a
    // session; whether that session can EDIT is a separate fact.
    const result = resolveHost(detection([]))
    if (result.ok) throw new Error("unreachable")
    expect(result.failure.remediation.join("\n")).toMatch(/inspected but not edited/)
  })

  it("says what it looked for, so 'no host' is checkable rather than mysterious", () => {
    const result = resolveHost(detection([]))
    if (result.ok) throw new Error("unreachable")
    for (const marker of ["next", "nuxt", "astro", "@react-router/dev", "vite.config"]) {
      expect(result.failure.cause).toContain(marker)
    }
  })
})

describe("resolveHost — attach is a host, and that must not leak", () => {
  it("resolves to attach when --attach is passed, on any repo shape", () => {
    const result = resolveHost(detection([candidate("nuxt")]), {
      attachUrl: "http://localhost:3000",
    })
    expect(result).toMatchObject({ ok: true, hostId: "attach" })
  })

  it("NEVER resolves to attach without a URL, whatever detection said", () => {
    // The hazard this milestone created. `attach` used to be absent from the
    // registry, and an earlier version of this file returned the id `"attach"`
    // as an unreachable-case sentinel — relying on the registry gap to turn it
    // into a refusal. The moment `attach` became a real entry, that sentinel
    // would have started meaning "boot attach mode" instead. There is no
    // in-band sentinel now, and this is what pins it.
    for (const d of [detection([]), detection([candidate("vite")]), detection([candidate("next")])]) {
      const result = resolveHost(d)
      expect(result.ok && result.hostId).not.toBe("attach")
    }
  })

  it("refuses --host attach with no URL, naming the flag that does work", () => {
    const result = resolveHost(detection([candidate("vite")]), { hostId: "attach" })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.failure.remediation.join("\n")).toContain("--attach")
  })
})

describe("resolveHost — --host override", () => {
  it("wins over detection", () => {
    expect(resolveHost(detection([candidate("next")]), { hostId: "vite" })).toMatchObject({
      ok: true,
      hostId: "vite",
    })
  })

  it("still checks the registry, so an unbuilt host refuses rather than falling back", () => {
    // Every id detection can produce is built today, so this drives the check
    // through a stubbed registry gap rather than pretending one exists.
    const unbuilt = registeredHostIds().filter((id) => getHostFactory(id) === null)
    expect(unbuilt).toEqual([])
  })
})

describe("attachConfigHostFor", () => {
  it("names the framework whose config attach mode has to wire", () => {
    expect(attachConfigHostFor(detection([candidate("next")]))).toBe("next")
    expect(attachConfigHostFor(detection([candidate("nuxt")]))).toBe("nuxt")
    expect(attachConfigHostFor(detection([candidate("astro")]))).toBe("astro")
    expect(attachConfigHostFor(detection([candidate("react-router")]))).toBe("react-router")
  })

  it("falls back to the plain vite config shape when nothing was detected", () => {
    // A developer attaching to their own `vite dev`. If there is no root
    // vite.config the preflight reports `no-config-file` with the paths it
    // searched, which beats guessing at a framework.
    expect(attachConfigHostFor(detection([]))).toBe("vite")
  })
})

describe("registry", () => {
  it("has exactly the hosts built so far, attach included", () => {
    // This assertion is meant to CHANGE, one host per milestone. It exists so
    // adding a registry entry is a deliberate act with a diff, not a drive-by.
    expect(registeredHostIds()).toEqual(["vite", "react-router", "astro", "nuxt", "next", "attach"])
  })

  it("keeps 'in-process host' and 'registered host' as separate facts", () => {
    // Attach is a host and is NOT an in-process one. Every message offering "the
    // in-process hosts available in this build", and the `hosts.<id>` opt-in
    // key, must use the narrower list — otherwise they offer a lane with no dev
    // server to boot.
    expect(inProcessHostIds()).toEqual(["vite", "react-router", "astro", "nuxt", "next"])
    expect(inProcessHostIds()).not.toContain("attach")
  })

  it("registered does NOT mean default-on", async () => {
    // The two facts are separate on purpose (see `enabled-hosts.ts`): a host
    // lands in the registry when its code exists and its live boot passed, and
    // becomes the default for every repo only after milestone 13's per-host
    // bar. A registry entry that silently changed which boot path an
    // unconfigured repo takes would collapse the two.
    //
    // This used to read `toEqual(["vite"])`. The 2026-08-11 flip turned `nuxt`,
    // `react-router` and `next` on for every repo, so the gap between the two
    // lists is now `astro` alone — held deliberately, see `DEFAULT_ENABLED`.
    // The property is unchanged and still has a witness; the witness is what
    // moved. If astro is ever flipped, do not delete this test — replace the
    // witness with the next unflipped host, because a registry that IS the
    // default set is the thing this asserts against.
    const { loadEnabledHosts } = await import("../enabled-hosts.js")
    const unconfigured = await loadEnabledHosts(join(tmpdir(), "pt-no-such-project"))
    expect([...unconfigured.enabled]).toEqual(["vite", "nuxt", "react-router", "next"])
    expect(inProcessHostIds()).toContain("astro")
    expect(unconfigured.enabled.has("astro")).toBe(false)
  })

  it("builds a host that declares the channel the pipeline can serve", () => {
    const host = getHostFactory("vite")!()
    expect(host.accepts).toBe("vite-plugin")
    expect(host.id).toBe("vite")
    expect(host.seams.every((seam) => seam.stability === "public")).toBe(true)
  })

  it("requires a versionGate of every in-process host, and only excuses attach", () => {
    // `versionGate` became optional so attach — which resolves no package from
    // the prototype — could omit it honestly instead of declaring
    // `packageName: ""`. This is what stops that optionality spreading.
    for (const id of inProcessHostIds()) {
      const host = getHostFactory(id)!()
      expect(host.versionGate, `${id} must declare a versionGate`).toBeDefined()
      expect(host.versionGate!.packageName.length).toBeGreaterThan(0)
    }
    expect(getHostFactory("attach")!().versionGate).toBeUndefined()
  })
})

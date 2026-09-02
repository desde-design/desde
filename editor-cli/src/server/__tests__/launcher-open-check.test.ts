/**
 * `checkLauncherOpen` — the launcher's in-process answer to "can we boot this",
 * asked before anything is spawned.
 *
 * The cases are chosen so that each one produces a DIFFERENT message, because
 * the defect being fixed was one message ("editor exited before it was ready
 * (code 4)") standing in for all of them.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { promises as fs } from "node:fs"
import { execFile } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { checkLauncherOpen } from "../launcher-open-check.js"
import { inProcessHostIds } from "../../hosts/registry.js"
import { loadEnabledHosts } from "../../hosts/enabled-hosts.js"

const execFileAsync = promisify(execFile)

let tmp: string

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "launcher-open-check-"))
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function fixture(name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(tmp, name)
  await fs.mkdir(dir, { recursive: true })
  for (const [file, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), body)
  }
  return dir
}

/**
 * A fixture that is also a git repo.
 *
 * Not optional decoration: `core.ts` runs `preflightCanonicalRoot` on the git
 * root before it will edit anything, so a fixture without a `.git` is a
 * fixture the real boot refuses. A "this one passes" test built on one would
 * be asserting against a project Editor cannot actually open.
 */
async function gitFixture(name: string, files: Record<string, string>): Promise<string> {
  const dir = await fixture(name, files)
  await execFileAsync("git", ["-C", dir, "init", "-q"])
  return dir
}

const VUE_VITE = {
  "package.json": JSON.stringify({
    dependencies: { vue: "^3.4.0" },
    devDependencies: { vite: "^5.0.0" },
  }),
  "vite.config.ts": "export default {}",
}

describe("checkLauncherOpen — repos it lets through", () => {
  it("passes a Vue + Vite project", async () => {
    expect(await checkLauncherOpen(await gitFixture("vue-vite", VUE_VITE))).toBeNull()
  })

  it("passes a React + Vite project", async () => {
    const dir = await gitFixture("react-vite", {
      "package.json": JSON.stringify({
        dependencies: { react: "^19.0.0" },
        devDependencies: { vite: "^5.0.0" },
      }),
      "vite.config.ts": "export default {}",
    })
    expect(await checkLauncherOpen(dir)).toBeNull()
  })
})

/**
 * The refusals that are about the repo rather than the framework. Both were
 * reaching the user as `editor exited before it was ready (code 1)` — MEASURED
 * by booting the real CLI on a non-git Vue app.
 */
describe("checkLauncherOpen — repo state", () => {
  it("refuses a perfectly good app that is not a git repository", async () => {
    const dir = await fixture("no-git", VUE_VITE)
    const block = await checkLauncherOpen(dir)
    expect(block?.code).toBe("not-a-git-repo")
    expect(block?.summary).toContain("not a git repository")
    expect(block?.remediation[0]).toContain("git init")
    // Attach mode runs the same preflight, so it is not an escape hatch here.
    expect(block?.attachCovers).toBe(false)
  })

  it("refuses a repo with a merge in progress, naming the operation", async () => {
    const dir = await gitFixture("mid-merge", VUE_VITE)
    await fs.writeFile(path.join(dir, ".git", "MERGE_HEAD"), "deadbeef\n")
    const block = await checkLauncherOpen(dir)
    expect(block?.code).toBe("repo-busy")
    expect(block?.cause).toContain("merge")
    expect(block?.remediation.join(" ")).toContain("--abort")
  })

  /**
   * The repo-state check runs LAST, mirroring `core.ts`. A folder that is
   * neither a project nor a repo should be told the more fundamental thing.
   */
  it("reports the framework problem first when a folder has both", async () => {
    const block = await checkLauncherOpen(await fixture("neither", {}))
    expect(block?.code).toBe("framework-unsupported")
  })
})

describe("checkLauncherOpen — repos it refuses", () => {
  it("an empty folder: no package.json, so nothing can be inferred", async () => {
    const block = await checkLauncherOpen(await fixture("empty", {}))
    expect(block?.code).toBe("framework-unsupported")
    expect(block?.summary).toContain("no package.json")
    expect(block?.cause).toContain("package.json")
    expect(block?.remediation.length).toBeGreaterThan(0)
    // Attach mode does NOT rescue this one, and saying so would be a false
    // promise: attaching proxies the app and then refuses every edit.
    expect(block?.attachCovers).toBe(false)
  })

  it("a Svelte project: no stamper for the dialect", async () => {
    const dir = await fixture("svelte", {
      "package.json": JSON.stringify({ devDependencies: { svelte: "^5.0.0", vite: "^5.0.0" } }),
      "vite.config.ts": "export default {}",
    })
    const block = await checkLauncherOpen(dir)
    expect(block?.code).toBe("framework-unsupported")
    // The remediation is EMPTY, and deliberately so (2026-08-17). It used to
    // read "Svelte, Solid and Angular have no source stamper, so their
    // elements would be selectable but never editable" — a fact about our
    // internals, in a numbered list of things the user should do. The
    // supported list rendered under the summary is the whole answer.
    expect(block?.remediation).toEqual([])
    expect(block?.summary).not.toMatch(/\bEditor\b/)
  })

  it("an Angular project: same refusal, and it never reaches host resolution", async () => {
    const dir = await fixture("angular", {
      "package.json": JSON.stringify({ dependencies: { "@angular/core": "^19.0.0" } }),
    })
    expect((await checkLauncherOpen(dir))?.code).toBe("framework-unsupported")
  })

  it("a Vue 2 project", async () => {
    const dir = await fixture("vue2", {
      "package.json": JSON.stringify({ dependencies: { vue: "^2.7.0" } }),
    })
    const block = await checkLauncherOpen(dir)
    expect(block?.code).toBe("framework-unsupported")
    expect(block?.summary).toContain("Vue 2")
  })

  it("a broken package.json is a parse failure, not a framework verdict", async () => {
    const dir = await fixture("broken-json", { "package.json": "{ nope" })
    const block = await checkLauncherOpen(dir)
    expect(block?.code).toBe("framework-unsupported")
    expect(block?.summary).toContain("could not be read")
  })

  it("a Vue project with no dev server we recognise downgrades to attach", async () => {
    const dir = await fixture("vue-no-host", {
      "package.json": JSON.stringify({ dependencies: { vue: "^3.4.0" } }),
    })
    const block = await checkLauncherOpen(dir)
    expect(block?.code).toBe("no-in-process-host")
    // The one refusal where attach mode is the real answer, so it says so.
    expect(block?.attachCovers).toBe(true)
    expect(block?.remediation.join(" ")).toContain("--attach")
  })

  it("two frameworks with two config files refuse rather than guess", async () => {
    const dir = await fixture("ambiguous", {
      "package.json": JSON.stringify({
        dependencies: { vue: "^3.4.0", nuxt: "^3.0.0", astro: "^4.0.0" },
      }),
      "nuxt.config.ts": "export default {}",
      "astro.config.mjs": "export default {}",
    })
    const block = await checkLauncherOpen(dir)
    expect(block?.code).toBe("ambiguous-host")
    expect(block?.remediation.join(" ")).toContain("--host")
  })
})

/**
 * A framework that resolves to a host this project will not boot.
 *
 * There used to be a whole `host-not-enabled` code for this, on the reasoning
 * that telling an Astro user "unsupported" would be false because the host is
 * built and its boot gate is green. Mo cut it on 2026-08-17: *"We do not
 * support Astro at this point, just use the generic not supported banner."*
 *
 * The old reasoning was true and unhelpful. From where the user stands there
 * is no difference between "not built" and "built and not turned on": the
 * folder does not open either way, and the only actionable content is the list
 * of frameworks that DO. These tests now pin that collapse.
 */
describe("checkLauncherOpen — a framework that will not boot", () => {
  it("reports a switched-off host as plain unsupported, naming it", async () => {
    const dir = await fixture("vite-off", {
      ...VUE_VITE,
      "desde.config.json": JSON.stringify({ hosts: { vite: false } }),
    })
    const block = await checkLauncherOpen(dir)
    expect(block?.code).toBe("framework-unsupported")
    expect(block?.summary).toContain("Vite")
    // No config switch, and no attach consolation prize: attach would proxy
    // the app and then refuse every edit.
    expect(block?.remediation.join(" ")).not.toContain('"hosts"')
    expect(block?.attachCovers).toBe(false)
  })

  /**
   * If someone flips astro default-ON this fails, correctly: the message has
   * to change with the decision.
   */
  it("gives Astro the same generic refusal, with no partial-support caveat", async () => {
    const dir = await fixture("astro-react", {
      "package.json": JSON.stringify({
        dependencies: { astro: "^4.0.0", react: "^19.0.0" },
      }),
      "astro.config.mjs": "export default {}",
    })
    const { enabled } = await loadEnabledHosts(dir)
    expect(enabled.has("astro"), "astro is on a deliberate default-OFF hold").toBe(false)

    const block = await checkLauncherOpen(dir)
    expect(block?.code).toBe("framework-unsupported")
    expect(block?.summary).toContain("Astro")
    // The caveat about .astro pages being inspect-only is gone: it explained
    // our internals rather than anything the user can do.
    expect(block?.cause ?? "").not.toMatch(/inspect|not edit/i)
    expect(block?.remediation).toEqual([])
    // Never names the product.
    expect(block?.summary).not.toMatch(/\bEditor\b/)
  })
})

describe("checkLauncherOpen — the supported list", () => {
  it("is derived from the host registry, never a literal", async () => {
    const block = await checkLauncherOpen(await fixture("list-empty", {}))
    const ids = block?.supported.map((h) => h.id) ?? []
    // A SUBSET of the registry now, not the whole of it: only enabled hosts
    // are listed (2026-08-17). Still derived, so a new host appears here
    // without touching the UI.
    const registry = inProcessHostIds()
    for (const id of ids) expect(registry).toContain(id)
    expect(ids.length).toBeGreaterThan(0)
    // `attach` is a registry entry but not something a project opts into, so
    // it must never appear in a list of frameworks.
    expect(ids).not.toContain("attach")
    // The dormant one is absent rather than present-and-flagged.
    expect(ids).not.toContain("astro")
  })

  it("labels each host with its own displayName", async () => {
    const block = await checkLauncherOpen(await fixture("list-labels", {}))
    expect(block?.supported.find((h) => h.id === "vite")).toMatchObject({
      label: "Vite",
    })
    for (const host of block?.supported ?? []) expect(host.label).not.toBe("")
  })

  /**
   * `supported` lists ONLY what is supported (2026-08-17). It used to carry
   * every built host with an `enabled` flag and a `note` explaining why an off
   * one was off, which the UI rendered as a second list under the badges. A
   * refusal screen exists to say what you CAN do.
   */
  it("omits a host this project switched off, rather than listing it as off", async () => {
    const dir = await fixture("list-vite-off", {
      ...VUE_VITE,
      "desde.config.json": JSON.stringify({ hosts: { vite: false } }),
    })
    const block = await checkLauncherOpen(dir)
    expect(block?.supported.find((h) => h.id === "vite")).toBeUndefined()
    // The rest of the inventory is unaffected.
    expect(block?.supported.length).toBeGreaterThan(0)
  })

  it("never lists a dormant host, so Astro cannot appear as a near-miss", async () => {
    const block = await checkLauncherOpen(await fixture("list-notes", {}))
    expect(block?.supported.find((h) => h.id === "astro")).toBeUndefined()
    // Nothing carries the removed fields any more.
    for (const host of block?.supported ?? []) {
      expect(Object.keys(host).sort()).toEqual(["id", "label"])
    }
  })
})

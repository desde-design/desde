/**
 * `root ??= prototypeRoot`, and specifically NOT `root = prototypeRoot`.
 *
 * The distinction is the whole reason this plugin exists instead of an inline
 * `createServer({ root })`: a repo that sets `root: 'app'` must keep it. That is
 * the `userHasRoot` guard `bootSupervisor` gets for free by pre-loading the
 * config, reproduced for the hosts that are forbidden from pre-loading it.
 */
import { describe, expect, it } from "vitest"
import type { Plugin, UserConfig } from "vite"
import { rootDefaultPlugin } from "../root-default-plugin.js"

/** Call the `config` hook however Vite would, given it is declared as an object hook. */
function runConfigHook(plugin: Plugin, config: UserConfig): UserConfig {
  const hook = plugin.config
  if (typeof hook !== "object" || hook === null || typeof hook.handler !== "function") {
    throw new Error("rootDefaultPlugin must declare `config` as an object hook with an order")
  }
  const returned = hook.handler.call(
    // The hook body touches nothing on `this`; Vite's context is irrelevant here.
    undefined as never,
    config,
    { command: "serve", mode: "development" },
  )
  // Returning a partial config would send it back through `mergeConfig`, and a
  // merge rule deciding `root` is the ambiguity this plugin exists to remove.
  expect(returned).toBeUndefined()
  return config
}

describe("rootDefaultPlugin", () => {
  it("fills in the prototype root when the repo did not set one", () => {
    const config = runConfigHook(rootDefaultPlugin("/repo/app"), {})
    expect(config.root).toBe("/repo/app")
  })

  it("leaves the repo's own root alone", () => {
    const config = runConfigHook(rootDefaultPlugin("/repo"), { root: "/repo/app" })
    expect(config.root).toBe("/repo/app")
  })

  it("treats an empty string as unset", () => {
    // `root: ""` would resolve to `process.cwd()` inside Vite, which is the
    // exact failure this plugin exists to prevent (MEASURED: React Router then
    // looks for `app/root.tsx` beside the CLI and dies before listen).
    const config = runConfigHook(rootDefaultPlugin("/repo"), { root: "" })
    expect(config.root).toBe("/repo")
  })

  it("runs before every plugin that reads root, by both orderings", () => {
    const plugin = rootDefaultPlugin("/repo")
    // React Router reads `viteUserConfig.root` in its own normal-enforce
    // `config` hook, so the default has to be written before that runs.
    expect(plugin.enforce).toBe("pre")
    expect(typeof plugin.config === "object" ? plugin.config.order : null).toBe("pre")
  })
})

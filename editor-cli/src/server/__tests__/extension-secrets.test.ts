import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { applyExtensionSecretsToEnv } from "../apply-extension-secrets.js"
import {
  clearExtensionSecret,
  extensionSecretFilePath,
  readExtensionSecretNames,
  readExtensionSecrets,
  writeExtensionSecret,
} from "../extension-secret-store.js"

let home: string

beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), "ext-secrets-"))
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

describe("extension secret store", () => {
  it("round-trips a secret and degrades to empty when absent", async () => {
    expect(await readExtensionSecrets(home)).toEqual({})
    await writeExtensionSecret("FIGMA_API_KEY", "figd_x", home)
    expect(await readExtensionSecrets(home)).toEqual({ FIGMA_API_KEY: "figd_x" })
    expect(await readExtensionSecretNames(home)).toEqual(["FIGMA_API_KEY"])
    await clearExtensionSecret("FIGMA_API_KEY", home)
    expect(await readExtensionSecrets(home)).toEqual({})
  })

  it("writes the file 0600 inside a 0700 directory", async () => {
    await writeExtensionSecret("FIGMA_API_KEY", "figd_x", home)
    const path = extensionSecretFilePath(home)
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600)
    expect((await fs.stat(join(home, ".config", "desde"))).mode & 0o777).toBe(0o700)
  })

  it("keeps the other keys when one entry is the wrong type", async () => {
    // A hand-edited file must cost the user only the entry they broke. The
    // whole-file `return defaults()` the version check uses would silently
    // sign them out of every extension at once.
    const path = extensionSecretFilePath(home)
    await fs.mkdir(join(home, ".config", "desde"), { recursive: true })
    await fs.writeFile(
      path,
      JSON.stringify({ version: 1, secrets: { FIGMA_API_KEY: "ok", OTHER: 42 } }),
    )
    expect(await readExtensionSecrets(home)).toEqual({ FIGMA_API_KEY: "ok" })
  })

  it("degrades to empty on a corrupt file rather than throwing", async () => {
    const path = extensionSecretFilePath(home)
    await fs.mkdir(join(home, ".config", "desde"), { recursive: true })
    await fs.writeFile(path, "{ not json")
    expect(await readExtensionSecrets(home)).toEqual({})
  })
})

describe("applyExtensionSecretsToEnv", () => {
  it("injects a catalog secret", () => {
    const env: NodeJS.ProcessEnv = {}
    applyExtensionSecretsToEnv({ FIGMA_API_KEY: "figd_x" }, env)
    expect(env.FIGMA_API_KEY).toBe("figd_x")
  })

  it("REFUSES a name no capability declares", () => {
    // The load-bearing guard. `process.env` decides what every subprocess we
    // spawn inherits, so a store entry that could name PATH or NODE_OPTIONS
    // would be code execution rather than a setting. The HTTP layer checks the
    // same set; this is the second, independent half.
    const env: NodeJS.ProcessEnv = {}
    applyExtensionSecretsToEnv(
      { PATH: "/tmp/evil", NODE_OPTIONS: "--require /tmp/evil.js" },
      env,
    )
    expect(env.PATH).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
  })

  it("never overwrites a value already in the environment", () => {
    // An exported key must keep meaning what it says. Same rule the Anthropic
    // key follows.
    const env: NodeJS.ProcessEnv = { FIGMA_API_KEY: "exported" }
    applyExtensionSecretsToEnv({ FIGMA_API_KEY: "stored" }, env)
    expect(env.FIGMA_API_KEY).toBe("exported")
  })

  it("treats a whitespace-only stored value as absent", () => {
    const env: NodeJS.ProcessEnv = {}
    applyExtensionSecretsToEnv({ FIGMA_API_KEY: "   " }, env)
    expect(env.FIGMA_API_KEY).toBeUndefined()
  })
})

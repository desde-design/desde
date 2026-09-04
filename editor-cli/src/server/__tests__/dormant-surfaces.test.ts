import { afterEach, describe, expect, it } from "vitest"
import {
  dormantSurfaceRefusal,
  isCodeViewEnabled,
  isCanvasEnabled,
  isNotesEnabled,
  isNeutralChatEnabled,
  chatRuntimeOverride,
} from "../dormant-surfaces.js"

// Every gate's env var, because this list does double duty: `setEnv` is typed
// from it, and the save/restore around each test reads it. A surface added to
// GATES but not here fails typecheck rather than silently leaking its variable
// into the next case.
const ENV_KEYS = [
  "EDITOR_CODE_VIEW",
  "EDITOR_NOTES",
  "EDITOR_CANVAS",
  "EDITOR_NEUTRAL_CHAT",
] as const
const saved = new Map<string, string | undefined>()

afterEach(() => {
  for (const key of ENV_KEYS) {
    const was = saved.get(key)
    if (was === undefined) delete process.env[key]
    else process.env[key] = was
    saved.delete(key)
  }
})

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined) {
  if (!saved.has(key)) saved.set(key, process.env[key])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/**
 * Both gates are the same shape, so they get the same table. The point of
 * every falsy case is that `=== true` is the mechanism: an opt-in flag whose
 * absent state reads as enabled is not a gate.
 */
const GATES = [
  { name: "codeView", read: isCodeViewEnabled, env: "EDITOR_CODE_VIEW" },
  { name: "notes", read: isNotesEnabled, env: "EDITOR_NOTES" },
  { name: "canvas", read: isCanvasEnabled, env: "EDITOR_CANVAS" },
] as const

describe.each(GATES)("$name gate", ({ name, read, env }) => {
  it("is dormant with no editor block at all", () => {
    expect(read({})).toBe(false)
  })

  it("is dormant when the editor block omits the key", () => {
    expect(read({ editor: {} })).toBe(false)
  })

  it("is dormant on an explicit false", () => {
    expect(read({ editor: { [name]: false } })).toBe(false)
  })

  it("is dormant on a truthy value that is not true", () => {
    // A config typo must not open the gate.
    expect(read({ editor: { [name]: 1 } as never })).toBe(false)
    expect(read({ editor: { [name]: "true" } as never })).toBe(false)
  })

  it("is enabled on an explicit true", () => {
    expect(read({ editor: { [name]: true } })).toBe(true)
  })

  it("is enabled by the env var alone", () => {
    setEnv(env, "1")
    expect(read({})).toBe(true)
  })

  it("ignores an env var set to anything other than 1", () => {
    setEnv(env, "true")
    expect(read({})).toBe(false)
    setEnv(env, "0")
    expect(read({})).toBe(false)
  })

  it("cannot be turned OFF by the env var once config says true", () => {
    // Either source enables; neither disables, because absent already means
    // dormant and a second way to say "off" buys nothing.
    setEnv(env, "0")
    expect(read({ editor: { [name]: true } })).toBe(true)
  })
})

describe("the two gates are independent", () => {
  it("does not leak config across surfaces", () => {
    expect(isCodeViewEnabled({ editor: { notes: true } })).toBe(false)
    expect(isNotesEnabled({ editor: { codeView: true } })).toBe(false)
  })

  it("does not leak env vars across surfaces", () => {
    setEnv("EDITOR_NOTES", "1")
    expect(isNotesEnabled({})).toBe(true)
    expect(isCodeViewEnabled({})).toBe(false)
  })
})

describe("chatRuntimeOverride", () => {
  it("is undefined when the env var is unset", () => {
    expect(chatRuntimeOverride({})).toBeUndefined()
  })

  it("returns 'neutral' only for the exact value 'neutral'", () => {
    expect(chatRuntimeOverride({ EDITOR_CHAT_RUNTIME_OVERRIDE: "neutral" })).toBe("neutral")
    expect(chatRuntimeOverride({ EDITOR_CHAT_RUNTIME_OVERRIDE: "1" })).toBeUndefined()
    expect(chatRuntimeOverride({ EDITOR_CHAT_RUNTIME_OVERRIDE: "true" })).toBeUndefined()
  })

  it("is a separate switch from isNeutralChatEnabled", () => {
    // Forcing the override does not depend on the lane's own on/off switch,
    // and the lane's switch does not itself force a provider onto it.
    expect(isNeutralChatEnabled({})).toBe(true)
    expect(chatRuntimeOverride({ EDITOR_CHAT_RUNTIME_OVERRIDE: "neutral" })).toBe("neutral")
  })
})

describe("isNeutralChatEnabled", () => {
  it("is ON with no configuration at all", () => {
    // The inversion, and the one line that changes what users get. Every other
    // surface in this module is opt-IN because it is unfinished. This one is
    // finished, so it is opt-OUT: the absent state means enabled.
    expect(isNeutralChatEnabled({})).toBe(true)
  })

  it("is off when the project config says so", () => {
    expect(isNeutralChatEnabled({ editor: { neutralChat: false } })).toBe(false)
  })

  it("is off when EDITOR_NEUTRAL_CHAT is exactly 0", () => {
    const previous = process.env.EDITOR_NEUTRAL_CHAT
    process.env.EDITOR_NEUTRAL_CHAT = "0"
    try {
      expect(isNeutralChatEnabled({})).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.EDITOR_NEUTRAL_CHAT
      else process.env.EDITOR_NEUTRAL_CHAT = previous
    }
  })

  it("stays on for any other value of the variable", () => {
    const previous = process.env.EDITOR_NEUTRAL_CHAT
    process.env.EDITOR_NEUTRAL_CHAT = "yes"
    try {
      // Only an exact "0" disables, mirroring the exact-"1" rule the opt-in
      // surfaces use. A typo must not silently turn chat off for a provider.
      expect(isNeutralChatEnabled({})).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.EDITOR_NEUTRAL_CHAT
      else process.env.EDITOR_NEUTRAL_CHAT = previous
    }
  })
})

describe("dormantSurfaceRefusal", () => {
  it("names the config key and the env var, so a caller can act on it", () => {
    const reason = dormantSurfaceRefusal("codeView", "The in-app code view")
    expect(reason).toContain("The in-app code view is dormant")
    expect(reason).toContain('"codeView": true')
    expect(reason).toContain(".desde/config.json")
    expect(reason).toContain("EDITOR_CODE_VIEW=1")
  })

  it("names the right env var per surface", () => {
    expect(dormantSurfaceRefusal("notes", "Notes")).toContain("EDITOR_NOTES=1")
    expect(dormantSurfaceRefusal("notes", "Notes")).not.toContain("EDITOR_CODE_VIEW")
    // The third arm was added when canvas joined. A chained ternary is
    // exactly where a new surface silently inherits the previous one's env
    // var, so assert the name AND the absence of its neighbours.
    expect(dormantSurfaceRefusal("canvas", "Canvas")).toContain("EDITOR_CANVAS=1")
    expect(dormantSurfaceRefusal("canvas", "Canvas")).not.toContain("EDITOR_NOTES")
    expect(dormantSurfaceRefusal("canvas", "Canvas")).not.toContain("EDITOR_CODE_VIEW")
  })

  it("reads as a sentence, per the repo's copy rules", () => {
    for (const surface of ["codeView", "notes", "canvas"] as const) {
      const reason = dormantSurfaceRefusal(surface, "X")
      expect(reason).not.toContain("—")
      expect(reason.endsWith(".")).toBe(true)
    }
  })
})

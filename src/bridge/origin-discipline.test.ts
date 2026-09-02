// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest"
import * as esbuild from "esbuild"
import { JSDOM } from "jsdom"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Behavioural guard on the bridge's postMessage origin discipline.
 *
 * This is not a source grep. It bundles `comment-bridge.ts` exactly as
 * `build:bridge` does (minus `--minify`), runs the real IIFE inside a jsdom
 * document dressed as a framed prototype, and drives the actual
 * `window.addEventListener("message", …)` handler with real MessageEvents.
 *
 * What it exists to stop coming back: until 2026-08-10 an unconfigured shell
 * origin meant `isTrustedMessageOrigin` returned `true` for EVERY origin and
 * `resolveShellTargetOrigin` returned `"*"`. That was reachable in production
 * — a prototype serving `script-src 'self'` without `'unsafe-inline'` drops
 * the inline config tag that used to be the only origin channel — and it was
 * exploited: an unrelated origin framing such a prototype could read
 * inspection payloads and design tokens and drive interactions.
 *
 * Both halves have to hold. Inbound-only would still broadcast; outbound-only
 * would still act on hostile commands.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = resolve(HERE, "comment-bridge.ts")

let BUNDLE = ""

beforeAll(async () => {
  const out = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2020",
  })
  BUNDLE = out.outputFiles[0].text
}, 60_000)

const SHELL_ORIGIN = "https://shell.example"
const PROTO_ORIGIN = "https://proto.example"
const HOSTILE_ORIGIN = "https://evil.example"

interface Sent {
  message: Record<string, unknown>
  targetOrigin: string
}

interface Harness {
  /** Everything the bridge posted to its (fake, cross-origin) parent. */
  sent: Sent[]
  /** Deliver a message event as if it came from the parent frame. */
  deliver(origin: string, data: Record<string, unknown>): void
  window: JSDOM["window"]
}

/**
 * Boot the bridge in a jsdom document.
 *
 * @param originChannel how the shell origin reaches the bridge, if at all:
 *   "attribute" = `data-shell-origin` on the bridge's own script tag (the
 *   CSP-safe channel), "global" = the legacy inline `__DESDE_SHELL_ORIGIN__`,
 *   "attribute-wins" = both, disagreeing, "none" = neither (strict CSP).
 */
function boot(originChannel: "attribute" | "global" | "attribute-wins" | "none"): Harness {
  const attr =
    originChannel === "attribute" || originChannel === "attribute-wins"
      ? ` data-shell-origin="${SHELL_ORIGIN}"`
      : ""
  const globalOrigin =
    originChannel === "global"
      ? SHELL_ORIGIN
      : originChannel === "attribute-wins"
        ? HOSTILE_ORIGIN
        : null

  const dom = new JSDOM(
    `<!doctype html><html><body><div id="app">hello</div></body></html>`,
    { url: `${PROTO_ORIGIN}/`, runScripts: "dangerously", pretendToBeVisual: true },
  )
  const { window } = dom

  const sent: Sent[] = []
  // A cross-origin parent: distinct object identity (so `source === window.parent`
  // can be satisfied only by our own delivery) and reading `.location.origin`
  // throws, which is exactly how a real cross-origin parent behaves and is what
  // `resolveShellTargetOrigin` uses as its same-origin test.
  const fakeParent = {
    postMessage(message: Record<string, unknown>, targetOrigin: string) {
      sent.push({ message, targetOrigin })
    },
    get location(): never {
      throw new Error("cross-origin")
    },
  }
  Object.defineProperty(window, "parent", { value: fakeParent, configurable: true })

  if (globalOrigin) {
    ;(window as unknown as Record<string, unknown>).__DESDE_SHELL_ORIGIN__ = globalOrigin
  }

  // Inline the bundle as the bridge's own <script> so `document.currentScript`
  // resolves to a tag carrying (or lacking) the attribute — the same thing the
  // serve layers produce, minus the network fetch.
  const script = window.document.createElement("script")
  script.setAttribute("data-prototype-flow", "bridge")
  if (attr) script.setAttribute("data-shell-origin", SHELL_ORIGIN)
  script.textContent = BUNDLE
  window.document.body.appendChild(script)

  return {
    sent,
    window,
    deliver(origin, data) {
      const event = new window.MessageEvent("message", { data, origin })
      // jsdom refuses a non-Window `source` through the constructor, so pin it
      // afterwards. The bridge only ever compares it against `window.parent`.
      Object.defineProperty(event, "source", { value: fakeParent })
      window.dispatchEvent(event)
    },
  }
}

/** Ask for the design tokens — a read the exploit actually performed. */
function requestTokens(h: Harness): void {
  h.deliver(HOSTILE_ORIGIN, { type: "GET_PAGE_TOKENS", payload: { requestId: "x" } })
}

describe("bridge postMessage origin discipline", () => {
  it("boots and handshakes when the shell origin arrives on the script attribute", () => {
    const h = boot("attribute")
    expect(h.sent.map((s) => s.message.type)).toContain("BRIDGE_READY")
    expect(h.sent.every((s) => s.targetOrigin === SHELL_ORIGIN)).toBe(true)
  })

  it("still boots on the legacy inline global, for a serve layer that predates the attribute", () => {
    const h = boot("global")
    expect(h.sent.map((s) => s.message.type)).toContain("BRIDGE_READY")
    expect(h.sent.every((s) => s.targetOrigin === SHELL_ORIGIN)).toBe(true)
  })

  it("answers the configured shell", () => {
    const h = boot("attribute")
    const before = h.sent.length
    h.deliver(SHELL_ORIGIN, { type: "GET_PAGE_TOKENS", payload: { requestId: "x" } })
    expect(h.sent.slice(before).map((s) => s.message.type)).toContain("PAGE_TOKENS_CAPTURED")
  })

  it("ignores a message from an unrelated origin even when a shell IS configured", () => {
    const h = boot("attribute")
    const before = h.sent.length
    requestTokens(h)
    expect(h.sent.slice(before)).toEqual([])
  })

  it("treats the attribute as authoritative over a disagreeing global", () => {
    // A stale/hostile global naming evil.example must not widen trust, and the
    // attribute's shell must still be answered.
    const h = boot("attribute-wins")
    const beforeHostile = h.sent.length
    requestTokens(h)
    expect(h.sent.slice(beforeHostile)).toEqual([])

    const beforeShell = h.sent.length
    h.deliver(SHELL_ORIGIN, { type: "GET_PAGE_TOKENS", payload: { requestId: "x" } })
    expect(h.sent.slice(beforeShell).map((s) => s.message.type)).toContain("PAGE_TOKENS_CAPTURED")
  })

  describe("with no shell origin configured at all (strict CSP dropped the inline tag)", () => {
    it("sends NOTHING to a cross-origin embedder — no BRIDGE_READY, no broadcast", () => {
      const h = boot("none")
      expect(h.sent).toEqual([])
    })

    it("never uses a wildcard targetOrigin", () => {
      const h = boot("none")
      requestTokens(h)
      expect(h.sent.map((s) => s.targetOrigin)).not.toContain("*")
      expect(h.sent).toEqual([])
    })

    it("refuses reads and remote control from a cross-origin frame", () => {
      const h = boot("none")
      for (const data of [
        { type: "GET_PAGE_TOKENS", payload: { requestId: "a" } },
        { type: "INSPECT_SELECTOR", payload: { requestId: "b", selector: "#app" } },
        { type: "GET_STRUCTURE", payload: { requestId: "c" } },
        { type: "PERFORM_INTERACT", payload: { requestId: "d", selector: "#app", action: "click" } },
        {
          type: "READ_RENDERED_VALUE",
          payload: { requestId: "e", selector: "#app", accessor: { kind: "text" } },
        },
      ]) {
        h.deliver(HOSTILE_ORIGIN, data)
      }
      expect(h.sent).toEqual([])
    })
  })
})

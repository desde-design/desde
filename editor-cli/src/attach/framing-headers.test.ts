import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { allowShellFraming, allowShellFramingOnSend } from "./framing-headers"

describe("allowShellFraming", () => {
  it("drops X-Frame-Options whatever its value", () => {
    for (const value of ["SAMEORIGIN", "DENY", "sameorigin", "ALLOW-FROM https://x.test"]) {
      expect(allowShellFraming({ "x-frame-options": value })).toEqual({})
    }
  })

  it("matches header names case-insensitively", () => {
    expect(
      allowShellFraming({
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "img-src 'self'; frame-ancestors 'none'",
      }),
    ).toEqual({ "Content-Security-Policy": "img-src 'self'" })
  })

  it("removes only the frame-ancestors directive from a policy", () => {
    expect(
      allowShellFraming({
        "content-security-policy":
          "default-src 'self'; frame-ancestors 'self' https://a.test; img-src *",
      }),
    ).toEqual({ "content-security-policy": "default-src 'self'; img-src *" })
  })

  it("matches the directive name case-insensitively, as browsers do", () => {
    expect(
      allowShellFraming({ "content-security-policy": "script-src 'self';  FRAME-ANCESTORS 'none' " }),
    ).toEqual({ "content-security-policy": "script-src 'self'" })
  })

  // Node joins repeated headers with ", ", and a comma is also how a single
  // CSP header carries several policies. Each policy is enforced on its own,
  // so each one has to lose its frame-ancestors.
  it("handles several policies in one comma-joined value", () => {
    expect(
      allowShellFraming({
        "content-security-policy":
          "default-src 'self'; frame-ancestors 'none', frame-ancestors 'self', img-src *",
      }),
    ).toEqual({ "content-security-policy": "default-src 'self', img-src *" })
  })

  // Node never delivers CSP as an array (it joins repeats into one string), and
  // its types say so for the lowercase key. A header object built by hand can
  // still carry one under another spelling, which is what this exercises.
  it("handles an array of values", () => {
    expect(
      allowShellFraming({
        "Content-Security-Policy": ["frame-ancestors 'none'", "img-src *; frame-ancestors 'self'"],
      }),
    ).toEqual({ "Content-Security-Policy": ["img-src *"] })
  })

  it("deletes the header when frame-ancestors was all it said", () => {
    expect(allowShellFraming({ "content-security-policy": "frame-ancestors 'none'" })).toEqual({})
    expect(
      allowShellFraming({
        "Content-Security-Policy": ["frame-ancestors 'none'", "frame-ancestors 'self';"],
      }),
    ).toEqual({})
  })

  it("leaves a policy with no frame-ancestors byte-for-byte alone", () => {
    const csp = "default-src 'self';img-src data:  https:"
    expect(allowShellFraming({ "content-security-policy": csp })).toEqual({
      "content-security-policy": csp,
    })
  })

  // Report-only never blocks anything, so it is not ours to touch.
  it("leaves Content-Security-Policy-Report-Only alone", () => {
    const headers = { "content-security-policy-report-only": "frame-ancestors 'none'" }
    expect(allowShellFraming(headers)).toEqual(headers)
  })

  it("passes every other header through, and does not mutate its input", () => {
    const input = {
      "content-type": "text/html",
      "set-cookie": ["a=1", "b=2"],
      "x-frame-options": "DENY",
      "content-length": 12,
    }
    const snapshot = structuredClone(input)
    expect(allowShellFraming(input)).toEqual({
      "content-type": "text/html",
      "set-cookie": ["a=1", "b=2"],
      "content-length": 12,
    })
    expect(input).toEqual(snapshot)
  })
})

// The Vite host has no proxy in front of it, so the same rewrite happens on the
// response object instead. Every way Node lets a handler send headers is here,
// because a Vite config, a plugin and a user middleware each pick their own.
describe("allowShellFramingOnSend", () => {
  const DENY = { "x-frame-options": "DENY", "content-security-policy": "img-src *; frame-ancestors 'none'" }
  const routes: Record<string, (res: ServerResponse) => void> = {
    // Vite's own `server.headers` path: setHeader, then an implicit writeHead.
    "/implicit": (res) => {
      res.setHeader("X-Frame-Options", "SAMEORIGIN")
      res.setHeader("Content-Security-Policy", "frame-ancestors 'self'")
      res.end("ok")
    },
    "/object": (res) => {
      res.writeHead(200, { "content-type": "text/html", ...DENY })
      res.end("ok")
    },
    "/reason-and-object": (res) => {
      res.writeHead(200, "Fine", DENY)
      res.end("ok")
    },
    // setHeader and a writeHead object together: Node merges the two.
    "/mixed": (res) => {
      res.setHeader("x-frame-options", "SAMEORIGIN")
      res.writeHead(200, { "content-security-policy": "default-src 'self'; frame-ancestors 'none'" })
      res.end("ok")
    },
    "/raw-array": (res) => {
      res.writeHead(200, [
        "Content-Type", "text/html",
        "X-Frame-Options", "DENY",
        "Content-Security-Policy", "frame-ancestors 'none'; img-src *",
      ])
      res.end("ok")
    },
    "/flushed": (res) => {
      res.setHeader("x-frame-options", "DENY")
      res.flushHeaders()
      res.end("ok")
    },
    "/untouched": (res) => {
      res.setHeader("content-security-policy", "default-src 'self'")
      res.setHeader("x-content-type-options", "nosniff")
      res.end("ok")
    },
  }

  let server: Server
  let port: number

  beforeAll(async () => {
    server = createServer((_req, res) => {
      const route = routes[(_req.url ?? "/").split("?")[0] ?? "/"]
      if (route) route(res)
      else res.writeHead(404).end()
    })
    // The same wiring the Vite plugin uses: our listener runs before the app's.
    server.prependListener("request", (_req, res) => allowShellFramingOnSend(res))
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const addr = server.address()
    port = typeof addr === "object" && addr ? addr.port : 0
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function headersOf(path: string): Promise<{ status: number; headers: IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port, path }, (res: IncomingMessage) => {
        res.resume()
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers }))
      })
      req.on("error", reject)
      req.end()
    })
  }

  it("filters headers set with setHeader before an implicit writeHead", async () => {
    const { status, headers } = await headersOf("/implicit")
    expect(status).toBe(200)
    expect(headers["x-frame-options"]).toBeUndefined()
    expect(headers["content-security-policy"]).toBeUndefined()
  })

  it("filters a writeHead headers object, with or without a reason phrase", async () => {
    for (const path of ["/object", "/reason-and-object"]) {
      const { status, headers } = await headersOf(path)
      expect(status).toBe(200)
      expect(headers["x-frame-options"]).toBeUndefined()
      expect(headers["content-security-policy"]).toBe("img-src *")
    }
  })

  it("filters both halves when setHeader and a writeHead object are mixed", async () => {
    const { headers } = await headersOf("/mixed")
    expect(headers["x-frame-options"]).toBeUndefined()
    expect(headers["content-security-policy"]).toBe("default-src 'self'")
  })

  it("filters Node's raw [name, value, ...] header array", async () => {
    const { headers } = await headersOf("/raw-array")
    expect(headers["x-frame-options"]).toBeUndefined()
    expect(headers["content-security-policy"]).toBe("img-src *")
    expect(headers["content-type"]).toBe("text/html")
  })

  it("filters headers sent early by flushHeaders", async () => {
    const { headers } = await headersOf("/flushed")
    expect(headers["x-frame-options"]).toBeUndefined()
  })

  it("leaves a response with no framing refusal alone", async () => {
    const { headers } = await headersOf("/untouched")
    expect(headers["content-security-policy"]).toBe("default-src 'self'")
    expect(headers["x-content-type-options"]).toBe("nosniff")
  })
})

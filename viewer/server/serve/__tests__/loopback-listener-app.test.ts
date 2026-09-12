import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import type { NextFunction, Request, Response } from "express"
import { clearSiteDataUntilDelivered } from "../loopback-listener-app"

/**
 * Codex round 44. The one-shot `Clear-Site-Data` used to be consumed at
 * request entry, so a first document request aborted before its headers
 * went out lost it for good, and every later document inherited the
 * previous deployment's storage. The header stays on document responses
 * until one is actually delivered.
 */
function fakeResponse(): Response & EventEmitter {
  const headers = new Map<string, string>()
  const res = new EventEmitter() as Response & EventEmitter
  res.setHeader = ((name: string, value: string) => {
    headers.set(name.toLowerCase(), value)
    return res
  }) as Response["setHeader"]
  res.getHeader = ((name: string) => headers.get(name.toLowerCase())) as Response["getHeader"]
  return res
}
const document = { headers: { "sec-fetch-dest": "iframe" } } as unknown as Request
const asset = { headers: { "sec-fetch-dest": "script" } } as unknown as Request
const next: NextFunction = () => {}

describe("clearSiteDataUntilDelivered", () => {
  it("keeps attaching the header until a document response finishes", () => {
    const handler = clearSiteDataUntilDelivered()
    const aborted = fakeResponse()
    handler(document, aborted, next)
    expect(aborted.getHeader("Clear-Site-Data")).toBe('"cache", "storage"')
    aborted.emit("close")

    const delivered = fakeResponse()
    handler(document, delivered, next)
    expect(delivered.getHeader("Clear-Site-Data")).toBe('"cache", "storage"')
    delivered.emit("finish")

    const later = fakeResponse()
    handler(document, later, next)
    expect(later.getHeader("Clear-Site-Data")).toBeUndefined()
  })

  it("never attaches it to an asset response", () => {
    const handler = clearSiteDataUntilDelivered()
    const res = fakeResponse()
    handler(asset, res, next)
    expect(res.getHeader("Clear-Site-Data")).toBeUndefined()
  })
})

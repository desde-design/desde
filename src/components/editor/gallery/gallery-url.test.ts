import { describe, expect, it } from "vitest"
import { parseGalleryParams } from "./gallery-url"

describe("parseGalleryParams", () => {
  it("reports gallery mode off when the param is absent", () => {
    expect(parseGalleryParams("?url=http://x/prototype.html").stateId).toBeNull()
  })

  it("reports gallery mode on with no selection for a bare param", () => {
    expect(parseGalleryParams("?gallery").stateId).toBe("")
    expect(parseGalleryParams("?gallery=").stateId).toBe("")
  })

  it("reads the selected state id", () => {
    expect(parseGalleryParams("?gallery=delete-scope/both-scopes").stateId).toBe(
      "delete-scope/both-scopes",
    )
  })

  it("defaults to the light theme and reads dark when asked", () => {
    expect(parseGalleryParams("?gallery=").theme).toBe("light")
    expect(parseGalleryParams("?gallery=&theme=dark").theme).toBe("dark")
    expect(parseGalleryParams("?gallery=&theme=nonsense").theme).toBe("light")
  })
})

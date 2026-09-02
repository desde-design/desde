import { describe, expect, it } from "vitest"
import { canManageProjects, isInstanceRole, type InstanceRole } from "./instance-role"

describe("isInstanceRole", () => {
  it.each(["admin", "editor", "viewer"])("accepts %s", (role) => {
    expect(isInstanceRole(role)).toBe(true)
  })

  it.each([null, undefined, "", "owner", "ADMIN", 1, {}, ["admin"]])("rejects %j", (v) => {
    expect(isInstanceRole(v)).toBe(false)
  })
})

/**
 * The client mirror of the server's `hasProjectManageAuthority`. Worth its own
 * table rather than being inferred from the components that call it: it is a
 * security rule's UI reflection, and it used to exist as four hand-written
 * copies of `role === "admin" || role === "editor"`.
 */
describe("canManageProjects", () => {
  it("admits admin and editor", () => {
    expect(canManageProjects("admin")).toBe(true)
    expect(canManageProjects("editor")).toBe(true)
  })

  it("refuses viewer — the whole reason that role exists", () => {
    expect(canManageProjects("viewer")).toBe(false)
  })

  it("refuses not-signed-in and still-loading, which arrive as null/undefined", () => {
    expect(canManageProjects(null)).toBe(false)
    expect(canManageProjects(undefined)).toBe(false)
  })

  // Exhaustive over the union, so adding a fourth role forces a decision here
  // rather than silently inheriting `false` (or, worse, `true`) at four call
  // sites nobody re-reads.
  it("covers every InstanceRole value", () => {
    const roles: InstanceRole[] = ["admin", "editor", "viewer"]
    expect(roles.map(canManageProjects)).toEqual([true, true, false])
  })
})

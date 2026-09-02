import { describe, expect, it } from "vitest"
import { launcherRouteHash, parseLauncherRoute } from "./use-launcher-route"

describe("parseLauncherRoute", () => {
  it("treats anything that is not the new-project route as the project list", () => {
    for (const hash of ["", "#", "#/", "#/projects", "#/newish", "#other"]) {
      expect(parseLauncherRoute(hash)).toEqual({ view: "projects" })
    }
  })

  it("reads the create view with no source", () => {
    expect(parseLauncherRoute("#/new")).toEqual({
      view: "new-project",
      source: null,
    })
  })

  it("reads a deep link to one source", () => {
    expect(parseLauncherRoute("#/new?source=clone")).toEqual({
      view: "new-project",
      source: "clone",
    })
    expect(parseLauncherRoute("#/new?source=local")).toEqual({
      view: "new-project",
      source: "local",
    })
  })

  /**
   * An unrecognised source is null, NOT a default. Falling back to "local"
   * would silently skip the question the source step exists to ask, and a
   * hand-edited URL is exactly where a wrong value comes from.
   */
  it("ignores a source it does not recognise rather than guessing", () => {
    expect(parseLauncherRoute("#/new?source=svn")).toEqual({
      view: "new-project",
      source: null,
    })
    expect(parseLauncherRoute("#/new?source=")).toEqual({
      view: "new-project",
      source: null,
    })
  })

  it("survives extra params it does not own", () => {
    expect(parseLauncherRoute("#/new?source=local&gallery=x")).toEqual({
      view: "new-project",
      source: "local",
    })
  })
})

describe("launcherRouteHash", () => {
  it("round-trips every route", () => {
    const routes = [
      { view: "projects" } as const,
      { view: "new-project", source: null } as const,
      { view: "new-project", source: "local" } as const,
      { view: "new-project", source: "clone" } as const,
    ]
    for (const route of routes) {
      expect(parseLauncherRoute(launcherRouteHash(route))).toEqual(route)
    }
  })

  it("omits the param entirely when there is no source", () => {
    // `#/new?source=null` would parse back to null anyway, but it is a URL a
    // user can see and copy, so it should not contain the word "null".
    expect(launcherRouteHash({ view: "new-project", source: null })).toBe("#/new")
  })
})

describe("project settings route", () => {
  it("round-trips a path through the hash", () => {
    const hash = launcherRouteHash({ view: "project-settings", path: "/a/b c" })
    expect(parseLauncherRoute(hash)).toEqual({
      view: "project-settings",
      path: "/a/b c",
    })
  })

  it("encodes the characters that would otherwise end or split the fragment", () => {
    // A real project path can hold any of these. `#` ends the fragment, `&`
    // splits the query, `?` starts a second one.
    const path = "/repos/my app#1?x&y"
    const hash = launcherRouteHash({ view: "project-settings", path })
    expect(hash).not.toContain(" ")
    expect(hash.split("path=")[1]).not.toContain("#")
    expect(parseLauncherRoute(hash)).toEqual({ view: "project-settings", path })
  })

  it("falls back to the list when there is no path to show settings for", () => {
    // A settings page about nothing is not a page. Same reasoning `#/new`
    // uses for an unrecognised source.
    expect(parseLauncherRoute("#/settings")).toEqual({ view: "projects" })
    expect(parseLauncherRoute("#/settings?path=")).toEqual({ view: "projects" })
  })

  it("does not match a route that merely starts with the prefix", () => {
    // The `#/newish` defect, in its second home.
    expect(parseLauncherRoute("#/settingsish?path=/a")).toEqual({ view: "projects" })
  })
})

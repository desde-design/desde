// @vitest-environment jsdom

/**
 * The URL plumbing behind the combined "Connect GitHub access" action.
 *
 * The flow itself is one click that becomes sign-in → return → maybe GitHub
 * install. These are the pure pieces that decide where each leg goes; the
 * server's half (validating `?next=` against open redirects) is covered by
 * `server/api/__tests__/return-path.test.ts`.
 */

import { afterEach, describe, expect, it } from "vitest"
import {
  appendCheckMarker,
  accessFlowDestination,
  clearGithubCheckMarker,
  clearUrlParams,
  decideAccessFlowCheck,
  githubAccessFlowHref,
  githubCheckInstallationId,
  githubInstallUrl,
  isGithubCheckReturn,
} from "../github-access-flow"

afterEach(() => {
  window.history.replaceState(null, "", "/")
})

describe("appendCheckMarker", () => {
  it("adds the marker to a bare path", () => {
    expect(appendCheckMarker("/review/ai-gateway")).toBe("/review/ai-gateway?gh=check")
  })

  it("keeps an existing query", () => {
    expect(appendCheckMarker("/review/ai-gateway?repo=1")).toBe("/review/ai-gateway?repo=1&gh=check")
  })

  it("keeps the hash last, where a URL needs it", () => {
    expect(appendCheckMarker("/review/x#c1")).toBe("/review/x?gh=check#c1")
  })
})

describe("githubAccessFlowHref", () => {
  it("points at sign-in, with the marked return path encoded", () => {
    const href = githubAccessFlowHref("/review/ai-gateway?repo=1")
    expect(href.startsWith("/api/v1/auth/github?next=")).toBe(true)
    const next = new URL(href, "https://viewer.test").searchParams.get("next")
    expect(next).toBe("/review/ai-gateway?repo=1&gh=check")
  })
})

describe("isGithubCheckReturn", () => {
  it("recognises the return leg", () => {
    expect(isGithubCheckReturn("?repo=1&gh=check")).toBe(true)
  })

  it("is false for an ordinary visit, and for a different value", () => {
    expect(isGithubCheckReturn("")).toBe(false)
    expect(isGithubCheckReturn("?repo=1")).toBe(false)
    expect(isGithubCheckReturn("?gh=something-else")).toBe(false)
  })
})

describe("clearGithubCheckMarker", () => {
  /**
   * The marker has to come off, or a refresh re-arms the flow and the reader
   * bounces to GitHub again on a page they only reloaded.
   */
  it("removes only the marker, leaving the rest of the URL alone", () => {
    window.history.replaceState(null, "", "/review/x?repo=1&gh=check#c1")
    clearGithubCheckMarker()
    expect(window.location.search).toBe("?repo=1")
    expect(window.location.hash).toBe("#c1")
    expect(window.location.pathname).toBe("/review/x")
  })

  it("does nothing when the marker is absent", () => {
    window.history.replaceState(null, "", "/review/x?repo=1")
    clearGithubCheckMarker()
    expect(window.location.search).toBe("?repo=1")
  })

  it("leaves no trailing '?' when the marker was the only parameter", () => {
    window.history.replaceState(null, "", "/review/x?gh=check")
    clearGithubCheckMarker()
    expect(window.location.search).toBe("")
    expect(window.location.href).not.toContain("?")
  })
})

describe("githubInstallUrl", () => {
  it("points at the page that INSTALLS the App, not the one that lists installs", () => {
    expect(githubInstallUrl("desde-viewer")).toBe(
      "https://github.com/apps/desde-viewer/installations/new",
    )
  })

  it("encodes the slug", () => {
    expect(githubInstallUrl("a b")).toBe("https://github.com/apps/a%20b/installations/new")
  })

  it("is null when the slug is unknown, so a caller cannot build a broken link", () => {
    expect(githubInstallUrl(null)).toBeNull()
  })
})

/**
 * The two halves of the flow, checked against each other.
 *
 * Each host supplies a return path carrying the parameter that reopens ITS
 * dialog (`?repo=1` on the review screen, `?connect=<id>` on the dashboard).
 * The flow then adds its own marker to that path. Nothing type-checks the
 * relationship, and losing it is silent: the reader completes sign-in, comes
 * back, and lands on a page with the dialog shut.
 */
describe("round trip — the host's reopen parameter survives the flow", () => {
  const hosts: [string, string, string][] = [
    ["review screen", "/review/ai-gateway?repo=1", "repo"],
    ["dashboard wizard", "/?connect=proj_123", "connect"],
    ["dashboard card settings", "/?settings=proj_123", "settings"],
  ]

  for (const [name, returnPath, reopenParam] of hosts) {
    it(`keeps ${reopenParam} for the ${name}, and marks it as a return`, () => {
      const href = githubAccessFlowHref(returnPath)
      const next = new URL(href, "https://viewer.test").searchParams.get("next")
      expect(next).not.toBeNull()

      // What the browser lands on after the callback redirects to `next`.
      const landed = new URL(next as string, "https://viewer.test")
      expect(landed.searchParams.has(reopenParam)).toBe(true)
      expect(isGithubCheckReturn(landed.search)).toBe(true)

      // And clearing the marker leaves the reopen parameter behind, so the
      // dialog stays open once the check has run.
      window.history.replaceState(null, "", `${landed.pathname}${landed.search}`)
      clearGithubCheckMarker()
      expect(new URLSearchParams(window.location.search).has(reopenParam)).toBe(true)
      expect(isGithubCheckReturn(window.location.search)).toBe(false)
    })
  }
})

/**
 * The account the flow was about.
 *
 * It travels because the "no repositories on this account" screen cannot be
 * resolved from the refreshed account list: that list comes back non-empty,
 * since the account is in it. The first version of the flow asked only the
 * count and therefore stopped dead on that screen every time (found by a
 * codex review, 2026-08-29).
 */
describe("githubCheckInstallationId", () => {
  it("round-trips through the href the button uses", () => {
    const href = githubAccessFlowHref("/review/x?repo=1", 42)
    const next = new URL(href, "https://viewer.test").searchParams.get("next") as string
    const landed = new URL(next, "https://viewer.test")
    expect(githubCheckInstallationId(landed.search)).toBe(42)
  })

  it("is null when the flow was about no account in particular", () => {
    const href = githubAccessFlowHref("/review/x?repo=1")
    const next = new URL(href, "https://viewer.test").searchParams.get("next") as string
    expect(next).not.toContain("ghi=")
    expect(githubCheckInstallationId(new URL(next, "https://viewer.test").search)).toBeNull()
  })

  it("is null unless this is actually a return leg", () => {
    // The id alone must not arm anything: a link someone pasted, or a
    // parameter another page owns, is not a flow.
    expect(githubCheckInstallationId("?ghi=42")).toBeNull()
  })

  /**
   * The value reaches an API path, so anything that is not a positive integer
   * is refused rather than passed along for GitHub to reject.
   */
  it("refuses a value that is not a positive integer", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "", "1e3", "9999999999999999999999", " 42"]) {
      expect(githubCheckInstallationId(`?gh=check&ghi=${encodeURIComponent(bad)}`)).toBeNull()
    }
  })

  it("comes off with the rest of the marker", () => {
    window.history.replaceState(null, "", "/review/x?repo=1&gh=check&ghi=42")
    clearGithubCheckMarker()
    expect(window.location.search).toBe("?repo=1")
  })
})

describe("appendCheckMarker with an account", () => {
  it("keeps the hash last", () => {
    expect(appendCheckMarker("/review/x#c1", 7)).toBe("/review/x?gh=check&ghi=7#c1")
  })

  it("ignores a non-finite id rather than writing NaN into a URL", () => {
    expect(appendCheckMarker("/review/x", Number.NaN)).toBe("/review/x?gh=check")
    expect(appendCheckMarker("/review/x", null)).toBe("/review/x?gh=check")
  })
})

/**
 * The return leg's decision.
 *
 * This is the piece that has been wrong twice, and it is tested here rather
 * than through the component because an effect that does nothing looks
 * exactly like an effect that correctly decided to do nothing. Both defects
 * were found by review, with a full green suite.
 */
describe("decideAccessFlowCheck", () => {
  const base = {
    installations: [] as { id: number; htmlUrl?: string | null }[],
    installationsStale: false,
    pendingInstallationId: null as number | null,
    flowMode: "fresh" as "fresh" | "edit" | null,
    access: "can-manage" as "loading" | "signed-out" | "read-only" | "can-manage",
    selectedInstallationId: null as number | null,
    repos: null as unknown[] | null,
  }

  it("waits while the account list is in flight", () => {
    expect(decideAccessFlowCheck({ ...base, installations: null })).toEqual({ action: "wait" })
  })

  it("waits while the reader's role is still resolving", () => {
    expect(decideAccessFlowCheck({ ...base, access: "loading" })).toEqual({ action: "wait" })
  })

  /**
   * The account list is only fetched for someone who can manage. A reader who
   * comes back read-only would otherwise wait on a list nothing requests, and
   * the marker would sit on their address bar for good (codex, 2026-08-29).
   * That is why the role is checked BEFORE the list, and why this takes an
   * access state rather than a boolean: `loading` and `read-only` need
   * opposite answers, and a boolean cannot hold both.
   */
  it("stops for a settled read-only reader rather than waiting on a fetch nobody makes", () => {
    for (const access of ["read-only", "signed-out"] as const) {
      expect(decideAccessFlowCheck({ ...base, access, installations: null })).toEqual({
        action: "stop",
      })
    }
  })

  it("goes to GitHub when no account has the App, naming no account", () => {
    expect(decideAccessFlowCheck(base)).toEqual({
      action: "continueToGithub",
      installationHtmlUrl: null,
    })
  })

  /**
   * A stale list is "we could not read GitHub", not "nothing is installed",
   * and a first-time signer-in has no snapshot so it arrives empty AND stale.
   * Continuing would send someone who already has the App off to install it
   * again, and burn the retry marker on the way out (codex, 2026-08-29).
   */
  it("stops on a stale answer rather than reading it as 'nothing installed'", () => {
    expect(decideAccessFlowCheck({ ...base, installationsStale: true })).toEqual({
      action: "stop",
    })
    // Even with accounts present: stale means the answer is not trustworthy.
    expect(
      decideAccessFlowCheck({
        ...base,
        installations: [{ id: 7 }],
        installationsStale: true,
        pendingInstallationId: 7,
      }),
    ).toEqual({ action: "stop" })
  })

  it("stops when the flow was about nothing and there is now something to pick", () => {
    expect(decideAccessFlowCheck({ ...base, installations: [{ id: 7 }] })).toEqual({
      action: "stop",
    })
  })

  it("stops when the account the flow was about is gone", () => {
    expect(
      decideAccessFlowCheck({
        ...base,
        installations: [{ id: 7 }],
        pendingInstallationId: 99,
      }),
    ).toEqual({ action: "stop" })
  })

  describe("the account the flow was about is still there", () => {
    const withPending = { ...base, installations: [{ id: 7 }], pendingInstallationId: 7 }

    it("waits for the wizard's mode, which resolves from a different fetch", () => {
      expect(decideAccessFlowCheck({ ...withPending, flowMode: null })).toEqual({
        action: "wait",
      })
    })

    it("stops for a reader who never gets a wizard, without waiting on it", () => {
      expect(decideAccessFlowCheck({ ...withPending, flowMode: null, access: "read-only" })).toEqual(
        { action: "stop" },
      )
    })

    it("stops in edit mode, which never reaches the empty-repo screen", () => {
      expect(decideAccessFlowCheck({ ...withPending, flowMode: "edit" })).toEqual({
        action: "stop",
      })
    })

    it("selects that account so the wizard does not drop back to the picker", () => {
      expect(decideAccessFlowCheck(withPending)).toEqual({ action: "select", installationId: 7 })
    })

    it("waits for its repositories once it is selected", () => {
      expect(decideAccessFlowCheck({ ...withPending, selectedInstallationId: 7 })).toEqual({
        action: "wait",
      })
    })

    /**
     * The case the whole account-carrying mechanism exists for. Asking only
     * whether the ACCOUNT list was empty answered "not empty" here, every
     * time, so the flow stopped on the one screen it was needed for.
     */
    it("goes to that account's OWN page when it still shares no repository", () => {
      expect(
        decideAccessFlowCheck({
          ...withPending,
          installations: [{ id: 7, htmlUrl: "https://github.com/settings/installations/7" }],
          selectedInstallationId: 7,
          repos: [],
        }),
      ).toEqual({
        action: "continueToGithub",
        installationHtmlUrl: "https://github.com/settings/installations/7",
      })
    })

    it("names no account when GitHub sent no URL for it", () => {
      expect(
        decideAccessFlowCheck({ ...withPending, selectedInstallationId: 7, repos: [] }),
      ).toEqual({ action: "continueToGithub", installationHtmlUrl: null })
    })

    it("stops once that account has a repository to pick", () => {
      expect(
        decideAccessFlowCheck({ ...withPending, selectedInstallationId: 7, repos: [{}] }),
      ).toEqual({ action: "stop" })
    })
  })
})

/**
 * The reopen parameters (`?repo=1`, `?connect=`, `?settings=`) exist to put a
 * dialog back up after the flow's round trip. A dialog that CLOSES has to
 * drop its own, or a reload reopens what the reader just dismissed and a
 * copied link reopens it for whoever they sent it to (codex, 2026-08-29).
 */
describe("clearUrlParams", () => {
  it("removes the named parameter and leaves the rest of the URL alone", () => {
    window.history.replaceState(null, "", "/review/x?repo=1&tab=comments#c1")
    clearUrlParams("repo")
    expect(window.location.search).toBe("?tab=comments")
    expect(window.location.hash).toBe("#c1")
    expect(window.location.pathname).toBe("/review/x")
  })

  it("removes several at once", () => {
    window.history.replaceState(null, "", "/?connect=a&settings=b&keep=1")
    clearUrlParams("connect", "settings")
    expect(window.location.search).toBe("?keep=1")
  })

  it("leaves no trailing '?' when the parameter was the only one", () => {
    window.history.replaceState(null, "", "/?settings=abc")
    clearUrlParams("settings")
    expect(window.location.href).not.toContain("?")
  })

  it("does nothing when none of them are present", () => {
    window.history.replaceState(null, "", "/?keep=1")
    clearUrlParams("repo", "connect")
    expect(window.location.search).toBe("?keep=1")
  })
})

/**
 * The two dead ends need different GitHub pages, and getting this wrong is
 * invisible: both URLs load, and one of them just puts an account picker in
 * front of someone who already said which account they meant (codex,
 * 2026-08-29).
 */
describe("accessFlowDestination", () => {
  it("uses the installation's own page when the flow was about one", () => {
    expect(
      accessFlowDestination(
        {
          action: "continueToGithub",
          installationHtmlUrl: "https://github.com/organizations/acme/settings/installations/7",
        },
        "desde-viewer",
      ),
    ).toBe("https://github.com/organizations/acme/settings/installations/7")
  })

  it("uses the install page when no account has the App", () => {
    expect(
      accessFlowDestination({ action: "continueToGithub", installationHtmlUrl: null }, "desde-viewer"),
    ).toBe("https://github.com/apps/desde-viewer/installations/new")
  })

  it("falls back to the install page when GitHub sent no URL", () => {
    // An account picker is a worse destination than a direct link, and a much
    // better one than nowhere.
    expect(
      accessFlowDestination({ action: "continueToGithub", installationHtmlUrl: null }, "a b"),
    ).toBe("https://github.com/apps/a%20b/installations/new")
  })

  it("is null when there is nowhere at all to send them", () => {
    expect(
      accessFlowDestination({ action: "continueToGithub", installationHtmlUrl: null }, null),
    ).toBeNull()
  })
})

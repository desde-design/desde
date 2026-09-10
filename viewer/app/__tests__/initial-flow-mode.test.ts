/**
 * `decideInitialFlowMode` — which flow the repo panel opens on.
 *
 * Written after the defect it closes reached a real install (Mo, 2026-09-10):
 * a connected project opened on the from-scratch wizard, and its Connect
 * button was dead. Both halves came from the same place.
 *
 * The panel reads three values that arrive from three separate requests: the
 * caller's role (`/me`), the project (`/projects/:id`), and whether a GitHub
 * App is configured (`/github/installations`). Two effects decided the flow
 * from them, and neither waited for the project. When `/me` won the race,
 * `repoConfig` was still null — not because nothing was connected, but
 * because nobody had looked yet — and the "no connection, open the wizard"
 * effect fired. The other effect, the one that puts a connected project on
 * its settings form, is guarded on the mode being undecided, so it could
 * never take it back.
 *
 * What the reader got: an account picker for a repository they had already
 * connected. Walking it again reached a form whose values matched what was
 * saved, so the dirty check refused to submit, and the button said Connect
 * with nothing left to connect.
 *
 * The rows below are ordered by the check they exercise, matching the
 * function's own doc comment.
 */

import { describe, expect, it } from "vitest"
import { decideInitialFlowMode, type ProjectRepoConfigView } from "../project-repo-utils"

const CONFIG: ProjectRepoConfigView = {
  installationId: 160669858,
  owner: "mochang",
  name: "mo-desde-test-repo",
  defaultBranch: "main",
  branch: "main",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDir: "dist",
  autoDeploy: true,
}

/** Every field settled and manageable, with a connection. Rows override one thing. */
function state(over: Partial<Parameters<typeof decideInitialFlowMode>[0]> = {}) {
  return {
    projectLoaded: true,
    access: "can-manage" as const,
    githubConfigured: true as boolean | null,
    repoConfig: CONFIG as ProjectRepoConfigView | null,
    flowMode: null as "fresh" | "edit" | null,
    ...over,
  }
}

describe("decideInitialFlowMode", () => {
  it("never re-decides a mode that is already set", () => {
    // The reader chose "Change repo", or a connect just landed. Either way
    // this must not pull them back out of it.
    expect(decideInitialFlowMode(state({ flowMode: "fresh" }))).toEqual({ action: "wait" })
    expect(decideInitialFlowMode(state({ flowMode: "edit" }))).toEqual({ action: "wait" })
    expect(
      decideInitialFlowMode(state({ flowMode: "fresh", repoConfig: null })),
    ).toEqual({ action: "wait" })
  })

  it("opens no editing surface for a reader who cannot manage", () => {
    for (const access of ["loading", "signed-out", "read-only"] as const) {
      expect(decideInitialFlowMode(state({ access }))).toEqual({ action: "wait" })
      expect(decideInitialFlowMode(state({ access, repoConfig: null }))).toEqual({
        action: "wait",
      })
    }
  })

  it("waits for the project rather than reading a not-yet-loaded null as 'nothing connected'", () => {
    /*
     * THE REGRESSION ROW. Before the fix this returned "fresh", and check 1
     * then made that permanent: the reader spent the rest of the page load in
     * a wizard for a repository that was already connected.
     *
     * The role is settled and the project is not, which is the exact state
     * `/me` winning the race produces. It is not a rare interleaving — it is
     * whichever of two requests answers first.
     */
    expect(
      decideInitialFlowMode(state({ projectLoaded: false, repoConfig: null })),
    ).toEqual({ action: "wait" })
  })

  it("opens the from-scratch wizard once the project has loaded with no connection", () => {
    expect(decideInitialFlowMode(state({ repoConfig: null }))).toEqual({ action: "fresh" })
  })

  it("opens the wizard for an unconnected project even before the App state is known", () => {
    // A project with nothing connected has nothing to edit either way, and
    // the wizard's own steps report an unconfigured App. Waiting on a third
    // request to say so would leave the panel blank for no gain.
    expect(
      decideInitialFlowMode(state({ repoConfig: null, githubConfigured: null })),
    ).toEqual({ action: "fresh" })
    expect(
      decideInitialFlowMode(state({ repoConfig: null, githubConfigured: false })),
    ).toEqual({ action: "fresh" })
  })

  it("shows the read-only card for a connected project when no App is configured", () => {
    // `false` is settled: there is nothing a save could do, so no form.
    expect(decideInitialFlowMode(state({ githubConfigured: false }))).toEqual({
      action: "wait",
    })
    // `null` is "still unknown", which is a wait for a different reason. Same
    // answer, and deliberately so: committing to either surface here would be
    // committing on a value that has not arrived.
    expect(decideInitialFlowMode(state({ githubConfigured: null }))).toEqual({
      action: "wait",
    })
  })

  it("opens the settings form, carrying the connection it was decided from", () => {
    // The config rides along on the decision rather than being re-read at the
    // call site: an `edit` that had to reach back for a possibly-null
    // `repoConfig` would need a non-null assertion, which is the type system
    // being told to ignore the exact ambiguity this function exists to settle.
    expect(decideInitialFlowMode(state())).toEqual({ action: "edit", repoConfig: CONFIG })
  })
})

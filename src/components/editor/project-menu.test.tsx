/**
 * ProjectMenu always renders the project's NAME from the embedded identity
 * (`EDITOR_PROJECT.identity`, sourced from `.desde/config.json` — no
 * sign-in, network, or cloud link needed), falling back to the raw slug and
 * then the literal string "Project" only when neither is present. Linking to
 * a viewer is a menu item ("Open in viewer" / "Copy project link"), not a
 * replacement for the chip's label — `activeProjectId` gates whether those
 * two items are enabled, it does not change what name is shown.
 *
 * Only `@/lib/editor-feature-flags` is mocked, since `EDITOR_PROJECT` is read
 * from the CLI bootstrap global at module-load time and there is no CLI
 * process in a unit test. There is no Firestore involved — the component
 * never reads it.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"

const embeddedIdentity = {
  id: "abc123def",
  name: "AI Gateway",
  slug: "ai-gateway",
}

const editorProject: {
  projectId: string | null
  slug: string | null
  identity: typeof embeddedIdentity | null
  platformBaseUrl: string | null
} = {
  projectId: null,
  slug: "ai-gateway",
  identity: embeddedIdentity,
  platformBaseUrl: null,
}

vi.mock("@/lib/editor-feature-flags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get EDITOR_PROJECT() {
    return editorProject
  },
}))


import { ProjectMenu } from "./project-menu"
import { useEditorStore } from "@/stores/editor-only"

afterEach(() => {
  cleanup()
  useEditorStore.setState({ activeProjectId: null })
})

describe("ProjectMenu", () => {
  it("shows the embedded project name when no cloud project is linked", () => {
    // Unlinked is the DEFAULT state. This used to render a bare "Link project"
    // button, so the repo's own name -- which the CLI already had in hand from
    // .desde/config.json -- was never surfaced anywhere.
    useEditorStore.setState({ activeProjectId: null })
    render(<ProjectMenu asBreadcrumb />)
    expect(screen.getByText("AI Gateway")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /^link project$/i }),
    ).toBeNull()
  })

  it("falls back to the slug when the repo has no embedded identity", () => {
    editorProject.identity = null
    useEditorStore.setState({ activeProjectId: null })
    render(<ProjectMenu asBreadcrumb />)
    expect(screen.getByText("ai-gateway")).toBeInTheDocument()
    editorProject.identity = embeddedIdentity
  })

  it("shows the embedded identity name even when the repo has no legacy slug", async () => {
    // Pins the CONSUMER half of the dropped-`identity` bug: given an identity
    // and no legacy slug, the chip must render the identity name rather than
    // falling back to `slug ?? "Project"`.
    //
    // It does NOT — and cannot — detect the bug that actually shipped, which
    // was on the PRODUCER side: the CLI bootstrap serialized
    // `projectId`/`slug`/`platformBaseUrl` and dropped `identity`. This file
    // `vi.mock`s `EDITOR_PROJECT` wholesale, so no serialization runs here and
    // this test passes either way. The real guard is the full-object `toEqual`
    // in editor-cli's http-server-bootstrap-project.integration.test.ts, which
    // pins the payload shape in both the identity-present and identity-absent
    // cases. Keep both: this one would catch a consumer-side regression, that
    // one catches a producer-side one.
    editorProject.slug = null
    useEditorStore.setState({ activeProjectId: null })
    render(<ProjectMenu asBreadcrumb />)
    await waitFor(() =>
      expect(screen.getByText("AI Gateway")).toBeInTheDocument(),
    )
    expect(screen.queryByText("Project")).toBeNull()
    editorProject.slug = "ai-gateway"
  })
})

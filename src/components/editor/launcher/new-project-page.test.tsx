/**
 * Tests for `<NewProjectPage>`'s wizard: the source step resolves a path
 * (pick / manual entry / clone) WITHOUT opening anything; the name step mints
 * the prototype's identity; the terminal design-systems step offers "Add a
 * design system" fed by the suggest route, accumulating a local pending list
 * that "Open prototype" declares before the final open.
 */

import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NewProjectPage, pendingIdentity } from "./new-project-page"
import { declarationIdentity } from "@/editor/core/design-system-declarations"
import type { DesignSystemDeclaration } from "@/editor/core/design-system-declarations"
import type { LauncherOpenBlock } from "@/types/launcher"
import type { GitHubReposState } from "./use-launcher-api"

function baseProps() {
  return {
    open: true,
    onOpenChange: vi.fn(),
    initialSource: null,
    folderPickerSupported: true,
    busy: false,
    error: null,
    openBlock: null,
    // Default: every picked path is openable. The suite below overrides this
    // for the repo-we-cannot-boot case.
    onInspectPath: vi.fn().mockResolvedValue({ block: null, error: null }),
    onPickFolder: vi.fn().mockResolvedValue({ supported: true, path: "/picked/repo" }),
    onOpenPath: vi.fn().mockResolvedValue(undefined),
    onClone: vi.fn().mockResolvedValue({ path: "/cloned/repo" }),
    onSuggestDesignSystems: vi.fn().mockResolvedValue([]),
    onDeclareDesignSystems: vi.fn().mockResolvedValue({ ok: true }),
    onSetProjectName: vi.fn().mockResolvedValue({ ok: true }),
  }
}

/**
 * Finish from the (now terminal) design-systems step. The wizard has one
 * commit point at the end that flushes the pending design-system list.
 * Reference folders left the wizard 2026-08-31; they live in settings now.
 */
function finishFromDesignSystems(): void {
  fireEvent.click(screen.getByTestId("new-project-open"))
}

/** Advance past the new name step to reach the design-systems step. */
async function passNameStep(): Promise<void> {
  await screen.findByTestId("new-project-name-continue")
  fireEvent.click(screen.getByTestId("new-project-name-continue"))
}

/**
 * Selecting a source REVEALS its form on the same step (2026-08-17). It was
 * select-then-Next for a while, which meant the source step's Next advanced
 * the flow without moving the progress bar.
 *
 * Still one call so the tests read the same either way, and so a future change
 * to how a source is chosen lands in one place.
 */
function chooseSource(which: "local" | "clone"): void {
  fireEvent.click(screen.getByTestId(`new-project-${which}`))
}

/**
 * Once `gh` has answered, the clone step's URL box sits behind its own tab, so
 * reading it takes a click. Before that answer there are no tabs and the box is
 * the whole step.
 *
 * mouseDown, not click: Radix activates a tab on press, so `fireEvent.click`
 * leaves the strip untouched and the assertion fails against the tab you were
 * already on. Same as `segmented-toggle.test.tsx`.
 */
function openUrlTab(): void {
  fireEvent.mouseDown(screen.getByTestId("new-project-tab-url"), { button: 0 })
}

/**
 * Radix `DropdownMenuTrigger` opens on POINTER DOWN, so `fireEvent.click`
 * leaves the menu shut and the item queries fail. Same trap as `openUrlTab`
 * above, and as `editor-toolbar.test.tsx`.
 */
function openRowMenu(id: string): void {
  fireEvent.pointerDown(screen.getByTestId(`design-system-row-menu-${id}`), {
    button: 0,
    ctrlKey: false,
  })
}

/** Pick a folder the way the UI does: Browse fills the field, Continue commits. */
async function pickLocalFolder(): Promise<void> {
  chooseSource("local")
  fireEvent.click(await screen.findByTestId("new-project-browse"))
  await screen.findByTestId("new-project-local-continue")
  fireEvent.click(screen.getByTestId("new-project-local-continue"))
}

describe("NewProjectPage", () => {
  it("advances to the design-systems step after a successful folder pick", async () => {
    const props = baseProps()
    render(<NewProjectPage {...props} />)

    await pickLocalFolder()

    await waitFor(() => expect(props.onPickFolder).toHaveBeenCalled())
    await passNameStep()
    await screen.findByTestId("new-project-design-systems-step")
    expect(screen.getByText("Add a design system")).toBeInTheDocument()
    expect(props.onOpenPath).not.toHaveBeenCalled()
  })

  it("shows the picked path back before it is used", async () => {
    // Browse fills the field rather than advancing. The old flow jumped
    // straight to the name step, so the path you chose was never shown.
    const props = baseProps()
    render(<NewProjectPage {...props} />)

    chooseSource("local")
    fireEvent.click(await screen.findByTestId("new-project-browse"))

    await waitFor(() =>
      expect(screen.getByLabelText("Folder path")).toHaveValue("/picked/repo"),
    )
    expect(screen.queryByTestId("new-project-name-step")).not.toBeInTheDocument()
  })

  it("stays on the folder step when the pick is canceled", async () => {
    const props = baseProps()
    props.onPickFolder.mockResolvedValue({ supported: true, path: undefined })
    render(<NewProjectPage {...props} />)

    chooseSource("local")
    fireEvent.click(await screen.findByTestId("new-project-browse"))
    await waitFor(() => expect(props.onPickFolder).toHaveBeenCalled())

    expect(screen.queryByTestId("new-project-design-systems-step")).not.toBeInTheDocument()
    expect(screen.getByTestId("new-project-local-step")).toBeInTheDocument()
    // Nothing was picked, so there is nothing to continue with.
    expect(screen.getByTestId("new-project-local-continue")).toBeDisabled()
  })

  it("drops the Browse button when no native picker is supported", async () => {
    // A permanently dead button is worse than no button; the field beside it
    // already accepts a typed path.
    const props = baseProps()
    props.onPickFolder.mockResolvedValue({ supported: false })
    render(<NewProjectPage {...props} />)

    chooseSource("local")
    fireEvent.click(await screen.findByTestId("new-project-browse"))
    await waitFor(() =>
      expect(screen.queryByTestId("new-project-browse")).not.toBeInTheDocument(),
    )

    const input = screen.getByLabelText("Folder path")
    fireEvent.change(input, { target: { value: "/manual/path" } })
    fireEvent.click(screen.getByTestId("new-project-local-continue"))

    await passNameStep()
    await screen.findByTestId("new-project-design-systems-step")
    expect(props.onSuggestDesignSystems).toHaveBeenCalledWith("/manual/path")
  })

  /**
   * There is no "Next" on this step any more: picking a source reveals its
   * form in place, and the footer button does the step's actual work. What has
   * to hold is that the step opens as ONE question, with no form and no live
   * submit until a source is chosen.
   */
  it("shows no source form and a dead submit until a source is picked", () => {
    render(<NewProjectPage {...baseProps()} />)
    expect(screen.queryByTestId("new-project-local-step")).not.toBeInTheDocument()
    expect(screen.queryByTestId("new-project-clone-step")).not.toBeInTheDocument()
    // A Next that advanced without moving the stepper is exactly what this
    // step lost; nothing should reintroduce one.
    expect(screen.queryByTestId("new-project-source-next")).not.toBeInTheDocument()
    expect(screen.getByTestId("new-project-local-continue")).toBeDisabled()

    fireEvent.click(screen.getByTestId("new-project-local"))
    expect(screen.getByTestId("new-project-local-step")).toBeInTheDocument()
    // Still dead: a source alone is not a path.
    expect(screen.getByTestId("new-project-local-continue")).toBeDisabled()
  })

  it("swaps the revealed form when the other source is picked", () => {
    render(<NewProjectPage {...baseProps()} />)
    fireEvent.click(screen.getByTestId("new-project-local"))
    expect(screen.getByTestId("new-project-local-step")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("new-project-clone"))
    // One form at a time, under both cards.
    expect(screen.queryByTestId("new-project-local-step")).not.toBeInTheDocument()
    expect(screen.getByTestId("new-project-clone-step")).toBeInTheDocument()
  })

  it("advances to the design-systems step after a successful clone", async () => {
    const props = baseProps()
    render(<NewProjectPage {...props} />)

    chooseSource("clone")
    fireEvent.change(await screen.findByLabelText("Repository URL"), {
      target: { value: "https://github.com/acme/repo.git" },
    })
    fireEvent.click(screen.getByTestId("new-project-clone-submit"))

    await waitFor(() =>
      expect(props.onClone).toHaveBeenCalledWith("https://github.com/acme/repo.git"),
    )
    await passNameStep()
    await screen.findByTestId("new-project-design-systems-step")
    expect(props.onSuggestDesignSystems).toHaveBeenCalledWith("/cloned/repo")
  })

  it("opens the resolved path without declaring anything when nothing was added", async () => {
    const props = baseProps()
    render(<NewProjectPage {...props} />)

    await pickLocalFolder()
    await passNameStep()
    await screen.findByTestId("new-project-design-systems-step")

    finishFromDesignSystems()

    await waitFor(() => expect(props.onOpenPath).toHaveBeenCalledWith("/picked/repo"))
    expect(props.onDeclareDesignSystems).not.toHaveBeenCalled()
  })

  /**
   * Installed-but-unregistered systems SEED the list (2026-08-17). They used
   * to be a third source you picked ("Already installed here") and then picked
   * again from, which asked the same question twice.
   */
  it("seeds the list with what is already installed, and declares it on finish", async () => {
    const props = baseProps()
    props.onSuggestDesignSystems.mockResolvedValue([
      { package: "@acme/ui", componentCount: 5, framework: "vue3" },
    ])
    render(<NewProjectPage {...props} />)

    await pickLocalFolder()
    await passNameStep()
    await screen.findByTestId("new-project-design-systems-step")

    // No click needed: it is in the list because it was found.
    const row = await screen.findByTestId("design-system-row-@acme/ui")
    expect(row).toHaveTextContent("@acme/ui")
    expect(row).toHaveTextContent("Detected")

    finishFromDesignSystems()

    await waitFor(() =>
      expect(props.onDeclareDesignSystems).toHaveBeenCalledWith("/picked/repo", [
        { source: { kind: "installed", package: "@acme/ui" } },
      ]),
    )
    await waitFor(() => expect(props.onOpenPath).toHaveBeenCalledWith("/picked/repo"))
  })

  it("does not open when the declare call fails", async () => {
    const props = baseProps()
    props.onSuggestDesignSystems.mockResolvedValue([
      { package: "@acme/ui", componentCount: 5, framework: "vue3" },
    ])
    props.onDeclareDesignSystems.mockResolvedValue({ ok: false, reason: "boom" })
    render(<NewProjectPage {...props} />)

    await pickLocalFolder()
    await passNameStep()
    await screen.findByTestId("new-project-design-systems-step")
    await screen.findByTestId("design-system-row-@acme/ui")

    finishFromDesignSystems()

    await waitFor(() => expect(props.onDeclareDesignSystems).toHaveBeenCalled())
    expect(props.onOpenPath).not.toHaveBeenCalled()
  })

  /**
   * A detected row is still removable. Being found is not consent, and the
   * scan is a heuristic over node_modules.
   */
  it("removes a detected row from the list via its menu", async () => {
    const props = baseProps()
    props.onSuggestDesignSystems.mockResolvedValue([
      { package: "@acme/ui", componentCount: 5, framework: "vue3" },
    ])
    render(<NewProjectPage {...props} />)

    await pickLocalFolder()
    await passNameStep()
    await screen.findByTestId("new-project-design-systems-step")
    await screen.findByTestId("design-system-row-@acme/ui")

    openRowMenu("@acme/ui")
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }))

    await waitFor(() =>
      expect(screen.queryByTestId("design-system-row-@acme/ui")).not.toBeInTheDocument(),
    )
  })

  /**
   * A detected row has no editable fields behind it — only the package name it
   * was found as — so offering Edit would open an empty form.
   */
  it("offers no Edit on a detected row", async () => {
    const props = baseProps()
    props.onSuggestDesignSystems.mockResolvedValue([
      { package: "@acme/ui", componentCount: 5, framework: "vue3" },
    ])
    render(<NewProjectPage {...props} />)

    await pickLocalFolder()
    await passNameStep()
    await screen.findByTestId("new-project-design-systems-step")
    await screen.findByTestId("design-system-row-@acme/ui")

    openRowMenu("@acme/ui")
    expect(await screen.findByRole("menuitem", { name: "Remove" })).toBeInTheDocument()
    expect(screen.queryByRole("menuitem", { name: "Edit" })).not.toBeInTheDocument()
  })

  it("adds an npm package through the modal, and it lands in the list", async () => {
    const props = baseProps()
    props.onSuggestDesignSystems.mockResolvedValue([])
    render(<NewProjectPage {...props} />)

    await pickLocalFolder()
    await passNameStep()
    await screen.findByTestId("new-project-design-systems-step")

    fireEvent.click(screen.getByTestId("design-system-add"))
    fireEvent.click(await screen.findByTestId("add-design-system-source-npm"))
    fireEvent.change(await screen.findByLabelText("Package"), {
      target: { value: "@acme/ds@2.0.0" },
    })
    fireEvent.click(screen.getByTestId("add-design-system-submit"))

    expect(await screen.findByTestId("design-system-row-@acme/ds")).toBeInTheDocument()
    // The modal closed on success rather than leaving the form up.
    await waitFor(() =>
      expect(screen.queryByTestId("add-design-system-dialog")).not.toBeInTheDocument(),
    )
  })

  it("renders the current error via the Callout", () => {
    render(<NewProjectPage {...baseProps()} error="Something failed" />)
    expect(screen.getByRole("alert")).toHaveTextContent("Something failed")
  })
})

/**
 * A folder Editor cannot boot.
 *
 * The check runs the moment a path resolves, and the reason it runs THERE is
 * that the two steps after it write to the user's repo: the name step mints
 * `.desde/config.json`, the design-system step appends `designSystems`
 * declarations. Refusing at the end would mean editing a repo we then decline
 * to open.
 */
describe("NewProjectPage — a project that cannot be opened", () => {
  const BLOCK: LauncherOpenBlock = {
    // The generic refusal. `host-not-enabled` and the per-host explanation
    // were removed 2026-08-17: a dormant framework and an unsupported one are
    // the same thing to a user.
    code: "framework-unsupported",
    summary: "Astro isn't supported.",
    remediation: [],
    attachCovers: false,
    supported: [
      { id: "vite", label: "Vite" },
      { id: "next", label: "Next.js" },
    ],
  }

  it("checks the picked path before asking for a name", async () => {
    const props = baseProps()
    props.onPickFolder.mockResolvedValue({ supported: true, path: "/repos/astro-site" })
    props.onInspectPath.mockResolvedValue({ block: BLOCK, error: null })
    render(<NewProjectPage {...props} openBlock={BLOCK} />)

    await pickLocalFolder()

    await waitFor(() => expect(props.onInspectPath).toHaveBeenCalledWith("/repos/astro-site"))
    // Never advances, so nothing is written to the repo.
    expect(screen.queryByLabelText(/project name/i)).not.toBeInTheDocument()
    expect(props.onSetProjectName).not.toHaveBeenCalled()
    expect(props.onDeclareDesignSystems).not.toHaveBeenCalled()
    expect(props.onOpenPath).not.toHaveBeenCalled()
  })

  it("checks a cloned path too", async () => {
    const props = baseProps()
    props.onInspectPath.mockResolvedValue({ block: BLOCK, error: null })
    render(<NewProjectPage {...props} initialSource="clone" openBlock={BLOCK} />)

    fireEvent.change(screen.getByLabelText(/repository url/i), {
      target: { value: "https://github.com/acme/astro-site.git" },
    })
    fireEvent.click(screen.getByTestId("new-project-clone-submit"))

    await waitFor(() => expect(props.onInspectPath).toHaveBeenCalledWith("/cloned/repo"))
    expect(screen.queryByLabelText(/project name/i)).not.toBeInTheDocument()
  })

  it("renders the summary and what IS supported, with no dormant list", () => {
    render(<NewProjectPage {...baseProps()} openBlock={BLOCK} />)

    const notice = screen.getByTestId("launcher-open-block")
    expect(notice).toHaveTextContent(BLOCK.summary)
    expect(notice).toHaveTextContent("Vite")
    expect(notice).toHaveTextContent("Next.js")
    // No "built, not switched on" list, and nothing about .astro pages being
    // inspect-only. A refusal screen says what you CAN do.
    expect(notice).not.toHaveTextContent(/built, not switched on/i)
    expect(notice).not.toHaveTextContent(/inspect/i)
    // Never names the product.
    expect(notice).not.toHaveTextContent(/\bEditor\b/)
  })

  it("renders no numbered list when there is no remediation", () => {
    render(<NewProjectPage {...baseProps()} openBlock={BLOCK} />)
    // An empty `remediation` is now legal and means "the supported list is the
    // answer". An empty <ol> would be a bullet-less stub.
    expect(
      screen.getByTestId("launcher-open-block").querySelectorAll("ol"),
    ).toHaveLength(0)
  })

  it("still renders each remediation step as its own list item when there are some", () => {
    const withSteps: LauncherOpenBlock = {
      ...BLOCK,
      code: "not-a-git-repo",
      summary: "This folder is not a git repository, and one is required.",
      remediation: ["Run git init, commit once, then open it again.", "Or open the repository this folder belongs to instead."],
    }
    render(<NewProjectPage {...baseProps()} openBlock={withSteps} />)
    const steps = screen
      .getByTestId("launcher-open-block")
      .querySelectorAll("ol > li")
    expect(steps).toHaveLength(2)
  })

  it("puts no nested panel inside the banner, even for process output", () => {
    const bootFailed: LauncherOpenBlock = {
      ...BLOCK,
      code: "boot-failed",
      summary: "This project could not be started.",
      cause: "This project declares Astro but astro is not installed.",
      remediation: ["Run npm install, then open it again."],
    }
    render(<NewProjectPage {...baseProps()} openBlock={bootFailed} />)
    const notice = screen.getByTestId("launcher-open-block")
    expect(notice).toHaveTextContent(bootFailed.cause!)
    // The cause used to render in its own bordered, tinted panel headed
    // "What Editor printed while starting it". A card inside a banner is two
    // containers for one message.
    expect(notice).not.toHaveTextContent(/what .* printed/i)
  })

  it("still advances when the path checks out", async () => {
    const props = baseProps()
    props.onPickFolder.mockResolvedValue({ supported: true, path: "/repos/vue-app" })
    render(<NewProjectPage {...props} />)

    await pickLocalFolder()

    expect(await screen.findByLabelText(/project name/i)).toBeInTheDocument()
    expect(props.onInspectPath).toHaveBeenCalledWith("/repos/vue-app")
  })
})

describe("pendingIdentity — parity with the core declarationIdentity", () => {
  // `pendingIdentity` is a duplicated (not imported) mirror of
  // `declarationIdentity` (src/editor/core/design-system-declarations.ts),
  // kept separate because that module reads/writes the config file with
  // `node:fs/promises` at module scope, which the browser UI bundle can't
  // resolve. Tests run in Node, though, so importing the real
  // `declarationIdentity` here is safe and lets this test catch drift
  // between the two directly (M4).
  it.each<[string, DesignSystemDeclaration["source"]]>([
    ["installed", { kind: "installed", package: "@acme/design-system" }],
    ["npm with a spec range", { kind: "npm", spec: "@acme/ds@^2" }],
    ["repo with ref + subdir", { kind: "repo", url: "https://github.com/acme/ds", ref: "main", subdir: "packages/ui" }],
  ])("matches declarationIdentity for a %s declaration", (_label, source) => {
    expect(pendingIdentity(source)).toBe(declarationIdentity(source))
  })

  // -------------------------------------------------------------------------
  // Naming (user item #2: "a dialog to input the name of the project")
  // -------------------------------------------------------------------------

  it("asks for a project name after a source is chosen, prefilled from the folder", async () => {
    const props = baseProps()
    props.onPickFolder.mockResolvedValue({ supported: true, path: "/repos/ai-gateway" })
    render(<NewProjectPage {...props} />)

    await pickLocalFolder()

    const input = (await screen.findByLabelText(/project name/i)) as HTMLInputElement
    expect(input.value).toBe("ai-gateway")
  })

  it("does not advance past the name step with a blank name", async () => {
    const props = baseProps()
    render(<NewProjectPage {...props} />)

    await pickLocalFolder()
    const input = await screen.findByLabelText(/project name/i)
    fireEvent.change(input, { target: { value: "   " } })

    expect(screen.getByTestId("new-project-name-continue")).toBeDisabled()
  })

  it("persists the name before opening the project", async () => {
    const props = baseProps()
    props.onPickFolder.mockResolvedValue({ supported: true, path: "/repos/ai-gateway" })
    render(<NewProjectPage {...props} />)

    await pickLocalFolder()
    const input = await screen.findByLabelText(/project name/i)
    fireEvent.change(input, { target: { value: "AI Gateway" } })
    fireEvent.click(screen.getByTestId("new-project-name-continue"))

    await screen.findByTestId("new-project-design-systems-step")
    finishFromDesignSystems()

    await waitFor(() =>
      expect(props.onSetProjectName).toHaveBeenCalledWith("/repos/ai-gateway", "AI Gateway"),
    )
    await waitFor(() => expect(props.onOpenPath).toHaveBeenCalledWith("/repos/ai-gateway"))
  })

  it("names a cloned repo from its checkout directory", async () => {
    const props = baseProps()
    props.onClone.mockResolvedValue({ path: "/clones/my-proto" })
    render(<NewProjectPage {...props} />)

    chooseSource("clone")
    fireEvent.change(await screen.findByLabelText(/repository url/i), {
      target: { value: "https://github.com/acme/my-proto.git" },
    })
    fireEvent.click(screen.getByTestId("new-project-clone-submit"))

    const input = (await screen.findByLabelText(/project name/i)) as HTMLInputElement
    expect(input.value).toBe("my-proto")
  })
})

/**
 * Browsing the developer's own GitHub repos through their `gh` login.
 *
 * The invariant under test in all of these: the repo list only ever FILLS the
 * URL field. There is one value and one Clone button whether you picked a row
 * or typed the URL, so a host without `gh` loses a convenience and nothing else.
 */
describe("NewProjectPage — GitHub repositories", () => {
  const repos = [
    { nameWithOwner: "acme/design-system", name: "design-system", isPrivate: true, updatedAt: "2026-08-09T00:00:00Z" },
    { nameWithOwner: "acme/checkout-proto", name: "checkout-proto", isPrivate: false, updatedAt: "2026-08-01T00:00:00Z" },
  ]

  /**
   * Regression, found by adversarial review and MEASURED before the fix.
   *
   * The `gh` fetch used to cancel on effect cleanup, which the merged source
   * step fires on every card click, while `askedGitHubRef` was only cleared by
   * `reset()` on an open false->true transition. So: pick Clone, change your
   * mind before `gh` answers, change back — the answer was discarded, the
   * effect early-returned on the latch, and the list sat on "Looking for your
   * repositories" for the rest of that page open.
   *
   * The collapse to one step is what made this a single radio click; before
   * it, leaving and re-entering took Next then Back.
   */
  it("still fills the repo list when the user leaves the clone card and comes back", async () => {
    const props = baseProps()
    let resolveRepos: (value: GitHubReposState) => void = () => {}
    const onListGitHubRepos = vi.fn(
      () => new Promise<GitHubReposState>((resolve) => { resolveRepos = resolve }),
    )
    render(<NewProjectPage {...props} onListGitHubRepos={onListGitHubRepos} />)

    chooseSource("clone")
    await waitFor(() => expect(onListGitHubRepos).toHaveBeenCalledTimes(1))
    // Away before it answers, then back.
    chooseSource("local")
    chooseSource("clone")

    await act(async () => {
      resolveRepos({ available: true, repos: [repos[0]] })
    })

    // The answer lands even though the user was elsewhere when it arrived.
    expect(
      await screen.findByTestId(`new-project-repo-${repos[0].nameWithOwner}`),
    ).toBeInTheDocument()
    expect(screen.queryByTestId("new-project-repo-loading")).not.toBeInTheDocument()
    // And it was asked exactly once: the latch still does its job.
    expect(onListGitHubRepos).toHaveBeenCalledTimes(1)
  })

  it("fills the clone URL from a picked repository", async () => {
    const props = baseProps()
    const onListGitHubRepos = vi.fn().mockResolvedValue({ available: true, repos })
    render(<NewProjectPage {...props} onListGitHubRepos={onListGitHubRepos} />)

    chooseSource("clone")
    fireEvent.click(await screen.findByTestId("new-project-repo-acme/checkout-proto"))

    // The same field the typed path uses, so Clone needs no second branch. It
    // sits on the other tab now, and a row picked here turns up there filled in.
    openUrlTab()
    expect(screen.getByLabelText("Repository URL")).toHaveValue(
      "https://github.com/acme/checkout-proto.git",
    )

    fireEvent.click(screen.getByTestId("new-project-clone-submit"))
    await waitFor(() =>
      expect(props.onClone).toHaveBeenCalledWith("https://github.com/acme/checkout-proto.git"),
    )
  })

  it("shows the list without the URL box beside it", async () => {
    // The point of the tabs. The two ways in used to stack, so everyone who
    // came to pick from the list also got a half-filled form parked under it.
    const props = baseProps()
    const onListGitHubRepos = vi.fn().mockResolvedValue({ available: true, repos })
    render(<NewProjectPage {...props} onListGitHubRepos={onListGitHubRepos} />)

    chooseSource("clone")
    await screen.findByTestId("new-project-repo-filter")

    expect(screen.queryByLabelText("Repository URL")).not.toBeInTheDocument()

    // And the other tab is the way to it, not a second thing on this one.
    openUrlTab()
    expect(screen.getByLabelText("Repository URL")).toBeInTheDocument()
    expect(screen.queryByTestId("new-project-repo-filter")).not.toBeInTheDocument()
  })

  it("shows a loading state instead of flashing the URL box while gh answers", async () => {
    // The bug this covers: `gh` is a shell-out, so the answer lands AFTER the
    // step is already on screen. Rendering the bare URL box in the meantime
    // meant a signed-in user watched the wrong control appear and then get
    // replaced by the list. The tab strip is up front from the first paint, so
    // the list fills in underneath it rather than displacing anything.
    const props = baseProps()
    let resolveList: (value: unknown) => void = () => {}
    const pending = new Promise((resolve) => {
      resolveList = resolve
    })
    const onListGitHubRepos = vi.fn().mockReturnValue(pending)
    render(<NewProjectPage {...props} onListGitHubRepos={onListGitHubRepos} />)

    chooseSource("clone")

    // Pending: tabs and the filter are already up, and the bare URL box is NOT
    // sitting where the list is about to land.
    expect(await screen.findByTestId("new-project-repo-loading")).toBeInTheDocument()
    expect(screen.getByTestId("new-project-tab-repos")).toBeInTheDocument()
    expect(screen.getByTestId("new-project-repo-filter")).toBeInTheDocument()
    expect(screen.queryByLabelText("Repository URL")).not.toBeInTheDocument()

    resolveList({ available: true, repos })

    // Resolved: the loading line is replaced in place, tabs never moved.
    await screen.findByTestId("new-project-repo-acme/checkout-proto")
    expect(screen.queryByTestId("new-project-repo-loading")).not.toBeInTheDocument()
    expect(screen.getByTestId("new-project-tab-repos")).toBeInTheDocument()
  })

  it("keeps a half-typed URL when the repo list arrives", async () => {
    // The URL tab is reachable while gh is still answering, so a user who does
    // not want the list is never blocked on it. What they type there has to
    // survive the answer landing.
    const props = baseProps()
    let resolveList: (value: unknown) => void = () => {}
    const pending = new Promise((resolve) => {
      resolveList = resolve
    })
    const onListGitHubRepos = vi.fn().mockReturnValue(pending)
    render(<NewProjectPage {...props} onListGitHubRepos={onListGitHubRepos} />)

    chooseSource("clone")
    await screen.findByTestId("new-project-repo-loading")

    openUrlTab()
    fireEvent.change(screen.getByLabelText("Repository URL"), {
      target: { value: "https://github.com/acme/typed.git" },
    })

    resolveList({ available: true, repos })
    await waitFor(() => expect(onListGitHubRepos).toHaveBeenCalled())

    // Still on the URL tab, still holding what was typed.
    expect(screen.getByLabelText("Repository URL")).toHaveValue(
      "https://github.com/acme/typed.git",
    )
  })

  it("filters the list without losing the filter box when nothing matches", async () => {
    // Gating the filter on the VISIBLE rows would remove it the moment a query
    // matched nothing, trapping the user in an empty list they cannot undo.
    const props = baseProps()
    const onListGitHubRepos = vi.fn().mockResolvedValue({ available: true, repos })
    render(<NewProjectPage {...props} onListGitHubRepos={onListGitHubRepos} />)

    chooseSource("clone")
    const filter = await screen.findByTestId("new-project-repo-filter")

    fireEvent.change(filter, { target: { value: "design" } })
    expect(screen.getByTestId("new-project-repo-acme/design-system")).toBeInTheDocument()
    expect(screen.queryByTestId("new-project-repo-acme/checkout-proto")).not.toBeInTheDocument()

    fireEvent.change(filter, { target: { value: "zzz" } })
    expect(screen.getByText("No repositories match that filter.")).toBeInTheDocument()
    expect(screen.getByTestId("new-project-repo-filter")).toBeInTheDocument()
  })

  it("keeps the URL field and names the fix when gh is not signed in", async () => {
    const props = baseProps()
    const onListGitHubRepos = vi
      .fn()
      .mockResolvedValue({ available: false, reason: "not-authenticated" })
    render(<NewProjectPage {...props} onListGitHubRepos={onListGitHubRepos} />)

    chooseSource("clone")
    await waitFor(() => expect(onListGitHubRepos).toHaveBeenCalled())

    expect(screen.queryByTestId("new-project-repo-filter")).not.toBeInTheDocument()
    expect(screen.getByLabelText("Repository URL")).toBeInTheDocument()
    // Signed out is an ordinary state, not an error: one quiet line, no alert.
    expect(screen.getByText(/gh auth login/)).toBeInTheDocument()
    expect(screen.queryByTestId("new-project-error")).not.toBeInTheDocument()
  })

  it("says to install the CLI when gh is missing entirely", async () => {
    const props = baseProps()
    const onListGitHubRepos = vi
      .fn()
      .mockResolvedValue({ available: false, reason: "not-installed" })
    render(<NewProjectPage {...props} onListGitHubRepos={onListGitHubRepos} />)

    chooseSource("clone")
    expect(await screen.findByText(/Install the GitHub CLI/)).toBeInTheDocument()
  })

  it("shells out once even when the parent re-renders mid-flight", async () => {
    // The original guard was `repos !== null`, which is false until the shell-out
    // RESOLVES. A parent that re-renders in that window hands down a new callback
    // identity, re-runs the effect, and starts another `gh` — which re-renders the
    // parent again. The gallery fixture (which logs every call, and logging
    // re-renders its host) spun until React's update-depth limit tripped.
    const props = baseProps()
    let resolveList: (value: unknown) => void = () => {}
    const calls: number[] = []
    const pending = new Promise((resolve) => {
      resolveList = resolve
    })

    function Host() {
      const [tick, setTick] = useState(0)
      return (
        <>
          <button type="button" data-testid="host-rerender" onClick={() => setTick(tick + 1)} />
          <NewProjectPage
            {...props}
            // New identity every render, exactly like the gallery fixture.
            onListGitHubRepos={() => {
              calls.push(tick)
              return pending as Promise<never>
            }}
          />
        </>
      )
    }

    render(<Host />)
    chooseSource("clone")
    await waitFor(() => expect(calls).toHaveLength(1))

    fireEvent.click(screen.getByTestId("host-rerender"))
    fireEvent.click(screen.getByTestId("host-rerender"))
    expect(calls).toHaveLength(1)

    resolveList({ available: true, repos })
    await waitFor(() => expect(screen.getByTestId("new-project-repo-filter")).toBeInTheDocument())
    expect(calls).toHaveLength(1)
  })

  it("starts clean when the parent closes the dialog without going through onOpenChange", async () => {
    // LauncherPage flips `open` to false itself before spawning the editor
    // (handoffToLoader), so the reset in handleOpenChange never runs. A failed
    // spawn then reopened the dialog on the previous run's repo URL and repo
    // list — and askedGitHubRef made that list impossible to refresh, because
    // "we already shelled out" was still true from the last open.
    const props = baseProps()
    const onListGitHubRepos = vi.fn().mockResolvedValue({ available: true, repos })
    const { rerender } = render(
      <NewProjectPage {...props} onListGitHubRepos={onListGitHubRepos} />,
    )

    chooseSource("clone")
    fireEvent.click(await screen.findByTestId("new-project-repo-acme/checkout-proto"))
    openUrlTab()
    expect(screen.getByLabelText("Repository URL")).toHaveValue(
      "https://github.com/acme/checkout-proto.git",
    )

    rerender(
      <NewProjectPage {...props} open={false} onListGitHubRepos={onListGitHubRepos} />,
    )
    rerender(<NewProjectPage {...props} open onListGitHubRepos={onListGitHubRepos} />)

    // Back at the start, and `gh` runs again for the reopened dialog.
    expect(screen.queryByTestId("new-project-clone-step")).not.toBeInTheDocument()
    chooseSource("clone")
    await waitFor(() => expect(onListGitHubRepos).toHaveBeenCalledTimes(2))
    openUrlTab()
    expect(screen.getByLabelText("Repository URL")).toHaveValue("")
  })

  it("re-asks gh on reopen even when the step never changed, and drops the old answer", async () => {
    // Deep-linked to the clone step, `step` is "clone" before and after a
    // close/reopen. Keying the load effect on `step` alone meant it never
    // re-ran: the reset cleared `repos` and nothing refilled it, so the picker
    // silently disappeared for the rest of that open. The dialog does not
    // unmount when it closes, which is what makes this reachable at all.
    const props = { ...baseProps(), initialSource: "clone" as const }
    let resolveFirst: (value: unknown) => void = () => {}
    const first = new Promise((resolve) => {
      resolveFirst = resolve
    })
    const onListGitHubRepos = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValue({ available: true, repos })

    const { rerender } = render(
      <NewProjectPage {...props} onListGitHubRepos={onListGitHubRepos} />,
    )
    await waitFor(() => expect(onListGitHubRepos).toHaveBeenCalledTimes(1))

    rerender(<NewProjectPage {...props} open={false} onListGitHubRepos={onListGitHubRepos} />)
    rerender(<NewProjectPage {...props} open onListGitHubRepos={onListGitHubRepos} />)

    await waitFor(() => expect(onListGitHubRepos).toHaveBeenCalledTimes(2))
    await screen.findByTestId("new-project-repo-filter")

    // The previous open's answer lands late and must not overwrite this one.
    resolveFirst({ available: false, reason: "not-authenticated" })
    await Promise.resolve()
    expect(screen.getByTestId("new-project-repo-filter")).toBeInTheDocument()
  })

  it("does not shell out to gh until the clone step is showing", async () => {
    const props = baseProps()
    const onListGitHubRepos = vi.fn().mockResolvedValue({ available: true, repos })
    render(<NewProjectPage {...props} onListGitHubRepos={onListGitHubRepos} />)

    // Most opens are for a local folder and never reach the clone step.
    expect(onListGitHubRepos).not.toHaveBeenCalled()
    chooseSource("clone")
    await waitFor(() => expect(onListGitHubRepos).toHaveBeenCalledTimes(1))
  })
})

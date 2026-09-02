/**
 * Tests for `<AddReferenceDirectory>` — purely props-driven, so every side
 * effect (`onInspect`, `onBrowse`, `onAdd`) is a `vi.fn()` and the assertions
 * drive the real DOM via `data-testid`, following the harness pattern in
 * `src/components/editor/launcher/new-project-page.test.tsx`.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { AddReferenceDirectory } from "./add-reference-directory"
import type { ReferenceDirectoryEntry, ReferenceDirectoryInspection } from "./add-reference-directory"

function baseProps() {
  return {
    onInspect: vi.fn<(path: string) => Promise<ReferenceDirectoryInspection | null>>(
      async () => null,
    ),
    onAdd: vi.fn<(entry: ReferenceDirectoryEntry) => Promise<unknown>>(async () => true),
    takenNames: [] as readonly string[],
  }
}

function fields() {
  return {
    path: screen.getByTestId("reference-dir-path") as HTMLInputElement,
    name: screen.getByTestId("reference-dir-name") as HTMLInputElement,
    description: screen.getByTestId("reference-dir-description") as HTMLInputElement,
    add: screen.getByTestId("reference-dir-add") as HTMLButtonElement,
  }
}

describe("AddReferenceDirectory — inspect on blur", () => {
  it("calls onInspect with the trimmed path when the path field loses focus", async () => {
    const props = baseProps()
    render(<AddReferenceDirectory {...props} />)
    const { path } = fields()

    fireEvent.change(path, { target: { value: "  /repos/billing-web  " } })
    fireEvent.blur(path)

    await waitFor(() => expect(props.onInspect).toHaveBeenCalledWith("/repos/billing-web"))
  })

  it("does not call onInspect when the path is blank", async () => {
    const props = baseProps()
    render(<AddReferenceDirectory {...props} />)
    const { path } = fields()

    fireEvent.change(path, { target: { value: "   " } })
    fireEvent.blur(path)

    // Nothing async to await on the not-called path, so just assert directly —
    // there is no pending microtask that could still call onInspect later.
    expect(props.onInspect).not.toHaveBeenCalled()
  })

  it("fills the path field and prefills the name with suggestedName on a successful inspect", async () => {
    const props = baseProps()
    props.onInspect.mockResolvedValue({
      path: "/repos/billing-web",
      suggestedName: "billing-web",
      isGit: true,
    })
    render(<AddReferenceDirectory {...props} />)
    const { path, name } = fields()

    fireEvent.change(path, { target: { value: "/repos/billing-web" } })
    fireEvent.blur(path)

    await waitFor(() => expect(path.value).toBe("/repos/billing-web"))
    expect(name.value).toBe("billing-web")
  })

  it("does not overwrite a name the user already typed", async () => {
    // Deliberate behavior: re-inspecting after a typo must not discard a name
    // the user chose for themselves.
    const props = baseProps()
    props.onInspect.mockResolvedValue({
      path: "/repos/billing-web",
      suggestedName: "server-suggested-name",
      isGit: true,
    })
    render(<AddReferenceDirectory {...props} />)
    const { path, name } = fields()

    fireEvent.change(name, { target: { value: "my-own-name" } })
    fireEvent.change(path, { target: { value: "/repos/billing-web" } })
    fireEvent.blur(path)

    await waitFor(() => expect(path.value).toBe("/repos/billing-web"))
    expect(name.value).toBe("my-own-name")
  })
})

describe("AddReferenceDirectory — Browse", () => {
  it("calls onBrowse and fills path + name from the result", async () => {
    const props = baseProps()
    const onBrowse = vi.fn<() => Promise<ReferenceDirectoryInspection | null>>(async () => ({
      path: "/picked/billing-web",
      suggestedName: "billing-web",
      isGit: false,
    }))
    render(<AddReferenceDirectory {...props} onBrowse={onBrowse} />)

    fireEvent.click(screen.getByTestId("reference-dir-browse"))

    await waitFor(() => expect(onBrowse).toHaveBeenCalled())
    const { path, name } = fields()
    await waitFor(() => expect(path.value).toBe("/picked/billing-web"))
    expect(name.value).toBe("billing-web")
  })

  it("is absent when no onBrowse prop is passed", () => {
    render(<AddReferenceDirectory {...baseProps()} />)
    expect(screen.queryByTestId("reference-dir-browse")).not.toBeInTheDocument()
  })
})

describe("AddReferenceDirectory — not-a-git-repo notice", () => {
  it("is absent before any inspection, absent when isGit is true, and shown when isGit is false", async () => {
    const props = baseProps()
    render(<AddReferenceDirectory {...props} />)
    const { path } = fields()

    expect(screen.queryByTestId("reference-dir-not-git")).not.toBeInTheDocument()

    props.onInspect.mockResolvedValueOnce({
      path: "/repos/billing-web",
      suggestedName: "billing-web",
      isGit: true,
    })
    fireEvent.change(path, { target: { value: "/repos/billing-web" } })
    fireEvent.blur(path)
    await waitFor(() => expect(path.value).toBe("/repos/billing-web"))
    expect(screen.queryByTestId("reference-dir-not-git")).not.toBeInTheDocument()

    props.onInspect.mockResolvedValueOnce({
      path: "/repos/plain-folder",
      suggestedName: "plain-folder",
      isGit: false,
    })
    fireEvent.change(path, { target: { value: "/repos/plain-folder" } })
    fireEvent.blur(path)
    await waitFor(() => expect(path.value).toBe("/repos/plain-folder"))
    expect(screen.getByTestId("reference-dir-not-git")).toBeInTheDocument()
  })
})

describe("AddReferenceDirectory — Add button enablement", () => {
  it("is disabled with an empty path, disabled with an empty name, and enabled once both are filled", () => {
    render(<AddReferenceDirectory {...baseProps()} />)
    const { path, name, add } = fields()

    expect(add).toBeDisabled()

    fireEvent.change(path, { target: { value: "/repos/billing-web" } })
    expect(add).toBeDisabled()

    fireEvent.change(name, { target: { value: "billing-web" } })
    expect(add).not.toBeDisabled()
  })
})

describe("AddReferenceDirectory — submit", () => {
  it("calls onAdd with {name, path} and no description key when the description is blank", async () => {
    const props = baseProps()
    render(<AddReferenceDirectory {...props} />)
    const { path, name, add } = fields()

    fireEvent.change(path, { target: { value: "/repos/billing-web" } })
    fireEvent.change(name, { target: { value: "billing-web" } })
    fireEvent.click(add)

    await waitFor(() =>
      expect(props.onAdd).toHaveBeenCalledWith({
        name: "billing-web",
        path: "/repos/billing-web",
      }),
    )
  })

  it("calls onAdd with description when it is filled", async () => {
    const props = baseProps()
    render(<AddReferenceDirectory {...props} />)
    const { path, name, description, add } = fields()

    fireEvent.change(path, { target: { value: "/repos/billing-web" } })
    fireEvent.change(name, { target: { value: "billing-web" } })
    fireEvent.change(description, { target: { value: "Production billing UI" } })
    fireEvent.click(add)

    await waitFor(() =>
      expect(props.onAdd).toHaveBeenCalledWith({
        name: "billing-web",
        path: "/repos/billing-web",
        description: "Production billing UI",
      }),
    )
  })

  it("trims path, name and description before passing them to onAdd", async () => {
    const props = baseProps()
    render(<AddReferenceDirectory {...props} />)
    const { path, name, description, add } = fields()

    fireEvent.change(path, { target: { value: "  /repos/billing-web  " } })
    fireEvent.change(name, { target: { value: "  billing-web  " } })
    fireEvent.change(description, { target: { value: "  Production billing UI  " } })
    fireEvent.click(add)

    await waitFor(() =>
      expect(props.onAdd).toHaveBeenCalledWith({
        name: "billing-web",
        path: "/repos/billing-web",
        description: "Production billing UI",
      }),
    )
  })

  it("clears all three fields once onAdd resolves truthy", async () => {
    const props = baseProps()
    render(<AddReferenceDirectory {...props} />)
    const { path, name, description, add } = fields()

    fireEvent.change(path, { target: { value: "/repos/billing-web" } })
    fireEvent.change(name, { target: { value: "billing-web" } })
    fireEvent.change(description, { target: { value: "Production billing UI" } })
    fireEvent.click(add)

    await waitFor(() => expect(props.onAdd).toHaveBeenCalled())
    await waitFor(() => expect(path.value).toBe(""))
    expect(name.value).toBe("")
    expect(description.value).toBe("")
  })

  it("does not clear the fields when onAdd resolves falsy, so the user does not lose their input", async () => {
    const props = baseProps()
    props.onAdd.mockResolvedValue(false)
    render(<AddReferenceDirectory {...props} />)
    const { path, name, description, add } = fields()

    fireEvent.change(path, { target: { value: "/repos/billing-web" } })
    fireEvent.change(name, { target: { value: "billing-web" } })
    fireEvent.change(description, { target: { value: "Production billing UI" } })
    fireEvent.click(add)

    await waitFor(() => expect(props.onAdd).toHaveBeenCalled())
    expect(path.value).toBe("/repos/billing-web")
    expect(name.value).toBe("billing-web")
    expect(description.value).toBe("Production billing UI")
  })
})

describe("AddReferenceDirectory — name validation", () => {
  it("shows an error and keeps Add disabled when the name is already taken", () => {
    render(<AddReferenceDirectory {...baseProps()} takenNames={["billing-web"]} />)
    const { path, name, add } = fields()

    fireEvent.change(path, { target: { value: "/repos/billing-web" } })
    fireEvent.change(name, { target: { value: "billing-web" } })

    expect(
      screen.getByText("That name is already used by another reference directory."),
    ).toBeInTheDocument()
    expect(add).toBeDisabled()
  })

  it("shows an error and keeps Add disabled for a malformed name (uppercase, leading digit)", () => {
    render(<AddReferenceDirectory {...baseProps()} />)
    const { path, name, add } = fields()

    fireEvent.change(path, { target: { value: "/repos/billing-web" } })
    fireEvent.change(name, { target: { value: "Billing-Web" } })
    expect(
      screen.getByText("Use lowercase letters, numbers and hyphens, starting with a letter."),
    ).toBeInTheDocument()
    expect(add).toBeDisabled()

    fireEvent.change(name, { target: { value: "1billing" } })
    expect(
      screen.getByText("Use lowercase letters, numbers and hyphens, starting with a letter."),
    ).toBeInTheDocument()
    expect(add).toBeDisabled()
  })
})

import { afterEach, describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import { toast } from "sonner"
import { BannerToasts } from "./banner-toasts"
import type { useEditorEditing } from "@/hooks/useEditorEditing"

// Status notices are bottom-right toasts, not header banners.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

type EditingApi = ReturnType<typeof useEditorEditing>

afterEach(() => {
  vi.clearAllMocks()
})

function makeEditing(overrides: Partial<EditingApi> = {}): EditingApi {
  return {
    componentEditState: null,
    handleExitComponentEdit: vi.fn(),
    saveStatus: null,
    saveStatusSeq: 0,
    saving: false,
    ...overrides,
  } as unknown as EditingApi
}

describe("BannerToasts", () => {
  it("toasts the component-edit notice when editing a subcomponent", () => {
    render(
      <BannerToasts
        editing={makeEditing({
          componentEditState: {
            componentName: "MyButton",
          } as unknown as EditingApi["componentEditState"],
        })}
      />,
    )
    expect(toast.info).toHaveBeenCalledWith(
      expect.stringContaining("MyButton"),
      expect.objectContaining({ duration: Infinity }),
    )
  })

  it("toasts the transient save status", () => {
    render(<BannerToasts editing={makeEditing({ saveStatus: "Patched 2 files" })} />)
    expect(toast).toHaveBeenCalledWith(
      "Patched 2 files",
      expect.objectContaining({ id: "editor-status" }),
    )
  })

  it("toasts the SAME sentence again when it is written again", () => {
    // The notice that names what a page change discarded is prose in a string,
    // and it repeats word for word: two page changes with a draft held each
    // time produce the identical line. Keyed on the text alone this effect
    // never ran for the second one, so the designer was told once that their
    // work was gone and never again. `saveStatusSeq` moves on every write,
    // which is how "written again" reaches here as its own event.
    const DISCARDED = "The page connection was reset; 1 pending edit was discarded."
    const { rerender } = render(
      <BannerToasts editing={makeEditing({ saveStatus: DISCARDED, saveStatusSeq: 1 })} />,
    )
    expect(toast).toHaveBeenCalledTimes(1)
    rerender(
      <BannerToasts editing={makeEditing({ saveStatus: DISCARDED, saveStatusSeq: 2 })} />,
    )
    expect(toast).toHaveBeenCalledTimes(2)
    expect(toast).toHaveBeenLastCalledWith(
      DISCARDED,
      expect.objectContaining({ id: "editor-status" }),
    )
  })

  it("does not re-toast on a render that wrote nothing (control)", () => {
    // The other half of the pair. A re-render with the same text AND the same
    // sequence is not a new notice, and must not toast again, or every
    // unrelated render would re-announce the last line.
    const editing = makeEditing({ saveStatus: "Patched 2 files", saveStatusSeq: 1 })
    const { rerender } = render(<BannerToasts editing={editing} />)
    expect(toast).toHaveBeenCalledTimes(1)
    rerender(
      <BannerToasts
        editing={makeEditing({ saveStatus: "Patched 2 files", saveStatusSeq: 1 })}
      />,
    )
    expect(toast).toHaveBeenCalledTimes(1)
  })
})

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
})

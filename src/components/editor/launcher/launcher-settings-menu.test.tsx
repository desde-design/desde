import type { ReactNode } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Faithful inline DropdownMenu (root content always rendered) instead of the
 * real Radix component. Radix's portal-based menu does not open reliably
 * under jsdom's `fireEvent` (it wants real pointer-capture semantics), and
 * this repo has no `@testing-library/user-event` installed. Same stand-in as
 * `chat-session-menu.test.tsx` and `model-picker-chip.test.tsx`. The item
 * under test here is ours, not Radix's.
 */
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    ...rest
  }: {
    children: ReactNode
    disabled?: boolean
    onSelect?: () => void
    [key: string]: unknown
  }) => (
    <div
      role="menuitem"
      aria-disabled={disabled ? "true" : undefined}
      onClick={() => {
        if (!disabled) onSelect?.()
      }}
      {...rest}
    >
      {children}
    </div>
  ),
}))

import { LauncherSettingsMenu } from "./launcher-settings-menu"

/** A configured Anthropic key, so the first-run credential prompt stays shut. */
const CREDENTIAL_STATUS = {
  providers: {
    anthropic: {
      id: "anthropic",
      label: "Anthropic",
      source: "stored",
      hasStoredKey: true,
      maskedHint: "sk-ant-…4f2a",
      storedHint: "sk-ant-…4f2a",
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      consoleUrl: "https://console.anthropic.com/settings/keys",
      maskPrefix: "sk-ant-",
      hasSubscriptionRuntime: true,
    },
  },
  devMode: false,
  promptDismissed: false,
}

function viewerAuthStatus(defaultOrigin: string | null) {
  return {
    configured: false,
    baseUrl: null,
    projectId: null,
    hasToken: false,
    source: null,
    defaultOrigin,
    link: { status: "no-viewer" },
  }
}

/**
 * `LauncherSettingsMenu` fetches both the LLM credential status
 * (`useLlmCredentials`) and the viewer-auth status (`useViewerAuthStatus`) on
 * mount. One global fetch stub answers both, branching on the request path.
 */
function stubFetch({ defaultOrigin = null }: { defaultOrigin?: string | null } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/api/editor/llm-credentials")) {
        return new Response(JSON.stringify(CREDENTIAL_STATUS), { status: 200 })
      }
      if (url.includes("/api/editor/viewer-auth")) {
        return new Response(JSON.stringify(viewerAuthStatus(defaultOrigin)), { status: 200 })
      }
      return new Response("{}", { status: 404 })
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("LauncherSettingsMenu — Viewer link", () => {
  it("offers the machine-level viewer setting", async () => {
    stubFetch({ defaultOrigin: "https://viewer.test" })
    render(<LauncherSettingsMenu updates={undefined} />)
    expect(await screen.findByTestId("launcher-settings-your-viewer")).toBeInTheDocument()
  })

  it("marks it unset when no viewer has been chosen", async () => {
    stubFetch({ defaultOrigin: null })
    render(<LauncherSettingsMenu updates={undefined} />)
    await waitFor(() =>
      expect(screen.getByTestId("launcher-settings-your-viewer")).toHaveTextContent("Not set"),
    )
  })
})

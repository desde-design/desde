import { createRoot } from "react-dom/client"

import "./self-host.css"
import EditorPage from "@/editor-ui/editor-page"
import { setActiveCliUser, cliBootstrapUserToAuthor } from "@/lib/cli-user-identity"
import { useEditorStore } from "@/stores/editor-only"
import { GalleryOverlay } from "@/components/editor/gallery/gallery-overlay"
import { parseGalleryParams } from "@/components/editor/gallery/gallery-url"
import { installMockBackend } from "./mock-backend"
import { MOCK_SELECTION, MOCK_MANIFEST } from "./mock-selection"
import { MOCK_LAYERS } from "./mock-layers"

/**
 * Self-host harness entry — a MOCK BOOT of the real Editor UI.
 *
 * This mirrors `editor-cli/ui-src/src/main.tsx` (which boots the real
 * `EditorPage` for the live CLI) but swaps the live CLI backend for a
 * stubbed `window.__DESDE_CLI__` + a `fetch` interceptor
 * (`./mock-backend.ts`). The result: the FULL real Editor chrome
 * (top bar, layers, right rail with chat/activity/comments tabs,
 * commit-push controls, inspector, dialogs) renders with mock data and
 * no live backend — so it can be supervised + edited by Editor, with
 * edits landing in the real `src/components/editor/*` source.
 *
 * The inner prototype iframe points at `prototype.html` (no live
 * prototype to drive), so the editing surface shows its "connecting to
 * bridge" affordance — expected; we're polishing chrome, not editing a
 * live target.
 */

// The CLI bootstrap (`window.__DESDE_CLI__`) is installed by an
// inline <script> in index.html, BEFORE this module's imports evaluate —
// fields like `framework`/`stylingSystem` are read off it at module-eval
// time by `src/lib/editor-feature-flags.ts` (imported transitively via
// `EditorPage`), and ES imports are hoisted, so setting it here would
// be too late. We only read it here for the runtime wiring below.
const origin = window.location.origin

// Gallery mode (`?gallery=<state-id>`) mounts the surface picker on top of
// the real chrome. Absent the param this is entirely inert — every existing
// self-host behaviour below is unchanged.
const gallery = parseGalleryParams(window.location.search)
const galleryMode = gallery.stateId !== null

installMockBackend()

const cli = window.__DESDE_CLI__
if (cli?.user) {
  setActiveCliUser(
    cliBootstrapUserToAuthor({
      username: cli.user.username,
      hostname: cli.user.hostname,
    }),
  )
}

// EditorPage reads `?url=` to enter the live editing surface (vs. the
// dev component picker). Seed it with the sample prototype (a root-level
// `prototype.html`). Under CLI supervision the bridge-plugin injects the
// bridge into that page, so the inner EditorSurface CONNECTS and the
// layers tree + inspector populate from its DOM. Run standalone (no CLI)
// and there's no bridge to inject → the inner surface stays "Connecting…".
const params = new URLSearchParams(window.location.search)
if (!params.get("url")) {
  params.set("url", `${origin}/prototype.html`)
  window.history.replaceState({}, "", `${window.location.pathname}?${params.toString()}`)
}

declare global {
  interface Window {
    __DESDE_CLI__?: {
      token: string
      shellOrigin: string
      viteUrl: string
      framework?: "vue3" | "react"
      stylingSystem?: "tailwind" | "css-modules" | "inline"
      sessionId?: string | null
      worktreePath?: string | null
      user?: { username?: string; hostname?: string }
    }
    /** Self-host harness Layers-panel seed — see ./mock-layers.ts. */
    __DESDE_SELF_HOST_LAYERS__?: import("@/types/bridge").OutlineNode[]
  }
}

// Seed the Layers tree BEFORE the first render: useEditorEditing reads
// this global in its `layersRoots` useState initializer (see the hook).
// Set after mount it would be too late — the initializer has already run.
// A live bridge (CLI supervision) overwrites this with the real
// prototype.html tree on connect; standalone (`vite`) keeps the seed.
window.__DESDE_SELF_HOST_LAYERS__ = MOCK_LAYERS

const root = document.getElementById("root")
if (!root) throw new Error("[self-host] #root not found in served HTML")
createRoot(root).render(
  <>
    <EditorPage />
    {galleryMode && (
      <GalleryOverlay initialStateId={gallery.stateId} initialTheme={gallery.theme} />
    )}
  </>,
)

// Seed a mock selection + manifest so the inspector ("Edit" tab) renders
// its fully-populated state (prop inputs, dropdowns, toggles, class
// editor) without a live bridge — see ./mock-selection.ts. Done after the
// first paint so useEditorEditing's mount effect has run; its store
// cleanup only fires on unmount, and the (never-connecting) bridge won't
// overwrite the seed.
const seedSelection = () => {
  const store = useEditorStore.getState()
  store.setEditorManifest(MOCK_MANIFEST)
  store.setEditorSelection(MOCK_SELECTION)
}

// The inspector only renders in Select mode (iframeMode === "select"),
// which is internal EditorSurface state with no prop/persistence hook.
// Flip it by clicking the real toggle so the populated inspector shows
// immediately. This runs in the harness's OWN document, so it targets the
// inner editor's toggle only. Poll until the top bar has mounted.
let tries = 0
const enterSelectMode = () => {
  seedSelection()
  const group = document.querySelector(
    '[role="radiogroup"][aria-label="Iframe mode"]',
  )
  const btn = group
    ? (Array.from(group.querySelectorAll('button[role="radio"]')).find((b) =>
        /select/i.test(b.textContent ?? ""),
      ) as HTMLButtonElement | undefined)
    : undefined
  if (btn && btn.getAttribute("aria-checked") !== "true") {
    btn.click()
    seedSelection() // re-assert after the mode switch
    return
  }
  if (++tries < 25) setTimeout(enterSelectMode, 150)
}
requestAnimationFrame(enterSelectMode)

// Auto-fire one chat turn so the Chat tab shows the agent "still
// thinking" (a reasoning/thinking disclosure + a Grep tool container,
// frozen mid-think) without the user typing anything. The chat tab is
// force-mounted (hidden when inactive), so we can drive its input even
// while the Edit tab is showing — the thinking state is already there
// when the user clicks over to Chat. The mock backend answers the submit
// with a held-open SSE stream (see ./mock-chat.ts).
//
// Two stages, because submitting into the "new chat" slot triggers a
// session re-key mid-stream that drops the running state. Instead we
// first SELECT an existing session tab (so the turn lands in an existing
// bucket and the mock echoes that same sessionId — no re-key), let its
// transcript hydrate, THEN type + send.
const SEED_CHAT_SESSION = "sess-aaaa1111"
let chatTries = 0
let chatStage: "select" | "send" = "select"
const seedThinkingChat = () => {
  if (chatStage === "select") {
    const tab = document.querySelector<HTMLButtonElement>(
      `[data-testid="chat-session-tab-${SEED_CHAT_SESSION}"]`,
    )
    if (tab) {
      tab.click()
      chatStage = "send"
      setTimeout(seedThinkingChat, 500) // let the transcript hydrate
      return
    }
    if (++chatTries < 40) setTimeout(seedThinkingChat, 150)
    return
  }

  // Stage "send". assistant-ui's Editor is a controlled <textarea>;
  // React only sees a value change via a native input event, so set the
  // value through the prototype setter and dispatch one before Send.
  const input = document.querySelector<HTMLTextAreaElement>(
    '[data-testid="editor-chat-input"]',
  )
  const send = document.querySelector<HTMLButtonElement>(
    '[data-testid="editor-chat-submit"]',
  )
  if (input && send) {
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set
    setValue?.call(input, "Make the Save button use our brand color")
    input.dispatchEvent(new Event("input", { bubbles: true }))
    // Let React flush the controlled value (which also enables Send)
    // before clicking.
    setTimeout(() => send.click(), 60)
    return
  }
  if (++chatTries < 40) setTimeout(seedThinkingChat, 150)
}
// Skip in gallery mode: the mock backend answers this submit with a
// held-open SSE stream, which leaves the chat pane animating and makes
// screenshots nondeterministic. The Edit-tab seeding above is kept — it
// settles, and a populated right rail is a more honest backdrop.
if (!galleryMode) requestAnimationFrame(seedThinkingChat)

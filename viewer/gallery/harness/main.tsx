import { createRoot } from "react-dom/client"

import "./gallery.css"
import { parseGalleryParams } from "@/components/gallery/gallery-url"
import { GalleryShell } from "./gallery-shell"
import { installFakeEventSource } from "./fake-event-source"
import { installMockBackend } from "./mock-backend"
import { SURFACE_REGISTRY } from "../registry"

/**
 * Viewer surface gallery — entry point.
 *
 * Unlike the Editor's harness, gallery mode is not a mode here. The Editor
 * overlays its catalog on a live `EditorPage`, so it needs `?gallery` to stay
 * inert on a normal boot. This app has no other job: the catalog IS the page.
 * `?gallery=<state-id>` therefore only chooses which surface is open, and its
 * absence means "nothing selected yet".
 *
 * Two globals are replaced before React renders, and the order matters. The
 * mock backend must own `window.fetch` first, because the shared fixture
 * router (`@/components/gallery/fetch-override`) chains onto whatever `fetch`
 * is current when a fixture first registers — install it after, and every
 * unstubbed endpoint would fall through to a dev server that has no `/api`.
 */
installMockBackend()
installFakeEventSource()

const params = parseGalleryParams(window.location.search)

const root = document.getElementById("root")
if (!root) throw new Error("[viewer-gallery] #root not found in served HTML")

createRoot(root).render(
  <GalleryShell
    registry={SURFACE_REGISTRY}
    initialStateId={params.stateId ?? ""}
    initialTheme={params.theme}
  />,
)

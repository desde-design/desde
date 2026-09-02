import { useEffect } from "react"
import { Overview } from "./pages/overview"
import { Workspaces } from "./pages/workspaces"
import { Settings } from "./pages/settings"
import { href, useRoute, type Route } from "./router"

/**
 * The demo prototype that ships with the viewer.
 *
 * Its job is to give a first-time user something worth commenting ON within
 * seconds of starting the process. So it is deliberately opinionated in ways
 * a review tool exercises: several distinct regions, a couple of numbers a
 * reviewer would question, a form with a control someone would argue about,
 * and one visibly unfinished row.
 *
 * THREE PAGES since 2026-09-02 (Mo: "you can't really navigate"). It was one
 * page whose nav items were `#overview` / `#workspaces` / `#settings`
 * anchors, and that was worse than merely thin. A comment's page key is
 * `pathname + hash` (`src/bridge/anchor-pins.ts`) and the pin layer filters on
 * it, so clicking a nav anchor moved the key from `/p/demo/` to
 * `/p/demo/#workspaces` and every pin the reviewer had just placed vanished.
 * Nothing was lost; it looked exactly like loss.
 *
 * Self-contained by necessity. The viewer sends a Content-Security-Policy on
 * every prototype response, so no web fonts, no CDN scripts, and no network
 * calls of any kind.
 */

const NAV: { route: Route; label: string }[] = [
  { route: "", label: "Overview" },
  { route: "workspaces", label: "Workspaces" },
  { route: "settings", label: "Settings" },
]

/**
 * Which source file painted each route.
 *
 * This is not decoration. The bridge gates its FIRST `ROUTE_CHANGED` on
 * `data-page-source` being present on `<html>`
 * (`src/bridge/comment-bridge.ts`), and the viewer's rail prints
 * `page.sourceFile`, falling back to the URL and then to an em dash. Before
 * this stamp existed the viewer's own demo was the one prototype that could
 * not demonstrate the viewer's page tracking: the rail showed a dash.
 *
 * On a prototype connected to a repo the rail turns this into a GitHub link,
 * so the paths have to be real repo-relative paths, not labels.
 */
const PAGE_SOURCE: Record<Route, string> = {
  "": "src/pages/overview.tsx",
  workspaces: "src/pages/workspaces.tsx",
  settings: "src/pages/settings.tsx",
}

export function App() {
  const [route, navigate] = useRoute()

  useEffect(() => {
    // Set AFTER render, which is the order the bridge's mutation observer
    // expects: it watches for the attribute to change and then reports the
    // route, so stamping before the new page has painted would name the page
    // the reviewer is leaving.
    document.documentElement.setAttribute("data-page-source", PAGE_SOURCE[route])
  }, [route])

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Northwind Analytics
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <a
              key={item.label}
              className={item.route === route ? "nav-item nav-item--active" : "nav-item"}
              href={href(item.route)}
              aria-current={item.route === route ? "page" : undefined}
              onClick={(e) => {
                // Plain left click only, so the reviewer keeps every ordinary
                // browser affordance: cmd-click, middle-click and "open in new
                // tab" all still get a real URL because `href` is a real one.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
                e.preventDefault()
                navigate(item.route)
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </header>

      <main className="main">
        {route === "" ? <Overview navigate={navigate} /> : null}
        {route === "workspaces" ? <Workspaces /> : null}
        {route === "settings" ? <Settings /> : null}
      </main>
    </div>
  )
}

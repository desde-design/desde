import { useState } from "react"
import { ROWS } from "../data"

/**
 * The card-grid page, plus the one control that makes it a page rather than a
 * screenshot: a filter that actually narrows the cards.
 *
 * `northwind-eu` is Degraded on purpose and is the card most reviewers comment
 * on first. It carries its own anchor so a seeded comment can land on it.
 */
export function Workspaces() {
  const [query, setQuery] = useState("")
  const [onlyDegraded, setOnlyDegraded] = useState(false)

  const visible = ROWS.filter((row) => {
    if (onlyDegraded && row.status === "Healthy") return false
    if (!query) return true
    return row.name.toLowerCase().includes(query.toLowerCase())
  })

  return (
    <div className="page-content">
        <section className="intro">
          <h1>Workspaces</h1>
          <p className="lede">
            Every workspace this account can reach, with the region it runs in and the
            traffic it took today.
          </p>
        </section>

        <section className="panel" data-demo-anchor="workspaces-table">
          <div className="toolbar">
            <input
              className="search"
              type="search"
              placeholder="Filter by name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter workspaces by name"
            />
            <label className="toggle" data-demo-anchor="degraded-toggle">
              <input
                type="checkbox"
                checked={onlyDegraded}
                onChange={(e) => setOnlyDegraded(e.target.checked)}
              />
              Only degraded
            </label>
          </div>

          <div className="card-grid">
            {visible.map((row) => (
              <article key={row.name} className="workspace-card" data-demo-anchor={`workspace-${row.name}`}>
                <div className="workspace-card__head">
                  <h3 className="workspace-card__name">{row.name}</h3>
                  <span className={row.status === "Healthy" ? "pill pill--ok" : "pill pill--warn"}>
                    {row.status}
                  </span>
                </div>
                <dl className="workspace-card__facts">
                  <div className="workspace-fact">
                    <dt>Region</dt>
                    <dd>{row.region}</dd>
                  </div>
                  <div className="workspace-fact">
                    <dt>Requests today</dt>
                    <dd className="numeric">{row.requests}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>

          {visible.length === 0 ? <p className="empty">No workspaces match that filter.</p> : null}
        </section>
    </div>
  )
}

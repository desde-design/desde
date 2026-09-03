import { METRICS, ROWS } from "../data"
import { Button } from "../components/Button"
import { href, type Route } from "../router"

/**
 * `data-demo-anchor` marks the elements the viewer's seeded comments anchor
 * to. They are LOAD-BEARING: `viewer/server/demo/seed-demo-project.ts` builds
 * `position.anchorSelector` from these values, so renaming one detaches a
 * seeded pin silently — the comment survives, the pin does not appear.
 *
 * A dedicated attribute rather than a class, so restyling cannot break
 * anchoring and so a reader can see at a glance which elements are spoken
 * for.
 */
export function Overview({ navigate }: { navigate: (route: Route) => void }) {
  const degraded = ROWS.filter((r) => r.status !== "Healthy")
  return (
    <>
      <section className="intro">
        <h1>Overview</h1>
        <p className="lede">
          This is a demo prototype served by your viewer. Try the comment tool in the
          toolbar, then click anything on this page to leave a note on it.
        </p>
      </section>

      <section className="metrics" data-demo-anchor="metrics">
        {METRICS.map((metric) => (
          <article className="metric" key={metric.label} data-demo-anchor={`metric-${metric.label.toLowerCase().replace(/\s+/g, "-")}`}>
            <p className="metric-label">{metric.label}</p>
            <p className="metric-value">{metric.value}</p>
            <p className={metric.positive ? "metric-delta metric-delta--up" : "metric-delta metric-delta--down"}>
              {metric.delta}
            </p>
          </article>
        ))}
      </section>

      <section className="panel" data-demo-anchor="attention">
        <h2>Needs attention</h2>
        {degraded.length === 0 ? (
          <p className="empty">Everything is healthy.</p>
        ) : (
          <ul className="attention-list">
            {degraded.map((row) => (
              <li key={row.name}>
                <span className="pill pill--warn">{row.status}</span>
                <span className="table-name">{row.name}</span>
                <span className="attention-meta">{row.region}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="actions" data-demo-anchor="view-all">
          <Button
            variant="secondary"
            href={href("workspaces")}
            onClick={(e) => {
              e.preventDefault()
              navigate("workspaces")
            }}
          >
            View all workspaces
          </Button>
        </div>
      </section>
    </>
  )
}

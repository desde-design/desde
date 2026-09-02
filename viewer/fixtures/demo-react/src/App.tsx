/**
 * The demo prototype that ships with the viewer.
 *
 * Its job is to give a first-time user something worth commenting ON within
 * seconds of starting the process. So it is deliberately opinionated in ways
 * a review tool exercises: several distinct regions, a couple of numbers a
 * reviewer would question, a form with a control someone would argue about,
 * and one visibly unfinished row.
 *
 * Self-contained by necessity. The viewer sends a Content-Security-Policy on
 * every prototype response, so no web fonts, no CDN scripts, and no network
 * calls of any kind.
 */

const METRICS = [
  { label: "Active workspaces", value: "1,284", delta: "+12.4%", positive: true },
  { label: "Requests today", value: "48,210", delta: "+3.1%", positive: true },
  { label: "Error rate", value: "0.42%", delta: "+0.18%", positive: false },
  { label: "Median latency", value: "184ms", delta: "-22ms", positive: true },
]

const ROWS = [
  { name: "acme-production", region: "us-east-1", status: "Healthy", requests: "18,402" },
  { name: "acme-staging", region: "us-east-1", status: "Healthy", requests: "4,118" },
  { name: "northwind-eu", region: "eu-west-2", status: "Degraded", requests: "9,733" },
  { name: "internal-tools", region: "us-west-2", status: "Healthy", requests: "2,004" },
]

export function App() {
  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Northwind Analytics
        </div>
        <nav className="nav">
          <a className="nav-item nav-item--active" href="#overview">Overview</a>
          <a className="nav-item" href="#workspaces">Workspaces</a>
          <a className="nav-item" href="#settings">Settings</a>
        </nav>
      </header>

      <main className="main">
        <section className="intro">
          <h1>Overview</h1>
          <p className="lede">
            This is a demo prototype served by your viewer. Try the comment tool in the
            toolbar, then click anything on this page to leave a note on it.
          </p>
        </section>

        <section className="metrics" id="overview">
          {METRICS.map((metric) => (
            <article className="metric" key={metric.label}>
              <p className="metric-label">{metric.label}</p>
              <p className="metric-value">{metric.value}</p>
              <p className={metric.positive ? "metric-delta metric-delta--up" : "metric-delta metric-delta--down"}>
                {metric.delta}
              </p>
            </article>
          ))}
        </section>

        <section className="panel" id="workspaces">
          <h2>Workspaces</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Region</th>
                <th>Status</th>
                <th className="numeric">Requests</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.name}>
                  <td className="table-name">{row.name}</td>
                  <td>{row.region}</td>
                  <td>
                    <span className={row.status === "Healthy" ? "pill pill--ok" : "pill pill--warn"}>
                      {row.status}
                    </span>
                  </td>
                  <td className="numeric">{row.requests}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="panel" id="settings">
          <h2>Alert settings</h2>
          <div className="field">
            <label htmlFor="threshold">Error rate threshold</label>
            <input id="threshold" type="text" defaultValue="0.50%" />
          </div>
          <div className="field">
            <label htmlFor="channel">Notify</label>
            <select id="channel" defaultValue="email">
              <option value="email">Email</option>
              <option value="slack">Slack</option>
              <option value="none">Nobody</option>
            </select>
          </div>
          <div className="actions">
            <button className="button button--primary" type="button">Save changes</button>
            <button className="button" type="button">Discard</button>
          </div>
        </section>
      </main>
    </div>
  )
}

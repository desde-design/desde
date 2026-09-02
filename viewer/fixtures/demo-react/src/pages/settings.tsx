/**
 * The form page.
 *
 * Two things here are deliberately arguable, because a review tool needs
 * something to argue with: the threshold defaults to 0.50% while the Overview
 * reports 0.42% (so the alert is nearly firing and nobody said so), and the
 * notify list offers `Nobody`, which no team should be able to pick by
 * accident.
 *
 * The retention row is the visibly unfinished one. It says so.
 */
export function Settings() {
  return (
    <>
      <section className="intro">
        <h1>Settings</h1>
        <p className="lede">
          Alerting and retention for this account. Changes apply to every workspace.
        </p>
      </section>

      <section className="panel" data-demo-anchor="alert-settings">
        <h2>Alerts</h2>
        <div className="field">
          <label htmlFor="threshold">Error rate threshold</label>
          <input id="threshold" type="text" defaultValue="0.50%" data-demo-anchor="threshold" />
          <p className="field-hint">Current error rate is 0.42%.</p>
        </div>
        <div className="field">
          <label htmlFor="channel">Notify</label>
          <select id="channel" defaultValue="email" data-demo-anchor="notify">
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

      <section className="panel" data-demo-anchor="retention">
        <h2>Retention</h2>
        <p className="empty">Retention controls are not built yet.</p>
      </section>
    </>
  )
}

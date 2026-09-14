/**
 * Can GitHub deliver a webhook to this deployment at all?
 *
 * MEASURED (2026-08-20, live App-manifest run): GitHub rejects the whole
 * manifest with "Hook url is not supported because it isn't reachable over the
 * public Internet (localhost)". So a viewer on a loopback address is created
 * with no webhook whatsoever, and nothing about a push can ever reach it.
 *
 * Its own leaf module, rather than a private function in `api/setup-routes.ts`
 * where it started, because the answer is needed in two places that must not
 * disagree:
 *
 *  - `setup-routes.ts` decides whether to ask GitHub for a webhook at all.
 *  - `projects-routes.ts` reports it to the dashboard, so a project's
 *    "Auto-deploy: On" row can stop promising a rebuild that cannot happen.
 *
 * The second one is the whole reason this moved. The panel read `autoDeploy`
 * out of storage and printed "On", which was true about the stored setting and
 * false about the world: on a laptop the flag is on, the webhook does not
 * exist, and a push produces nothing with no explanation anywhere. Computing
 * the answer here, from the same fact the manifest used, is what keeps the two
 * ends from drifting into that gap again.
 *
 * No Node imports, so a browser bundle could carry it if the client ever needs
 * the predicate directly. Today it does not: the server sends the answer.
 */

/**
 * `true` when `publicUrl` is an address GitHub could reach. Loopback spellings
 * are the only `false` — including `*.localhost`, which is local subdomain
 * mode's default shell address since 2026-09-13 and resolves nowhere outside
 * this machine.
 */
export function webhooksReachable(publicUrl: string): boolean {
  let hostname: string
  try {
    hostname = new URL(publicUrl).hostname.toLowerCase()
  } catch {
    // An unparseable public URL is a configuration error other code reports.
    // Answering "reachable" here keeps this function from being the thing that
    // silently disables a deployment's webhook over a typo.
    return true
  }
  return !(
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  )
}

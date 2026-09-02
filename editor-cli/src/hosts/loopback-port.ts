import { createServer } from "node:net"

/**
 * Ask the OS for a free loopback port and hand back the NUMBER.
 *
 * **Why this exists rather than passing `port: 0` through to the framework.**
 * `HostContext.internal.port` is `0` meaning "you pick"; the obvious reading is
 * to forward that literal into Vite and read the bound port back. MEASURED on
 * two React Router fixtures, that is wrong on some Vite versions and right on
 * others:
 *
 * ```
 * vite 8.2.1  chunks/node.js:26623
 *   const port = configPort === server._configServerPort
 *     ? server._currentServerPort ?? configPort : configPort
 *   →  createServer({ server: { port: 0 } })  bound 57916   (0 honoured)
 *
 * vite 8.0.8  chunks/node.js:26302
 *   const port = (!configPort || configPort === server._configServerPort
 *     ? server._currentServerPort : configPort) ?? 5173
 *   →  createServer({ server: { port: 0 } })  bound 5173    (0 is FALSY here,
 *                                                            so it reads as
 *                                                            "unset")
 * ```
 *
 * The second one is not a curiosity. A fronted host is supposed to bind a
 * loopback ephemeral port while the PROXY takes the user-facing 5173; a Vite
 * that quietly reinterprets `0` as `5173` makes the inner server grab the front
 * door's port and the proxy then fails to bind. And the version that does it is
 * the one installed in a real repo we test against — the host resolves the
 * PROTOTYPE's Vite, so which of these two behaviours applies is the customer's
 * choice, not ours.
 *
 * So: never hand a framework a literal `0`. Ask the OS ourselves, pass a
 * concrete number with `strictPort: true`, and still read the bound port back
 * from `server.address()` afterwards — the request is not the answer.
 *
 * **The race is real and deliberately accepted.** Between this probe closing
 * and the framework binding, another process can take the port. `strictPort`
 * turns that into a loud boot failure rather than a silent bind somewhere else,
 * which is the same trade `core.ts`'s `pickTwoPorts` already documents for the
 * front door.
 */
export function pickLoopbackPort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, host, () => {
      const address = probe.address()
      if (address === null || typeof address === "string") {
        probe.close(() =>
          reject(new Error(`Could not read an ephemeral port back from a probe bound to ${host}.`)),
        )
        return
      }
      const { port } = address
      probe.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

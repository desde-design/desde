import type { Plugin } from "vite"
import { allowShellFramingOnSend } from "../attach/framing-headers.js"

/**
 * Drops the prototype's framing refusal (`X-Frame-Options`, CSP
 * `frame-ancestors`) on the plain Vite host, the one host with no attach proxy
 * in front of it. The proxy does the same for every other host. The why is in
 * `../attach/framing-headers.ts`.
 *
 * MEASURED 2026-09-21: a Vite project with
 * `server.headers: { "X-Frame-Options": "SAMEORIGIN" }` showed a blank frame
 * in the Editor, with only a console line saying why.
 *
 * Hooked as a `request` listener PREPENDED to Vite's http server, not as a
 * middleware. A middleware runs in plugin order, so a user plugin's middleware
 * registered earlier could answer before it. The prepended listener runs before
 * Vite's whole middleware stack, and `allowShellFramingOnSend` rewrites at send
 * time, so who set the header and when stops mattering.
 *
 * `httpServer` is null in middleware mode. That is not this host (it binds its
 * own front door), so null means there is nothing to hook.
 */
export function allowShellFramingPlugin(): Plugin {
  return {
    name: "@desde/editor-allow-shell-framing",
    configureServer(server) {
      server.httpServer?.prependListener("request", (_req, res) => {
        allowShellFramingOnSend(res)
      })
    },
  }
}

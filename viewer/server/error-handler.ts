import type { ErrorRequestHandler, NextFunction, Request, Response } from "express"

/**
 * The last middleware on every Express app this server builds.
 *
 * Extracted from `create-app.ts` when the second app appeared: each
 * per-deployment loopback listener is its own Express app
 * (`serve/loopback-listener-app.ts`), and an app with no error handler falls
 * back to Express's default one, which in development writes the stack trace
 * into the response body. On a prototype origin that would put viewer
 * internals into a document a hostile prototype can read.
 *
 * A 5xx is a server fault: log it, and send a constant body. A 4xx is a
 * client fault (body-parser's malformed-JSON 400, its over-limit 413) — no
 * stack trace, and the parser's own message is more useful than a generic
 * one. Neither branch ever echoes anything the request supplied.
 */
export function createErrorHandler(): ErrorRequestHandler {
  return function errorHandler(
    error: Error & { statusCode?: number; status?: number },
    _req: Request,
    res: Response,
    _next: NextFunction,
  ): void {
    if (res.headersSent) return
    const statusCode = error.statusCode ?? error.status ?? 500
    if (statusCode >= 500) {
      console.error("[viewer] unhandled error:", error)
      res.status(statusCode).json({ error: "Internal server error" })
      return
    }
    res.status(statusCode).json({ error: error.message })
  }
}

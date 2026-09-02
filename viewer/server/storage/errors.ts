export class NotFoundError extends Error {
  constructor(what: string, id: string) {
    super(`${what} not found: ${id}`)
    this.name = "NotFoundError"
  }
}

export class ConflictError extends Error {
  /**
   * Read by `create-app.ts`'s terminal error middleware, which maps
   * `statusCode` onto the response and echoes `message` for anything below
   * 500. Without it, a `ConflictError` reaching a route that doesn't catch
   * it explicitly became a generic 500 "Internal server error" — which is
   * both wrong (the caller CAN act on it) and, for the audit-S18 ambiguous-
   * email refusal, indistinguishable from the viewer being broken.
   *
   * Routes that already catch `ConflictError` themselves (e.g.
   * `projects-routes.ts`'s slug conflict) are unaffected — they never reach
   * the middleware.
   */
  readonly statusCode = 409

  constructor(message: string) {
    super(message)
    this.name = "ConflictError"
  }
}

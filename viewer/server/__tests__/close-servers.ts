import { afterAll } from "vitest"
import { openServers } from "./supertest-reuse"

/**
 * Close every server `supertest-reuse` opened for this test file.
 *
 * Setup files run per test file, so this `afterAll` scopes cleanup to the file
 * that opened them — a worker running several files in sequence doesn't
 * accumulate listeners, and vitest can exit without lingering handles.
 */
afterAll(async () => {
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise<void>((resolve) => {
          openServers.delete(server)
          server.close(() => resolve())
          // Sockets kept open by a client that never read the response would
          // otherwise hold `close` forever.
          server.closeAllConnections?.()
        }),
    ),
  )
})

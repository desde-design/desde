// A stand-in for `next start`: listens on $PORT, answers HTTP, and does what
// the test's env asks: FAKE_DELAY_MS before listening, FAKE_EXIT_CODE to die
// instead of listening, FAKE_SIGTERM_DELAY_MS to hold off exiting on SIGTERM
// (widens the window a `stop`/`retire` is actually waiting in, for tests that
// need to land a concurrent call inside it), FAKE_RESPONSE_DELAY_MS to hold
// the manager's readiness probe open for that long (and log when it arrives,
// so a test can land a concurrent call while the probe is in flight instead
// of by timing luck), FAKE_FORK_WORKER to fork a worker of its own (see
// below), FAKE_EXIT_AFTER_MS to exit ON ITS OWN (not via SIGTERM or /exit)
// that many ms after it starts listening — stands in for a leader that
// crashes by itself once it is already running, rather than one the manager
// stopped — GET /exit to die while running, and GET /env to answer with the
// child's own env (so the env-allowlist test can see exactly what reached the
// process).
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { writeFileSync } from "node:fs"
const port = Number(process.env.PORT)
if (process.env.FAKE_EXIT_CODE) {
  console.error("fake server: refusing to start")
  process.exit(Number(process.env.FAKE_EXIT_CODE))
}

/**
 * A worker this server forked, which IGNORES SIGTERM and writes its pid to
 * `FAKE_WORKER_PID_FILE`.
 *
 * Stands in for what a real prototype server does: a Next server with
 * `experimental.cpus`, a Nitro worker, anything the app spawns for itself.
 * Spawned WITHOUT `detached`, so it inherits this process's group — the
 * manager spawns this server detached, which makes this server the group
 * leader and the worker a member of that group. Killing the leader alone
 * therefore leaves the worker holding whatever it holds.
 *
 * It exits on its own after five seconds whatever happens, so a test that
 * fails (or never gets as far as its assertion) cannot leave a process
 * behind.
 */
if (process.env.FAKE_FORK_WORKER) {
  const worker = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 5000)"],
    { stdio: "ignore" },
  )
  // So the worker's handle never holds this server's event loop open.
  worker.unref()
  if (process.env.FAKE_WORKER_PID_FILE) {
    writeFileSync(process.env.FAKE_WORKER_PID_FILE, String(worker.pid))
  }
}
if (process.env.FAKE_SIGTERM_DELAY_MS) {
  const delay = Number(process.env.FAKE_SIGTERM_DELAY_MS)
  process.on("SIGTERM", () => {
    setTimeout(() => process.exit(0), delay)
  })
}
console.log(`fake server: starting on ${port}`)
setTimeout(() => {
  createServer((req, res) => {
    if (req.url === "/exit") {
      res.end("bye")
      setTimeout(() => process.exit(0), 10)
      return
    }
    if (req.url === "/env") {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(process.env))
      return
    }
    res.setHeader("content-type", "text/plain")
    const probeDelay = Number(process.env.FAKE_RESPONSE_DELAY_MS ?? 0)
    if (probeDelay > 0 && req.url === "/") {
      console.log("fake server: probe received")
      setTimeout(() => res.end(`hello from ${port} ${req.url}`), probeDelay)
      return
    }
    res.end(`hello from ${port} ${req.url}`)
  }).listen(port, "127.0.0.1", () => {
    console.log("fake server: listening")
    if (process.env.FAKE_EXIT_AFTER_MS) {
      setTimeout(() => process.exit(7), Number(process.env.FAKE_EXIT_AFTER_MS))
    }
  })
}, Number(process.env.FAKE_DELAY_MS ?? 0))

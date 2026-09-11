// A stand-in for `next start`: listens on $PORT, answers HTTP, and does what
// the test's env asks: FAKE_DELAY_MS before listening, FAKE_EXIT_CODE to die
// instead of listening, FAKE_SIGTERM_DELAY_MS to hold off exiting on SIGTERM
// (widens the window a `stop`/`retire` is actually waiting in, for tests that
// need to land a concurrent call inside it), GET /exit to die while running,
// and GET /env to answer with the child's own env (so the env-allowlist test
// can see exactly what reached the process).
import { createServer } from "node:http"
const port = Number(process.env.PORT)
if (process.env.FAKE_EXIT_CODE) {
  console.error("fake server: refusing to start")
  process.exit(Number(process.env.FAKE_EXIT_CODE))
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
    res.end(`hello from ${port} ${req.url}`)
  }).listen(port, "127.0.0.1", () => console.log("fake server: listening"))
}, Number(process.env.FAKE_DELAY_MS ?? 0))

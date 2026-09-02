#!/usr/bin/env node
// A fake payload entry point for child.test.ts — small enough to spawn with
// plain Node in a fast unit test, no real 337MB payload needed. Behavior is
// controlled by FIXTURE_MODE so one script covers every case
// spawnPayloadChild needs to handle:
//
//   ready                  registers a SIGTERM handler that exits promptly
//                           (code 0), THEN prints the launcher-mode ready
//                           line — the well-behaved case. (Order matters —
//                           see the comment on the handler registration
//                           below.)
//   ready-ignore-sigterm    registers a SIGTERM handler that does nothing,
//                           THEN prints the ready line — only a SIGKILL ends
//                           this one.
//   fail                    writes to stderr and exits 1 WITHOUT ever
//                           printing the ready line.
//
// FIXTURE_ENV_DUMP_PATH (independent of FIXTURE_MODE): when set, writes
// EDITOR_CLAUDE_RUNTIME_DIR's value (or the literal string "unset") to that
// path before printing the ready line — lets child.test.ts assert on env
// propagation via a file instead of racing the stdout stream (a listener
// attached AFTER the ready-line promise resolves would miss data already
// emitted on an already-flowing stream).
const mode = process.env.FIXTURE_MODE ?? "ready"

if (mode === "fail") {
  process.stderr.write("This project declares Astro but astro is not installed.\n")
  process.exit(1)
}

if (process.env.FIXTURE_ENV_DUMP_PATH) {
  require("node:fs").writeFileSync(
    process.env.FIXTURE_ENV_DUMP_PATH,
    process.env.EDITOR_CLAUDE_RUNTIME_DIR ?? "unset",
  )
}

// Same pattern for EDITOR_CLAUDE_EXECUTABLE_PATH — lets child.test.ts prove
// spawnPayloadChild SCRUBS the inherited override (the F5 fix) rather than
// passing it down to a child whose resolver would otherwise be offered an
// arbitrary, content-unverified executable.
if (process.env.FIXTURE_ENV_DUMP_EXEC_PATH) {
  require("node:fs").writeFileSync(
    process.env.FIXTURE_ENV_DUMP_EXEC_PATH,
    process.env.EDITOR_CLAUDE_EXECUTABLE_PATH ?? "unset",
  )
}

// The SIGTERM handler is registered BEFORE the ready line is printed —
// deliberately, and load-bearing for test stability. `child.test.ts`'s
// caller sends SIGTERM the instant it sees the ready line on stdout; if the
// handler were registered AFTER that write, there is a real race between
// "parent sees the line and signals" and "child finishes registering its own
// handler". Node's default disposition for an UNHANDLED SIGTERM is immediate
// termination, so losing that race kills this process before its own
// ignore-handler (the "ready-ignore-sigterm" case below) or its own
// exit-cleanly handler (the "ready" case) ever runs — surfacing as
// `signalCode: "SIGTERM"` where a test expected `"SIGKILL"` (escalation
// path) or a clean `exitCode: 0` (plain-shutdown path). This was measured,
// not guessed: an isolated repro of this exact fixture shape, run 300 times
// per ordering, showed ~11% failures (34/300) with the handler registered
// after the ready line, and 0/300 with it registered first. Registering
// first closes the race entirely rather than narrowing it.
if (mode === "ready-ignore-sigterm") {
  process.on("SIGTERM", () => {
    // Deliberately swallow it — only SIGKILL (uncatchable) ends this process.
  })
} else {
  process.on("SIGTERM", () => process.exit(0))
}

// Both "ready" variants print the exact launcher-mode sentinel cli.ts prints
// in runLauncher — this is what proves the broadened ready-line regex (this
// same phase's fix) is what spawnPayloadChild actually depends on.
process.stdout.write("▸ Launcher ready at http://127.0.0.1:45999\n")
process.stdout.write("  Pick a project, open a local folder, or clone from GitHub.\n")

// Keep the event loop alive, like the real launcher does.
setInterval(() => {}, 1000)

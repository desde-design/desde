/**
 * The sentinel reader the launcher's spawn path waits on.
 *
 * Why this is worth a suite of its own: a miss here is SILENT and unbounded.
 * `defaultSpawnEditor` resolves on the sentinel, rejects on `error` and rejects
 * on `exit` — there is no timeout — so a sentinel that is printed but not
 * recognised produces a promise that never settles: the browser's Open request
 * hangs, and the editor child it started keeps running with nothing holding a
 * reference to it.
 */
import { describe, expect, it } from "vitest"
import { createReadyLineReader } from "../ready-line.js"

const URL_ = "http://127.0.0.1:4321"

describe("createReadyLineReader", () => {
  it("reads the url out of a whole line", () => {
    const read = createReadyLineReader()
    expect(read(`▸ Editor UI ready at ${URL_}\n`)).toBe(URL_)
  })

  it("ignores output that is not the sentinel", () => {
    const read = createReadyLineReader()
    expect(read("▸ Vite running at http://127.0.0.1:5173\n")).toBeNull()
    expect(read("▸ Bridge version 2026-08-11a\n")).toBeNull()
  })

  /**
   * The bug. `data` chunk boundaries belong to the pipe, not to the writer, so
   * the sentinel arriving in two pieces is ordinary — and a per-chunk match
   * sees neither piece.
   */
  it("reads a sentinel split across two chunks", () => {
    const read = createReadyLineReader()
    expect(read("▸ Editor UI re")).toBeNull()
    expect(read(`ady at ${URL_}\n`)).toBe(URL_)
  })

  it("reads a sentinel that arrives one byte at a time", () => {
    const read = createReadyLineReader()
    const line = `▸ Editor UI ready at ${URL_}\n`
    let found: string | null = null
    for (const ch of line) found = read(ch) ?? found
    expect(found).toBe(URL_)
  })

  it("still finds the sentinel after a chatty preamble", () => {
    const read = createReadyLineReader()
    for (let i = 0; i < 500; i++) expect(read(`noise line ${i} `.repeat(20))).toBeNull()
    expect(read(`▸ Editor UI ready at ${URL_}\n`)).toBe(URL_)
  })

  it("does not grow without bound while it waits", () => {
    const read = createReadyLineReader()
    // 5 MB of output with no sentinel: if the reader kept it all, this is
    // where a long-lived launcher would leak.
    for (let i = 0; i < 5000; i++) read("x".repeat(1000))
    expect(read(` Editor UI ready at ${URL_}\n`)).toBe(URL_)
  })

  /**
   * The launcher-mode sentinel (`runLauncher`, cli.ts) — a DIFFERENT string
   * from the editor-mode one above (`▸ Launcher ready at …` vs `▸ Editor UI
   * ready at …`). `defaultSpawnEditor` never sees this line (it only ever
   * spawns editor-mode children), but a desktop shell spawning the CLI with
   * no repo path to show the launcher/picker UI does — and before this
   * reader recognised both sentinels, that wait hung forever on a line that
   * is never printed. See the module doc comment.
   */
  describe("launcher-mode sentinel", () => {
    it("reads the url out of a whole launcher-mode line", () => {
      const read = createReadyLineReader()
      expect(read(`▸ Launcher ready at ${URL_}\n`)).toBe(URL_)
    })

    it("reads a launcher-mode sentinel split across two chunks", () => {
      const read = createReadyLineReader()
      expect(read("▸ Launcher rea")).toBeNull()
      expect(read(`dy at ${URL_}\n`)).toBe(URL_)
    })

    it("does not confuse the launcher-mode line for the editor-mode one, or vice versa", () => {
      // Same reader instance sees a run of ordinary boot noise (including the
      // OTHER mode's own preamble lines) before its actual sentinel — proves
      // the broadened regex didn't accidentally start matching everything.
      const read = createReadyLineReader()
      expect(read("▸ Vite running at http://127.0.0.1:5173\n")).toBeNull()
      expect(read("▸ Bridge version 2026-08-11a\n")).toBeNull()
      expect(read(`▸ Launcher ready at ${URL_}\n`)).toBe(URL_)
    })
  })
})

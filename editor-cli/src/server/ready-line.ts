/**
 * Watches a spawned CLI process's stdout for the line that says it is
 * serving — either boot mode.
 *
 * Extracted from `launcher-server.ts`'s `defaultSpawnEditor`, where it was an
 * inline `chunk.toString().match(...)` — a per-CHUNK match, which is a
 * different thing from a per-LINE match and quietly wrong. `data` chunk
 * boundaries are set by the pipe, not by the writer: a child that prints
 * `▸ Editor UI ready at http://127.0.0.1:4321` can deliver it as two chunks,
 * and then the regex never matches anything. Nothing detects that — the
 * promise simply never settles, so the HTTP request hangs open forever AND the
 * child keeps running with no one waiting on it. That is the orphan path.
 *
 * **Two sentinels, one reader.** `cli.ts` prints `▸ Editor UI ready at
 * <url>` when booted against a repo, and `▸ Launcher ready at <url>` when
 * booted with no repo path (`runLauncher`). `defaultSpawnEditor` only ever
 * spawns the former (a per-project editor), so matching both here is a no-op
 * for that caller — but a desktop shell spawning the CLI in LAUNCHER mode
 * (Electron main, watching the top-level process's own stdout) needs the
 * second sentinel recognised too, or its wait hangs forever on a line that is
 * never printed, the exact blank-window failure mode this reader exists to
 * avoid. One regex covers both rather than forking the reader in two, since
 * every other property (chunk-boundary safety, the bounded buffer) applies
 * identically to either sentinel.
 */
export function createReadyLineReader(): (chunk: string) => string | null {
  let buffered = ""
  return (chunk) => {
    buffered += chunk
    const match = buffered.match(/(?:Editor UI|Launcher) ready at (\S+)/)
    if (!match) {
      // Keep only what could still be the head of the sentinel. Unbounded
      // accumulation would hold every byte a chatty child ever printed.
      if (buffered.length > MAX_BUFFERED) buffered = buffered.slice(-MAX_BUFFERED)
      return null
    }
    return match[1]
  }
}

/**
 * Comfortably longer than the sentinel plus a URL, short enough that a child
 * logging megabytes cannot grow this.
 */
const MAX_BUFFERED = 4096

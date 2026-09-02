/**
 * `--flag=value` → `--flag`, `value`.
 *
 * `cli.ts`'s `parseArgs` dispatches on whole tokens (`switch (a)`), so without
 * this every `=` form lands in the "Unknown option" arm. That is not a
 * cosmetic gap: Editor's own boot-failure guidance PRINTS the `=` form —
 * "To keep the in-process path and fail loudly instead, pass
 * --host-mode=in-process" (`hosts/ladder.ts`) — so a user who did exactly
 * what the screen told them got `Unknown option: --host-mode=in-process`.
 * MEASURED 2026-08-13 against the packaged desktop app.
 *
 * Normalizing here rather than rewording the three message sites is both the
 * smaller change and the more honest one: `--flag=value` is what people type,
 * and now it works for every flag rather than for the ones someone remembered
 * to document with a space.
 *
 * Lives in its own module because `cli.ts` calls `main()` at import time, so
 * importing it from a test would boot the CLI.
 */
export function normalizeEqualsFlags(argv: string[]): string[] {
  return argv.flatMap((a) => {
    // Only long flags. A positional (a repo path) or a `-h` short flag is
    // passed through untouched — a path may legitimately contain `=`.
    if (!a.startsWith("--")) return [a]
    // FIRST `=` only: values legitimately contain more of them. The live case
    // is an `--attach` URL carrying a query string.
    const eq = a.indexOf("=")
    return eq === -1 ? [a] : [a.slice(0, eq), a.slice(eq + 1)]
  })
}

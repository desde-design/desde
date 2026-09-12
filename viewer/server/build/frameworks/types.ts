/**
 * The framework seam for server prototypes. An adapter looks at a FINISHED
 * build and says what it produced. Detection is post-build on purpose: the
 * output on disk is the truth, and parsing four flavours of framework config
 * is not. One adapter per framework; adding Remix is adding `remix.ts`.
 */
export type BuildShape =
  | { kind: "static"; outputDir: string; reason: string }
  | {
      kind: "server"
      start: string[]
      reason: string
      /**
       * The directory `start` runs in, relative to the checkout root;
       * absent means the root (codex round 39). A workspace app's launcher
       * resolves its own relative paths against the working directory, so
       * `start`'s paths are relative to this directory too.
       */
      cwd?: string
      /**
       * An optional extra build-output-to-build-output copy step, run once
       * against the checkout AFTER detection and BEFORE the checkout is kept
       * for the process manager to run `start` in.
       *
       * Exists for Next's `output: "standalone"`: the standalone server
       * needs `<distDir>/static` and `public/` copied alongside it, or it
       * starts but every asset 404s (codex round 4, Fix 3) — see
       * `frameworks/next.ts`. Never touches source, only build output
       * already inside the checkout, so it does not run afoul of "never
       * modify prototype source" (a VIEWER rule, and one this route does not
       * bind to regardless — see CLAUDE.md's Editor rules for where that
       * line actually falls).
       */
      prepare?: (checkoutRoot: string) => Promise<void>
    }
  /**
   * Codex round 15, Fix 3. The checkout IS a server build an adapter
   * recognises, but the adapter also knows recording a `server` shape here
   * would be a lie: something a `start` command needs to actually run is
   * missing (a launcher binary that a bare `npm install` does not always
   * pull in). Recording `server` anyway marks the deployment `deployed`
   * and spends the restart budget on a cold start that ENOENTs every
   * single time. `inspectBuild` (`frameworks/index.ts`) returns this
   * straight through — an adapter that reaches it is DONE, not merely
   * uninterested, so this must never fall through to the next adapter or
   * to the generic static default the way `null` does. The build runner
   * (`in-process-build-runner.ts`) turns it into an ordinary build failure.
   */
  | { kind: "unsupported"; reason: string }

/**
 * Where the prototype's configured output dir points (codex round 34).
 * `within` is the package directory that owns it, relative to the checkout
 * root, or `null` when the root's own package does. A workspace build can
 * write outputs for several apps, and each adapter used to take the first
 * one its scan met, so a prototype configured to publish `apps/web` could
 * start the root app or a sibling instead. Adapters look inside `within`
 * and nowhere else: a sibling package's output is another app, whatever
 * framework it was built with (codex round 36).
 */
export interface BuildTarget {
  within: string | null
}

export interface FrameworkAdapter {
  readonly id: string
  /** `null` when this adapter does not recognise the checkout. */
  inspectBuild(checkoutRoot: string, target?: BuildTarget): Promise<BuildShape | null>
}

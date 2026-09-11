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

export interface FrameworkAdapter {
  readonly id: string
  /** `null` when this adapter does not recognise the checkout. */
  inspectBuild(checkoutRoot: string): Promise<BuildShape | null>
}

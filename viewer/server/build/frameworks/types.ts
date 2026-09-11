/**
 * The framework seam for server prototypes. An adapter looks at a FINISHED
 * build and says what it produced. Detection is post-build on purpose: the
 * output on disk is the truth, and parsing four flavours of framework config
 * is not. One adapter per framework; adding Remix is adding `remix.ts`.
 */
export type BuildShape =
  | { kind: "static"; outputDir: string; reason: string }
  | { kind: "server"; start: string[]; reason: string }

export interface FrameworkAdapter {
  readonly id: string
  /** `null` when this adapter does not recognise the checkout. */
  inspectBuild(checkoutRoot: string): Promise<BuildShape | null>
}

/**
 * LIVE proof that the llm-patch lane patches React source end to end: real
 * applicator loaders, real prompt, real model, real write. Skipped unless
 * `RUN_LIVE_LLM_TESTS=1` — same gate as `apply-llm-patch.test.ts`'s live case.
 *
 * Credentials: an `ANTHROPIC_API_KEY`, or the Claude-subscription runtime via
 * `EDITOR_USE_CLAUDE_SUBSCRIPTION=1` with a signed-in `claude` binary. The
 * subscription path is self-use only (see the root CLAUDE.md on the Agent SDK
 * terms), which is exactly what a local verification run is.
 *
 * Run it:
 *   cd editor-cli && RUN_LIVE_LLM_TESTS=1 EDITOR_USE_CLAUDE_SUBSCRIPTION=1 \
 *     npx vitest run src/server/__tests__/edit-handler.jsx-llm-lane.live.test.ts
 *
 * The fixture is the shape from the 2026-09-17 report: a brand button holding
 * an icon `<span>` and the label text as siblings. The deterministic JSX
 * applicator refuses that (mixed children) by design, so reaching a correct
 * write here means the LLM lane carried it.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parse as parseBabel } from "@babel/parser"
import {
  applyEdit,
  defaultApplicatorLoaders,
  type EditRequestBody,
} from "../edit-handler.js"

const LIVE = process.env.RUN_LIVE_LLM_TESTS === "1"

const APP_HEADER_TSX = `import type { ReactNode } from "react";

/** Shared top bar. \`children\` renders on the right. */
export function AppHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
      <button
        type="button"
        className="flex items-center gap-2 text-sm font-medium tracking-tight"
      >
        <span className="inline-block size-2 rounded-full bg-foreground" aria-hidden />
        Sooth
      </button>
      <div className="flex items-center gap-2">{children}</div>
    </header>
  );
}
`
// <button> opening tag: line 7, indented 6 → column 6.

describe.skipIf(!LIVE)("llm-patch LLM lane — React, live model", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-jsx-live-"))
    mkdirSync(join(dir, "src", "components"), { recursive: true })
    writeFileSync(join(dir, "src", "components", "AppHeader.tsx"), APP_HEADER_TSX)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it(
    "renames the brand label in a mixed-children button",
    async () => {
      const body: EditRequestBody = {
        edit: {
          kind: "llm-patch",
          mutations: [
            {
              id: "dom-mut-1",
              kind: "text",
              sourceLoc: "src/components/AppHeader.tsx:7:6",
              resolutionKind: "direct",
              scope: "definition",
              callsiteLoc: null,
              instancePath: "[0]",
              selector: "header > button",
              before: "Sooth",
              after: "Sayer",
            },
          ],
        },
      }

      const result = await applyEdit(body, dir, defaultApplicatorLoaders)
      if (!result.ok) throw new Error(`edit refused: ${result.reason}`)

      const written = readFileSync(join(dir, "src", "components", "AppHeader.tsx"), "utf8")
      expect(written).toContain("Sayer")
      expect(written).not.toContain("Sooth")
      // The sibling icon and the import survive — the model was told to touch
      // only the bytes the mutation names.
      expect(written).toContain('aria-hidden')
      expect(written).toContain('import type { ReactNode } from "react";')
      // And the result is real JSX, not prose or a fenced block.
      expect(() =>
        parseBabel(written, { sourceType: "module", plugins: ["jsx", "typescript"] }),
      ).not.toThrow()
    },
    180_000,
  )
})

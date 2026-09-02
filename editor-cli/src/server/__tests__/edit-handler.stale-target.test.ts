/**
 * WS1 stale-target guard tests (tasks/edit-pipeline-rearchitecture.md).
 *
 * `prop` / `move` edits and `llm-patch` mutations may carry the
 * per-file `data-desde-v` source-version hash captured together with their
 * `data-desde-src` coordinates. The handler compares it (SHA-256 prefix match)
 * against the on-disk file before dispatching; a mismatch refuses 409
 * instead of splicing at coordinates that predate the current bytes.
 *
 * The prop cases run the REAL applicator on purpose — the last test is the
 * regression repro from the 2026-07-24 audit: two sibling KButtons swap
 * places, a stale prop edit replays, and WITHOUT the guard the wrong button
 * silently receives the edit with ok:true. WITH the guard it refuses 409.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"
import type { DormantLaneId } from "../enabled-lanes.js"

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

/** What the source-tag plugin stamps into data-desde-v: a 12-char prefix. */
function stampOf(s: string): string {
  return sha256Hex(s).slice(0, 12)
}

// Real Vue applicators — the guard sits in front of them, and the
// wrong-button repro needs the genuine splice behavior.
const REAL_LOADERS: ApplicatorLoaders = {
  loadApplyPropEdit: async () =>
    import("../../../../src/editor/edit-service/apply-prop-edit"),
  loadApplyMoveEdit: async () =>
    import("../../../../src/editor/edit-service/apply-move-edit"),
  loadApplyDetachEdit: async () =>
    import("../../../../src/editor/edit-service/apply-detach-edit"),
  // Enables the llm-patch deterministic fast-path for the success-case test.
  loadApplySlotTextEdit: async () =>
    import("../../../../src/editor/edit-service/apply-slot-text-edit"),
  // handleLLMPatch refuses 503 without this loader configured. The stale
  // guard fires before the LLM lane and the success case applies via the
  // deterministic fast-path, so the stub is never actually invoked — it
  // exists to get past the configuration preflight (same approach as
  // edit-handler.hash-guard.test.ts).
  loadApplyLLMPatch: async () =>
    ({
      applyLLMPatch: (async () => {
        throw new Error("LLM lane must not be reached in these tests")
      }) as unknown as typeof import("../../../../src/editor/edit-service/apply-llm-patch").applyLLMPatch,
      parseSourceLocFile: () => null,
      isCrossFileInstanceEdit: () => false,
      patchFileFor: () => ({ ok: false, reason: "stub" }),
    }) as unknown as typeof import("../../../../src/editor/edit-service/apply-llm-patch"),
  loadStyleGrounding: async () => ({
    loadStyleGrounding: () => ({
      tokens: [],
      classTaxonomy: [],
      preprocessor: "css" as const,
    }),
  }),
}

describe("CLI handler stale-target guard (WS1)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-stale-target-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const ORIGINAL = [
    "<template>",
    '  <KButton variant="primary">Save</KButton>',
    '  <KButton variant="secondary">Cancel</KButton>',
    "</template>",
    "",
  ].join("\n")

  // The same two buttons with their order swapped — e.g. by an earlier
  // edit or an engineer's IDE save between capture and dispatch. The
  // ORIGINAL's (line 2, col 3) coordinates now point at the Cancel button.
  const SWAPPED = [
    "<template>",
    '  <KButton variant="secondary">Cancel</KButton>',
    '  <KButton variant="primary">Save</KButton>',
    "</template>",
    "",
  ].join("\n")

  function propBody(baseHash?: string): EditRequestBody {
    return {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "variant",
        value: "danger",
        ...(baseHash ? { baseHash } : {}),
      },
    } as EditRequestBody
  }

  it("applies a prop edit when the baseHash matches the on-disk file", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL)
    const result = await applyEdit(propBody(stampOf(ORIGINAL)), dir, REAL_LOADERS)
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toContain(
      '<KButton variant="danger">Save</KButton>',
    )
  })

  it("refuses 409 when the file changed since capture (wrong-button regression)", async () => {
    // Captured against ORIGINAL (targeting the Save button), but the file
    // on disk is now SWAPPED — line 2 col 3 is the Cancel button.
    writeFileSync(join(dir, "App.vue"), SWAPPED)
    const result = await applyEdit(propBody(stampOf(ORIGINAL)), dir, REAL_LOADERS)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.reason).toMatch(/stale target/i)
    }
    // The load-bearing assertion: NEITHER button was edited. Without the
    // guard this exact request returned ok:true and gave Cancel
    // variant="danger" (reproduced 2026-07-24).
    const after = readFileSync(join(dir, "App.vue"), "utf8")
    expect(after).toBe(SWAPPED)
    expect(after).not.toContain("danger")
  })

  it("proceeds without a hash (opt-in guard — unstamped substrates unchanged)", async () => {
    // No baseHash → legacy behavior: the coordinates are trusted. This is
    // the graceful path for prototypes whose own source-tag plugin doesn't
    // stamp data-desde-v.
    writeFileSync(join(dir, "App.vue"), SWAPPED)
    const result = await applyEdit(propBody(undefined), dir, REAL_LOADERS)
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toContain(
      '<KButton variant="danger">Cancel</KButton>',
    )
  })

  it("accepts a full 64-char hash as well as the 12-char stamp prefix", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL)
    const result = await applyEdit(propBody(sha256Hex(ORIGINAL)), dir, REAL_LOADERS)
    expect(result.ok).toBe(true)
  })

  it("refuses a stale move with 409 and leaves the file untouched", async () => {
    writeFileSync(join(dir, "App.vue"), SWAPPED)
    const body: EditRequestBody = {
      edit: {
        kind: "move",
        file: "App.vue",
        line: 2,
        column: 3,
        destFile: "App.vue",
        destParentLine: 1,
        destParentColumn: 1,
        destIndex: -1,
        baseHash: stampOf(ORIGINAL),
      },
    } as EditRequestBody
    const result = await applyEdit(body, dir, REAL_LOADERS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(409)
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(SWAPPED)
  })

  it("refuses a stale llm-patch mutation batch with 409 before any applicator runs", async () => {
    writeFileSync(join(dir, "App.vue"), SWAPPED)
    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "App.vue:2:3",
            sourceVersion: stampOf(ORIGINAL),
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: "button",
            before: "Save",
            after: "Persist",
          },
        ],
      },
    } as EditRequestBody
    const result = await applyEdit(body, dir, REAL_LOADERS)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.reason).toMatch(/stale target/i)
    }
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(SWAPPED)
  })

  it("refuses 409 when a cross-file mutation's CALLSITE file is stale (codex WS1 P2)", async () => {
    // Cross-file (callsite-targeted) mutations splice against callsiteLoc's
    // file — its version must be guarded, not just sourceLoc's. Here the
    // callsite file changed since capture; sourceLoc's file isn't even in
    // the batch's read set (only the callsite file is patched).
    const PARENT_ORIGINAL = "<template>\n  <Card title=\"Hi\" />\n</template>\n"
    const PARENT_EDITED = "<template>\n  <Card title=\"Changed\" />\n</template>\n"
    writeFileSync(join(dir, "Parent.vue"), PARENT_EDITED)
    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "node_modules/lib/Card.vue:5:3",
            sourceVersion: null,
            resolutionKind: "direct",
            scope: "callsite",
            callsiteLoc: "Parent.vue:0:0",
            callsiteVersion: stampOf(PARENT_ORIGINAL),
            instancePath: "[0]",
            selector: ".card",
            before: "Hi",
            after: "Hello",
            disambiguationChoice: "this-instance",
          },
        ],
      },
    } as EditRequestBody
    const result = await applyEdit(body, dir, REAL_LOADERS)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.reason).toMatch(/stale target/i)
    }
    expect(readFileSync(join(dir, "Parent.vue"), "utf8")).toBe(PARENT_EDITED)
  })

  it("applies an llm-patch mutation when sourceVersion matches", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL)
    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "App.vue:2:3",
            sourceVersion: stampOf(ORIGINAL),
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: "button",
            before: "Save",
            after: "Persist",
          },
        ],
      },
    } as EditRequestBody
    const result = await applyEdit(body, dir, REAL_LOADERS)
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toContain(">Persist</KButton>")
  })
})

/**
 * Audit Task 23 — the stale-target guard was widened from prop/move to
 * every COORDINATE-MATCHED kind. A delete/unwrap/detach/swap/flatten-conditional
 * request splices at `data-desde-src` coordinates exactly like a prop edit does, so
 * a file that moved on since capture is the same wrong-target hazard: an unwrap
 * captured against one wrapper can strip a DIFFERENT wrapper, and a delete can
 * remove the wrong element entirely.
 *
 * These run the REAL applicators so a missing guard shows up as a real
 * mis-splice on disk, not just a status-code difference.
 */
describe("CLI handler stale-target guard — widened kinds (audit Task 23)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-stale-widened-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const WIDENED_LOADERS: ApplicatorLoaders = {
    ...REAL_LOADERS,
    loadApplyDeleteEdit: async () =>
      import("../../../../src/editor/edit-service/apply-delete-edit"),
    loadApplyUnwrapEdit: async () =>
      import("../../../../src/editor/edit-service/apply-unwrap-edit"),
    loadApplyFlattenConditionalEdit: async () =>
      import("../../../../src/editor/edit-service/apply-flatten-conditional-edit"),
    loadApplySwapEdit: async () =>
      import("../../../../src/editor/edit-service/apply-swap-edit"),
  }

  /**
   * `detach` and `swap` went DORMANT on 2026-08-11 (product decision — see
   * `enabled-lanes.ts`), so dispatch refuses them 400 unless the prototype
   * opted in. The three cases below are about the STALE-TARGET guard, not
   * about dormancy: they opt the lanes in so they keep asserting exactly what
   * they always asserted. That they still pass unchanged is the evidence that
   * the gate gated rather than broke — dormancy is a refusal in front of the
   * lane, not a change to it. `dormant-lanes.test.ts` owns the refusal itself.
   */
  const OPTED_IN = { enabledLanes: new Set<DormantLaneId>(["detach", "swap"]) }

  // Two wrappers. Coordinates captured against ORIGINAL (line 2 = the
  // `.header` div); after the swap, line 2 is the `.footer` div instead.
  const ORIGINAL = [
    "<template>",
    '  <div class="header"><KButton>Save</KButton></div>',
    '  <div class="footer"><KButton>Cancel</KButton></div>',
    "</template>",
    "",
  ].join("\n")

  const SWAPPED = [
    "<template>",
    '  <div class="footer"><KButton>Cancel</KButton></div>',
    '  <div class="header"><KButton>Save</KButton></div>',
    "</template>",
    "",
  ].join("\n")

  function bodyFor(kind: "delete" | "unwrap", baseHash?: string): EditRequestBody {
    return {
      edit: {
        kind,
        file: "App.vue",
        line: 2,
        column: 3,
        ...(baseHash ? { baseHash } : {}),
      },
    } as EditRequestBody
  }

  it("refuses a stale DELETE with 409 and leaves the file untouched", async () => {
    writeFileSync(join(dir, "App.vue"), SWAPPED)
    const result = await applyEdit(bodyFor("delete", stampOf(ORIGINAL)), dir, WIDENED_LOADERS)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.reason).toMatch(/stale target/i)
    }
    // Load-bearing: without the guard this deleted the FOOTER (the element
    // that now occupies the captured coordinates), not the header.
    const after = readFileSync(join(dir, "App.vue"), "utf8")
    expect(after).toBe(SWAPPED)
    expect(after).toContain('class="footer"')
  })

  it("applies a DELETE when the baseHash matches the on-disk file", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL)
    const result = await applyEdit(bodyFor("delete", stampOf(ORIGINAL)), dir, WIDENED_LOADERS)
    expect(result.ok).toBe(true)
    const after = readFileSync(join(dir, "App.vue"), "utf8")
    expect(after).not.toContain('class="header"')
    expect(after).toContain('class="footer"')
  })

  it("proceeds on a DELETE with no hash (guard stays opt-in per request)", async () => {
    writeFileSync(join(dir, "App.vue"), SWAPPED)
    const result = await applyEdit(bodyFor("delete", undefined), dir, WIDENED_LOADERS)
    expect(result.ok).toBe(true)
    // Unstamped substrates keep the legacy trust-the-coordinates behavior:
    // line 2 is the footer here, and that is what gets removed.
    expect(readFileSync(join(dir, "App.vue"), "utf8")).not.toContain('class="footer"')
  })

  it("refuses a stale UNWRAP with 409 and leaves the file untouched", async () => {
    writeFileSync(join(dir, "App.vue"), SWAPPED)
    const result = await applyEdit(bodyFor("unwrap", stampOf(ORIGINAL)), dir, WIDENED_LOADERS)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(409)
      expect(result.reason).toMatch(/stale target/i)
    }
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(SWAPPED)
  })

  it("proceeds on an UNWRAP with no hash", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL)
    const result = await applyEdit(bodyFor("unwrap", undefined), dir, WIDENED_LOADERS)
    expect(result.ok).toBe(true)
    // The header wrapper is gone; its KButton child survives.
    const after = readFileSync(join(dir, "App.vue"), "utf8")
    expect(after).not.toContain('class="header"')
    expect(after).toContain("<KButton>Save</KButton>")
  })

  it("refuses a stale FLATTEN-CONDITIONAL with 409", async () => {
    const CONDITIONAL = [
      "<template>",
      '  <div v-if="ok">Yes</div>',
      '  <div v-else>No</div>',
      "</template>",
      "",
    ].join("\n")
    writeFileSync(join(dir, "App.vue"), CONDITIONAL)
    const body: EditRequestBody = {
      edit: {
        kind: "flatten-conditional",
        file: "App.vue",
        line: 2,
        column: 3,
        branchToKeep: 0,
        baseHash: stampOf(ORIGINAL), // captured against a DIFFERENT version
      },
    } as EditRequestBody
    const result = await applyEdit(body, dir, WIDENED_LOADERS)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(409)
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(CONDITIONAL)
  })

  it("refuses a stale SWAP with 409", async () => {
    writeFileSync(join(dir, "App.vue"), SWAPPED)
    const body: EditRequestBody = {
      edit: {
        kind: "swap",
        file: "App.vue",
        line: 2,
        column: 23,
        fromComponentName: "KButton",
        toComponentName: "KExternalLink",
        baseHash: stampOf(ORIGINAL),
      },
    } as EditRequestBody
    const result = await applyEdit(body, dir, WIDENED_LOADERS, undefined, OPTED_IN)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(409)
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(SWAPPED)
  })

  it("applies a DETACH when the CONSUMER hash matches even though the component file changed", async () => {
    // The negative of the case below: `baseHash` guards the consumer file
    // (which carries the call-site coordinates) and ONLY that file. The
    // component file is read wholesale, not coordinate-matched, so a change
    // to it must NOT be treated as a stale target — guarding it would refuse
    // valid detaches every time the component was edited.
    const CONSUMER = [
      "<template>",
      "  <Card />",
      "</template>",
      "",
    ].join("\n")
    writeFileSync(join(dir, "App.vue"), CONSUMER)
    // A component file whose content is unrelated to any hash the client sent.
    writeFileSync(
      join(dir, "Card.vue"),
      "<template>\n  <div class=\"card-v2\">changed since capture</div>\n</template>\n",
    )
    const body: EditRequestBody = {
      edit: {
        kind: "detach",
        file: "App.vue",
        line: 2,
        column: 3,
        componentFile: "Card.vue",
        componentName: "Card",
        baseHash: stampOf(CONSUMER), // matches the CONSUMER, as captured
      },
    } as EditRequestBody
    const result = await applyEdit(body, dir, WIDENED_LOADERS, undefined, OPTED_IN)
    // Load-bearing: the detach APPLIES (not a 409). Asserted unconditionally
    // so the case can't pass vacuously if the applicator starts refusing for
    // an unrelated reason.
    expect(result.ok).toBe(true)
    // The component's CHANGED markup is what got inlined — proof the handler
    // read the current component file rather than refusing over its drift.
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toContain("card-v2")
  })

  it("refuses a stale DETACH with 409 (guards the consumer file)", async () => {
    writeFileSync(join(dir, "App.vue"), SWAPPED)
    writeFileSync(join(dir, "Card.vue"), "<template>\n  <div>card</div>\n</template>\n")
    const body: EditRequestBody = {
      edit: {
        kind: "detach",
        file: "App.vue",
        line: 2,
        column: 23,
        componentFile: "Card.vue",
        componentName: "KButton",
        baseHash: stampOf(ORIGINAL),
      },
    } as EditRequestBody
    const result = await applyEdit(body, dir, WIDENED_LOADERS, undefined, OPTED_IN)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(409)
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(SWAPPED)
  })
})

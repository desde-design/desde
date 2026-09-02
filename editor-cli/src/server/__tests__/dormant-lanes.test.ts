/**
 * Dormant lanes — `detach` and `swap` (product decision 2026-08-11,
 * `tasks/dev-server-hosts.md` § 9e).
 *
 * These lanes are GATED, not deleted: their applicators, their applicator
 * suites and their live-verified behaviour all stay. What changes is that the
 * product no longer OFFERS them, and — the half this file exists for — the
 * edit API no longer DISPATCHES them, so a stale client, a hand-built request
 * or an agent tool call gets a real answer naming the config key instead of a
 * confusing applicator error further down.
 *
 * Every assertion here runs the REAL applicators. A dormancy test that stubs
 * the applicator can pass while the lane is wide open — the refusal has to be
 * proven against a body that would otherwise SUCCEED, which is why each
 * dormant case has an opt-in twin asserting the very same body applies once
 * `lanes.<id>: true` is set. That pair is what separates "gated" from "broken".
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"
import { handleLLMFallback, type LLMFallbackLoaders } from "../llm-fallback-handler.js"
import {
  DORMANT_LANE_IDS,
  dormantLaneRefusal,
  loadEnabledLanes,
  type DormantLaneId,
} from "../enabled-lanes.js"

const REAL_LOADERS: ApplicatorLoaders = {
  loadApplyPropEdit: async () =>
    import("../../../../src/editor/edit-service/apply-prop-edit"),
  loadApplyMoveEdit: async () =>
    import("../../../../src/editor/edit-service/apply-move-edit"),
  loadApplyDetachEdit: async () =>
    import("../../../../src/editor/edit-service/apply-detach-edit"),
  loadApplySwapEdit: async () =>
    import("../../../../src/editor/edit-service/apply-swap-edit"),
}

function lanes(...ids: DormantLaneId[]): ReadonlySet<DormantLaneId> {
  return new Set(ids)
}

/** A consumer that renders `<Card />`, and the component it renders. */
const CONSUMER = ["<template>", "  <Card />", "</template>", ""].join("\n")
const CARD = '<template>\n  <div class="card-v2">detached body</div>\n</template>\n'

const DETACH_BODY: EditRequestBody = {
  edit: {
    kind: "detach",
    file: "App.vue",
    line: 2,
    column: 3,
    componentFile: "Card.vue",
    componentName: "Card",
  },
} as EditRequestBody

const SWAP_CONSUMER = [
  "<template>",
  '  <UiButton variant="primary" />',
  "</template>",
  "<script setup lang=\"ts\">",
  "import { UiButton } from '@acme/design-system'",
  "</script>",
  "",
].join("\n")

const SWAP_BODY: EditRequestBody = {
  edit: {
    kind: "swap",
    file: "App.vue",
    line: 2,
    column: 3,
    fromComponentName: "UiButton",
    toComponentName: "UiSegmentedButton",
    toPackageName: "@acme/design-system",
  },
} as EditRequestBody

describe("dormant lanes — dispatch refuses detach/swap by default", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-dormant-lanes-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("refuses a detach that would otherwise apply, naming lanes.detach", async () => {
    writeFileSync(join(dir, "App.vue"), CONSUMER)
    writeFileSync(join(dir, "Card.vue"), CARD)

    const result = await applyEdit(DETACH_BODY, dir, REAL_LOADERS)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.reason).toContain("lanes.detach")
    }
    // Nothing was written. A refusal that still edits is not a refusal.
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(CONSUMER)
  })

  it("applies the SAME detach body once lanes.detach is opted in", async () => {
    writeFileSync(join(dir, "App.vue"), CONSUMER)
    writeFileSync(join(dir, "Card.vue"), CARD)

    const result = await applyEdit(DETACH_BODY, dir, REAL_LOADERS, undefined, {
      enabledLanes: lanes("detach"),
    })

    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toContain("card-v2")
  })

  it("refuses a swap that would otherwise apply, naming lanes.swap", async () => {
    writeFileSync(join(dir, "App.vue"), SWAP_CONSUMER)

    const result = await applyEdit(SWAP_BODY, dir, REAL_LOADERS)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(400)
      expect(result.reason).toContain("lanes.swap")
    }
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(SWAP_CONSUMER)
  })

  it("applies the SAME swap body once lanes.swap is opted in", async () => {
    writeFileSync(join(dir, "App.vue"), SWAP_CONSUMER)

    const result = await applyEdit(SWAP_BODY, dir, REAL_LOADERS, undefined, {
      enabledLanes: lanes("swap"),
    })

    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toContain(
      "<UiSegmentedButton",
    )
  })

  it("gates per-lane: lanes.detach alone does not open swap", async () => {
    writeFileSync(join(dir, "App.vue"), SWAP_CONSUMER)

    const result = await applyEdit(SWAP_BODY, dir, REAL_LOADERS, undefined, {
      enabledLanes: lanes("detach"),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("lanes.swap")
  })

  it("leaves a non-dormant lane alone", async () => {
    writeFileSync(
      join(dir, "App.vue"),
      '<template>\n  <KButton variant="primary">Save</KButton>\n</template>\n',
    )
    const result = await applyEdit(
      {
        edit: {
          kind: "prop",
          file: "App.vue",
          line: 2,
          column: 3,
          propName: "variant",
          value: "secondary",
        },
      } as EditRequestBody,
      dir,
      REAL_LOADERS,
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toContain(
      'variant="secondary"',
    )
  })
})

/**
 * The repair lane is the SECOND dispatch surface for these kinds — it takes an
 * `intent.kind` of `detach`/`swap` and returns an LLM full-file rewrite. Gating
 * only `POST /api/editor/edit` would leave the dormant lane reachable here.
 */
describe("dormant lanes — the LLM repair lane refuses the same kinds", () => {
  let dir: string
  const loaders: LLMFallbackLoaders = {
    loadApplyRepairEdit: async () => {
      throw new Error("the repair lane must not be reached for a dormant kind")
    },
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-dormant-repair-"))
    writeFileSync(join(dir, "App.vue"), CONSUMER)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  for (const kind of DORMANT_LANE_IDS) {
    it(`refuses intent.kind "${kind}" with 400 naming lanes.${kind}`, async () => {
      const result = await handleLLMFallback(
        {
          file: "App.vue",
          intent: { kind, description: "repair it" },
          errorReason: "applicator refused",
        },
        dir,
        loaders,
      )
      expect(result.ok).toBe(false)
      expect(result.status).toBe(400)
      expect(result.reason).toContain(`lanes.${kind}`)
    })
  }

  it("still admits a non-dormant intent kind (reaches the repair loader)", async () => {
    await expect(
      handleLLMFallback(
        {
          file: "App.vue",
          intent: { kind: "move", description: "move it" },
          errorReason: "applicator refused",
        },
        dir,
        loaders,
      ),
    ).rejects.toThrow(/must not be reached/)
  })
})

describe("dormantLaneRefusal", () => {
  it("names the kind, the config key and the config file", () => {
    const reason = dormantLaneRefusal("detach", new Set())
    expect(reason).not.toBeNull()
    expect(reason).toContain("detach")
    expect(reason).toContain("lanes.detach")
    expect(reason).toContain("desde.config.json")
  })

  it("returns null for an enabled lane and for a non-dormant kind", () => {
    expect(dormantLaneRefusal("detach", new Set(["detach"]))).toBeNull()
    expect(dormantLaneRefusal("prop", new Set())).toBeNull()
  })

  it("treats an absent set as dormant (fail-closed)", () => {
    expect(dormantLaneRefusal("swap", undefined)).not.toBeNull()
  })
})

describe("loadEnabledLanes", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-lanes-config-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeConfig(value: unknown): void {
    writeFileSync(
      join(dir, "desde.config.json"),
      JSON.stringify(value),
    )
  }

  it("enables nothing when there is no config file", async () => {
    const r = await loadEnabledLanes(dir)
    expect([...r.enabled]).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it("enables nothing when the config has no lanes block", async () => {
    writeConfig({ hosts: { astro: true } })
    const r = await loadEnabledLanes(dir)
    expect([...r.enabled]).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it("enables exactly the lanes set to true", async () => {
    writeConfig({ lanes: { detach: true, swap: false } })
    const r = await loadEnabledLanes(dir)
    expect([...r.enabled]).toEqual(["detach"])
  })

  it("warns and ignores an unknown lane id", async () => {
    writeConfig({ lanes: { detatch: true } })
    const r = await loadEnabledLanes(dir)
    expect([...r.enabled]).toEqual([])
    expect(r.warnings.join("\n")).toContain("detatch")
  })

  it("warns and ignores a non-boolean value", async () => {
    writeConfig({ lanes: { detach: "yes" } })
    const r = await loadEnabledLanes(dir)
    expect([...r.enabled]).toEqual([])
    expect(r.warnings.join("\n")).toContain("must be true or false")
  })

  it("warns and ignores a non-object lanes block, never throwing", async () => {
    writeConfig({ lanes: ["detach"] })
    const r = await loadEnabledLanes(dir)
    expect([...r.enabled]).toEqual([])
    expect(r.warnings.length).toBe(1)
  })

  it("warns on unreadable JSON rather than failing the boot", async () => {
    writeFileSync(join(dir, "desde.config.json"), "{ not json")
    const r = await loadEnabledLanes(dir)
    expect([...r.enabled]).toEqual([])
    expect(r.warnings.length).toBe(1)
  })

  it("reads the same file the hosts block lives in, from the prototype root", async () => {
    mkdirSync(join(dir, "nested"), { recursive: true })
    writeConfig({ hosts: { astro: true }, lanes: { swap: true } })
    expect([...(await loadEnabledLanes(dir)).enabled]).toEqual(["swap"])
    // A different root sees nothing — the block is per-prototype.
    expect([...(await loadEnabledLanes(join(dir, "nested"))).enabled]).toEqual([])
  })
})

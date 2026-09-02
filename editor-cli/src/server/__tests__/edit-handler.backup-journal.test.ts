/**
 * Audit Task 14 — backup journal coverage for `applyEdit`'s deterministic
 * single-kind write path (the highest-volume edit lane: prop / move /
 * detach / delete / swap / insert / overwrite / …) and the `allowCreate`
 * new-file path. Before this task these were the only write sites with NO
 * `.desde/backups/` entry — every other lane (llm-patch, the SDK
 * structural tools) already journaled through the Task 12 write broker.
 *
 * Cases, matching the task brief:
 *   1. A prop edit journals the pre-edit original.
 *   2. A no-op edit (refused upstream by the applicator) writes NO journal
 *      dir at all — the compare-before-write guard runs before any
 *      journal, not after.
 *   3. An `allowCreate` new-file edit journals as `isNew` — no prior
 *      content to snapshot, so no journal-entry-with-content, and the
 *      response omits `backupDir` (nothing on disk for it to point at —
 *      review round-1 MINOR 1).
 *   4. A detach edit journals the CONSUMER file (the only file it writes;
 *      the component file is read-only input to the inline).
 *
 * Review round-1 CRITICAL follow-up: a `file` request path with enough
 * leading `../` segments to re-descend back inside the repo root passes
 * `applyEdit`'s own root-containment guard (built around
 * `path.resolve(rootReal, file)`), but used VERBATIM as a journal key it
 * can still escape `.desde/backups/<ts>-<uuid>/` when joined against
 * it (a differently-nested base directory) — landing the backup write
 * somewhere else on disk entirely, with intermediate dirs auto-created.
 * Two more cases close this:
 *   5. `writeBackupJournal` itself refuses an escaping key (the central,
 *      defense-in-depth check — `backup-journal.test.ts` covers this
 *      directly; not duplicated here).
 *   6. An `applyEdit` request built with such a `file` still succeeds, and
 *      journals under the NORMALIZED relative key (derived from the
 *      already-resolved target path) — nothing lands outside the repo.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { tmpdir } from "node:os"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"
import type { DormantLaneId } from "../enabled-lanes.js"

const REAL_APPLICATORS: ApplicatorLoaders = {
  loadApplyPropEdit: () => import("../../../../src/editor/edit-service/apply-prop-edit"),
  loadApplyMoveEdit: () => import("../../../../src/editor/edit-service/apply-move-edit"),
  loadApplyDetachEdit: () => import("../../../../src/editor/edit-service/apply-detach-edit"),
}

// llm-patch's deterministic fast-path (an `attr` mutation routes straight
// through applyPropEdit) requires loadApplySlotTextEdit to be present just
// to ENTER the branch, plus loadApplyLLMPatch/loadStyleGrounding to pass
// handleLLMPatch's up-front "loaders configured" gate — neither is ever
// actually invoked by the attr-only mutation below, but both must be wired
// for the request to reach the fast-path at all.
let llmInvocations = 0
const LLM_PATCH_APPLICATORS: ApplicatorLoaders = {
  ...REAL_APPLICATORS,
  loadApplySlotTextEdit: () =>
    import("../../../../src/editor/edit-service/apply-slot-text-edit"),
  loadApplyLLMPatch: async () =>
    ({
      applyLLMPatch: (async () => {
        llmInvocations += 1
        return { ok: true, patchedFiles: new Map(), perMutationOutcomes: [] }
      }) as unknown as typeof import("../../../../src/editor/edit-service/apply-llm-patch").applyLLMPatch,
      parseSourceLocFile: () => null,
      isCrossFileInstanceEdit: () => false,
      patchFileFor: () => ({ ok: false, reason: "stub" }),
    }) as typeof import("../../../../src/editor/edit-service/apply-llm-patch"),
  loadStyleGrounding: async () => ({
    loadStyleGrounding: () => ({ tokens: [], classTaxonomy: [], preprocessor: "css" as const }),
  }),
}

const BACKUP_DIR_RE =
  /^\.desde[/\\]backups[/\\][\dTZ_:.-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe("edit-handler — backup journal for the deterministic write path (audit Task 14)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "edit-handler-backup-journal-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("journals the pre-edit original for a prop edit", async () => {
    const original = [
      "<template>",
      '  <KEmptyState title="Hello" />',
      "</template>",
      "",
    ].join("\n")
    writeFileSync(join(dir, "App.vue"), original)

    const body: EditRequestBody = {
      edit: { kind: "prop", file: "App.vue", line: 2, column: 3, propName: "title", value: "World" },
    }
    const result = await applyEdit(body, dir, REAL_APPLICATORS)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.backupDir).toMatch(BACKUP_DIR_RE)
    // The journal holds the PRE-edit bytes, not the new ones.
    expect(readFileSync(join(dir, result.backupDir!, "App.vue"), "utf8")).toBe(original)
    // The live file reflects the edit.
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toContain('title="World"')
  })

  it("writes no journal directory for a no-op edit", async () => {
    const original = [
      "<template>",
      '  <KEmptyState title="Hello" />',
      "</template>",
      "",
    ].join("\n")
    writeFileSync(join(dir, "App.vue"), original)

    // Same value as already on disk — apply-prop-edit refuses this
    // upstream of any write (`Prop value is unchanged — no edit needed.`),
    // so the handler's broker call must never run.
    const body: EditRequestBody = {
      edit: { kind: "prop", file: "App.vue", line: 2, column: 3, propName: "title", value: "Hello" },
    }
    const result = await applyEdit(body, dir, REAL_APPLICATORS)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(422)
    expect(result.backupDir).toBeUndefined()

    // No backup machinery touched disk at all.
    expect(existsSync(join(dir, ".desde"))).toBe(false)
    // File on disk is untouched.
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(original)
  })

  it("journals an allowCreate new file as isNew (no prior content, no backupDir in the response)", async () => {
    const newSource = "<template><div>fresh</div></template>\n"
    const body: EditRequestBody = {
      edit: { kind: "overwrite", file: "Fresh.vue", newSource, allowCreate: true },
    }
    const result = await applyEdit(body, dir, REAL_APPLICATORS)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The write succeeded and landed the exact new content.
    expect(readFileSync(join(dir, "Fresh.vue"), "utf8")).toBe(newSource)
    // No `backupDir` on the response (review round-1 MINOR 1): `journal:
    // []` means writeBackupJournal never created that directory, so
    // advertising it as a recovery location would be misleading.
    expect(result.backupDir).toBeUndefined()
    // No backup journal: an `isNew` create has no PRIOR content to snapshot.
    // (Scoped to `backups/` deliberately — `.desde/` itself is no longer
    // exclusive to the journal, since the edit ledger writes its log there too.)
    expect(existsSync(join(dir, ".desde", "backups"))).toBe(false)
  })

  it("journals only the consumer file for a detach edit (component file is read-only input)", async () => {
    // Fixture mirrors apply-detach-edit.test.ts's happy path exactly —
    // callSiteLine/Column must land on the <ProtoButton> tag.
    const consumer = [
      "<template>",
      "  <div>",
      '    <ProtoButton variant="primary">Save</ProtoButton>',
      "  </div>",
      "</template>",
      "",
    ].join("\n")
    const component = [
      "<template>",
      '  <button :variant="variant">',
      "    <slot />",
      "  </button>",
      "</template>",
      "",
      "<script setup>",
      "defineProps(['variant'])",
      "</script>",
      "",
    ].join("\n")
    writeFileSync(join(dir, "App.vue"), consumer)
    writeFileSync(join(dir, "ProtoButton.vue"), component)

    const body: EditRequestBody = {
      edit: {
        kind: "detach",
        file: "App.vue",
        line: 3,
        column: 5,
        componentFile: "ProtoButton.vue",
        componentName: "ProtoButton",
      },
    }
    // `detach` is DORMANT by default since 2026-08-11 (see `enabled-lanes.ts`),
    // so this opts the lane in. What is under test is the backup journal, not
    // the gate — and the case passing UNCHANGED with the lane opted in is the
    // evidence that dormancy is a refusal in front of the lane rather than a
    // change to it.
    const result = await applyEdit(body, dir, REAL_APPLICATORS, undefined, {
      enabledLanes: new Set<DormantLaneId>(["detach"]),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.backupDir).toMatch(BACKUP_DIR_RE)
    // Only the consumer's PRE-edit bytes are journaled.
    expect(readFileSync(join(dir, result.backupDir!, "App.vue"), "utf8")).toBe(consumer)
    expect(existsSync(join(dir, result.backupDir!, "ProtoButton.vue"))).toBe(false)
    // The component file itself was never written — detach only reads it.
    expect(readFileSync(join(dir, "ProtoButton.vue"), "utf8")).toBe(component)
    // The consumer was rewritten with the component inlined.
    const written = readFileSync(join(dir, "App.vue"), "utf8")
    expect(written).not.toContain("<ProtoButton")
    expect(written).toContain("<button")
  })

  it("journals under the normalized relative key when `file` re-enters the root via `../` (review round-1 CRITICAL)", async () => {
    // realpath, matching what applyEdit computes internally as `rootReal`
    // — macOS resolves the tmpdir through a `/private/...` symlink, and
    // the crafted string below has to be built against the SAME base
    // applyEdit uses or the arithmetic won't line up.
    const rootReal = realpathSync(dir)
    const original = [
      "<template>",
      '  <KEmptyState title="Hello" />',
      "</template>",
      "",
    ].join("\n")
    writeFileSync(join(rootReal, "App.vue"), original)

    // Craft a `file` whose raw string carries leading `../` segments but
    // whose RESOLUTION lands back on `rootReal/App.vue` — reproducing
    // rootReal's own last-N path segments after popping N levels is a
    // general identity (works for any tmpdir depth): `resolve(rootReal,
    // '../'.repeat(N) + rootReal's-last-N-segments + '/App.vue')` always
    // equals `rootReal/App.vue`. N=4 is comfortably past `.desde/
    // backups/<ts>-<uuid>/`'s fixed 3-segment nesting, so joining the
    // SAME raw string against backupDir pops past the repo root entirely
    // instead of reconstructing it — a clean, assertable escape if the
    // fix weren't in place.
    const N = 4
    const segs = rootReal.split(sep).filter(Boolean).slice(-N)
    const craftedFile = "../".repeat(N) + segs.join("/") + "/App.vue"

    // Sanity: the crafted string really does pass applyEdit's OWN
    // root-containment guard — otherwise this test would be pinning the
    // wrong thing (a request that never reaches the write site at all).
    expect(resolve(rootReal, craftedFile)).toBe(join(rootReal, "App.vue"))
    // And sanity that this really WOULD have escaped `rootReal` if used
    // verbatim as a journal key — otherwise the "fix" being tested isn't
    // actually exercised.
    const naiveEscapeTarget = join(dirname(rootReal), ...segs, "App.vue")
    expect(naiveEscapeTarget.startsWith(rootReal + sep)).toBe(false)

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: craftedFile,
        line: 2,
        column: 3,
        propName: "title",
        value: "World",
      },
    }
    const result = await applyEdit(body, rootReal, REAL_APPLICATORS)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // The edit landed normally, at the file the crafted path actually
    // resolves to.
    expect(readFileSync(join(rootReal, "App.vue"), "utf8")).toContain('title="World"')
    // The journal key is the NORMALIZED relative path (`App.vue`) — the
    // same shape every other case in this file gets — not the raw
    // crafted string.
    expect(result.backupDir).toMatch(BACKUP_DIR_RE)
    expect(readFileSync(join(rootReal, result.backupDir!, "App.vue"), "utf8")).toBe(original)

    // Nothing landed where the UNSANITIZED raw key would have (outside
    // the repo root entirely).
    expect(existsSync(naiveEscapeTarget)).toBe(false)
  })

  it("the llm-patch lane's deterministic fast-path also normalizes journal keys (review round-1 CRITICAL)", async () => {
    // Same shape of bug, different call site: the llm-patch lane keys
    // its journal/ops off `sourceLoc`'s file portion — client-supplied,
    // same escape risk as `applyEdit`'s `file`.
    const rootReal = realpathSync(dir)
    const original = [
      "<template>",
      '  <KEmptyState title="Hello" />',
      "</template>",
      "",
    ].join("\n")
    writeFileSync(join(rootReal, "App.vue"), original)

    const N = 4
    const segs = rootReal.split(sep).filter(Boolean).slice(-N)
    const craftedFile = "../".repeat(N) + segs.join("/") + "/App.vue"
    const naiveEscapeTarget = join(dirname(rootReal), ...segs, "App.vue")
    expect(naiveEscapeTarget.startsWith(rootReal + sep)).toBe(false)

    llmInvocations = 0
    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1",
            kind: "attr",
            sourceLoc: `${craftedFile}:2:3`,
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".empty-state",
            target: "title",
            before: "Hello",
            after: "World",
          },
        ],
      },
    }
    const result = await applyEdit(body, rootReal, LLM_PATCH_APPLICATORS)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The deterministic fast-path handled it — the LLM lane never ran.
    expect(llmInvocations).toBe(0)

    // The edit landed normally, and the RESPONSE still keys `newHashes`
    // by the raw crafted string (client-facing shape unchanged — this is
    // a journal-key-only normalization).
    expect(readFileSync(join(rootReal, "App.vue"), "utf8")).toContain('title="World"')
    expect(result.newHashes?.[craftedFile]).toBeDefined()

    // But the journal itself used the normalized key.
    expect(result.backupDir).toMatch(BACKUP_DIR_RE)
    expect(readFileSync(join(rootReal, result.backupDir!, "App.vue"), "utf8")).toBe(original)
    expect(existsSync(naiveEscapeTarget)).toBe(false)
  })
})

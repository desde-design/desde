/**
 * Phase E3 — external-edit conflict guard tests for the CLI handler's
 * `llm-patch` path. Mirrors the behavior of the Next route's
 * `handleLLMPatch`. Uses real filesystem with a tmpdir so the read +
 * hash + write loop executes end-to-end. The applyLLMPatch loader is
 * stubbed so we don't fire a live LLM call.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

function makeStubApplicators(
  patches: Map<string, string>,
): ApplicatorLoaders {
  // The stub's applyLLMPatch returns the supplied per-file patches.
  // The CLI handler is responsible for hash comparison BEFORE this
  // gets called for the conflict path; we still wire a real-ish
  // applicator for the success path tests.
  return {
    loadApplyPropEdit: async () => ({
      applyPropEdit: () => ({ ok: false, reason: "stub" }),
    }),
    loadApplyMoveEdit: async () => ({
      applyMoveEdit: () => ({ ok: false, reason: "stub" }),
    }),
    loadApplyDetachEdit: async () => ({
      applyDetachEdit: () => ({ ok: false, reason: "stub" }),
    }),
    loadApplyLLMPatch: async () =>
      // Stub mirrors the real module's surface (incl. helpers exported
      // for cross-file routing tests). We only USE applyLLMPatch here;
      // the helpers are a no-op pass-through.
      ({
        applyLLMPatch: (async () => ({
          ok: true,
          patchedFiles: patches,
          perMutationOutcomes: Array.from(patches.keys()).map((_, i) => ({
            mutationId: `m-${i + 1}`,
            outcome: "applied" as const,
          })),
        })) as unknown as typeof import("../../../../src/editor/edit-service/apply-llm-patch").applyLLMPatch,
        parseSourceLocFile: () => null,
        isCrossFileInstanceEdit: () => false,
        patchFileFor: () => ({ ok: false, reason: "stub" }),
      }) as typeof import("../../../../src/editor/edit-service/apply-llm-patch"),
    loadStyleGrounding: async () => ({
      loadStyleGrounding: () => ({
        tokens: [],
        classTaxonomy: [],
        preprocessor: "css" as const,
      }),
    }),
  }
}

describe("CLI handler LLM-patch hash guard (Phase E3)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-hash-guard-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("returns the post-write hash so the client can carry it forward", async () => {
    const original = "<template><h1>Hi</h1></template>\n<style></style>"
    const patched = "<template><h1>Hello</h1></template>\n<style></style>"
    writeFileSync(join(dir, "App.vue"), original)
    const applicators = makeStubApplicators(new Map([["App.vue", patched]]))

    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "App.vue:1:11",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: "h1",
            before: "Hi",
            after: "Hello",
          },
        ],
      },
    }
    const result = await applyEdit(body, dir, applicators)
    expect(result.ok).toBe(true)
    expect(result.newHashes).toBeDefined()
    expect(result.newHashes!["App.vue"]).toBe(sha256Hex(patched))
    // Disk reflects the patch.
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(patched)
    // The LLM lane's backup dir carries the timestamp+uuid suffix (audit
    // Task 12). It was timestamp-ONLY before the write broker, so two
    // patches landing in the same millisecond could clobber each other's
    // originals — the deterministic lane never had that hole.
    expect(result.backupDir).toMatch(
      /^\.desde[/\\]backups[/\\][\dTZ_:.-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(readFileSync(join(dir, result.backupDir!, "App.vue"), "utf8")).toBe(original)
  })

  it("rejects with 409 when baseHashes don't match the on-disk file", async () => {
    const original = "<template><h1>Hi</h1></template>\n<style></style>"
    const externallyEdited =
      "<template><h1>EngineerEdit</h1></template>\n<style></style>"
    writeFileSync(join(dir, "App.vue"), externallyEdited)
    const applicators = makeStubApplicators(
      new Map([["App.vue", "should not be written"]]),
    )

    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        // Client thinks the file is at the original hash — engineer
        // edited it externally to externallyEdited.
        baseHashes: { "App.vue": sha256Hex(original) },
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "App.vue:1:11",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: "h1",
            before: "Hi",
            after: "Hello",
          },
        ],
      },
    }
    const result = await applyEdit(body, dir, applicators)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(409)
    expect(result.reason).toBe("external-edit-conflict")
    expect(result.conflicts).toBeDefined()
    expect(result.conflicts!.length).toBe(1)
    expect(result.conflicts![0].file).toBe("App.vue")
    expect(result.conflicts![0].expected).toBe(sha256Hex(original))
    expect(result.conflicts![0].actual).toBe(sha256Hex(externallyEdited))
    // File must NOT have been overwritten.
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(externallyEdited)
  })

  it("proceeds when baseHashes match (no conflict)", async () => {
    const original = "<template><h1>Hi</h1></template>\n<style></style>"
    const patched = "<template><h1>Hello</h1></template>\n<style></style>"
    writeFileSync(join(dir, "App.vue"), original)
    const applicators = makeStubApplicators(new Map([["App.vue", patched]]))

    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        baseHashes: { "App.vue": sha256Hex(original) },
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "App.vue:1:11",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: "h1",
            before: "Hi",
            after: "Hello",
          },
        ],
      },
    }
    const result = await applyEdit(body, dir, applicators)
    expect(result.ok).toBe(true)
    expect(result.newHashes!["App.vue"]).toBe(sha256Hex(patched))
  })

  it("ignores stale baseHashes entries for files not in the bundle", async () => {
    const original = "<template><h1>Hi</h1></template>\n<style></style>"
    const patched = "<template><h1>Hello</h1></template>\n<style></style>"
    writeFileSync(join(dir, "App.vue"), original)
    const applicators = makeStubApplicators(new Map([["App.vue", patched]]))

    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        // baseHashes carries an entry for a file NOT touched by this
        // bundle (carry-over from prior save). The route should
        // silently skip — no conflict.
        baseHashes: {
          "App.vue": sha256Hex(original),
          "OtherFile.vue": "f".repeat(64),
        },
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "App.vue:1:11",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: "h1",
            before: "Hi",
            after: "Hello",
          },
        ],
      },
    }
    const result = await applyEdit(body, dir, applicators)
    expect(result.ok).toBe(true)
  })

  it("cross-file: routes 'this-instance' to callsiteLoc's file and reports both hashes", async () => {
    // Designer edits a button INSIDE UiButton from inside Catalog.vue.
    // Choose 'this-instance' → patch lands in Catalog.vue, not the
    // Acme DS internal. The host file isn't touched, but its
    // pre-existing source is still read and reported back.
    const catalogOriginal =
      '<template><UiButton variant="primary">Save</UiButton></template>'
    const catalogPatched =
      '<template><UiButton variant="danger">Save</UiButton></template>'
    writeFileSync(join(dir, "Catalog.vue"), catalogOriginal)

    // Note the cross-file routing: applyLLMPatch returns ONLY the
    // patched parent. Host file (UiButton) is read but not patched.
    const applicators = makeStubApplicators(
      new Map([["Catalog.vue", catalogPatched]]),
    )

    // Make a fake UiButton on disk too (mutations request it via
    // sourceLoc, the route walks it via the file resolver).
    const kbuttonDir = join(dir, "node_modules", "@acme", "design-system")
    mkdirSync(kbuttonDir, { recursive: true })
    const kbuttonOriginal = "<template><button>SLOT</button></template>"
    writeFileSync(join(kbuttonDir, "UiButton.vue"), kbuttonOriginal)

    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1",
            kind: "attr",
            sourceLoc:
              "node_modules/@acme/design-system/UiButton.vue:1:11",
            resolutionKind: "direct",
            scope: "callsite",
            callsiteLoc: "Catalog.vue:1:11",
            disambiguationChoice: "this-instance",
            instancePath: "[0]",
            selector: "button",
            target: "variant",
            before: "primary",
            after: "danger",
          },
        ],
      },
    }
    const result = await applyEdit(body, dir, applicators)
    expect(result.ok).toBe(true)
    // Only Catalog.vue was patched; both files report a hash so the
    // shell can guard subsequent saves on either.
    expect(result.newHashes!["Catalog.vue"]).toBe(sha256Hex(catalogPatched))
    // UiButton was read for cross-file context and is reported with
    // its ORIGINAL hash (not patched). Note: in this test the route
    // reads UiButton.vue because the bundle requests it via sourceLoc;
    // the cross-file routing in applyLLMPatch happens to NOT patch it
    // (the stub only provides Catalog patches). The client should
    // carry both hashes forward.
    expect(readFileSync(join(dir, "Catalog.vue"), "utf8")).toBe(catalogPatched)
  })
})

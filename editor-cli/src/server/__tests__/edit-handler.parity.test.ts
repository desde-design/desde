import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join, basename } from "node:path"
import { tmpdir } from "node:os"
import { validateEditRequest } from "../../../../src/editor/edit-service/validate-edit-request"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"
import {
  getSharedEditHistory,
  resetSharedEditHistoryForTests,
} from "../../../../src/editor/edit-service/edit-history"
import { hashContent } from "../../../../src/editor/ledger/edit-ledger"

/**
 * Contract tests for the CLI's edit-handler. The file is named
 * "parity" for historical reasons — there was once a parallel web
 * Next.js route at `src/app/api/editor/edit/route.ts` and these
 * tests pinned the two routes to the same validator contract. The
 * web route was removed 2026-06-04 (see `tasks/web-editor-removal.md`);
 * the CLI handler is now the single dispatcher. These tests remain
 * useful because they pin the validator's error-string contract
 * end-to-end (input → error string + status), which is what changes
 * if `validateEditRequest` drifts.
 *
 * The tests also exercise applyEdit() with stubbed applicators to
 * confirm the post-validate guards (regex checks for prop/component
 * names) return the expected reasons.
 */

/**
 * Properly typed stub applicators. The loader return type matches the
 * actual module shape so signature drift in the in-tree applicators
 * surfaces here as a typecheck error, not a silent runtime breakage.
 */
const stubApplicators: ApplicatorLoaders = {
  loadApplyPropEdit: async () => ({
    applyPropEdit: () => ({ ok: false, reason: "stub" }),
  }),
  loadApplyMoveEdit: async () => ({
    applyMoveEdit: () => ({ ok: false, reason: "stub" }),
  }),
  loadApplyDetachEdit: async () => ({
    applyDetachEdit: () => ({ ok: false, reason: "stub" }),
  }),
}

const REPO_ROOT = process.cwd()

interface Case {
  name: string
  body: unknown
  expect: { status: number; reason: string }
}

const VALIDATION_CASES: Case[] = [
  {
    name: "missing edit",
    body: {},
    expect: { status: 400, reason: "Body.edit must be an object" },
  },
  {
    name: "wrong kind",
    body: { edit: { kind: "wat" } },
    expect: {
      status: 400,
      reason:
        'edit.kind must be "prop" | "move" | "detach" | "swap" | "delete" | "insert" | "unwrap" | "flatten-conditional" | "overwrite" | "scoped-css-override" | "jsx-style" | "llm-patch" | "text-branch" | "token-value"',
    },
  },
  {
    name: "missing file",
    body: { edit: { kind: "prop" } },
    expect: { status: 400, reason: "edit.file required" },
  },
  {
    name: "non-positive line",
    body: { edit: { kind: "prop", file: "x.vue", line: 0, column: 1 } },
    expect: { status: 400, reason: "edit.line must be a positive integer" },
  },
  {
    name: "non-integer column",
    body: { edit: { kind: "prop", file: "x.vue", line: 1, column: 1.5 } },
    expect: { status: 400, reason: "edit.column must be a non-negative integer" },
  },
  {
    name: "prop missing propName",
    body: { edit: { kind: "prop", file: "x.vue", line: 1, column: 1 } },
    expect: { status: 400, reason: "edit.propName required" },
  },
  {
    name: "prop value wrong type",
    body: {
      edit: {
        kind: "prop",
        file: "x.vue",
        line: 1,
        column: 1,
        propName: "class",
        value: { obj: 1 },
      },
    },
    expect: { status: 400, reason: "edit.value must be string | number | boolean (V1.3)" },
  },
  {
    name: "move missing destFile",
    body: { edit: { kind: "move", file: "x.vue", line: 1, column: 1 } },
    expect: { status: 400, reason: "edit.destFile required for move" },
  },
  {
    name: "move cross-file rejected",
    body: {
      edit: {
        kind: "move",
        file: "a.vue",
        line: 1,
        column: 1,
        destFile: "b.vue",
        destParentLine: 1,
        destParentColumn: 1,
        destIndex: 0,
      },
    },
    expect: {
      status: 400,
      reason: "edit.destFile must equal edit.file (cross-file moves are V2)",
    },
  },
  {
    name: "detach missing componentFile",
    body: { edit: { kind: "detach", file: "x.vue", line: 1, column: 1 } },
    expect: { status: 400, reason: "edit.componentFile required for detach" },
  },
  {
    name: "detach missing componentName",
    body: {
      edit: {
        kind: "detach",
        file: "x.vue",
        line: 1,
        column: 1,
        componentFile: "y.vue",
      },
    },
    expect: { status: 400, reason: "edit.componentName required for detach" },
  },
]

describe("validateEditRequest LLM-patch baseHashes (Phase E)", () => {
  const validLLMBody = {
    edit: {
      kind: "llm-patch",
      mutations: [
        {
          id: "m-1",
          kind: "text",
          sourceLoc: "src/Foo.vue:1:1",
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
  const validHash = "a".repeat(64)

  it("accepts a valid hex SHA-256 baseHashes entry", () => {
    expect(
      validateEditRequest({
        edit: {
          ...validLLMBody.edit,
          baseHashes: { "src/Foo.vue": validHash },
        },
      }),
    ).toBeNull()
  })

  it("accepts an LLM-patch body with NO baseHashes (back-compat)", () => {
    expect(validateEditRequest(validLLMBody)).toBeNull()
  })

  it("rejects baseHashes with a non-hex value", () => {
    expect(
      validateEditRequest({
        edit: {
          ...validLLMBody.edit,
          baseHashes: { "src/Foo.vue": "not-hex-and-too-short" },
        },
      }),
    ).toMatch(/64-char hex SHA-256/)
  })

  it("rejects baseHashes with a wrong-length hex value", () => {
    expect(
      validateEditRequest({
        edit: {
          ...validLLMBody.edit,
          baseHashes: { "src/Foo.vue": "abc" },
        },
      }),
    ).toMatch(/64-char hex SHA-256/)
  })

  it("rejects baseHashes as an array", () => {
    expect(
      validateEditRequest({
        edit: {
          ...validLLMBody.edit,
          baseHashes: ["a".repeat(64)],
        },
      }),
    ).toMatch(/string-valued object/)
  })

  it("rejects baseHashes as null", () => {
    expect(
      validateEditRequest({
        edit: {
          ...validLLMBody.edit,
          baseHashes: null,
        },
      }),
    ).toMatch(/string-valued object/)
  })
})

describe("validateEditRequest direct surface (covers null/undefined)", () => {
  it("rejects undefined body", () => {
    expect(validateEditRequest(undefined)).toBe("Body must be an object")
  })
  it("rejects null body", () => {
    expect(validateEditRequest(null)).toBe("Body must be an object")
  })
  it("rejects non-object body", () => {
    expect(validateEditRequest("just a string")).toBe("Body must be an object")
  })
  it("accepts a fully-valid PropEdit body", () => {
    expect(
      validateEditRequest({
        edit: {
          kind: "prop",
          file: "x.vue",
          line: 1,
          column: 1,
          propName: "class",
          value: "x",
        },
      }),
    ).toBeNull()
  })
  it("accepts a PropEdit body with llmFallback:'chat'", () => {
    expect(
      validateEditRequest({
        edit: {
          kind: "prop",
          file: "x.vue",
          line: 1,
          column: 1,
          propName: "class",
          value: "x",
          llmFallback: "chat",
        },
      }),
    ).toBeNull()
  })
  it("rejects a PropEdit body with invalid llmFallback value", () => {
    expect(
      validateEditRequest({
        edit: {
          kind: "prop",
          file: "x.vue",
          line: 1,
          column: 1,
          propName: "class",
          value: "x",
          llmFallback: "garbage",
        },
      }),
    ).toBe('edit.llmFallback must be "patch" or "chat" when provided')
  })

  const insertBase = {
    kind: "insert" as const,
    file: "x.vue",
    line: 2,
    column: 3,
    destIndex: -1,
    snippet: "<UiCard>hi</UiCard>",
  }
  it("accepts an Insert body without componentImport", () => {
    expect(validateEditRequest({ edit: insertBase })).toBeNull()
  })
  it("accepts an Insert body with a valid componentImport", () => {
    expect(
      validateEditRequest({
        edit: {
          ...insertBase,
          componentImport: { name: "UiCard", importPath: "@acme/design-system", named: true },
        },
      }),
    ).toBeNull()
  })
  it("rejects an Insert body whose componentImport lacks name", () => {
    expect(
      validateEditRequest({
        edit: { ...insertBase, componentImport: { importPath: "@acme/design-system" } },
      }),
    ).toBe("edit.componentImport.name required")
  })
  it("rejects an Insert body whose componentImport lacks importPath", () => {
    expect(
      validateEditRequest({
        edit: { ...insertBase, componentImport: { name: "UiCard" } },
      }),
    ).toBe("edit.componentImport.importPath required")
  })
  it("rejects an Insert body whose componentImport.name is not a JS identifier", () => {
    expect(
      validateEditRequest({
        edit: { ...insertBase, componentImport: { name: "foo-bar", importPath: "@acme/design-system" } },
      }),
    ).toBe("edit.componentImport.name must be a valid JS identifier")
  })
  it("rejects an Insert body whose componentImport.importPath has an unsafe char", () => {
    expect(
      validateEditRequest({
        edit: { ...insertBase, componentImport: { name: "UiCard", importPath: "pkg'broken" } },
      }),
    ).toBe(
      "edit.componentImport.importPath contains characters that are not allowed in a module specifier",
    )
  })
  it("rejects an Insert body whose componentImport.named is non-boolean", () => {
    expect(
      validateEditRequest({
        edit: {
          ...insertBase,
          componentImport: { name: "UiCard", importPath: "@acme/design-system", named: "yes" },
        },
      }),
    ).toBe("edit.componentImport.named must be a boolean when provided")
  })
  it("accepts an Insert body with contentKind 'text'", () => {
    expect(
      validateEditRequest({ edit: { ...insertBase, snippet: "hello", contentKind: "text" } }),
    ).toBeNull()
  })
  it("accepts an Insert body with contentKind 'element'", () => {
    expect(
      validateEditRequest({ edit: { ...insertBase, contentKind: "element" } }),
    ).toBeNull()
  })
  it("rejects an Insert body with an invalid contentKind", () => {
    expect(
      validateEditRequest({ edit: { ...insertBase, contentKind: "markup" } }),
    ).toBe('edit.contentKind must be "element" or "text" when provided')
  })
})

describe("edit-handler parity with web route validate()", () => {
  for (const c of VALIDATION_CASES) {
    it(c.name, async () => {
      const r = await applyEdit(
        c.body as EditRequestBody,
        REPO_ROOT,
        stubApplicators,
      )
      expect({ status: r.status, reason: r.reason }).toEqual(c.expect)
    })
  }
})

describe("post-validate guards mirror web route", () => {
  it("PropEdit propName regex", async () => {
    const r = await applyEdit(
      {
        edit: {
          kind: "prop",
          file: "x.vue",
          line: 1,
          column: 1,
          propName: "0bad",
          value: "x",
        },
      } as EditRequestBody,
      REPO_ROOT,
      stubApplicators,
    )
    expect(r.status).toBe(400)
    expect(r.reason).toBe("propName must match /^[A-Za-z_][A-Za-z0-9_-]*$/")
  })

  it("DetachEdit componentName regex", async () => {
    const r = await applyEdit(
      {
        edit: {
          kind: "detach",
          file: "x.vue",
          line: 1,
          column: 1,
          componentFile: "y.vue",
          componentName: "lowercase",
        },
      } as EditRequestBody,
      REPO_ROOT,
      stubApplicators,
    )
    expect(r.status).toBe(400)
    expect(r.reason).toBe("componentName must match /^[A-Z][A-Za-z0-9_]*$/")
  })

  // The identifier regexes moved from the handler into `validateEditRequest`
  // (audit Task 23). The two cases above pin that the refusal STRINGS and the
  // 400 status survived the move; these pin the remaining swap identifiers,
  // which had no coverage before.
  it("SwapEdit fromComponentName regex", async () => {
    const r = await applyEdit(
      {
        edit: {
          kind: "swap",
          file: "x.vue",
          line: 1,
          column: 1,
          fromComponentName: "lowercase",
          toComponentName: "UiButton",
        },
      } as EditRequestBody,
      REPO_ROOT,
      stubApplicators,
    )
    expect(r.status).toBe(400)
    expect(r.reason).toBe("fromComponentName must match /^[A-Z][A-Za-z0-9_]*$/")
  })

  it("SwapEdit toComponentName regex", async () => {
    const r = await applyEdit(
      {
        edit: {
          kind: "swap",
          file: "x.vue",
          line: 1,
          column: 1,
          fromComponentName: "UiButton",
          toComponentName: "0bad",
        },
      } as EditRequestBody,
      REPO_ROOT,
      stubApplicators,
    )
    expect(r.status).toBe(400)
    expect(r.reason).toBe("toComponentName must match /^[A-Z][A-Za-z0-9_]*$/")
  })

  // Shape check for the stale-target stamp on the kinds that gained it in
  // audit Task 23 — the message must match the one prop/move have always
  // returned, since the client can't tell the lanes apart.
  for (const kind of ["delete", "unwrap", "detach", "swap", "flatten-conditional"] as const) {
    it(`${kind}: rejects an empty baseHash with the shared message`, async () => {
      const r = await applyEdit(
        {
          edit: {
            kind,
            file: "x.vue",
            line: 1,
            column: 1,
            baseHash: "",
            // Per-kind required fields so the shape checks pass and the
            // baseHash check is what refuses.
            ...(kind === "detach"
              ? { componentFile: "y.vue", componentName: "UiButton" }
              : {}),
            ...(kind === "swap"
              ? { fromComponentName: "UiButton", toComponentName: "UiCard" }
              : {}),
            ...(kind === "flatten-conditional" ? { branchToKeep: 0 } : {}),
          },
        } as unknown as EditRequestBody,
        REPO_ROOT,
        stubApplicators,
      )
      expect(r.status).toBe(400)
      expect(r.reason).toBe("edit.baseHash must be a non-empty string when provided")
    })
  }
})

/**
 * Agent mini-turn fallback parity tests (WS4,
 * tasks/edit-pipeline-rearchitecture.md). Mirrors `tryPropEditLLMFallback`
 * — when `applyPropEdit` refuses with a `fallback` hint the CLI handler
 * must engage `runEditFixMiniTurn` (the headless SDK mini-turn that
 * replaced the one-shot source-aware LLM prompt) and return
 * `{ ok: true, fallbackUsed: 'agent-mini-turn' }` on a verified success,
 * or a combined deterministic+agent reason on refusal/no-op.
 */
describe("CLI prop-edit agent mini-turn fallback (parity with web route)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-llm-fallback-"))
    // Branch mode is git-native, and the mini-turn refuses to run when the
    // working state can't be snapshotted (its cross-file writes would be
    // unverifiable) — the fixture must be a real repo like every prototype.
    execFileSync("git", ["init", "-q"], { cwd: dir })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir })
    resetSharedEditHistoryForTests()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const ORIGINAL_SOURCE = [
    "<template>",
    "  <UiInput :placeholder=\"filterPlaceholder\" />",
    "</template>",
    "<script setup>",
    "const filterPlaceholder = 'Search...'",
    "</script>",
    "",
  ].join("\n")

  const REWRITTEN_SOURCE = [
    "<template>",
    "  <UiInput :placeholder=\"filterPlaceholder\" />",
    "</template>",
    "<script setup>",
    "const filterPlaceholder = 'Filter results'",
    "</script>",
    "",
  ].join("\n")

  // Structurally broken SFC (mismatched template tag) — @vue/compiler-sfc's
  // parse() flags this with a non-empty `errors` array, which is what the
  // handler's post-mini-turn parse-validation guard checks for.
  const UNPARSEABLE_SOURCE = [
    "<template>",
    "  <UiInput><span>",
    "</template>",
    "<script setup>",
    "const filterPlaceholder = 'Filter results'",
    "</script>",
    "",
  ].join("\n")

  function makeLoaders(overrides: Partial<ApplicatorLoaders> = {}): ApplicatorLoaders {
    return {
      loadApplyPropEdit: async () => ({
        applyPropEdit: () => ({
          ok: false,
          reason: 'Cannot overwrite bound prop "placeholder" — source uses v-bind.',
          fallback: { kind: "bound-binding" as const, expression: "filterPlaceholder" },
        }),
      }),
      loadApplyMoveEdit: async () => ({ applyMoveEdit: () => ({ ok: false, reason: "stub" }) }),
      loadApplyDetachEdit: async () => ({
        applyDetachEdit: () => ({ ok: false, reason: "stub" }),
      }),
      loadStyleGrounding: async () => ({
        loadStyleGrounding: () => ({ tokens: [], classTaxonomy: [], preprocessor: "css" as const }),
      }),
      loadProjectKnowledge: async () => ({
        loadCachedProjectKnowledge: () => ({
          rules: "",
          rulesFiles: [],
          docIndex: [],
          truncated: false,
        }),
        loadProjectKnowledge: () => ({
          rules: "",
          rulesFiles: [],
          docIndex: [],
          truncated: false,
        }),
        __clearProjectKnowledgeCache: () => undefined,
      }),
      loadRunEditFixMiniTurn: async () =>
        ({
          runEditFixMiniTurn: async () => {
            writeFileSync(join(dir, "App.vue"), REWRITTEN_SOURCE)
            return { outcome: "applied", notes: "Rewrote filterPlaceholder binding" }
          },
        }) as unknown as typeof import("../../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
      ...overrides,
    }
  }

  it("writes patched file and returns fallbackUsed:'agent-mini-turn' on verified success", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const result = await applyEdit(body, dir, makeLoaders())

    expect(result.ok).toBe(true)
    expect(result.fallbackUsed).toBe("agent-mini-turn")
    expect(result.notes).toBe("Rewrote filterPlaceholder binding")

    const written = readFileSync(join(dir, "App.vue"), "utf8")
    expect(written).toBe(REWRITTEN_SOURCE)
  })

  // P1-1 follow-up (whole-branch review finding, 2026-08-18): the
  // mini-turn's own `sdk-write-guard.ts` instance records no ledger
  // entry per write (its writes are provisional — see the comment on
  // `tryPropEditLLMFallback`'s consolidated-record block). This is the
  // consolidation point that must produce ONE entry once the fix is
  // verified durable — without it, a mini-turn-fixed edit never showed
  // up in `GET /api/editor/ledger` at all.
  it("records ONE consolidated ledger entry, kind 'prop' lane 'chat', once the mini-turn's fix is verified durable", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const result = await applyEdit(body, dir, makeLoaders())
    expect(result.ok).toBe(true)

    const { readLedger } = await import("../../../../src/editor/ledger/edit-ledger")
    const entries = await readLedger(dir)
    const editEntries = entries.filter((e) => e.type === "edit")
    expect(editEntries).toHaveLength(1)
    const [entry] = editEntries
    expect(entry).toMatchObject({
      kind: "prop",
      lane: "chat",
      files: ["App.vue"],
      fields: { propName: "placeholder", value: "Filter results" },
    })
    expect(entry.type === "edit" && entry.afterHashes).toHaveProperty("App.vue")
  })

  // P2-2 (codex review round 3, 2026-08-20): `applyEdit`'s OWN
  // deterministic-success ledger append (the `brokeredWrite` call
  // earlier in `edit-handler.ts`) has always threaded `correlationId`
  // through. This lane's consolidated append — reached only when the
  // deterministic applicator REFUSES and the mini-turn then succeeds —
  // used to be the one producer that dropped it, so a prop edit that
  // fell back to the mini-turn produced a row the client's own
  // verification record (created against the ORIGINAL edit id before
  // either lane ran) could never join to. Reverting the fix (removing
  // `correlationId: body.correlationId` from the `tryPropEditLLMFallback`
  // call, or `correlationId: args.correlationId` from its ledger append)
  // makes this go red.
  it("threads the request's correlationId onto the consolidated mini-turn ledger entry", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
      correlationId: "client-edit-mini-turn-1",
    }

    const result = await applyEdit(body, dir, makeLoaders())
    expect(result.ok).toBe(true)

    const { readLedger } = await import("../../../../src/editor/ledger/edit-ledger")
    const entries = await readLedger(dir)
    const editEntries = entries.filter((e) => e.type === "edit")
    expect(editEntries).toHaveLength(1)
    expect(editEntries[0]).toMatchObject({
      kind: "prop",
      lane: "chat",
      correlationId: "client-edit-mini-turn-1",
    })
  })

  // P2 (round-7 whole-branch review finding, 2026-08-19): the consolidated
  // ledger entry used to key the mini-turn's OWN target file by
  // `args.file` — the RAW REQUEST spelling — instead of the canonical
  // repo-relative path `repoRelOf` derives from the already-resolved
  // `args.targetPath`. A non-canonical spelling like
  // `../<repo-dirname>/App.vue` still resolves inside the root under a
  // different string (see `repoRelOf`'s doc comment in
  // `edit-handler.ts`), so the request is ACCEPTED, not refused — but
  // that raw string never string-matches `otherChanged`'s own canonical
  // entry for the SAME physical file (git-status-based, always
  // canonical), so the exclusion filter that's supposed to keep the
  // target out of `otherChanged` silently fails, and the ledger records
  // the identical file TWICE: once correctly, once under a spelling that
  // isn't even a valid repo-relative path.
  it("records the target file once, under its canonical repo-relative path, even when the request used a non-canonical spelling", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const nonCanonicalFile = `../${basename(dir)}/App.vue`
    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: nonCanonicalFile,
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const result = await applyEdit(body, dir, makeLoaders())
    expect(result.ok).toBe(true)

    const { readLedger } = await import("../../../../src/editor/ledger/edit-ledger")
    const entries = await readLedger(dir)
    const editEntries = entries.filter((e) => e.type === "edit")
    expect(editEntries).toHaveLength(1)
    const [entry] = editEntries
    // The load-bearing assertion. Before the fix this was
    // `[nonCanonicalFile, "App.vue"]` — the same physical file recorded
    // twice, once under a string that isn't a valid repo-relative path.
    expect(entry.type === "edit" && entry.files).toEqual(["App.vue"])
  })

  // C3 (round-2 whole-branch review finding, 2026-08-19): the backup block
  // in `tryPropEditLLMFallback` really does write the pre-turn original
  // under a generated `.desde/backups/<stamp>-mini-turn/` directory —
  // but the consolidated ledger entry above used to omit `backupDir`
  // entirely, so Plan B's Undo read as unavailable for a mini-turn-fixed
  // edit even though a real, restorable backup existed on disk for it.
  it("carries the mini-turn's real backup directory through to the ledger entry", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const result = await applyEdit(body, dir, makeLoaders())
    expect(result.ok).toBe(true)

    const { readLedger } = await import("../../../../src/editor/ledger/edit-ledger")
    const [entry] = (await readLedger(dir)).filter((e) => e.type === "edit")
    if (entry.type !== "edit") throw new Error("expected an edit entry")
    expect(entry.backupDir).toBeTruthy()
    // Not just present — a real, readable backup of the PRE-turn source.
    const backedUp = readFileSync(join(dir, entry.backupDir!, "App.vue"), "utf8")
    expect(backedUp).toBe(ORIGINAL_SOURCE)
  })

  // P2-1 (codex review round 6, 2026-08-20): the consolidated ledger
  // entry above never stated `createdFiles`, even for an `otherChanged`
  // file the mini-turn wrote as a brand-new, never-before-tracked side
  // effect (`historyFiles`' own `before.exists: false` case, a few lines
  // above where `otherUntracked.has(p)` is checked). Without it, Plan
  // B's Undo planner (`undo-entry.ts`) cannot distinguish "this write
  // created the file" from "this write modified a file with no backup"
  // and refuses as `unbacked` — even though creation is exactly the case
  // the planner can prove safe to delete.
  it("records createdFiles for a brand-new untracked file the mini-turn wrote as a side effect", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const loaders = makeLoaders({
      loadRunEditFixMiniTurn: async () =>
        ({
          runEditFixMiniTurn: async () => {
            writeFileSync(join(dir, "App.vue"), REWRITTEN_SOURCE)
            // Genuinely new: never existed before this turn, never
            // tracked by git.
            writeFileSync(join(dir, "New.ts"), "export const y = 1\n")
            return { outcome: "applied", notes: "Rewrote App.vue and added New.ts" }
          },
        }) as unknown as typeof import("../../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
    })

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const result = await applyEdit(body, dir, loaders)
    expect(result.ok).toBe(true)

    const { readLedger } = await import("../../../../src/editor/ledger/edit-ledger")
    const editEntries = (await readLedger(dir)).filter((e) => e.type === "edit")
    expect(editEntries).toHaveLength(1)
    const [entry] = editEntries
    if (entry.type !== "edit") throw new Error("expected an edit entry")
    expect([...entry.files].sort()).toEqual(["App.vue", "New.ts"])
    // The load-bearing assertion: New.ts is STATED as created, not left
    // for the undo planner to guess about (and refuse) — App.vue is NOT
    // in this list, since it already existed before the turn.
    expect(entry.createdFiles).toEqual(["New.ts"])

    // Confirm this isn't merely a field with no effect: the planner it
    // exists for actually treats the entry as undoable now.
    const { planLedgerUndo } = await import("../../../../src/editor/ledger/undo-entry")
    const { existsSync } = await import("node:fs")
    const plan = await planLedgerUndo(entry, {
      hashFile: async (repoRel) => {
        try {
          return hashContent(readFileSync(join(dir, repoRel)))
        } catch {
          return null
        }
      },
      backupDirExists: async (backupDir) => existsSync(join(dir, backupDir)),
      backupHasFile: async (repoRel, backupDir) => existsSync(join(dir, backupDir, repoRel)),
      readBackup: async (repoRel, backupDir) => readFileSync(join(dir, backupDir, repoRel)),
    })
    expect(plan.ok).toBe(true)
    if (plan.ok) {
      expect(plan.ops).toContainEqual({ kind: "delete", repoRel: "New.ts" })
    }
  })

  // P2-2 (round-3 whole-branch review finding, 2026-08-19): the ledger
  // block above used to derive BOTH its gate (`historyFiles.length > 0`)
  // and its `files`/`afterHashes` from `historyFiles` — the UNDO-eligible
  // subset, which deliberately excludes an `otherChanged` file that was
  // already dirty BEFORE the mini-turn ran (no recoverable "before" to
  // push onto the undo stack for it). When that already-dirty cross-file
  // fix was the ONLY thing the turn changed, `historyFiles` stayed empty
  // and the whole ledger-append block was skipped — no entry at all for
  // a real, durable edit.
  it("still records a ledger entry when the only change is to a file that was ALREADY dirty before the mini-turn ran", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)
    writeFileSync(join(dir, "Other.ts"), "export const x = 1\n")
    execFileSync("git", ["add", "-A"], { cwd: dir })
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"],
      { cwd: dir },
    )
    // Dirty it BEFORE the mini-turn runs — no recoverable "before" once
    // the mini-turn edits it further.
    writeFileSync(join(dir, "Other.ts"), "export const x = 2 // already dirty\n")

    const loaders = makeLoaders({
      loadRunEditFixMiniTurn: async () =>
        ({
          runEditFixMiniTurn: async () => {
            // Leaves App.vue UNTOUCHED — the only durable change this
            // turn makes is to the already-dirty cross-file source.
            writeFileSync(join(dir, "Other.ts"), "export const x = 3 // agent's fix\n")
            return { outcome: "applied", notes: "Fixed Other.ts" }
          },
        }) as unknown as typeof import("../../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
    })

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const result = await applyEdit(body, dir, loaders)
    expect(result.ok).toBe(true)

    const { readLedger } = await import("../../../../src/editor/ledger/edit-ledger")
    const editEntries = (await readLedger(dir)).filter((e) => e.type === "edit")
    expect(editEntries).toHaveLength(1)
    const [entry] = editEntries
    if (entry.type !== "edit") throw new Error("expected an edit entry")
    expect(entry.files).toEqual(["Other.ts"])
    expect(entry.afterHashes).toHaveProperty("Other.ts")
  })

  it("includes an already-dirty cross-file mutation in the ledger entry even when the target ALSO changed", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)
    writeFileSync(join(dir, "Other.ts"), "export const x = 1\n")
    execFileSync("git", ["add", "-A"], { cwd: dir })
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"],
      { cwd: dir },
    )
    writeFileSync(join(dir, "Other.ts"), "export const x = 2 // already dirty\n")

    const loaders = makeLoaders({
      loadRunEditFixMiniTurn: async () =>
        ({
          runEditFixMiniTurn: async () => {
            writeFileSync(join(dir, "App.vue"), REWRITTEN_SOURCE)
            writeFileSync(join(dir, "Other.ts"), "export const x = 3 // agent's fix\n")
            return { outcome: "applied", notes: "Rewrote filterPlaceholder binding" }
          },
        }) as unknown as typeof import("../../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
    })

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const result = await applyEdit(body, dir, loaders)
    expect(result.ok).toBe(true)

    const { readLedger } = await import("../../../../src/editor/ledger/edit-ledger")
    const editEntries = (await readLedger(dir)).filter((e) => e.type === "edit")
    expect(editEntries).toHaveLength(1)
    const [entry] = editEntries
    if (entry.type !== "edit") throw new Error("expected an edit entry")
    // `historyFiles`/`backupDir` only cover App.vue — Other.ts had no
    // recoverable original for undo purposes — but the ledger's `files`
    // must cover BOTH: it records what happened, not what can be undone.
    expect([...entry.files].sort()).toEqual(["App.vue", "Other.ts"])
    expect(entry.afterHashes).toHaveProperty("App.vue")
    expect(entry.afterHashes).toHaveProperty("Other.ts")
    expect(entry.backupDir).toBeTruthy()
    const { existsSync } = await import("node:fs")
    expect(existsSync(join(dir, entry.backupDir!, "App.vue"))).toBe(true)
    // The backup directory genuinely does NOT cover Other.ts — proves
    // the ledger's file coverage isn't just accidentally matching what
    // the backup loop happened to write.
    expect(existsSync(join(dir, entry.backupDir!, "Other.ts"))).toBe(false)
  })

  it("records no ledger entry when the mini-turn refuses (nothing landed)", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const loaders = makeLoaders({
      loadRunEditFixMiniTurn: async () =>
        ({
          runEditFixMiniTurn: async () => ({
            outcome: "refused",
            notes: "The agent could not find a safe rewrite.",
          }),
        }) as unknown as typeof import("../../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
    })

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    await applyEdit(body, dir, loaders)

    const { readLedger } = await import("../../../../src/editor/ledger/edit-ledger")
    const entries = await readLedger(dir)
    expect(entries.filter((e) => e.type === "edit")).toEqual([])
  })

  it("returns combined deterministic+agent reason when the mini-turn refuses", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const loaders = makeLoaders({
      loadRunEditFixMiniTurn: async () =>
        ({
          runEditFixMiniTurn: async () => ({
            outcome: "refused",
            notes: "Agent could not locate the binding definition.",
          }),
        }) as unknown as typeof import("../../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
    })

    const result = await applyEdit(body, dir, loaders)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.reason).toContain('Cannot overwrite bound prop "placeholder"')
    expect(result.reason).toContain("Agent could not locate the binding definition.")
  })

  it("falls through to deterministic 422 when loadRunEditFixMiniTurn loader is absent", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const loaders = makeLoaders({ loadRunEditFixMiniTurn: undefined })

    const result = await applyEdit(body, dir, loaders)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    // Should return just the deterministic reason, not a combined one
    expect(result.reason).toContain('Cannot overwrite bound prop "placeholder"')
  })

  it("returns needsChat:true when the mini-turn refuses AND llmFallback='chat'", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
        llmFallback: "chat",
      },
    }

    const loaders = makeLoaders({
      loadRunEditFixMiniTurn: async () =>
        ({
          runEditFixMiniTurn: async () => ({
            outcome: "refused",
            notes: "Agent could not locate the binding definition.",
          }),
        }) as unknown as typeof import("../../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
    })

    const result = await applyEdit(body, dir, loaders)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.needsChat).toBe(true)
    // Combined reason still surfaces so the chat prompt and any banner
    // share the same context.
    expect(result.reason).toContain('Cannot overwrite bound prop "placeholder"')
    expect(result.reason).toContain("Agent could not locate the binding definition.")
  })

  it("does NOT set needsChat when the mini-turn refuses but llmFallback is absent (legacy)", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const loaders = makeLoaders({
      loadRunEditFixMiniTurn: async () =>
        ({
          runEditFixMiniTurn: async () => ({
            outcome: "refused",
            notes: "Agent could not locate the binding definition.",
          }),
        }) as unknown as typeof import("../../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
    })

    const result = await applyEdit(body, dir, loaders)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.needsChat).toBeUndefined()
  })

  it("returns needsChat:true when the mini-turn loader is absent AND llmFallback='chat'", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
        llmFallback: "chat",
      },
    }

    const loaders = makeLoaders({ loadRunEditFixMiniTurn: undefined })

    const result = await applyEdit(body, dir, loaders)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.needsChat).toBe(true)
    // No agent-turn reason added — just the deterministic refusal.
    expect(result.reason).toContain('Cannot overwrite bound prop "placeholder"')
    expect(result.reason).not.toContain("could not locate")
  })

  it("does NOT engage chat lane when the mini-turn succeeds — file is written and committed", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
        llmFallback: "chat",
      },
    }

    const result = await applyEdit(body, dir, makeLoaders())

    expect(result.ok).toBe(true)
    expect(result.fallbackUsed).toBe("agent-mini-turn")
    expect(result.needsChat).toBeUndefined()
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(REWRITTEN_SOURCE)
  })

  it("escalates a numeric bound-prop refusal directly to chat (skips the text-only mini-turn lane)", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    // applyPropEdit refuses with a bound-binding hint — but the value is
    // a number, not a string. The mini-turn lane in this handler only
    // engages for string prop values; this exercises the chat-mode
    // shortcut for non-string values, which must never reach the loader.
    const miniTurnCalls: number[] = []
    const loaders = makeLoaders({
      loadRunEditFixMiniTurn: async () =>
        ({
          runEditFixMiniTurn: async () => {
            miniTurnCalls.push(1)
            return { outcome: "refused", notes: "should not be called" }
          },
        }) as unknown as typeof import("../../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
    })

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "max",
        value: 42,
        llmFallback: "chat",
      },
    }

    const result = await applyEdit(body, dir, loaders)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.needsChat).toBe(true)
    expect(miniTurnCalls.length).toBe(0)
  })

  it("does NOT escalate a numeric bound-prop refusal when llmFallback is absent (legacy)", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "max",
        value: 42,
      },
    }

    const result = await applyEdit(body, dir, makeLoaders())

    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.needsChat).toBeUndefined()
  })

  it("refuses with 'no file changed' when the mini-turn claims success but writes nothing", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const loaders = makeLoaders({
      loadRunEditFixMiniTurn: async () =>
        ({
          // Claims applied, but never touches the working tree — the
          // handler-level no-op guard must catch this rather than trust
          // the agent's self-report.
          runEditFixMiniTurn: async () => ({
            outcome: "applied",
            notes: "I changed the binding source.",
          }),
        }) as unknown as typeof import("../../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
    })

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const result = await applyEdit(body, dir, loaders)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.reason).toMatch(/no file changed/i)
    // The file is genuinely untouched.
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(ORIGINAL_SOURCE)
  })

  it("refuses with 'unparseable' and restores the original when the mini-turn's edit breaks the SFC", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const loaders = makeLoaders({
      loadRunEditFixMiniTurn: async () =>
        ({
          runEditFixMiniTurn: async () => {
            writeFileSync(join(dir, "App.vue"), UNPARSEABLE_SOURCE)
            return { outcome: "applied", notes: "I changed the binding source." }
          },
        }) as unknown as typeof import("../../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
    })

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const result = await applyEdit(body, dir, loaders)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.reason).toMatch(/unparseable/i)
    // The pre-turn source is restored to disk, not left broken.
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(ORIGINAL_SOURCE)
  })

  // Task 5 review fix (Important 1): the mini-turn's own SDK write guard
  // has `recordHistory: false` — its writes are provisional until every
  // gate here passes. The handler records its OWN consolidated step on
  // verified success, and records NOTHING when a gate above rolls the
  // turn's writes back (`cleanupAllWrites`) — otherwise a guard-recorded
  // step would capture the now-reverted bytes as its "after" and jam
  // `undo` forever.
  it("records one undo step in the shared history on a verified success", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const result = await applyEdit(body, dir, makeLoaders())
    expect(result.ok).toBe(true)

    const state = getSharedEditHistory().state()
    expect(state.canUndo).toBe(true)
    expect(state.undoLabel).toBe("AI edit: App.vue")
    const top = getSharedEditHistory().peek("undo")
    expect(top?.files).toEqual(["App.vue"])
  })

  it("records NOTHING in the shared history when the mini-turn's edit is rolled back (unparseable)", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const loaders = makeLoaders({
      loadRunEditFixMiniTurn: async () =>
        ({
          runEditFixMiniTurn: async () => {
            writeFileSync(join(dir, "App.vue"), UNPARSEABLE_SOURCE)
            return { outcome: "applied", notes: "I changed the binding source." }
          },
        }) as unknown as typeof import("../../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
    })

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const result = await applyEdit(body, dir, loaders)
    expect(result.ok).toBe(false)

    expect(getSharedEditHistory().state()).toMatchObject({ canUndo: false })
  })

  it("records NOTHING when the mini-turn refuses outright (cleanupAllWrites rollback)", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const loaders = makeLoaders({
      loadRunEditFixMiniTurn: async () =>
        ({
          runEditFixMiniTurn: async () => ({
            outcome: "refused",
            notes: "Agent could not locate the binding definition.",
          }),
        }) as unknown as typeof import("../../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
    })

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const result = await applyEdit(body, dir, loaders)
    expect(result.ok).toBe(false)

    expect(getSharedEditHistory().state()).toMatchObject({ canUndo: false })
  })

  // Fix round 2 (review): `git status --porcelain` collapses a brand-new
  // UNTRACKED directory to a single `?? newdir/` entry — that path used to
  // flow straight into the consolidated history step as
  // `{repoRel:'newdir/', before:{exists:false}, after:{exists:false}}`
  // (fs.readFile on a directory throws EISDIR, caught and treated as
  // "absent"). At undo time `edit-history.ts`'s `readState` does NOT
  // tolerate EISDIR (only ENOENT), so `applyTop` would THROW instead of
  // refusing — the step never pops and everything under it on the undo
  // stack becomes unreachable. The fix skips any `otherChanged` entry
  // ending in `/`.
  it("skips an untracked new directory (git status porcelain collapse) — the step has no directory entry and undo does not throw", async () => {
    writeFileSync(join(dir, "App.vue"), ORIGINAL_SOURCE)

    const loaders = makeLoaders({
      loadRunEditFixMiniTurn: async () =>
        ({
          runEditFixMiniTurn: async () => {
            writeFileSync(join(dir, "App.vue"), REWRITTEN_SOURCE)
            // Side effect: a brand-new untracked directory with a file
            // inside. `git status --porcelain` reports this as a single
            // `?? newdir/` entry (the file inside is never individually
            // listed) — the exact porcelain-collapse shape the fix guards.
            mkdirSync(join(dir, "newdir"))
            writeFileSync(join(dir, "newdir", "extra.ts"), "export const x = 1\n")
            return { outcome: "applied", notes: "Rewrote filterPlaceholder binding" }
          },
        }) as unknown as typeof import("../../../../src/editor/agent-chat-sdk/edit-fix-mini-turn"),
    })

    const body: EditRequestBody = {
      edit: {
        kind: "prop",
        file: "App.vue",
        line: 2,
        column: 3,
        propName: "placeholder",
        value: "Filter results",
      },
    }

    const result = await applyEdit(body, dir, loaders)
    expect(result.ok).toBe(true)

    const top = getSharedEditHistory().peek("undo")
    expect(top?.files).toEqual(["App.vue"])
    expect(top?.files.some((f) => f.endsWith("/"))).toBe(false)

    // Undo must not throw — it either applies cleanly or refuses honestly,
    // never an uncaught EISDIR.
    const undoResult = await getSharedEditHistory().undo({ canonicalRoot: dir })
    expect(undoResult.ok).toBe(true)
    expect(readFileSync(join(dir, "App.vue"), "utf8")).toBe(ORIGINAL_SOURCE)
  })
})

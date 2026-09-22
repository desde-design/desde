/**
 * The unique-text edit on the CLI dispatcher, both routes, end to end over
 * a real temp repo.
 *
 * WHY THE KIND EXISTS. On a site whose pages are data (a Webflow export
 * rendering a JSON tree, a translated app, a Markdown content site) a
 * text edit has no `data-desde-src` to splice at, so every one of them
 * reverted and opened a chat session. MEASURED 2026-09-21 on
 * `~/Documents/modesigns`: one such edit took a model turn and about 24
 * seconds to do one grep and one replacement in `content/home.json`.
 *
 * WHAT THESE TESTS PIN, in order of what would hurt most if it broke:
 *   1. a unique match writes the file, and only that file
 *   2. zero and many matches refuse with `needsChat`, so the edit still
 *      reaches chat rather than being silently dropped
 *   3. the write is recorded: a ledger row of kind `unique-text`, its id
 *      handed back, and `newHashes` for the file the SERVER chose
 *   4. the path guards still apply to a file the client never named
 *   5. route 2: the same step as the last rung of the llm-patch text
 *      ladder, for a stamped edit whose bytes live in a data file
 *
 * See `docs/superpowers/specs/2026-09-21-unique-text-edit-design.md`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"
import { validateEditRequest } from "../../../../src/editor/edit-service/validate-edit-request"
import { resetSharedEditHistoryForTests } from "../../../../src/editor/edit-service/edit-history"

/** Counts LLM-lane entries so route 2's tests can prove it was skipped. */
let llmInvocations = 0

/**
 * Test-only hook for the "a second writer lands mid-placement" test below.
 * `null` (the default) makes this module behave exactly like the real
 * `collectSearchFiles` for every OTHER test in this file. When set, it
 * writes `content` to `path` right after the search reads the project's
 * files — simulating another writer's change landing in the gap between
 * the unique-text rung's read and the broker's own write, which is what
 * the rung's write-time precondition (P1, codex review 2026-09-21) exists
 * to catch.
 */
let staleWriteAfterSearch: { path: string; content: string } | null = null

vi.mock("../collect-search-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../collect-search-files.js")>()
  return {
    ...actual,
    collectSearchFiles: async (
      rootReal: string,
      limits?: Parameters<typeof actual.collectSearchFiles>[1],
    ) => {
      const result = await actual.collectSearchFiles(rootReal, limits)
      if (staleWriteAfterSearch && result.ok) {
        writeFileSync(
          join(rootReal, staleWriteAfterSearch.path),
          staleWriteAfterSearch.content,
          "utf8",
        )
      }
      return result
    },
  }
})

const APPLICATORS: ApplicatorLoaders = {
  loadApplyPropEdit: () => import("../../../../src/editor/edit-service/apply-prop-edit"),
  loadApplyMoveEdit: () => import("../../../../src/editor/edit-service/apply-move-edit"),
  loadApplyDetachEdit: () => import("../../../../src/editor/edit-service/apply-detach-edit"),
  loadApplySlotTextEdit: () =>
    import("../../../../src/editor/edit-service/apply-slot-text-edit"),
  loadApplyJsxSlotTextEdit: () =>
    import("../../../../src/editor/edit-service/apply-jsx-slot-text-edit"),
  loadApplyJsxPropEdit: () => import("../../../../src/editor/edit-service/apply-jsx-prop-edit"),
  loadInferAttrFromTextEdit: () =>
    import("../../../../src/editor/edit-service/infer-attr-from-text-edit"),
  loadInferAttrFromJsxTextEdit: () =>
    import("../../../../src/editor/edit-service/infer-attr-from-jsx-text-edit"),
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

function write(root: string, relPath: string, content: string): void {
  const abs = join(root, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, "utf8")
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

function uniqueTextBody(over: Partial<Record<string, unknown>> = {}): EditRequestBody {
  return {
    edit: {
      kind: "unique-text",
      before: "May 2022 - present",
      after: "May 2023 - present",
      selector: ".role .dates",
      page: "/",
      ...over,
    },
  } as EditRequestBody
}

async function readEditEntries(root: string) {
  const { readLedger } = await import("../../../../src/editor/ledger/edit-ledger")
  return (await readLedger(root)).filter((e) => e.type === "edit")
}

describe("unique-text: route 1 (no source stamp)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-unique-text-"))
    llmInvocations = 0
    resetSharedEditHistoryForTests()
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("writes the one file holding the text, and records it", async () => {
    write(dir, "content/home.json", '{"role":{"dates":"May 2022 - present"}}\n')
    write(dir, "content/about.json", '{"role":{"dates":"Jan 2019 - May 2022"}}\n')
    const aboutBefore = readFileSync(join(dir, "content/about.json"), "utf8")

    const result = await applyEdit(
      { ...uniqueTextBody(), correlationId: "client-edit-1" },
      dir,
      APPLICATORS,
    )

    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.file).toBe("content/home.json")

    const written = readFileSync(join(dir, "content/home.json"), "utf8")
    expect(written).toBe('{"role":{"dates":"May 2023 - present"}}\n')
    // Only the matched file moved. A search-driven write that also
    // touched a near-miss would be the worst failure this lane could have.
    expect(readFileSync(join(dir, "content/about.json"), "utf8")).toBe(aboutBefore)

    // `newHashes` is keyed by the file the SERVER chose, since the client
    // had no file to send and cannot key it itself.
    expect(result.newHashes).toEqual({ "content/home.json": sha256Hex(written) })
    expect(result.backupDir).toBeTruthy()
    expect(
      readFileSync(join(dir, result.backupDir!, "content/home.json"), "utf8"),
    ).toBe('{"role":{"dates":"May 2022 - present"}}\n')
  })

  it("records one ledger row of kind unique-text and hands back its id", async () => {
    write(dir, "content/home.json", '{"role":{"dates":"May 2022 - present"}}\n')

    const result = await applyEdit(
      { ...uniqueTextBody(), correlationId: "client-edit-1" },
      dir,
      APPLICATORS,
    )
    expect(result.ok).toBe(true)
    expect(result.ledgerEntryId).toBeTruthy()

    const entries = await readEditEntries(dir)
    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry).toMatchObject({
      id: result.ledgerEntryId,
      kind: "unique-text",
      lane: "direct",
      files: ["content/home.json"],
      correlationId: "client-edit-1",
      fields: {
        file: "content/home.json",
        before: "May 2022 - present",
        after: "May 2023 - present",
        selector: ".role .dates",
        page: "/",
      },
    })
  })

  it("describes the row by the file the search found the text in", async () => {
    write(dir, "content/home.json", '{"role":{"dates":"May 2022 - present"}}\n')
    await applyEdit(uniqueTextBody(), dir, APPLICATORS)

    const [entry] = await readEditEntries(dir)
    if (entry.type !== "edit") throw new Error("expected an edit entry")
    const { describeLedgerEntry } = await import(
      "../../../../src/editor/ledger/describe-entry"
    )
    expect(describeLedgerEntry(entry)).toBe("Changed text in home.json")
  })

  it("refuses with needsChat when no file contains the text", async () => {
    write(dir, "content/home.json", '{"role":{"dates":"Something else"}}\n')
    const before = readFileSync(join(dir, "content/home.json"), "utf8")

    const result = await applyEdit(uniqueTextBody(), dir, APPLICATORS)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.needsChat).toBe(true)
    expect(result.reason).toBe("That text was not found in any of the project's files.")
    expect(readFileSync(join(dir, "content/home.json"), "utf8")).toBe(before)
    expect(await readEditEntries(dir)).toEqual([])
  })

  it("refuses with needsChat, and names the files, when the text appears more than once", async () => {
    write(dir, "content/home.json", '{"role":{"dates":"May 2022 - present"}}\n')
    write(dir, "content/about.json", '{"role":{"dates":"May 2022 - present"}}\n')

    const result = await applyEdit(uniqueTextBody(), dir, APPLICATORS)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.needsChat).toBe(true)
    expect(result.reason).toBe(
      "The text appears 2 times in the project (content/about.json, content/home.json).",
    )
    // Neither file moved.
    expect(readFileSync(join(dir, "content/home.json"), "utf8")).toContain("May 2022")
    expect(readFileSync(join(dir, "content/about.json"), "utf8")).toContain("May 2022")
  })

  it("refuses to write through a symlink, even when the link holds the only match", async () => {
    // `collectSearchFiles` never follows a symlink, so the step should not
    // name one in the first place. This proves the OUTCOME the user cares
    // about rather than the mechanism: the file outside the repo is
    // byte-identical afterwards, and nothing was recorded.
    const outside = mkdtempSync(join(tmpdir(), "editor-unique-text-outside-"))
    try {
      const outsideFile = join(outside, "secret.json")
      const outsideContent = '{"role":{"dates":"May 2022 - present"}}\n'
      writeFileSync(outsideFile, outsideContent, "utf8")
      symlinkSync(outsideFile, join(dir, "linked.json"))

      const result = await applyEdit(uniqueTextBody(), dir, APPLICATORS)

      expect(result.ok).toBe(false)
      expect(result.needsChat).toBe(true)
      expect(readFileSync(outsideFile, "utf8")).toBe(outsideContent)
      expect(await readEditEntries(dir)).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("finds the text in a Markdown paragraph as readily as in JSON", async () => {
    write(dir, "content/post.md", "# Title\n\nThe old paragraph.\n")

    const result = await applyEdit(
      uniqueTextBody({ before: "The old paragraph.", after: "The new paragraph." }),
      dir,
      APPLICATORS,
    )

    expect(result.ok).toBe(true)
    expect(result.file).toBe("content/post.md")
    expect(readFileSync(join(dir, "content/post.md"), "utf8")).toBe(
      "# Title\n\nThe new paragraph.\n",
    )
  })
})

describe("unique-text: request validation", () => {
  // The parity suite pins the validator's error-string contract; these are
  // this kind's own strings.
  it("accepts a well-formed body", () => {
    expect(validateEditRequest(uniqueTextBody())).toBeNull()
  })

  it("names unique-text in the unknown-kind message", () => {
    expect(validateEditRequest({ edit: { kind: "wat" } })).toContain('"unique-text"')
  })

  it("refuses a whitespace-only before", () => {
    expect(validateEditRequest(uniqueTextBody({ before: "   " }))).toBe(
      "edit.before must not be empty or only whitespace",
    )
  })

  it("refuses an after identical to before", () => {
    expect(validateEditRequest(uniqueTextBody({ after: "May 2022 - present" }))).toBe(
      "edit.after must differ from edit.before",
    )
  })

  it("refuses a non-string before", () => {
    expect(validateEditRequest(uniqueTextBody({ before: 42 }))).toBe(
      "edit.before must be a string",
    )
  })

  it("refuses text past the size cap", () => {
    expect(validateEditRequest(uniqueTextBody({ after: "x".repeat(10_001) }))).toBe(
      "edit.before and edit.after must each be at most 10000 characters",
    )
  })

  it("refuses a missing selector or page", () => {
    expect(validateEditRequest(uniqueTextBody({ selector: "" }))).toBe("edit.selector required")
    expect(validateEditRequest(uniqueTextBody({ page: undefined }))).toBe("edit.page required")
  })

  it("returns the validator's message, as a 400, through the dispatcher", async () => {
    const dir = mkdtempSync(join(tmpdir(), "editor-unique-text-validate-"))
    try {
      const result = await applyEdit(uniqueTextBody({ before: "   " }), dir, APPLICATORS)
      expect(result.status).toBe(400)
      expect(result.reason).toBe("edit.before must not be empty or only whitespace")
      // A 400 is a shape error, not an ambiguity: it must NOT be handed to
      // chat, which could do nothing useful with a malformed request.
      expect(result.needsChat).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * Route 2: the element IS stamped, but the bytes it renders are at
 * neither the stamp nor the consumer callsite. The canonical shape is a
 * translated app: the stamp names a `t("key")` call and the English
 * string lives in `messages/en.json`, which no `data-desde-src` will ever
 * point at.
 */
describe("unique-text: route 2 (the last rung of the llm-patch text ladder)", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-unique-text-route2-"))
    llmInvocations = 0
    staleWriteAfterSearch = null
    resetSharedEditHistoryForTests()
  })

  afterEach(() => {
    staleWriteAfterSearch = null
    rmSync(dir, { recursive: true, force: true })
  })

  const PAGE_TSX = [
    'import { useTranslations } from "next-intl"',
    "export default function Page() {",
    "  const t = useTranslations()",
    "  return (",
    '    <h1 className="title">{t("home.heading")}</h1>',
    "  )",
    "}",
    "",
  ].join("\n")
  // `<h1` is line 5, column 4 (Babel: 1-based line, 0-based column).

  function translationMutation(over: Record<string, unknown> = {}): EditRequestBody {
    return {
      edit: {
        kind: "llm-patch",
        llmFallback: "chat",
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "app/page.tsx:5:4",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".title",
            before: "Welcome to the shop",
            after: "Welcome to the store",
            ...over,
          },
        ],
      },
    } as EditRequestBody
  }

  it("writes the translation file the stamp could never name", async () => {
    write(dir, "app/page.tsx", PAGE_TSX)
    write(dir, "messages/en.json", '{"home":{"heading":"Welcome to the shop"}}\n')

    const result = await applyEdit(translationMutation(), dir, APPLICATORS)

    expect(result.ok).toBe(true)
    expect(result.needsChat).toBeUndefined()
    expect(llmInvocations).toBe(0)
    expect(readFileSync(join(dir, "messages/en.json"), "utf8")).toBe(
      '{"home":{"heading":"Welcome to the store"}}\n',
    )
    // The stamped component is not where the bytes were, so it must be
    // untouched.
    expect(readFileSync(join(dir, "app/page.tsx"), "utf8")).toBe(PAGE_TSX)
  })

  it("carries the JSON file through hashes, the journal and the ledger", async () => {
    write(dir, "app/page.tsx", PAGE_TSX)
    const original = '{"home":{"heading":"Welcome to the shop"}}\n'
    write(dir, "messages/en.json", original)

    const result = await applyEdit(translationMutation(), dir, APPLICATORS)
    expect(result.ok).toBe(true)

    const written = readFileSync(join(dir, "messages/en.json"), "utf8")
    expect(result.newHashes?.["messages/en.json"]).toBe(sha256Hex(written))
    // Undo needs the pre-write bytes of a file the batch only learned
    // about mid-ladder.
    expect(
      readFileSync(join(dir, result.backupDir!, "messages/en.json"), "utf8"),
    ).toBe(original)

    const entries = await readEditEntries(dir)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      kind: "llm-patch",
      lane: "direct",
      // How the edit was LOCATED. Without it an Activity row reads as an
      // ordinary coordinate splice.
      fields: { mutationCount: 1, placedBy: "unique-text" },
    })
    expect(entries[0].type === "edit" && entries[0].files).toContain("messages/en.json")

    // This route has no page-verification of its own (unlike route 1's
    // client-side text lane), so the client needs both of these to undo
    // the row if the designer later notices the page never took the
    // change: the ledger row's id, and which file that row is about.
    expect(result.ledgerEntryId).toBeTruthy()
    expect(result.ledgerEntryId).toBe(entries[0].id)
    expect(result.uniqueTextFile).toBe("messages/en.json")
  })

  it("does NOT run the Vue SFC parser over the JSON it is about to write", async () => {
    // The pre-write validator used to parse everything that was not
    // .tsx/.jsx with `@vue/compiler-sfc`, which reports "At least one
    // <template> or <script> is required" for any non-SFC. A JSON file
    // going through it would 422 a perfectly good edit, the same shape as
    // the 2026-09-17 DOM-mutation-lane bug. A successful write is the
    // proof; a regression here shows up as a 422 naming "SFC parse".
    write(dir, "app/page.tsx", PAGE_TSX)
    write(dir, "messages/en.json", '{"home":{"heading":"Welcome to the shop"}}\n')

    const result = await applyEdit(translationMutation(), dir, APPLICATORS)

    expect(result.ok).toBe(true)
    expect(result.reason ?? "").not.toMatch(/SFC parse/)
  })

  it("hands the edit to chat when a second locale carries the same English string", async () => {
    write(dir, "app/page.tsx", PAGE_TSX)
    write(dir, "messages/en.json", '{"home":{"heading":"Welcome to the shop"}}\n')
    // A locale file that has not been translated yet still holds the
    // English source string. Two matches, so the step must not guess.
    write(dir, "messages/fr.json", '{"home":{"heading":"Welcome to the shop"}}\n')

    const result = await applyEdit(translationMutation(), dir, APPLICATORS)

    expect(result.ok).toBe(false)
    expect(result.status).toBe(422)
    expect(result.needsChat).toBe(true)
    expect(llmInvocations).toBe(0)
    expect(readFileSync(join(dir, "messages/en.json"), "utf8")).toContain("the shop")
    expect(readFileSync(join(dir, "messages/fr.json"), "utf8")).toContain("the shop")
    // P3 (codex review, 2026-09-21): the step's own reason for giving up —
    // not just the generic "going to chat" sentence — reaches the client,
    // since the client reads `reason` for the hand-off prompt.
    expect(result.reason).toBe(
      "This edit needs interpretation, so it is going to the chat agent. " +
        "The text appears 2 times in the project (messages/en.json, messages/fr.json).",
    )
  })

  it("never pre-empts a coordinate that still works", async () => {
    // The stamp holds the text itself AND the same string sits alone in a
    // JSON file. The coordinate rung must win, or a working deterministic
    // splice would start being decided by a project-wide search.
    write(
      dir,
      "app/page.tsx",
      ['export default function Page() {', '  return <h1 className="title">Welcome to the shop</h1>', "}", ""].join("\n"),
    )
    const json = '{"unused":"Welcome to the shop"}\n'
    write(dir, "messages/en.json", json)

    const result = await applyEdit(
      translationMutation({ sourceLoc: "app/page.tsx:2:9" }),
      dir,
      APPLICATORS,
    )

    expect(result.ok).toBe(true)
    expect(readFileSync(join(dir, "app/page.tsx"), "utf8")).toContain(
      "Welcome to the store",
    )
    expect(readFileSync(join(dir, "messages/en.json"), "utf8")).toBe(json)
  })

  it("hands the batch to chat rather than splice twice into one file", async () => {
    // Both mutations fall to this rung and both resolve to `en.json`. The
    // step's byte offsets come from the file ON DISK, which the first
    // splice has already moved past, so applying the second at them could
    // land anywhere. The batch refuses instead, and nothing is written.
    write(
      dir,
      "app/page.tsx",
      [
        "export default function Page() {",
        "  return (",
        "    <>",
        '      <h1 className="title">{t("home.heading")}</h1>',
        '      <p className="sub">{t("home.sub")}</p>',
        "    </>",
        "  )",
        "}",
        "",
      ].join("\n"),
    )
    const original = '{"home":{"heading":"Welcome to the shop","sub":"Open every day"}}\n'
    write(dir, "messages/en.json", original)

    const body: EditRequestBody = {
      edit: {
        kind: "llm-patch",
        llmFallback: "chat",
        mutations: [
          {
            id: "m-1", kind: "text", sourceLoc: "app/page.tsx:4:6", resolutionKind: "direct",
            scope: "definition", callsiteLoc: null, instancePath: "[0]",
            selector: ".title", before: "Welcome to the shop", after: "Welcome to the store",
          },
          {
            id: "m-2", kind: "text", sourceLoc: "app/page.tsx:5:6", resolutionKind: "direct",
            scope: "definition", callsiteLoc: null, instancePath: "[0]",
            selector: ".sub", before: "Open every day", after: "Open on weekdays",
          },
        ],
      },
    } as EditRequestBody

    const result = await applyEdit(body, dir, APPLICATORS)

    expect(result.ok).toBe(false)
    expect(result.needsChat).toBe(true)
    expect(readFileSync(join(dir, "messages/en.json"), "utf8")).toBe(original)
  })

  it("never runs on an empty needle", async () => {
    write(dir, "app/page.tsx", PAGE_TSX)
    write(dir, "messages/en.json", '{"home":{"heading":"Welcome to the shop"}}\n')
    const original = readFileSync(join(dir, "messages/en.json"), "utf8")

    const result = await applyEdit(
      translationMutation({ before: "   ", after: "Something" }),
      dir,
      APPLICATORS,
    )

    expect(result.ok).toBe(false)
    expect(result.needsChat).toBe(true)
    expect(readFileSync(join(dir, "messages/en.json"), "utf8")).toBe(original)
  })

  /**
   * P1 (codex review, 2026-09-21): route 2 has no page-verification of its
   * own. Route 1's write is checked against the rendered page by the
   * client's text lane and can be undone through the ledger, but a batch
   * running in `'patch'` mode (the save-time AI queue) has neither, so a
   * wrong file placed there would stay wrong with nothing to catch it. The
   * rung must therefore run ONLY in `'chat'` mode; every other mode falls
   * to the LLM lane exactly as it did before this rung existed.
   */
  /** Same mutation `translationMutation()` builds, but with `edit.llmFallback` overridable. */
  function translationBody(llmFallback?: "patch" | "chat"): EditRequestBody {
    return {
      edit: {
        kind: "llm-patch",
        ...(llmFallback ? { llmFallback } : {}),
        mutations: [
          {
            id: "m-1",
            kind: "text",
            sourceLoc: "app/page.tsx:5:4",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: ".title",
            before: "Welcome to the shop",
            after: "Welcome to the store",
          },
        ],
      },
    } as EditRequestBody
  }

  it("does not run in 'patch' mode: the batch falls through to the LLM lane instead", async () => {
    write(dir, "app/page.tsx", PAGE_TSX)
    const original = '{"home":{"heading":"Welcome to the shop"}}\n'
    write(dir, "messages/en.json", original)

    const result = await applyEdit(translationBody("patch"), dir, APPLICATORS)

    // The fake LLM lane (`APPLICATORS.loadApplyLLMPatch`) was reached — the
    // proof that the rung did NOT place the edit itself. It returns an
    // empty patch, which reads as a no-op refusal rather than a silent
    // file write.
    expect(llmInvocations).toBe(1)
    expect(result.ok).toBe(false)
    expect(result.needsChat).toBeUndefined()
    expect(readFileSync(join(dir, "messages/en.json"), "utf8")).toBe(original)
    expect(readFileSync(join(dir, "app/page.tsx"), "utf8")).toBe(PAGE_TSX)
  })

  it("does not run when llmFallback is absent either: same LLM-lane fall-through", async () => {
    write(dir, "app/page.tsx", PAGE_TSX)
    const original = '{"home":{"heading":"Welcome to the shop"}}\n'
    write(dir, "messages/en.json", original)

    const result = await applyEdit(translationBody(undefined), dir, APPLICATORS)

    expect(llmInvocations).toBe(1)
    expect(result.ok).toBe(false)
    expect(readFileSync(join(dir, "messages/en.json"), "utf8")).toBe(original)
  })

  /**
   * P1 (codex review, 2026-09-21): the rung reads its target file OUTSIDE
   * this call's locks, as its own search pass rather than through the
   * coordinate-matched `baseHashes`/`data-desde-v` checks earlier in
   * `handleLLMPatch`. Without a write-time precondition, a second writer
   * landing in that gap would have its change silently discarded by a
   * patch computed from the now-stale bytes the rung read — and the
   * backup journal would record THAT stale content as the "original",
   * losing the second writer's change for good.
   */
  it("refuses when the file changes after the search, and writes nothing", async () => {
    write(dir, "app/page.tsx", PAGE_TSX)
    write(dir, "messages/en.json", '{"home":{"heading":"Welcome to the shop"}}\n')

    const staleContent = '{"home":{"heading":"Someone else already changed this"}}\n'
    staleWriteAfterSearch = { path: "messages/en.json", content: staleContent }

    const result = await applyEdit(translationMutation(), dir, APPLICATORS)

    expect(result.ok).toBe(false)
    expect(result.needsChat).toBe(true)
    expect(result.reason).toMatch(/messages\/en\.json changed while this edit was being placed/)
    // The other writer's change survives untouched — not overwritten by
    // the rung's patch, and not reverted back to the pre-rung text either.
    expect(readFileSync(join(dir, "messages/en.json"), "utf8")).toBe(staleContent)
    // Nothing was recorded: no ledger row, and no backup directory left
    // holding either the stale bytes or the original ones (`brokeredWrite`
    // discards the journal it wrote before taking its locks once a
    // precondition misses).
    expect(await readEditEntries(dir)).toEqual([])
    let backupEntries: string[] = []
    try {
      backupEntries = readdirSync(join(dir, ".desde", "backups"))
    } catch {
      backupEntries = []
    }
    expect(backupEntries).toEqual([])
  })
})

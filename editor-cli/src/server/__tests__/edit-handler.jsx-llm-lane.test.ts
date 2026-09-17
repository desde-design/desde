/**
 * The llm-patch LLM lane on React source — the fallback the deterministic JSX
 * applicators defer to.
 *
 * Reported 2026-09-17: editing a logo's text in a React prototype failed with
 * "Mutation dom-mut-1 targets non-.vue file 'src/components/AppHeader.tsx';
 * V1 only patches Vue SFCs." The deterministic applicator had refused
 * correctly — the `<button>` holds an icon `<span>` AND the label text, which
 * is the applicator's documented "deferring to the LLM lane" case — and the
 * LLM lane then refused the file for not being a Vue SFC. The identical shape
 * in a `.vue` recovered, so React had a hole Vue did not.
 *
 * Two Vue-only blockers were stacked here, and the reported error was only the
 * first. Behind it, the lane's pre-write validator parsed every patched file
 * with `@vue/compiler-sfc`, which rejects a valid React module outright — so
 * lifting the refusal alone would have turned the save failure into a 422 on
 * every successful React patch.
 *
 * These tests cover the handler's half of closing both: the mixed-children
 * shape reaches the lane, a valid `.tsx` patch is written, and a patch that
 * genuinely doesn't parse as JSX is refused before anything touches disk.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { applyEdit, type ApplicatorLoaders, type EditRequestBody } from "../edit-handler.js"

type PatchModule = typeof import("../../../../src/editor/edit-service/apply-llm-patch")

/** Files the fake LLM was handed, so a test can assert the lane was reached. */
let seenFiles: string[] = []

/**
 * Loaders whose LLM lane returns `patchedFiles` built by `patch` from the
 * sources the handler read. The deterministic applicators are the real ones,
 * so a test that reaches the lane reached it for a real refusal.
 */
function loadersWithPatch(
  patch: (files: ReadonlyMap<string, string>) => Map<string, string>,
): ApplicatorLoaders {
  return {
    loadApplyPropEdit: () => import("../../../../src/editor/edit-service/apply-prop-edit"),
    loadApplyMoveEdit: () => import("../../../../src/editor/edit-service/apply-move-edit"),
    loadApplyDetachEdit: () => import("../../../../src/editor/edit-service/apply-detach-edit"),
    loadApplySlotTextEdit: () =>
      import("../../../../src/editor/edit-service/apply-slot-text-edit"),
    loadApplyJsxSlotTextEdit: () =>
      import("../../../../src/editor/edit-service/apply-jsx-slot-text-edit"),
    loadApplyJsxPropEdit: () =>
      import("../../../../src/editor/edit-service/apply-jsx-prop-edit"),
    loadInferAttrFromTextEdit: () =>
      import("../../../../src/editor/edit-service/infer-attr-from-text-edit"),
    loadInferAttrFromJsxTextEdit: () =>
      import("../../../../src/editor/edit-service/infer-attr-from-jsx-text-edit"),
    loadApplyLLMPatch: async () =>
      ({
        applyLLMPatch: (async (input: { files: ReadonlyMap<string, string> }) => {
          seenFiles = [...input.files.keys()]
          return {
            ok: true,
            patchedFiles: patch(input.files),
            perMutationOutcomes: [],
          }
        }) as unknown as PatchModule["applyLLMPatch"],
        parseSourceLocFile: () => null,
        isCrossFileInstanceEdit: () => false,
        patchFileFor: () => ({ ok: false, reason: "stub" }),
      }) as PatchModule,
    loadStyleGrounding: async () => ({
      loadStyleGrounding: () => ({
        tokens: [],
        classTaxonomy: [],
        preprocessor: "css" as const,
      }),
    }),
  }
}

/** The reported shape: an icon element and the label text as siblings. */
const APP_HEADER_TSX = `export function AppHeader() {
  return (
    <header className="bar">
      <button type="button" className="brand">
        <span className="dot" aria-hidden />
        Sooth
      </button>
    </header>
  )
}
`
// <button> opening tag: line 4, indented 6 → column 6.

/** One text mutation, parameterized on the file it targets. */
function bundleFor(sourceLoc: string): EditRequestBody {
  return {
    edit: {
      kind: "llm-patch",
      mutations: [
        {
          id: "dom-mut-1",
          kind: "text",
          sourceLoc,
          resolutionKind: "direct",
          scope: "definition",
          callsiteLoc: null,
          instancePath: "[0]",
          selector: ".brand",
          before: "Sooth",
          after: "Sayer",
        },
      ],
    },
  }
}

const MUTATION = bundleFor("src/components/AppHeader.tsx:4:6")

describe("llm-patch LLM lane — React source", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-jsx-llm-lane-"))
    seenFiles = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function writeHeader() {
    const nested = join(dir, "src", "components")
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, "AppHeader.tsx"), APP_HEADER_TSX)
  }

  it("reaches the LLM lane for a mixed-children text edit and writes the .tsx", async () => {
    writeHeader()
    const result = await applyEdit(
      MUTATION,
      dir,
      loadersWithPatch((files) => {
        const file = "src/components/AppHeader.tsx"
        return new Map([[file, files.get(file)!.replace("Sooth", "Sayer")]])
      }),
    )

    expect(result.ok).toBe(true)
    // The lane was reached at all — this is the refusal the bug report showed.
    expect(seenFiles).toEqual(["src/components/AppHeader.tsx"])
    const written = readFileSync(join(dir, "src", "components", "AppHeader.tsx"), "utf8")
    expect(written).toContain("Sayer")
    expect(written).not.toContain("Sooth")
    // Everything the mutation didn't name survives byte-for-byte.
    expect(written).toContain('<span className="dot" aria-hidden />')
  })

  it("refuses a patch that does not parse as JSX, before writing anything", async () => {
    writeHeader()
    const result = await applyEdit(
      MUTATION,
      dir,
      loadersWithPatch(
        () =>
          new Map([
            // Unbalanced JSX. The old validator ran `@vue/compiler-sfc` over
            // every patched file, which is not a weaker gate on a `.tsx` — it
            // is the WRONG one in both directions. MEASURED: it reports "At
            // least one <template> or <script> is required" for a perfectly
            // valid React module, so it would have 422'd every correct React
            // patch, and its complaint about broken JSX is that same generic
            // error rather than anything about the syntax. The deterministic
            // fast-path already skipped JSX for exactly this reason; the LLM
            // lane never got the same treatment.
            ["src/components/AppHeader.tsx", "export const A = () => <div><span></div>;"],
          ]),
      ),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(422)
      expect(result.reason).toMatch(/JSX parse/)
    }
    // The original is untouched.
    const onDisk = readFileSync(join(dir, "src", "components", "AppHeader.tsx"), "utf8")
    expect(onDisk).toBe(APP_HEADER_TSX)
  })

  // Codex review 2026-09-17, P1: a syntax parse accepts valid-but-wrong output.
  // The designer typed the characters "Sayer {n}"; emitting them raw makes a
  // live expression container, so the label binds to a variable instead.
  it("refuses a patch that turns the designer's text into a live expression", async () => {
    writeHeader()
    const result = await applyEdit(
      MUTATION,
      dir,
      loadersWithPatch((files) => {
        const file = "src/components/AppHeader.tsx"
        return new Map([[file, files.get(file)!.replace("Sooth", "Sayer {n}")]])
      }),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(422)
      expect(result.reason).toMatch(/new dynamic binding/)
    }
    // Nothing was written.
    const onDisk = readFileSync(join(dir, "src", "components", "AppHeader.tsx"), "utf8")
    expect(onDisk).toBe(APP_HEADER_TSX)
  })

  it("accepts the same text properly escaped", async () => {
    writeHeader()
    const result = await applyEdit(
      MUTATION,
      dir,
      loadersWithPatch((files) => {
        const file = "src/components/AppHeader.tsx"
        return new Map([[file, files.get(file)!.replace("Sooth", "Sayer &#123;n&#125;")]])
      }),
    )
    expect(result.ok).toBe(true)
    const written = readFileSync(join(dir, "src", "components", "AppHeader.tsx"), "utf8")
    expect(written).toContain("Sayer &#123;n&#125;")
  })

  // Codex review 2026-09-17, P2: a uniform `["jsx","typescript"]` gate accepted
  // a `.jsx` carrying type annotations that the project's own loader rejects.
  // The repo convention is explicit in jsx-source-tag-plugin.ts.
  it("refuses TypeScript syntax in a .jsx patch, matching the project's loader", async () => {
    mkdirSync(join(dir, "src", "components"), { recursive: true })
    writeFileSync(join(dir, "src", "components", "Plain.jsx"), "export const P = () => <b>Sooth</b>;\n")
    const result = await applyEdit(
      bundleFor("src/components/Plain.jsx:1:24"),
      dir,
      loadersWithPatch(
        () =>
          new Map([
            ["src/components/Plain.jsx", 'const label: string = "Sayer";\nexport const P = () => <b>{label}</b>;\n'],
          ]),
      ),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(422)
      expect(result.reason).toMatch(/JSX parse/)
    }
  })

  // Codex review 2026-09-17, P2: parseSfc alone reports ZERO errors on a
  // template compiler-dom refuses, so the gate wrote files Vite then rejected.
  it("refuses a .vue patch that parses but cannot compile", async () => {
    writeFileSync(join(dir, "Orphan.vue"), "<template><div>Sooth</div></template>\n")
    const result = await applyEdit(
      bundleFor("Orphan.vue:1:10"),
      dir,
      loadersWithPatch(
        () => new Map([["Orphan.vue", "<template><div v-else>Sayer</div></template>\n"]]),
      ),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(422)
      expect(result.reason).toMatch(/SFC parse/)
    }
  })

  it("still validates a .vue patch with the SFC parser", async () => {
    writeFileSync(join(dir, "Card.vue"), "<template><h1>Sooth</h1></template>\n")
    const result = await applyEdit(
      bundleFor("Card.vue:1:10"),
      dir,
      loadersWithPatch(() => new Map([["Card.vue", "<template><h1>Sayer</h1>\n"]])),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(422)
      expect(result.reason).toMatch(/SFC parse/)
    }
  })
})

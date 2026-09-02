/**
 * Tests for `recordManifestValueMismatchDrift` — the server-side wiring
 * for the `manifest-value-mismatch` drift signal (Phase 5 carry-forward
 * (g)). Exercises the real `resolveTemplateTarget` + a real filesystem
 * temp file (so the tag-resolution step is genuinely proven), with a
 * stubbed `GroundingLoaders` standing in for the real grounding pipeline —
 * same pattern `grounding-context.test.ts` uses.
 */
import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createDriftLog, type ComponentManifest, type GroundingService } from "../../../../src/editor/core"
import { resetGroundingCache, type GroundingLoaders } from "../grounding-context.js"
import { recordManifestValueMismatchDrift } from "../manifest-value-mismatch-drift.js"
import type { PropEditBody } from "../../../../src/editor/edit-service/validate-edit-request.js"
import type { RepairDeps } from "../../../../src/editor/drift/repair-component.js"
import { createRepairQueue } from "../repair-queue.js"
import { createPendingInvalidationQueue } from "../pending-invalidation-queue.js"

const SFC_SOURCE = [
  "<template>",
  "  <div>",
  '    <UiButton appearance="ghost">Click</UiButton>',
  "  </div>",
  "</template>",
].join("\n")

// SFC-absolute (line, column) of `<UiButton`'s opening `<` in SFC_SOURCE
// above — line 3, 4 leading spaces, so column 5 (1-based).
const KBUTTON_LINE = 3
const KBUTTON_COLUMN = 5

function trustedButtonManifest(): ComponentManifest {
  return {
    id: "acme-ds.ui-button",
    name: "UiButton",
    framework: "vue3",
    designSystem: "acme-ds",
    importPath: "@acme/design-system",
    props: [
      {
        name: "appearance",
        type: "string",
        required: false,
        control: {
          kind: "finite-choice",
          options: [
            { label: "primary", value: "primary" },
            { label: "secondary", value: "secondary" },
          ],
        },
      },
    ],
    rendering: [
      {
        kind: "dom",
        source: { kind: "slot", name: "default" },
        domTarget: { selector: ":root", field: "textContent" },
        editability: "literal",
      },
    ],
  }
}

function loadersFor(getComponent: (name: string) => Promise<ComponentManifest | null>): GroundingLoaders {
  const service: GroundingService = {
    getManifestSource: async () => ({
      id: "fake",
      framework: "vue3",
      designSystem: "acme-ds",
      listComponents: async () => [],
      getComponent,
    }),
    tokens: {
      id: "fake",
      designSystem: "acme-ds",
      listTokens: async () => [],
      getToken: async () => null,
    },
    getProjectKnowledge: () => ({ rules: "", rulesFiles: [], docIndex: [], truncated: false }),
    getGroundingHealth: async () => null,
  }
  return {
    loadCreateGroundingService: async () =>
      ({ createGroundingService: () => service }) as unknown as Awaited<
        ReturnType<GroundingLoaders["loadCreateGroundingService"]>
      >,
  }
}

/**
 * A `GroundingLoaders` stub whose manifest source implements
 * `getComponentCandidates` (composite-only in production) — needed to
 * exercise the same-name-across-sources disambiguation in
 * `resolveManifestForName` (codex P2 fix, 2026-07-30). `getComponent`
 * mirrors `CompositeManifestSource`'s own first-candidate-wins default so a
 * test that doesn't care about disambiguation still gets sane behavior.
 */
function loadersWithCandidates(candidatesByName: Record<string, ComponentManifest[]>): GroundingLoaders {
  const service: GroundingService = {
    getManifestSource: async () => ({
      id: "fake-composite",
      framework: "vue3",
      designSystem: "acme-ds",
      listComponents: async () => [],
      getComponent: async (name) => candidatesByName[name]?.[0] ?? null,
      getComponentCandidates: async (name) => candidatesByName[name] ?? [],
    }),
    tokens: {
      id: "fake",
      designSystem: "acme-ds",
      listTokens: async () => [],
      getToken: async () => null,
    },
    getProjectKnowledge: () => ({ rules: "", rulesFiles: [], docIndex: [], truncated: false }),
    getGroundingHealth: async () => null,
  }
  return {
    loadCreateGroundingService: async () =>
      ({ createGroundingService: () => service }) as unknown as Awaited<
        ReturnType<GroundingLoaders["loadCreateGroundingService"]>
      >,
  }
}

/** Two design-system packages that both export a `UiButton` with the same
 *  `appearance` finite-choice prop but different `importPath` — the
 *  same-name collision `resolveManifestForName` must disambiguate. */
function buttonManifestFrom(importPath: string): ComponentManifest {
  return buttonManifestFor(importPath, "acme-ds")
}

/**
 * Same as `buttonManifestFrom`, but the caller also picks `designSystem` —
 * needed for the "duplicate importPath" case: the registry legitimately
 * allows two candidates to share an `importPath` while differing in
 * `designSystem`/`dtsRoots` (`buildRegisteredSources` keys each by its own
 * `registeredCacheName()`), so `id` alone can't be assumed unique either.
 * `sourceId` overrides only `id` — for the "redundant coverage" shape (real
 * `UiAlert`/`UiButton`/`UiBadge`/`UiCard` on the dogfood substrate) where several
 * manifest sources agree on name/importPath/designSystem and differ ONLY in
 * which source produced them.
 */
function buttonManifestFor(importPath: string, designSystem: string, sourceId?: string): ComponentManifest {
  return {
    id: sourceId ?? `${designSystem}.${importPath}.ui-button`,
    name: "UiButton",
    framework: "vue3",
    designSystem,
    importPath,
    props: [
      {
        name: "appearance",
        type: "string",
        required: false,
        control: {
          kind: "finite-choice",
          options: [
            { label: "primary", value: "primary" },
            { label: "secondary", value: "secondary" },
          ],
        },
      },
    ],
  }
}

function propEdit(overrides: Partial<PropEditBody> = {}): PropEditBody {
  return {
    kind: "prop",
    file: "src/App.vue",
    line: KBUTTON_LINE,
    column: KBUTTON_COLUMN,
    propName: "appearance",
    value: "ghost",
    ...overrides,
  }
}

let root = ""
let rootCounter = 0

async function withTempRepo(): Promise<string> {
  root = await mkdtemp(path.join(tmpdir(), "pt-drift-"))
  await writeFile(path.join(root, "App.vue"), SFC_SOURCE, "utf8")
  return root
}

afterEach(async () => {
  resetGroundingCache()
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
  root = ""
})

function canonicalRoot(): string {
  rootCounter += 1
  return `canonical-root-${rootCounter}`
}

describe("recordManifestValueMismatchDrift", () => {
  it("records a signal for an off-manifest value on a trusted finite-choice prop", async () => {
    const repoRoot = await withTempRepo()
    const driftLog = createDriftLog()
    const loaders = loadersFor(async (name) => (name === "UiButton" ? trustedButtonManifest() : null))

    await recordManifestValueMismatchDrift(propEdit({ file: "App.vue", value: "ghost" }), {
      repoRoot,
      canonicalRoot: canonicalRoot(),
      groundingLoaders: loaders,
      driftLog,
    })

    const entries = driftLog.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].component).toBe("UiButton")
    expect(entries[0].kinds).toEqual(["manifest-value-mismatch"])
    expect(entries[0].lastDetail).toContain("ghost")
    expect(entries[0].lastDetail).toContain("primary")
  })

  it("records nothing when the value IS among the declared options", async () => {
    const repoRoot = await withTempRepo()
    const driftLog = createDriftLog()
    const loaders = loadersFor(async (name) => (name === "UiButton" ? trustedButtonManifest() : null))

    await recordManifestValueMismatchDrift(propEdit({ file: "App.vue", value: "primary" }), {
      repoRoot,
      canonicalRoot: canonicalRoot(),
      groundingLoaders: loaders,
      driftLog,
    })

    expect(driftLog.list()).toHaveLength(0)
  })

  it("records nothing when there is no manifest for the component", async () => {
    const repoRoot = await withTempRepo()
    const driftLog = createDriftLog()
    const loaders = loadersFor(async () => null)

    await recordManifestValueMismatchDrift(propEdit({ file: "App.vue" }), {
      repoRoot,
      canonicalRoot: canonicalRoot(),
      groundingLoaders: loaders,
      driftLog,
    })

    expect(driftLog.list()).toHaveLength(0)
  })

  it("never throws when the grounding service itself throws, and records nothing", async () => {
    const repoRoot = await withTempRepo()
    const driftLog = createDriftLog()
    const loaders: GroundingLoaders = {
      loadCreateGroundingService: async () => {
        throw new Error("boom")
      },
    }

    await expect(
      recordManifestValueMismatchDrift(propEdit({ file: "App.vue" }), {
        repoRoot,
        canonicalRoot: canonicalRoot(),
        groundingLoaders: loaders,
        driftLog,
      }),
    ).resolves.toBeUndefined()

    expect(driftLog.list()).toHaveLength(0)
  })

  it("never throws when getComponent itself throws, and records nothing", async () => {
    const repoRoot = await withTempRepo()
    const driftLog = createDriftLog()
    const loaders = loadersFor(async () => {
      throw new Error("manifest lookup exploded")
    })

    await expect(
      recordManifestValueMismatchDrift(propEdit({ file: "App.vue" }), {
        repoRoot,
        canonicalRoot: canonicalRoot(),
        groundingLoaders: loaders,
        driftLog,
      }),
    ).resolves.toBeUndefined()

    expect(driftLog.list()).toHaveLength(0)
  })

  it("records nothing when the target file cannot be read", async () => {
    const repoRoot = await withTempRepo()
    const driftLog = createDriftLog()
    const loaders = loadersFor(async (name) => (name === "UiButton" ? trustedButtonManifest() : null))

    await recordManifestValueMismatchDrift(propEdit({ file: "does-not-exist.vue" }), {
      repoRoot,
      canonicalRoot: canonicalRoot(),
      groundingLoaders: loaders,
      driftLog,
    })

    expect(driftLog.list()).toHaveLength(0)
  })
})

/**
 * Codex P2 fix (2026-07-30): a `.tsx`/`.jsx` prop edit used to run the
 * Vue-only `resolveTemplateTarget` unconditionally, which finds nothing for
 * a JSX file — silently swallowed by the outer catch — so this signal (and
 * the React auto-repair it can trigger) was unreachable for React. Proves
 * the JSX dispatch lane end to end over a real `.tsx` file.
 */
const JSX_SOURCE = [
  'import { UiButton } from "@acme/design-system"',
  "",
  "export function App() {",
  "  return (",
  '    <UiButton appearance="ghost">Click</UiButton>',
  "  )",
  "}",
].join("\n")

// Babel coords (1-based line, 0-based column) of `<UiButton`'s opening `<` —
// line 5, 4 leading spaces, so column 4.
const JSX_KBUTTON_LINE = 5
const JSX_KBUTTON_COLUMN = 4

describe("recordManifestValueMismatchDrift — React/.tsx dispatch (codex P2 fix)", () => {
  it("records a signal for an off-manifest value on a .tsx prop edit", async () => {
    const repoRoot = await withTempRepo()
    await writeFile(path.join(repoRoot, "App.tsx"), JSX_SOURCE, "utf8")
    const driftLog = createDriftLog()
    const loaders = loadersFor(async (name) => (name === "UiButton" ? trustedButtonManifest() : null))

    await recordManifestValueMismatchDrift(
      propEdit({ file: "App.tsx", line: JSX_KBUTTON_LINE, column: JSX_KBUTTON_COLUMN, value: "ghost" }),
      { repoRoot, canonicalRoot: canonicalRoot(), groundingLoaders: loaders, driftLog },
    )

    const entries = driftLog.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].component).toBe("UiButton")
    expect(entries[0].kinds).toEqual(["manifest-value-mismatch"])
  })

  it("records nothing for a value that IS among the declared options in a .tsx file", async () => {
    const repoRoot = await withTempRepo()
    await writeFile(path.join(repoRoot, "App.tsx"), JSX_SOURCE, "utf8")
    const driftLog = createDriftLog()
    const loaders = loadersFor(async (name) => (name === "UiButton" ? trustedButtonManifest() : null))

    await recordManifestValueMismatchDrift(
      propEdit({ file: "App.tsx", line: JSX_KBUTTON_LINE, column: JSX_KBUTTON_COLUMN, value: "primary" }),
      { repoRoot, canonicalRoot: canonicalRoot(), groundingLoaders: loaders, driftLog },
    )

    expect(driftLog.list()).toHaveLength(0)
  })

  it("no-ops silently for an extension with no resolver (e.g. .ts)", async () => {
    const repoRoot = await withTempRepo()
    await writeFile(path.join(repoRoot, "helpers.ts"), "export const x = 1\n", "utf8")
    const driftLog = createDriftLog()
    const loaders = loadersFor(async (name) => (name === "UiButton" ? trustedButtonManifest() : null))

    await expect(
      recordManifestValueMismatchDrift(propEdit({ file: "helpers.ts", line: 1, column: 0 }), {
        repoRoot,
        canonicalRoot: canonicalRoot(),
        groundingLoaders: loaders,
        driftLog,
      }),
    ).resolves.toBeUndefined()

    expect(driftLog.list()).toHaveLength(0)
  })
})

/**
 * Codex P2 fix (2026-07-30, safety): `getComponent(name)` always returns the
 * FIRST manifest source's manifest for that tag name. In a project where
 * two sources export the same component name, that can suppress a genuine
 * off-manifest edit or — worse — record drift (and trigger a repair)
 * against the wrong package. `resolveManifestForName` disambiguates by the
 * edited file's actual import path, and refuses to guess when it can't.
 */
const TWO_SOURCE_SFC = [
  "<script setup>",
  "import { UiButton } from '@pkg-b/design-system'",
  "</script>",
  "<template>",
  "  <div>",
  '    <UiButton appearance="ghost">Click</UiButton>',
  "  </div>",
  "</template>",
].join("\n")

// SFC-absolute (line, column) of `<UiButton`'s opening `<` in TWO_SOURCE_SFC
// above — line 6, 4 leading spaces, so column 5 (1-based).
const TWO_SOURCE_LINE = 6
const TWO_SOURCE_COLUMN = 5

// Same template/tag, but with no import for UiButton at all (as if it were
// globally registered) — `target.imports.get("UiButton")` is undefined.
const NO_IMPORT_SFC = [
  "<template>",
  "  <div>",
  '    <UiButton appearance="ghost">Click</UiButton>',
  "  </div>",
  "</template>",
].join("\n")

describe("recordManifestValueMismatchDrift — same-name manifest disambiguation (codex P2 fix)", () => {
  it("targets the SECOND package when the edited file imports it, even though the first source would otherwise win", async () => {
    const repoRoot = await withTempRepo()
    await writeFile(path.join(repoRoot, "Two.vue"), TWO_SOURCE_SFC, "utf8")
    const driftLog = createDriftLog()
    const loaders = loadersWithCandidates({
      UiButton: [buttonManifestFrom("@pkg-a/design-system"), buttonManifestFrom("@pkg-b/design-system")],
    })

    await recordManifestValueMismatchDrift(
      propEdit({ file: "Two.vue", line: TWO_SOURCE_LINE, column: TWO_SOURCE_COLUMN, value: "ghost" }),
      { repoRoot, canonicalRoot: canonicalRoot(), groundingLoaders: loaders, driftLog },
    )

    const entries = driftLog.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].importPath).toBe("@pkg-b/design-system")
    // Coalescing key is `${component}::${importPath}` — asserting on it
    // directly proves the SECOND package's entry, not the first's.
    expect(driftLog.get("UiButton::@pkg-a/design-system")).toBeUndefined()
    expect(driftLog.get("UiButton::@pkg-b/design-system")).toBeDefined()
  })

  it("emits nothing when the import can't be resolved AND the name is ambiguous across sources", async () => {
    const repoRoot = await withTempRepo()
    await writeFile(path.join(repoRoot, "NoImport.vue"), NO_IMPORT_SFC, "utf8")
    const driftLog = createDriftLog()
    const loaders = loadersWithCandidates({
      UiButton: [buttonManifestFrom("@pkg-a/design-system"), buttonManifestFrom("@pkg-b/design-system")],
    })

    await recordManifestValueMismatchDrift(
      propEdit({ file: "NoImport.vue", line: KBUTTON_LINE, column: KBUTTON_COLUMN, value: "ghost" }),
      { repoRoot, canonicalRoot: canonicalRoot(), groundingLoaders: loaders, driftLog },
    )

    expect(driftLog.list()).toHaveLength(0)
  })

  it("keeps today's behavior — signal against the single source — for an unambiguous name with no import resolution", async () => {
    const repoRoot = await withTempRepo()
    await writeFile(path.join(repoRoot, "NoImport.vue"), NO_IMPORT_SFC, "utf8")
    const driftLog = createDriftLog()
    const loaders = loadersWithCandidates({
      UiButton: [buttonManifestFrom("@acme/design-system")],
    })

    await recordManifestValueMismatchDrift(
      propEdit({ file: "NoImport.vue", line: KBUTTON_LINE, column: KBUTTON_COLUMN, value: "ghost" }),
      { repoRoot, canonicalRoot: canonicalRoot(), groundingLoaders: loaders, driftLog },
    )

    const entries = driftLog.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].component).toBe("UiButton")
    expect(entries[0].importPath).toBe("@acme/design-system")
  })

  it("emits nothing when the import-path filter itself leaves more than one candidate (same importPath, different designSystem)", async () => {
    const repoRoot = await withTempRepo()
    await writeFile(path.join(repoRoot, "Two.vue"), TWO_SOURCE_SFC, "utf8")
    const driftLog = createDriftLog()
    // Both candidates share the SAME importPath the edited file resolves to
    // (`@pkg-b/design-system`) but come from different registered sources
    // (differing `designSystem`) — the `.find()`-based filter used to pick
    // the first one here, which can record drift (and trigger repair)
    // against whichever candidate happened to be first, not necessarily the
    // one actually installed at that import path.
    const loaders = loadersWithCandidates({
      UiButton: [
        buttonManifestFor("@pkg-b/design-system", "design-system-a"),
        buttonManifestFor("@pkg-b/design-system", "design-system-b"),
      ],
    })

    await recordManifestValueMismatchDrift(
      propEdit({ file: "Two.vue", line: TWO_SOURCE_LINE, column: TWO_SOURCE_COLUMN, value: "ghost" }),
      { repoRoot, canonicalRoot: canonicalRoot(), groundingLoaders: loaders, driftLog },
    )

    expect(driftLog.list()).toHaveLength(0)
  })

  it("resolves to the first candidate when the import-path filter leaves several candidates that AGREE on designSystem — redundant coverage, not a collision (the real UiAlert/UiButton/UiBadge/UiCard shape on the dogfood substrate)", async () => {
    const repoRoot = await withTempRepo()
    await writeFile(path.join(repoRoot, "Two.vue"), TWO_SOURCE_SFC, "utf8")
    const driftLog = createDriftLog()
    // Same shape observed live against ai-gateway-prototype: several
    // manifest sources (there, `@acme/design-system-vue-dts`,
    // `@acme/design-system:UiAlert`, `acme-ds-dts`) all surface the SAME
    // component — identical name, importPath, AND designSystem — differing
    // only in which source produced the candidate. This is redundant
    // coverage, not a genuine collision, and must resolve (to the first —
    // the composite's props-winner) rather than go ambiguous. Before the
    // fix, this rule conflated the two and silently emitted nothing for
    // EVERY component on the real substrate.
    const loaders = loadersWithCandidates({
      UiButton: [
        buttonManifestFor("@pkg-b/design-system", "acme-ds", "acme-ds-vue-dts"),
        buttonManifestFor("@pkg-b/design-system", "acme-ds", "acme-ds-static"),
        buttonManifestFor("@pkg-b/design-system", "acme-ds", "acme-ds-dts"),
      ],
    })

    await recordManifestValueMismatchDrift(
      propEdit({ file: "Two.vue", line: TWO_SOURCE_LINE, column: TWO_SOURCE_COLUMN, value: "ghost" }),
      { repoRoot, canonicalRoot: canonicalRoot(), groundingLoaders: loaders, driftLog },
    )

    const entries = driftLog.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].component).toBe("UiButton")
    expect(entries[0].importPath).toBe("@pkg-b/design-system")
  })
})

/**
 * Codex P2 fix (2026-07-30): `recordManifestValueMismatchDrift` now routes
 * a recorded signal through the SAME `triggerRepairForEntry` the
 * `POST /api/editor/drift` route uses, so this server-side producer's
 * entries are auto-repaired instead of only ever sitting in the log inert
 * (since this producer never goes through the POST route, the
 * `manifest-value-mismatch` → `REPAIRABLE_DRIFT_KINDS` wiring previously
 * had no effect for it).
 */
function fakeRepairDeps(overrides: Partial<RepairDeps> = {}): RepairDeps {
  return {
    reextractVue: overrides.reextractVue ?? (async () => null),
    reextractReact: overrides.reextractReact ?? (async () => null),
    patchCache: overrides.patchCache ?? (() => false),
    readCache: overrides.readCache ?? (() => null),
    invalidate: overrides.invalidate ?? (() => {}),
    findRegisteredEntry: overrides.findRegisteredEntry ?? (async () => null),
    discoverVueDtsComponents: overrides.discoverVueDtsComponents ?? (async () => []),
    discoverReactDtsEntries: overrides.discoverReactDtsEntries ?? (() => []),
    resolveTsconfigPath: overrides.resolveTsconfigPath ?? (async () => null),
    resolvePackageVersion: overrides.resolvePackageVersion ?? (() => null),
    fingerprintFile: overrides.fingerprintFile ?? (() => ""),
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
}

/**
 * Codex P2 fix (2026-07-30): an aliased named import
 * (`import { Button as PrimaryButton } from 'x'`) used to be looked up in
 * the manifest by its LOCAL name (`PrimaryButton`), which manifests never
 * key by — manifests are keyed by the EXPORTED name (`Button`). The import
 * PATH resolved fine, but the manifest lookup silently missed, so the
 * signal (and its auto-repair) was skipped even though nothing was actually
 * ambiguous. `collectImportBindings`/`collectVueImportBindings` now record
 * both the local and exported name per binding, and the lookup queries the
 * manifest by the exported name.
 */
const ALIASED_IMPORT_SFC = [
  "<script setup>",
  "import { UiButton as PrimaryButton } from '@pkg-b/design-system'",
  "</script>",
  "<template>",
  "  <div>",
  '    <PrimaryButton appearance="ghost">Click</PrimaryButton>',
  "  </div>",
  "</template>",
].join("\n")

// SFC-absolute (line, column) of `<PrimaryButton`'s opening `<` in
// ALIASED_IMPORT_SFC above — line 6, 4 leading spaces, so column 5 (1-based).
const ALIASED_LINE = 6
const ALIASED_COLUMN = 5

const JSX_DEFAULT_IMPORT_SOURCE = [
  'import PrimaryButton from "@pkg-a/design-system"',
  "",
  "export function App() {",
  "  return (",
  '    <PrimaryButton appearance="ghost">Click</PrimaryButton>',
  "  )",
  "}",
].join("\n")

// Babel coords (1-based line, 0-based column) of `<PrimaryButton`'s opening
// `<` — line 5, 4 leading spaces, so column 4.
const JSX_DEFAULT_LINE = 5
const JSX_DEFAULT_COLUMN = 4

describe("recordManifestValueMismatchDrift — aliased/default import resolution (codex P2 fix)", () => {
  it("resolves an aliased named import to its EXPORTED name, not its local alias", async () => {
    const repoRoot = await withTempRepo()
    await writeFile(path.join(repoRoot, "Aliased.vue"), ALIASED_IMPORT_SFC, "utf8")
    const driftLog = createDriftLog()
    // getComponent is keyed by the manifest's real name — "UiButton", the
    // EXPORTED name — never "PrimaryButton", the local alias. If the lookup
    // regresses to querying by local name, this loader returns null and no
    // signal is recorded.
    const loaders = loadersFor(async (name) => (name === "UiButton" ? buttonManifestFrom("@pkg-b/design-system") : null))

    await recordManifestValueMismatchDrift(
      propEdit({ file: "Aliased.vue", line: ALIASED_LINE, column: ALIASED_COLUMN, value: "ghost" }),
      { repoRoot, canonicalRoot: canonicalRoot(), groundingLoaders: loaders, driftLog },
    )

    const entries = driftLog.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].component).toBe("UiButton")
    expect(entries[0].importPath).toBe("@pkg-b/design-system")
  })

  it("still disambiguates an aliased import across sources by import path, rather than suppressing on ambiguity", async () => {
    const repoRoot = await withTempRepo()
    await writeFile(path.join(repoRoot, "Aliased.vue"), ALIASED_IMPORT_SFC, "utf8")
    const driftLog = createDriftLog()
    // Two sources both export a "UiButton" (the exported name the alias
    // resolves to); only the file's actual import path (@pkg-b/design-system)
    // should win — the ambiguity must not suppress the signal, since the
    // import path is known and resolves it.
    const loaders = loadersWithCandidates({
      UiButton: [buttonManifestFrom("@pkg-a/design-system"), buttonManifestFrom("@pkg-b/design-system")],
    })

    await recordManifestValueMismatchDrift(
      propEdit({ file: "Aliased.vue", line: ALIASED_LINE, column: ALIASED_COLUMN, value: "ghost" }),
      { repoRoot, canonicalRoot: canonicalRoot(), groundingLoaders: loaders, driftLog },
    )

    const entries = driftLog.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].importPath).toBe("@pkg-b/design-system")
    expect(driftLog.get("UiButton::@pkg-a/design-system")).toBeUndefined()
    expect(driftLog.get("UiButton::@pkg-b/design-system")).toBeDefined()
  })

  it("leaves a plain (unaliased) named import's lookup unchanged", async () => {
    const repoRoot = await withTempRepo()
    await writeFile(path.join(repoRoot, "Two.vue"), TWO_SOURCE_SFC, "utf8")
    const driftLog = createDriftLog()
    const loaders = loadersWithCandidates({
      UiButton: [buttonManifestFrom("@pkg-a/design-system"), buttonManifestFrom("@pkg-b/design-system")],
    })

    await recordManifestValueMismatchDrift(
      propEdit({ file: "Two.vue", line: TWO_SOURCE_LINE, column: TWO_SOURCE_COLUMN, value: "ghost" }),
      { repoRoot, canonicalRoot: canonicalRoot(), groundingLoaders: loaders, driftLog },
    )

    const entries = driftLog.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].importPath).toBe("@pkg-b/design-system")
  })

  it("resolves a default import by its local name (the only name recoverable from a default import), matching the manifest's own default-export convention", async () => {
    const repoRoot = await withTempRepo()
    await writeFile(path.join(repoRoot, "Default.tsx"), JSX_DEFAULT_IMPORT_SOURCE, "utf8")
    const driftLog = createDriftLog()
    // A default export has no module-side binding name to recover from the
    // import statement — the manifest for a default-exported component is
    // itself keyed by the component's own name (vue-dts-meta: the file
    // basename; react-dts-meta: the exported symbol name), which in
    // practice is what authors also use as the local import identifier.
    const loaders = loadersFor(async (name) =>
      name === "PrimaryButton" ? buttonManifestFrom("@pkg-a/design-system") : null,
    )

    await recordManifestValueMismatchDrift(
      propEdit({ file: "Default.tsx", line: JSX_DEFAULT_LINE, column: JSX_DEFAULT_COLUMN, value: "ghost" }),
      { repoRoot, canonicalRoot: canonicalRoot(), groundingLoaders: loaders, driftLog },
    )

    const entries = driftLog.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].importPath).toBe("@pkg-a/design-system")
  })
})

describe("recordManifestValueMismatchDrift — repair triggering (codex P2 fix)", () => {
  it("triggers exactly one repair for a server-recorded manifest-value-mismatch signal, same guard as the POST path", async () => {
    const repoRoot = await withTempRepo()
    const driftLog = createDriftLog()
    const loaders = loadersFor(async (name) => (name === "UiButton" ? trustedButtonManifest() : null))
    const calls: string[] = []
    const deps = fakeRepairDeps({
      resolveTsconfigPath: async () => "/proto/tsconfig.json",
      discoverVueDtsComponents: async () => [
        { componentName: "UiButton", declarationFile: "/x/UiButton.vue.d.ts" },
      ],
      resolvePackageVersion: () => "9.0.0",
      readCache: () => null,
      patchCache: () => true,
      reextractVue: async () => {
        calls.push("reextract")
        return { id: "x", name: "UiButton", framework: "vue3", designSystem: "acme-ds", props: [] }
      },
    })
    const queue = createRepairQueue()

    await recordManifestValueMismatchDrift(propEdit({ file: "App.vue", value: "ghost" }), {
      repoRoot,
      canonicalRoot: canonicalRoot(),
      groundingLoaders: loaders,
      driftLog,
      repair: { prototypeRoot: "/proto", deps, queue },
    })
    await flushMicrotasks()

    expect(calls).toEqual(["reextract"])
    const entry = driftLog.get("UiButton::@acme/design-system")
    expect(entry?.repair?.outcome).toBe("seeded")

    // A second identical edit for the SAME component must not trigger a
    // second re-extract — the once-per-entry guard is shared with the POST
    // path, not reimplemented here.
    await recordManifestValueMismatchDrift(propEdit({ file: "App.vue", value: "ghost" }), {
      repoRoot,
      canonicalRoot: canonicalRoot(),
      groundingLoaders: loaders,
      driftLog,
      repair: { prototypeRoot: "/proto", deps, queue },
    })
    await flushMicrotasks()
    expect(calls).toEqual(["reextract"]) // still just once
  })

  it("delivers the settled repair's invalidation via pendingInvalidations, the same durable delivery a subsequent drift response drains", async () => {
    const repoRoot = await withTempRepo()
    const driftLog = createDriftLog()
    const loaders = loadersFor(async (name) => (name === "UiButton" ? trustedButtonManifest() : null))
    const deps = fakeRepairDeps({
      resolveTsconfigPath: async () => "/proto/tsconfig.json",
      discoverVueDtsComponents: async () => [
        { componentName: "UiButton", declarationFile: "/x/UiButton.vue.d.ts" },
      ],
      resolvePackageVersion: () => "9.0.0",
      readCache: () => null,
      patchCache: () => true,
      reextractVue: async () => ({
        id: "x",
        name: "UiButton",
        framework: "vue3",
        designSystem: "acme-ds",
        props: [],
      }),
    })
    const pendingInvalidations = createPendingInvalidationQueue()
    let registryChanges = 0

    await recordManifestValueMismatchDrift(propEdit({ file: "App.vue", value: "ghost" }), {
      repoRoot,
      canonicalRoot: canonicalRoot(),
      groundingLoaders: loaders,
      driftLog,
      repair: {
        prototypeRoot: "/proto",
        deps,
        queue: createRepairQueue(),
        onRegistryChange: () => {
          registryChanges += 1
        },
      },
      pendingInvalidations,
    })
    await flushMicrotasks()

    const entry = driftLog.get("UiButton::@acme/design-system")
    expect(entry?.repair?.outcome).toBe("seeded")
    expect(registryChanges).toBe(1)
    // `drain()` is exactly what a subsequent GET/POST/DELETE
    // `/api/editor/drift` response does with `ctx.pendingInvalidations`
    // — proving delivery here proves it for that response too, since both
    // read the SAME queue instance.
    expect(pendingInvalidations.drain()).toEqual([
      { name: "UiButton", importPath: "@acme/design-system", attemptedAt: entry?.repair?.attemptedAt },
    ])
  })

  it("does not trigger a repair when the resulting entry isn't itself repairable (defense in depth: the shared trigger's own kind guard)", async () => {
    const repoRoot = await withTempRepo()
    const driftLog = createDriftLog()
    const loaders = loadersFor(async (name) => (name === "UiButton" ? trustedButtonManifest() : null))
    const calls: string[] = []
    const deps = fakeRepairDeps({
      reextractVue: async () => {
        calls.push("reextract")
        return null
      },
    })

    // A value that IS among the declared options records no signal at all —
    // nothing to repair, and the repair path must never be reached.
    await recordManifestValueMismatchDrift(propEdit({ file: "App.vue", value: "primary" }), {
      repoRoot,
      canonicalRoot: canonicalRoot(),
      groundingLoaders: loaders,
      driftLog,
      repair: { prototypeRoot: "/proto", deps, queue: createRepairQueue() },
    })
    await flushMicrotasks()

    expect(driftLog.list()).toHaveLength(0)
    expect(calls).toEqual([])
  })

  it("does nothing when ctx.repair is omitted — repair triggering stays opt-in for this producer too", async () => {
    const repoRoot = await withTempRepo()
    const driftLog = createDriftLog()
    const loaders = loadersFor(async (name) => (name === "UiButton" ? trustedButtonManifest() : null))

    await recordManifestValueMismatchDrift(propEdit({ file: "App.vue", value: "ghost" }), {
      repoRoot,
      canonicalRoot: canonicalRoot(),
      groundingLoaders: loaders,
      driftLog,
    })
    await flushMicrotasks()

    const entry = driftLog.get("UiButton::@acme/design-system")
    expect(entry).toBeDefined()
    expect(entry?.repair).toBeUndefined()
  })
})

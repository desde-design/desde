/**
 * LLM-mediated patch service. Pure function (no filesystem I/O) given an
 * Anthropic client. Takes a bundle of DOM-edit-mode mutations and a
 * map of original sources, returns patched sources.
 *
 * Architecturally separates the LLM call from filesystem concerns the
 * same way `apply-prop-edit.ts` separates AST mutation from filesystem.
 * The CLI handler at `editor-cli/src/server/edit-handler.ts` owns
 * the I/O — reads the affected files, builds `projectStyleContext` once
 * per session, calls this service, writes outputs.
 *
 * V1 hard-refuses any mutation whose `resolutionKind !== 'direct'`
 * (Phase A guarantees this is the bridge's policy too, but we re-check
 * here so the service is safe to call in isolation), any mutation
 * targeting a non-`.vue` file, any mutation whose `sourceLoc` file is
 * absent from the input map, and bundles whose per-file mutation count
 * exceeds the configurable cap.
 *
 * Tests inject a fake `LLMProvider` through the `provider?:` parameter.
 * One live integration test is gated by `RUN_LIVE_LLM_TESTS=1`.
 */

import type { Mutation } from '../core/edit'
import { mapWithConcurrency } from '../core/concurrency'
import type { ProjectKnowledge } from '../core/project-knowledge'
import { getProvider } from '../llm-providers/registry'
import type { CompletionProvider, ContentBlock } from '../llm-providers/types'
import { buildPatchPrompt, type ProjectStyleContext } from './llm-patch-prompt'

export type { ProjectStyleContext } from './llm-patch-prompt'

/** Allowed outcomes the LLM may report per mutation. */
const ALLOWED_OUTCOMES: ReadonlySet<string> = new Set(['applied', 'skipped', 'refused'])

export interface ApplyLLMPatchInput {
  /** Map of source-file path → original source. Reads only. */
  files: ReadonlyMap<string, string>
  /** Bundle of mutations to translate into source patches. */
  mutations: readonly Mutation[]
  /** Project-level styling priors loaded once per editor session. */
  projectStyleContext: ProjectStyleContext
  /**
   * The prototype repo's documented conventions, loaded once per editor
   * session. Rendered as a cached prompt block. Optional — absent when the
   * repo documents nothing.
   */
  projectKnowledge?: ProjectKnowledge
  /** Optional injected LLM provider (tests pass a fake). */
  provider?: CompletionProvider
  /**
   * Lazily resolves the LLM provider when `provider` is not supplied. The
   * CLI injects the project's per-request resolved provider here (the same
   * seam every other lane uses) so this service never falls back to the
   * process-wide registry default on its own. Absent → `getProvider()`.
   */
  resolveProvider?: () => CompletionProvider
  /**
   * Model id. Optional. When omitted the PROVIDER's own `defaultModel` is
   * used, so an OpenAI-configured project does not get a Claude model id
   * its API rejects outright.
   */
  model?: string
  /** Max output tokens per file patch. Default 16000. */
  maxTokens?: number
  /** Per-file mutation cap. Default 20. */
  maxMutationsPerFile?: number
  /**
   * Max number of per-file LLM calls to run concurrently when the bundle
   * spans MULTIPLE files. Default 4. A single-file bundle always runs the
   * one call directly (byte-identical to the old sequential path); only
   * N>1-file bundles fan out. File is the conflict-safe unit — same-file
   * mutations are already grouped into one call, so cross-file parallelism
   * never races two writers on one source. Outcome order stays stable
   * (results are reassembled in `byFile` insertion order regardless of
   * completion order). Tradeoff vs. the old sequential loop: concurrent
   * requests can't reuse each other's prompt-cache writes, so the shared
   * `projectStyleContext` / source blocks are re-sent per call; wall-clock
   * for a multi-file commit drops to ≈ the slowest single file instead of
   * the sum. Set to 1 to force the sequential behavior.
   */
  maxConcurrency?: number
  /**
   * Token-delta callback. When provided AND the provider supports
   * `streamComplete`, the patch service uses the streaming endpoint and
   * fires this callback for each token as it arrives. Otherwise falls
   * back to non-streaming `complete()`. Lets the route surface
   * incremental LLM output to the save dialog while a 5–95s patch is
   * in flight. The string passed includes the per-file `# file-marker`
   * header (rendered before each file's stream) so multi-file bundles
   * are visually delimited in the UI.
   */
  onTextDelta?: (delta: string) => void
  /**
   * Abort signal forwarded to the underlying provider call. Set by the
   * route to `request.signal` so a client navigation / disconnect
   * cancels the in-flight LLM call instead of letting it consume
   * tokens and write files into a disconnected session (Codex review
   * P1).
   */
  signal?: AbortSignal
}

export interface PerMutationOutcome {
  mutationId: string
  outcome: 'applied' | 'skipped' | 'refused'
  reason?: string
}

export type ApplyLLMPatchResult =
  | {
      ok: true
      /** Map of file path → newly patched source. */
      patchedFiles: Map<string, string>
      perMutationOutcomes: PerMutationOutcome[]
      /** Aggregate notes the LLM produced (concatenated across files). */
      notes?: string
    }
  | {
      ok: false
      reason: string
      // Failure path intentionally carries no perMutationOutcomes —
      // codex round-1 P1 #3 caught that surfacing partial outcomes on
      // failure invites callers to misread the bundle as
      // partially-applied. The bundle is atomic from the route
      // handler's perspective: ok=true → write all files; ok=false →
      // write none. Diagnostic outcomes from completed files (if any)
      // are dropped here.
    }

interface PatchResponseShape {
  newSource: string
  perMutationOutcome: PerMutationOutcome[]
  notes?: string
}

/**
 * Apply an LLM-mediated patch to a bundle of source files.
 *
 * **Failure semantics:** if any per-file LLM call fails or returns an
 * incomplete response, the whole bundle is rejected (`ok: false`). We
 * never apply a partial patch — the route handler treats the bundle
 * atomically (write all or write none) so a failed LLM call doesn't
 * leave the prototype in a half-patched state.
 */
export async function applyLLMPatch(
  input: ApplyLLMPatchInput,
): Promise<ApplyLLMPatchResult> {
  const {
    files,
    mutations,
    projectStyleContext,
    projectKnowledge,
    // No hardcoded default. `undefined` lets each provider's complete() fall
    // back to its OWN defaultModel, so an OpenAI-configured project does not
    // get a Claude model id its API rejects outright, deep inside a save.
    model,
    maxTokens = 16_000,
    maxMutationsPerFile = 20,
    maxConcurrency = 4,
    onTextDelta,
    signal,
  } = input

  // Resolved inside the function, not as a parameter default: `getProvider()`
  // THROWS on missing credentials, and a default-parameter throw is evaluated
  // during destructuring, so it escapes every try/catch below and reaches the
  // caller as a raw 500 with a stack in the response body. This is the shape
  // `repair-edit.ts` and `iteration-data-llm.ts` already use.
  let provider = input.provider
  if (!provider) {
    try {
      provider = (input.resolveProvider ?? getProvider)()
    } catch (err) {
      return { ok: false, reason: (err as Error).message }
    }
  }

  if (mutations.length === 0) {
    return { ok: true, patchedFiles: new Map(), perMutationOutcomes: [] }
  }

  // V1 hard refusals — fail fast before any LLM cost.
  for (const m of mutations) {
    if (m.resolutionKind !== 'direct') {
      return {
        ok: false,
        reason: `Mutation ${m.id} has resolutionKind='${m.resolutionKind}'; V1 only patches direct mutations.`,
      }
    }
    if (!m.sourceLoc) {
      return {
        ok: false,
        reason: `Mutation ${m.id} has no sourceLoc; V1 hard refuses.`,
      }
    }
    // V1 hard-refuses class and style mutations — the prompt has
    // experimental rules for them, but the V1 spike scope is text +
    // attribute only. Without this gate, an experimental class/style
    // mutation that bypassed Phase A's bridge gate would slip through
    // and produce nondeterministic output.
    if (m.kind === 'class' || m.kind === 'style') {
      return {
        ok: false,
        reason: `Mutation ${m.id} kind='${m.kind}'; V1 only patches text and attr mutations.`,
      }
    }
  }

  // Enforce disambiguation state: v-for ambiguity is when N>1 mutations
  // share a sourceLoc but target DIFFERENT instances (different
  // `instancePath`). Multiple mutations sharing both `sourceLoc` AND
  // `instancePath` target the SAME instance — that's just the designer
  // editing one element multiple times across debounce intervals; it's
  // expected, not an ambiguity. Group by sourceLoc, then within each
  // group check whether instancePath varies.
  //
  // Cross-file ('this-instance' against the parent SFC) does NOT count
  // as v-for ambiguity for this check — those mutations are routed to
  // the parent file regardless of how many sibling iterations exist;
  // the ambiguity is only meaningful when patching the host template
  // (where the same template renders all instances).
  const byLoc = new Map<string, Mutation[]>()
  for (const m of mutations) {
    if (isCrossFileInstanceEdit(m)) continue
    let bucket = byLoc.get(m.sourceLoc!)
    if (!bucket) {
      bucket = []
      byLoc.set(m.sourceLoc!, bucket)
    }
    bucket.push(m)
  }
  for (const [, bucket] of byLoc) {
    if (bucket.length < 2) continue
    const distinctPaths = new Set(bucket.map((m) => m.instancePath))
    if (distinctPaths.size <= 1) continue
    // Real v-for ambiguity in this group → every mutation must carry a
    // disambiguationChoice.
    for (const m of bucket) {
      if (m.disambiguationChoice === undefined) {
        return {
          ok: false,
          reason: `Mutation ${m.id} shares sourceLoc='${m.sourceLoc}' with another mutation at a different v-for instance but has no disambiguationChoice; ambiguity must be resolved before save.`,
        }
      }
    }
  }

  // Group by *patch file*. For 'definition'-scope mutations and for
  // 'callsite'-scope mutations resolved as 'all-instances', the patch
  // file is `sourceLoc`'s file (the host SFC). For 'callsite' +
  // 'this-instance', the patch file is `callsiteLoc`'s file (the parent
  // SFC) — that's the cross-file edit path.
  const byFile = new Map<string, Mutation[]>()
  for (const m of mutations) {
    const fileResult = patchFileFor(m)
    if (!fileResult.ok) {
      return { ok: false, reason: `Mutation ${m.id} ${fileResult.reason}` }
    }
    const file = fileResult.file
    if (!file.endsWith('.vue')) {
      return {
        ok: false,
        reason: `Mutation ${m.id} targets non-.vue file '${file}'; V1 only patches Vue SFCs.`,
      }
    }
    if (!files.has(file)) {
      return {
        ok: false,
        reason: `Mutation ${m.id} targets file '${file}' which is not in the input files map.`,
      }
    }
    let bucket = byFile.get(file)
    if (!bucket) {
      bucket = []
      byFile.set(file, bucket)
    }
    bucket.push(m)
  }

  // Per-file caps.
  for (const [file, muts] of byFile.entries()) {
    if (muts.length > maxMutationsPerFile) {
      return {
        ok: false,
        reason: `File '${file}' has ${muts.length} mutations; cap is ${maxMutationsPerFile}. Split the save into smaller batches.`,
      }
    }
  }

  // Adaptive fan-out by file. A single-file bundle runs the one call
  // directly (byte-identical to the old sequential path, incl. per-token
  // streaming + the `--- file ---` marker). A multi-file bundle fans out:
  // bounded-parallel per-file calls (cap = `maxConcurrency`), with
  // per-token streaming disabled so the deltas of N concurrent files don't
  // interleave into garbled text in the commit dialog — a single coarse
  // "Applying N files…" status is emitted instead. Either way outcomes are
  // reassembled in `byFile` insertion order so the result is order-stable
  // regardless of which file's LLM call finishes first.
  const fileEntries = [...byFile.entries()]
  const multiFile = fileEntries.length > 1

  const runFile = (
    file: string,
    muts: Mutation[],
  ): Promise<PerFileResult> =>
    patchOneFile({
      file,
      muts,
      originalSource: files.get(file)!,
      projectStyleContext,
      projectKnowledge,
      provider,
      model,
      maxTokens,
      // Stream only for a single-file bundle: streaming interleaves across
      // concurrent files (codex caveat), so multi-file falls back to the
      // non-streaming `complete()` path and shows a coarse status instead.
      onTextDelta: multiFile ? undefined : onTextDelta,
      signal,
    })

  let perFileResults: (PerFileResult | undefined)[]
  if (multiFile) {
    if (onTextDelta) {
      try {
        onTextDelta(`\nApplying ${fileEntries.length} files…\n`)
      } catch {
        // Ignore — same swallow as the provider's onTextDelta path.
      }
    }
    // Fail-fast: once a per-file call fails, stop scheduling NEW work
    // (in-flight calls still finish). Restores the old sequential loop's
    // "don't keep spending LLM calls for a bundle that's already doomed"
    // behavior under concurrency (codex P2). Because the pool pulls
    // indices monotonically, unscheduled files form a contiguous suffix,
    // so the assembly below still reports the FIRST failure in input
    // order deterministically.
    perFileResults = await mapWithConcurrency(
      fileEntries,
      maxConcurrency,
      ([file, muts]) => runFile(file, muts),
      (r) => !r.ok,
    )
  } else {
    perFileResults = []
    for (const [file, muts] of fileEntries) {
      perFileResults.push(await runFile(file, muts))
    }
  }

  // Assemble in byFile insertion order. First failure (in that stable
  // order) rejects the whole bundle — atomic from the route handler's
  // perspective (write all or write none). `undefined` entries are files
  // fail-fast skipped after an earlier failure (a contiguous suffix); we
  // reach the triggering failure before any hole, so they're inert.
  const patchedFiles = new Map<string, string>()
  const allOutcomes: PerMutationOutcome[] = []
  const notes: string[] = []
  for (const r of perFileResults) {
    if (!r) continue
    if (!r.ok) return { ok: false, reason: r.reason }
    patchedFiles.set(r.file, r.newSource)
    allOutcomes.push(...r.outcomes)
    if (r.note) notes.push(r.note)
  }

  return {
    ok: true,
    patchedFiles,
    perMutationOutcomes: allOutcomes,
    notes: notes.length > 0 ? notes.join('\n\n') : undefined,
  }
}

type PerFileResult =
  | {
      ok: true
      file: string
      newSource: string
      outcomes: PerMutationOutcome[]
      note?: string
    }
  | { ok: false; reason: string }

interface PatchOneFileInput {
  file: string
  muts: Mutation[]
  originalSource: string
  projectStyleContext: ProjectStyleContext
  projectKnowledge?: ProjectKnowledge
  provider: CompletionProvider
  model?: string
  maxTokens: number
  onTextDelta?: (delta: string) => void
  signal?: AbortSignal
}

/**
 * Build the prompt for one file, call the LLM (streaming when asked and
 * supported), and fully validate the response. Returns a per-file result
 * the caller assembles in stable order; never throws (LLM errors become
 * `{ ok: false }`). Factored out of {@link applyLLMPatch} so the per-file
 * unit can run sequentially (single-file) or concurrently (multi-file)
 * without duplicating the validation logic.
 */
async function patchOneFile(input: PatchOneFileInput): Promise<PerFileResult> {
  const {
    file,
    muts,
    originalSource,
    projectStyleContext,
    projectKnowledge,
    provider,
    model,
    maxTokens,
    onTextDelta,
    signal,
  } = input

  const prompt = buildPatchPrompt({
    file,
    originalSource,
    mutations: muts,
    projectStyleContext,
    projectKnowledge,
  })

  const completeOpts = {
    model,
    maxTokens,
    system: toNeutralBlocks(prompt.systemBlocks),
    user: toNeutralBlocks(prompt.userContent),
    responseFormat: {
      kind: 'json_schema' as const,
      schema: { ...prompt.schema },
    },
    ...(signal ? { signal } : {}),
  }
  // Stream when both signals are present: caller asked for it AND the
  // provider supports it. Otherwise the non-streaming path runs
  // unchanged — test fakes without streamComplete still work, and
  // OpenAI's stub (single delta at end) degrades gracefully.
  const wantStream = onTextDelta !== undefined && provider.streamComplete
  let completion
  try {
    if (wantStream) {
      // Prepend a per-file marker so multi-file bundles are visually
      // separable in the consumer (the save dialog accumulates the
      // text verbatim). Cheap; fires once per file before any token
      // deltas arrive. (Single-file path only — multi-file disables
      // streaming entirely, see applyLLMPatch.)
      try {
        onTextDelta!(`\n--- ${file} ---\n`)
      } catch {
        // Ignore — same swallow as the provider's onTextDelta path.
      }
      completion = await provider.streamComplete!(completeOpts, onTextDelta)
    } else {
      completion = await provider.complete(completeOpts)
    }
  } catch (err) {
    return {
      ok: false,
      reason: `LLM call failed for '${file}': ${(err as Error).message}`,
    }
  }

  if (!completion.text) {
    return {
      ok: false,
      reason: `LLM produced no text block for '${file}'.`,
    }
  }
  if (completion.parsed === undefined) {
    return {
      ok: false,
      reason: `LLM response for '${file}' was not valid JSON: ${completion.text.slice(0, 120)}`,
    }
  }
  const parsed = completion.parsed as PatchResponseShape

  // Verify every input mutationId appears in perMutationOutcome.
  if (!Array.isArray(parsed.perMutationOutcome)) {
    return {
      ok: false,
      reason: `LLM response for '${file}' missing perMutationOutcome array.`,
    }
  }
  // Validate each outcome row: known shape, allowed enum, no
  // duplicates, no extras (codex round-1 P3 #1).
  const expectedIds = new Set(muts.map((m) => m.id))
  const seenIds = new Set<string>()
  for (const row of parsed.perMutationOutcome) {
    if (typeof row.mutationId !== 'string') {
      return {
        ok: false,
        reason: `LLM response for '${file}' has an outcome row missing mutationId.`,
      }
    }
    if (!ALLOWED_OUTCOMES.has(row.outcome)) {
      return {
        ok: false,
        reason: `LLM response for '${file}' has invalid outcome='${row.outcome}' for mutation ${row.mutationId}.`,
      }
    }
    if (!expectedIds.has(row.mutationId)) {
      return {
        ok: false,
        reason: `LLM response for '${file}' has outcome for unknown mutationId='${row.mutationId}'.`,
      }
    }
    if (seenIds.has(row.mutationId)) {
      return {
        ok: false,
        reason: `LLM response for '${file}' has duplicate outcome for mutation ${row.mutationId}.`,
      }
    }
    seenIds.add(row.mutationId)
  }
  const missing = muts.filter((m) => !seenIds.has(m.id)).map((m) => m.id)
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `LLM response for '${file}' missing outcomes for mutations: ${missing.join(', ')}.`,
    }
  }
  if (typeof parsed.newSource !== 'string') {
    return {
      ok: false,
      reason: `LLM response for '${file}' missing newSource string.`,
    }
  }
  // Strip code-fence framing the LLM occasionally adds despite the
  // schema (json_schema constrains shape but not content). The Phase
  // D route handler should additionally re-parse the patched source
  // with @vue/compiler-sfc before writing it to disk — that's the
  // last line of defense against malformed output reaching the file
  // system.
  const newSource = stripCodeFences(parsed.newSource)

  return {
    ok: true,
    file,
    newSource,
    outcomes: parsed.perMutationOutcome,
    note: parsed.notes ? `[${file}] ${parsed.notes}` : undefined,
  }
}

/**
 * Translate the prompt builder's Anthropic-shaped blocks (with
 * `cache_control: { type: 'ephemeral' }`) into the vendor-neutral
 * `ContentBlock[]` shape the provider interface accepts. Anthropic's
 * impl re-attaches `cache_control` from `cacheHint`; other providers
 * silently ignore it.
 */
function toNeutralBlocks(
  blocks: ReadonlyArray<{
    type: 'text'
    text: string
    cache_control?: { type: 'ephemeral' }
  }>,
): ContentBlock[] {
  return blocks.map((b) => {
    const out: ContentBlock = { type: 'text', text: b.text }
    if (b.cache_control?.type === 'ephemeral') {
      out.cacheHint = 'ephemeral'
    }
    return out
  })
}

/**
 * Strip leading/trailing markdown code-fence framing the LLM sometimes
 * adds despite the schema constraint. Catches the common cases: triple-
 * backtick fences with optional `vue`/`html` language tag.
 */
function stripCodeFences(s: string): string {
  let out = s.trim()
  const opening = out.match(/^```(?:vue|html|xml)?\s*\n/)
  if (opening) {
    out = out.slice(opening[0].length)
    if (out.endsWith('```')) {
      out = out.slice(0, -3).replace(/\n+$/, '')
    } else if (out.endsWith('```\n')) {
      out = out.slice(0, -4)
    }
  }
  return out
}

/**
 * Parse `data-desde-src` value `"file:line:col"` into its file component.
 * The file may itself contain colons on exotic paths, so split from the
 * right and take everything before the second-to-last colon. Mirrors
 * `getSourceLocation` in `src/bridge/comment-bridge.ts`.
 */
export function parseSourceLocFile(sourceLoc: string): string | null {
  const lastColon = sourceLoc.lastIndexOf(':')
  if (lastColon < 0) return null
  const secondLast = sourceLoc.lastIndexOf(':', lastColon - 1)
  if (secondLast < 0) return null
  return sourceLoc.slice(0, secondLast) || null
}

/**
 * Cross-file 'this-instance' edits route to the parent SFC at
 * `callsiteLoc` instead of the host SFC at `sourceLoc`. This helper
 * gates that decision in one place so the byFile keying and the
 * v-for ambiguity check stay in sync.
 */
export function isCrossFileInstanceEdit(m: Mutation): boolean {
  return (
    m.scope === 'callsite' &&
    m.disambiguationChoice === 'this-instance' &&
    m.callsiteLoc !== null
  )
}

/**
 * Resolve the *patch file* for a mutation — i.e. which SFC the LLM
 * should rewrite. For cross-file 'this-instance' edits, this is the
 * parent SFC at `callsiteLoc`. Otherwise it's the host SFC at
 * `sourceLoc`. Returns `{ ok: false }` with a reason on malformed input.
 */
export function patchFileFor(
  m: Mutation,
): { ok: true; file: string } | { ok: false; reason: string } {
  if (isCrossFileInstanceEdit(m)) {
    const file = parseSourceLocFile(m.callsiteLoc!)
    if (!file) {
      return {
        ok: false,
        reason: `has malformed callsiteLoc='${m.callsiteLoc}'.`,
      }
    }
    return { ok: true, file }
  }
  if (!m.sourceLoc) {
    return { ok: false, reason: `has no sourceLoc.` }
  }
  const file = parseSourceLocFile(m.sourceLoc)
  if (!file) {
    return {
      ok: false,
      reason: `has malformed sourceLoc='${m.sourceLoc}'.`,
    }
  }
  return { ok: true, file }
}

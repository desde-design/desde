/**
 * LLM one-shot hint-generation lane — Phase 4 "rendering hints at scale"
 * (Task 5). The last-resort lane for components neither the probe
 * (`derive-hints.ts`/`probe-driver.ts`, Task 3) nor source inference
 * (`infer-from-source.ts`, Task 4) could produce ANY hint for. Opt-in only
 * (`generate-hints-run.ts`'s `useLlm` gate) — this lane costs a real LLM
 * call per component, so it never runs unless the caller explicitly asks.
 *
 * ── Shape of the work ──
 *
 * For each targeted component: one `provider.complete({ responseFormat:
 * json_schema })` call carrying the component's manifest props/slots
 * (names, types, descriptions) plus, best-effort, up to 8KB of its resolved
 * dist source (`resolveDistExcerpt`) — no docs scraping in V1. The response
 * is HAND-VALIDATED per hint (never trust `.parsed` blindly, mirroring
 * `apply-llm-patch.ts`'s posture): a hint whose `source.name` isn't one of
 * the manifest's own prop/slot names, or whose selector/field/attribute
 * shape doesn't satisfy the conservative rules below, is silently dropped
 * — REJECTION IS PER-HINT, NOT PER-BATCH, so one bad hint in a response
 * doesn't discard the rest. Every surviving hint is stamped
 * `provenance: 'generated', verified: false` — unverified LLM output is
 * harmless by construction: `isTrustedHint`
 * (`src/editor/attribution/attribute.ts`) keeps it out of the
 * deterministic attribution lane until independently confirmed.
 *
 * ── Post-generation probe verification ──
 *
 * A component that reached this lane failed the ORIGINAL sentinel probe
 * (no match at any string prop / the default slot) but may still be
 * MOUNTABLE (Task 3's probe already confirmed the mount succeeded — it
 * just found nothing). For exactly those components, {@link
 * runLlmHintsLane} re-mounts with a sentinel on ONLY the ONE prop/slot the
 * LLM claims a hint for, and checks whether the CLAIMED selector+field
 * actually surfaces it — pass flips `verified: true` (functionally
 * identical to a probe-derived hint from that point on); fail/unmountable
 * leaves it `verified: false`. This reuses `derive-hints.ts`'s own
 * `resolveMatch` ambiguity policy rather than re-deriving it.
 *
 * ── Budget ──
 *
 * `maxComponents` (default 100) caps how many components get an LLM call
 * at all — anything past the cap is reported skipped with reason
 * `'llm budget'`, never silently dropped. `maxConcurrency` (default 4)
 * bounds concurrent LLM calls via the SAME `mapWithConcurrency` helper
 * `apply-llm-patch.ts` uses (now shared at `../core/concurrency`) — LLM
 * calls are network-bound and safe to parallelize. Probe verification runs
 * AFTER all LLM calls settle, sequentially, one mount at a time — mirrors
 * `generate-hints-run.ts`'s own "concurrency 1: ONE ProbePage" invariant
 * (the caller only ever has one live page to reuse).
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import type { ComponentManifest, ComponentPropManifest, RenderingHint } from '../core/manifest'
import { mapWithConcurrency } from '../core/concurrency'
import { getProvider } from '../llm-providers/registry'
import type { CompletionProvider } from '../llm-providers/types'
import { dropCollidingHints, resolveMatch, type ProbeFn } from './derive-hints'
import type { ProbeMountSpec, ProbeObservation } from './probe-driver'
import type { GenerateHintsSkip } from './generate-hints-run'

const DEFAULT_MAX_COMPONENTS = 100
const DEFAULT_MAX_CONCURRENCY = 4
/** Hard cap on the dist-source excerpt handed to the model. */
const MAX_DIST_EXCERPT_BYTES = 8 * 1024

// ──────────────── per-component LLM call + validation ────────────────

/** JSON schema constraining the model's response — one entry per claimed rendering site. */
export const HINTS_SCHEMA = {
  type: 'object',
  properties: {
    hints: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['prop', 'slot'] },
              name: { type: 'string' },
            },
            required: ['kind', 'name'],
            additionalProperties: false,
          },
          domTarget: {
            type: 'object',
            properties: {
              selector: { type: 'string' },
              field: { type: 'string', enum: ['textContent', 'attribute', 'innerHTML'] },
              attribute: { type: 'string' },
            },
            required: ['selector', 'field'],
            additionalProperties: false,
          },
        },
        required: ['source', 'domTarget'],
        additionalProperties: false,
      },
    },
  },
  required: ['hints'],
  additionalProperties: false,
} as const

export interface GenerateLlmHintsForComponentOptions {
  manifest: ComponentManifest
  /** Up to 8KB of the component's resolved dist source — see {@link resolveDistExcerpt}. Omitted when unresolvable. */
  distSourceExcerpt?: string
  /** Injected for tests; defaults to the registry's default provider (same acquisition path as `apply-llm-patch.ts`). */
  provider?: CompletionProvider
  /** Defaults to `provider.defaultModel` — never hardcode a model id. */
  model?: string
  signal?: AbortSignal
}

export interface GenerateLlmHintsOutcome {
  /** `false` only on an LLM/transport failure or an unparseable response — NOT when the model legitimately found nothing. */
  ok: boolean
  reason?: string
  /** Validated hints — empty when the model found nothing, or every claimed hint failed hand-validation. */
  hints: RenderingHint[]
}

/**
 * Call the LLM once for ONE component and hand-validate its response.
 * Never throws — a provider error or unparseable response resolves to
 * `{ ok: false, reason, hints: [] }`; the caller counts this as skipped and
 * moves on (never fatal to the batch).
 */
export async function generateLlmHintsForComponent(
  opts: GenerateLlmHintsForComponentOptions,
): Promise<GenerateLlmHintsOutcome> {
  const provider = opts.provider ?? getProvider()
  const model = opts.model ?? provider.defaultModel

  let completion
  try {
    completion = await provider.complete({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(opts.manifest, opts.distSourceExcerpt),
      model,
      responseFormat: { kind: 'json_schema', schema: HINTS_SCHEMA },
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch (err) {
    return { ok: false, reason: `LLM call failed: ${errMessage(err)}`, hints: [] }
  }

  if (completion.parsed === undefined) {
    return {
      ok: false,
      reason: `LLM response was not valid JSON: ${completion.text.slice(0, 200)}`,
      hints: [],
    }
  }

  const raw = completion.parsed as { hints?: unknown }
  if (!Array.isArray(raw.hints)) {
    return { ok: false, reason: 'LLM response missing hints array', hints: [] }
  }

  return { ok: true, hints: validateLlmHints(raw.hints, opts.manifest) }
}

const SYSTEM_PROMPT = `You are helping ground a design-system component's rendering hints for a visual editor. Given a component's manifest (props/slots) and, when available, an excerpt of its compiled source, report where each prop or slot's value ends up in the component's rendered DOM.

Rules:
- Only report a prop/slot that is EXACTLY one of the names listed in the manifest — never invent a name.
- "selector" is a CSS selector rooted at the component's own mount-root element. Use ":root" when the value renders at the mount root itself. Prefer simple descendant/child selectors; never use commas (multiple selectors) or pseudo-classes/pseudo-elements.
- "field" is "textContent" when the value appears as text, "attribute" when it sets an HTML attribute (also set "attribute" to the attribute name), or "innerHTML" when it's rendered as raw markup.
- If you aren't confident where a prop/slot renders, omit it — an incomplete but correct list is far more useful than a guess.
- Respond with JSON conforming to the provided schema only.`

function buildUserPrompt(manifest: ComponentManifest, distSourceExcerpt?: string): string {
  const propLines = manifest.props.map((p) => describeProp(p)).join('\n')
  const slotLines = (manifest.slots ?? [])
    .map((s) => `- slot "${s.name}"${s.description ? `: ${s.description}` : ''}`)
    .join('\n')

  const parts = [
    `Component: ${manifest.name}`,
    propLines ? `Props:\n${propLines}` : 'Props: (none)',
    slotLines ? `Slots:\n${slotLines}` : 'Slots: (none)',
  ]
  if (distSourceExcerpt) {
    parts.push(`Compiled source excerpt:\n\`\`\`\n${distSourceExcerpt}\n\`\`\``)
  }
  return parts.join('\n\n')
}

function describeProp(p: ComponentPropManifest): string {
  const bits = [`- prop "${p.name}" (type: ${p.type})`]
  if (p.description) bits.push(`— ${p.description}`)
  return bits.join(' ')
}

// ──────────────── hand-validation (reject per-hint, not per-batch) ────────────────

const ALLOWED_FIELDS: ReadonlySet<string> = new Set(['textContent', 'attribute', 'innerHTML'])
const MAX_SELECTOR_LENGTH = 200

/**
 * Validate the model's raw `hints` array against the component's OWN
 * manifest, dropping anything that doesn't check out. Every survivor is
 * stamped `kind: 'dom'` (V1 never emits `forward` hints from the LLM lane),
 * `editability: 'literal'`, `provenance: 'generated'`, `verified: false`.
 * Exported for direct unit testing of the rejection rules.
 */
export function validateLlmHints(raw: unknown, manifest: ComponentManifest): RenderingHint[] {
  if (!Array.isArray(raw)) return []
  const propNames = new Set(manifest.props.map((p) => p.name))
  const slotNames = new Set((manifest.slots ?? []).map((s) => s.name))
  const out: RenderingHint[] = []
  for (const item of raw) {
    const hint = validateOneLlmHint(item, propNames, slotNames)
    if (hint) out.push(hint)
  }
  return out
}

function validateOneLlmHint(
  item: unknown,
  propNames: ReadonlySet<string>,
  slotNames: ReadonlySet<string>,
): RenderingHint | null {
  if (!item || typeof item !== 'object') return null
  const obj = item as Record<string, unknown>
  const source = obj.source
  const domTarget = obj.domTarget
  if (!source || typeof source !== 'object') return null
  if (!domTarget || typeof domTarget !== 'object') return null

  const sourceObj = source as Record<string, unknown>
  const kind = sourceObj.kind
  const name = sourceObj.name
  if (kind !== 'prop' && kind !== 'slot') return null
  if (typeof name !== 'string' || name.length === 0) return null
  const known = kind === 'prop' ? propNames.has(name) : slotNames.has(name)
  if (!known) return null

  const domObj = domTarget as Record<string, unknown>
  const selector = domObj.selector
  if (!isAllowedSelector(selector)) return null

  const field = domObj.field
  if (typeof field !== 'string' || !ALLOWED_FIELDS.has(field)) return null

  let attribute: string | undefined
  if (field === 'attribute') {
    if (typeof domObj.attribute !== 'string' || domObj.attribute.length === 0) return null
    attribute = domObj.attribute
  }

  return {
    kind: 'dom',
    source: { kind, name },
    domTarget: {
      selector,
      field: field as 'textContent' | 'attribute' | 'innerHTML',
      ...(attribute ? { attribute } : {}),
    },
    editability: 'literal',
    provenance: 'generated',
    verified: false,
  }
}

/**
 * Conservative selector gate: non-empty, ≤200 chars, no combined-selector
 * commas, and no pseudo-classes/pseudo-elements other than the literal
 * `:root` (the one pseudo-class `RenderingHint.domTarget.selector` itself
 * uses to mean "the mount root"). `+`/`~` sibling combinators are rejected
 * too — only descendant (space) and child (`>`) combinators are allowed.
 * Exported for direct unit testing.
 */
export function isAllowedSelector(selector: unknown): selector is string {
  if (typeof selector !== 'string') return false
  if (selector.length === 0 || selector.length > MAX_SELECTOR_LENGTH) return false
  if (selector.includes(',')) return false
  if (selector.includes('+') || selector.includes('~')) return false
  if (selector === ':root') return true
  if (selector.includes(':')) return false
  return true
}

// ──────────────── best-effort dist-source resolution ────────────────

/** Bounds the dist-tree walk — mirrors `infer-from-source.ts`'s depth-6 convention. */
const DIST_DEPTH_LIMIT = 6

/** Directories never worth descending into looking for compiled component output. */
const DIST_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'test',
  'tests',
  '__tests__',
  'stories',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
])

/** Candidate extensions for a component's compiled/source file, most-source-like first. */
const DIST_CANDIDATE_EXTENSIONS = ['.vue', '.tsx', '.jsx', '.mjs', '.js', '.cjs'] as const

/**
 * Best-effort resolution of a component's compiled source file from an
 * installed (or ingested) package's root: search `<packageRoot>/dist`
 * first (the common case for a published design system), falling back to
 * a bounded walk of the whole `packageRoot` when no `dist` directory
 * exists or nothing matched inside it. Returns the first file whose
 * basename (extension stripped) exactly equals `componentName`, read and
 * truncated to `maxBytes`. Returns `undefined` — never throws — when
 * nothing resolves; callers omit the excerpt silently, per the Task 5
 * brief ("best-effort... omit silently when unresolvable").
 */
export function resolveDistExcerpt(
  packageRoot: string,
  componentName: string,
  maxBytes: number = MAX_DIST_EXCERPT_BYTES,
): string | undefined {
  const searchRoots = [join(packageRoot, 'dist'), packageRoot]
  for (const root of searchRoots) {
    const found = findComponentFile(root, componentName)
    if (!found) continue
    try {
      const buf = readFileSync(found)
      return buf.subarray(0, maxBytes).toString('utf8')
    } catch {
      // Unreadable (permissions, race with a concurrent delete) — try the
      // next search root rather than failing the whole lookup.
      continue
    }
  }
  return undefined
}

function findComponentFile(root: string, componentName: string): string | null {
  let best: string | null = null
  const walk = (dir: string, depth: number): void => {
    if (best || depth > DIST_DEPTH_LIMIT) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (best) return
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (DIST_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        walk(abs, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      for (const ext of DIST_CANDIDATE_EXTENSIONS) {
        if (entry.name === `${componentName}${ext}`) {
          best = abs
          break
        }
      }
    }
  }
  walk(root, 0)
  return best
}

// ──────────────── batch runner: budget + concurrency + probe verify ────────────────

export interface RunLlmHintsLaneOptions {
  /** Components with zero hints after probe+inference, in catalog order. */
  targets: ComponentManifest[]
  /**
   * Names of `targets` that mounted successfully during the EARLIER probe
   * pass (Task 3) — even though sentinel matching found nothing there.
   * Only these are eligible for post-generation probe verification; an
   * unmountable component's LLM hints stay `verified: false` forever.
   */
  mountable: ReadonlySet<string>
  /** The SAME probe function the earlier pass used — reused for verification mounts. Absent ⇒ no verification is ever attempted. */
  probe?: ProbeFn
  /** Best-effort dist-source resolver — absent ⇒ every component's prompt omits the source excerpt. */
  resolveDistExcerpt?: (manifest: ComponentManifest) => string | undefined
  /** Injected for tests; defaults to the registry's default provider. */
  provider?: CompletionProvider
  /** Defaults to `provider.defaultModel`. */
  model?: string
  /** Default 100 — components beyond the cap are skipped with reason 'llm budget', never called. */
  maxComponents?: number
  /** Default 4 — bounds concurrent LLM calls (verification always runs sequentially afterward). */
  maxConcurrency?: number
  /** Shared verification-sentinel suffix; defaults to a fixed string (tests can override for determinism). */
  sentinelSuffix?: string
  signal?: AbortSignal
}

export interface RunLlmHintsLaneResult {
  /** componentName → validated (and possibly probe-verified) hints, for components with ≥1 hint. */
  hints: Record<string, RenderingHint[]>
  skipped: GenerateHintsSkip[]
}

/**
 * Run the LLM hint-generation lane over `opts.targets`: LLM calls fan out
 * concurrently (bounded by `maxConcurrency`) since they're network-bound;
 * post-generation probe verification then runs sequentially over whatever
 * came back, since a probe mount is browser-bound and the caller has only
 * ONE live page. Never throws — every per-component failure (LLM error,
 * unparseable response, zero validated hints, over budget) is folded into
 * `skipped`.
 */
export async function runLlmHintsLane(
  opts: RunLlmHintsLaneOptions,
): Promise<RunLlmHintsLaneResult> {
  const maxComponents = opts.maxComponents ?? DEFAULT_MAX_COMPONENTS
  const maxConcurrency = opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
  const suffix = opts.sentinelSuffix ?? 'llmverify'

  const withinBudget = opts.targets.slice(0, maxComponents)
  const overBudget = opts.targets.slice(maxComponents)

  const hints: Record<string, RenderingHint[]> = {}
  const skipped: GenerateHintsSkip[] = []

  type GenEntry = { manifest: ComponentManifest; outcome: GenerateLlmHintsOutcome }
  const genResults = await mapWithConcurrency<ComponentManifest, GenEntry>(
    withinBudget,
    maxConcurrency,
    async (manifest) => {
      const distSourceExcerpt = opts.resolveDistExcerpt?.(manifest)
      const outcome = await generateLlmHintsForComponent({
        manifest,
        distSourceExcerpt,
        provider: opts.provider,
        model: opts.model,
        signal: opts.signal,
      })
      return { manifest, outcome }
    },
  )

  for (const entry of genResults) {
    if (!entry) continue
    const { manifest, outcome } = entry
    if (!outcome.ok) {
      skipped.push({ name: manifest.name, reason: outcome.reason ?? 'llm call failed' })
      continue
    }
    if (outcome.hints.length === 0) {
      skipped.push({ name: manifest.name, reason: 'llm produced no usable hints' })
      continue
    }

    let finalHints = outcome.hints
    if (opts.probe && opts.mountable.has(manifest.name)) {
      finalHints = await verifyHintsViaProbe(manifest, outcome.hints, opts.probe, suffix)
    }
    // C1 safety guard: the model can claim two different props/slots for
    // the same rendering site in one response (`validateLlmHints` only
    // checks each hint in isolation) — drop any such collision rather than
    // let a possibly-verified-but-wrong hint reach the cache. See
    // `dropCollidingHints`'s doc comment.
    const deduped = dropCollidingHints(finalHints)
    if (deduped.length === 0) {
      skipped.push({ name: manifest.name, reason: 'llm hints dropped: cross-prop selector collision' })
      continue
    }
    hints[manifest.name] = deduped
  }

  for (const manifest of overBudget) {
    skipped.push({ name: manifest.name, reason: 'llm budget' })
  }

  return { hints, skipped }
}

/**
 * Re-mount `manifest` once PER HINT, each time setting a sentinel on ONLY
 * that hint's claimed prop/slot, and check whether the CLAIMED
 * selector+field (+attribute) actually surfaces it. A confirmed hint is
 * returned with `verified: true`; everything else is returned unchanged.
 * Sequential by design — see module doc comment.
 */
async function verifyHintsViaProbe(
  manifest: ComponentManifest,
  hints: RenderingHint[],
  probe: ProbeFn,
  sentinelSuffix: string,
): Promise<RenderingHint[]> {
  const out: RenderingHint[] = []
  for (let i = 0; i < hints.length; i++) {
    const hint = hints[i]
    const verified = await verifyOneHintViaProbe(manifest, hint, probe, `PT_LLM_${i}_${sentinelSuffix}`)
    out.push(verified ? { ...hint, verified: true } : hint)
  }
  return out
}

async function verifyOneHintViaProbe(
  manifest: ComponentManifest,
  hint: RenderingHint,
  probe: ProbeFn,
  sentinelValue: string,
): Promise<boolean> {
  if (hint.kind !== 'dom' || !manifest.importPath) return false

  const spec: ProbeMountSpec =
    hint.source.kind === 'prop'
      ? {
          importPath: manifest.importPath,
          exportName: manifest.name,
          props: { [hint.source.name]: sentinelValue },
        }
      : {
          importPath: manifest.importPath,
          exportName: manifest.name,
          props: {},
          slotText: sentinelValue,
        }

  let observation: ProbeObservation
  try {
    observation = await probe(spec)
  } catch {
    return false
  }
  if (!observation.ok) return false

  const finding = observation.findings.find(
    (f) => f.propOrSlot.kind === hint.source.kind && f.propOrSlot.name === hint.source.name,
  )
  if (!finding) return false

  const resolved = resolveMatch(finding.matches)
  if (!resolved) return false

  // The probe found the sentinel on DOM belonging to a CHILD component, so
  // this `dom` hint describes markup its own component does not own. Selector
  // and field can still match perfectly — the LLM read the rendered output,
  // and the rendered output is right — but `attribute()` matches a dom hint
  // against the element's OWNING component's mount root, so this one can never
  // be consulted. Stamping it `verified: true` would promote a permanently
  // unreachable hint into the trusted, deterministic lane.
  //
  // Refuse verification rather than convert it to a forward hint here: this
  // function answers one yes/no question about a hint it was handed, and the
  // probe-derivation lane already emits the forward hint for this case.
  if (resolved.ownedByChild) return false

  if (resolved.selector !== hint.domTarget.selector) return false
  if (resolved.field !== hint.domTarget.field) return false
  if (hint.domTarget.field === 'attribute' && resolved.attribute !== hint.domTarget.attribute) {
    return false
  }
  return true
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

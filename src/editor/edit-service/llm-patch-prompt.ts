/**
 * Prompt builder for `apply-llm-patch.ts`. Splits the request into:
 *
 * - **System** — frozen patch instructions + JSON schema. Cached aggressively
 *   (changes only with prompt-engineering revisions to this file).
 * - **User content blocks** — project style context, then original source,
 *   then the mutations payload. Each block has its own `cache_control`
 *   breakpoint so the LLM can reuse cache reads across saves: project
 *   context is the most stable, source per-file changes only when that
 *   file is patched, and mutations are the per-save volatile content.
 *
 * Designed to be testable without a live API call: `buildPatchPrompt`
 * returns plain JSON-serializable structures the caller hands to the
 * Anthropic SDK.
 */

import type { Mutation } from '../core/edit'
import type { DesignToken, TokenCategory } from '../core/design-tokens'
import type { ProjectKnowledge } from '../core/project-knowledge'
import {
  PROJECT_KNOWLEDGE_GUIDANCE,
  renderProjectKnowledgeBlock,
} from './render-project-knowledge'

/**
 * Project-level styling priors handed to the LLM patch/repair/agent
 * prompts. v2 (2026-07-25, grounding-phase2-tokens task 4): tokens now come
 * from the grounding seam (`GroundingService.tokens`, a `DesignTokenSource`
 * composed over the prototype's installed design-system + app stylesheets)
 * instead of this module's own raw-file scan. `rawStyleFallback` is the
 * escape hatch for substrates the token seam can't parse yet — populated
 * ONLY when the caller passed an empty `tokens` array. `classTaxonomy` and
 * `preprocessor` are unchanged: still a raw filesystem walk of `.vue` files
 * (see `load-style-grounding.ts`), since neither has a grounding-seam
 * equivalent.
 */
export interface ProjectStyleContext {
  /** Structured tokens from the grounding seam (may be empty). */
  tokens: readonly DesignToken[]
  /** Top-N most-used static class names from first-party `.vue` files. */
  classTaxonomy: string[]
  /** Detected SFC `<style lang="...">` preprocessor. */
  preprocessor: 'css' | 'scss' | 'sass' | 'less' | 'stylus' | 'unknown'
  /**
   * Raw fallback (old behavior: tailwind config text + token-file
   * fragments), populated ONLY when `tokens.length === 0` — the escape
   * hatch for substrates the token seam can't parse yet. Absent otherwise.
   */
  rawStyleFallback?: string
}

export interface BuildPatchPromptInput {
  file: string
  originalSource: string
  mutations: readonly Mutation[]
  projectStyleContext: ProjectStyleContext
  /**
   * The prototype repo's documented conventions. Rendered as a cached
   * user-content block right after the style context. Optional — absent
   * when the repo documents nothing or the caller skipped discovery.
   */
  projectKnowledge?: ProjectKnowledge
}

export interface BuildPatchPromptOutput {
  /** System prompt blocks. Last block carries cache_control. */
  systemBlocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>
  /** User message content blocks with per-block cache_control on stable ones. */
  userContent: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>
  /** JSON schema for the response. */
  schema: PatchResponseSchema
}

/**
 * The response JSON schema we constrain Claude to. The shell + service
 * verifies every input mutationId appears in `perMutationOutcome`
 * after the LLM responds.
 */
export interface PatchResponseSchema {
  type: 'object'
  properties: {
    newSource: { type: 'string' }
    perMutationOutcome: {
      type: 'array'
      items: {
        type: 'object'
        properties: {
          mutationId: { type: 'string' }
          outcome: { type: 'string'; enum: ['applied', 'skipped', 'refused'] }
          reason: { type: 'string' }
        }
        required: ['mutationId', 'outcome']
        additionalProperties: false
      }
    }
    notes: { type: 'string' }
  }
  required: ['newSource', 'perMutationOutcome']
  additionalProperties: false
}

const SCHEMA: PatchResponseSchema = {
  type: 'object',
  properties: {
    newSource: { type: 'string' },
    perMutationOutcome: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          mutationId: { type: 'string' },
          outcome: { type: 'string', enum: ['applied', 'skipped', 'refused'] },
          reason: { type: 'string' },
        },
        required: ['mutationId', 'outcome'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string' },
  },
  required: ['newSource', 'perMutationOutcome'],
  additionalProperties: false,
}

const SYSTEM_PROMPT = `You are a deterministic Vue Single-File Component (SFC) source-patching engine. You receive a Vue SFC source file plus a list of mutations captured from the rendered DOM in a designer's browser. Your job is to translate those mutations into precise edits to the source.

# Contract

For each mutation:
- \`kind\` is one of \`text\`, \`attr\`, \`class\`, \`style\`.
- \`sourceLoc\` is the build-time tag's "file:line:column" — this is where the mutation's host element was emitted. The source you receive contains that line.
- \`scope\` is \`definition\` (apply at the host component's template) or \`callsite\` (apply at the parent component's reference site).
- \`disambiguationChoice\` is \`this-instance\` (apply only at this call site, even though the v-for template contains multiple instances) or \`all-instances\` (apply to the v-for template, affecting every iteration). Absent when the source line has only one rendered instance.
- \`before\` and \`after\` are the literal old/new values for that mutation kind.

# Per-kind rules

V1 only handles \`text\` and \`attr\` mutations. The service layer hard-refuses \`class\` and \`style\` before they reach you.

- **text**: locate the element at \`sourceLoc\`'s line. The rendered text may mix static text nodes and Vue interpolations (\`{{ expr }}\`). Compute the \`before\` → \`after\` change and apply the SMALLEST source edit that produces it:
  - **Static text node** — replace the literal text matching \`before\` with \`after\`.
  - **Literal characters inside an interpolation** — string literals (\`'...'\`, \`"..."\`) and the static, non-\`\${}\` spans of template literals: when the \`before\` → \`after\` difference is confined to those literal characters, rewrite the literal in place, leaving every \`\${...}\` substitution and the surrounding logic byte-for-byte unchanged. Example: rendered \`Add (3)\` → \`Add 3\`, source \`Add {{ n > 0 ? \`(\${n})\` : '' }}\` → \`Add {{ n > 0 ? \`\${n}\` : '' }}\` (only the literal \`(\` and \`)\` are removed; \`\${n}\` is untouched).
  - **Refuse** with reason "text edit on bound expression — would require state mutation, not template change" ONLY when producing \`after\` would require changing state-derived output: the value inside a \`\${...}\` substitution, a bare interpolation of an identifier / computed / ref (\`{{ label }}\`, \`{{ user.name }}\`), \`v-text\`, \`v-html\`, or \`:innerText\`. Editing the literal scaffolding around a substitution is a template change and IS allowed; editing the substituted value is NOT.
  - If the literal \`before\` text cannot be located at that line at all, refuse with reason "text 'before' value not found at sourceLoc".
- **attr**: locate the element. Replace the static attribute named \`target\` with the new value. If the attribute is a directive (\`:foo\`, \`v-bind:foo\`, \`:class\`, \`:style\`, \`v-model\`), refuse with reason "attribute edit on dynamic binding". \`@click\` and other event handlers also count as dynamic — refuse.

# Outcome semantics (precise)

For each input mutation, exactly one of:

- **\`applied\`** — the patch was made. Every \`applied\` outcome corresponds to a byte-level change in \`newSource\` relative to the original.
- **\`skipped\`** — the mutation reached this engine but you intentionally chose not to apply it because it wouldn't change the rendered output (e.g., \`before === after\`, or the requested change is already present in the source). \`newSource\` is unchanged for that mutation. Always include a \`reason\`.
- **\`refused\`** — the mutation cannot be safely applied (dynamic binding, ambiguous location, this-instance edit across files, etc.). \`newSource\` is unchanged for that mutation. Always include a \`reason\`.

If multiple mutations target the same file and one refuses, OTHER mutations in the same file may still be \`applied\` against the source-as-modified-by-prior-mutations. The bundle is atomic at the file level, not the mutation level.

# Patch-file routing (which file you're looking at)

Each request gives you ONE source file. The mutations targeting that file may have been routed to it via two different paths:

1. **Host-template edits** (the source is the component's own SFC). Patch the element at \`sourceLoc\`'s line:column directly. This applies to:
   - \`scope === "definition"\` mutations.
   - \`scope === "callsite"\` AND \`disambiguationChoice === "all-instances"\` (all v-for iterations get the same change → patch the v-for template in the host).

2. **Cross-file call-site edits** (the source is the PARENT SFC where the component is referenced). Patch the call-site element at \`callsiteLoc\`'s line:column. This applies to \`scope === "callsite"\` AND \`disambiguationChoice === "this-instance"\`.

# Cross-file rewriting rules

When you patch at \`callsiteLoc\` (case 2 above), the call-site is a component reference like \`<UiButton variant="primary">Submit</UiButton>\`. The mutation captured a DOM change inside the rendered component's tree, but you must express the change at the call-site level (not by editing the component's internals — that file isn't in this request).

Translate per kind:

- **text on the call-site element's default slot** (the mutation's \`sourceLoc\` element corresponds to the call-site's text content / default slot): replace the slot content. \`<UiButton>Submit</UiButton>\` → \`<UiButton>Save</UiButton>\`. If the call-site is self-closing (\`<UiButton variant="primary"/>\`), expand it: \`<UiButton variant="primary">Save</UiButton>\`. If the call-site already has structured slot template syntax (\`<template #default>...\`), edit inside that template.

- **attr on a prop the call-site already passes** (e.g. mutation says \`variant: "primary" → "danger"\` and the call-site has \`variant="primary"\`): rewrite the attribute value at the call-site. Both static (\`variant="primary"\`) and dynamic (\`:variant="'primary'"\` with a literal value) forms work the same. Refuse with reason "attribute edit on dynamic binding" if the call-site has a non-literal binding (\`:variant="someRef"\`, computed, etc).

- **attr on a prop the call-site doesn't yet pass**: add it. \`<UiButton>Save</UiButton>\` + mutation \`variant: "" → "danger"\` → \`<UiButton variant="danger">Save</UiButton>\`. Place new attributes before the closing \`>\` of the open tag, after existing attributes.

- **deep DOM edits** (the mutation's \`sourceLoc\` corresponds to an element nested INSIDE the rendered component, not the component's root): refuse with reason "deep-dom-this-instance-not-supported — call-site override only handles the slot/prop surface, not internal DOM".

- **mutation describes slot content already passed at the call-site**: identify the named slot from the mutation context. \`<UiCard><template #header>Title</template></UiCard>\` + mutation on the header text → edit inside \`<template #header>\`. Refuse if the named slot isn't visible at this call-site with reason "slot-content-needs-instance-edit at <selector>" — the engineer needs to add the slot template first.

If \`scope === "definition"\`, edit the host's template directly (case 1, no translation needed).

# Output

Respond with JSON conforming to the provided schema:
- \`newSource\`: the complete patched SFC source. Preserve formatting, indentation, and every byte not covered by an applied mutation. If you applied no mutations, return \`newSource\` equal to the original.
- \`perMutationOutcome\`: one entry per input mutation, in input order. \`outcome\` is \`applied\` / \`skipped\` / \`refused\`; include \`reason\` for skipped/refused (and applied if non-obvious).
- \`notes\` (optional): any cross-cutting concerns about the patch.

Determinism: re-running with the same inputs MUST produce the same \`newSource\`. Do not add comments, reorder unrelated content, or normalize formatting. Touch only the bytes a mutation requires.

If multiple mutations target the same line, apply them in input order — each subsequent mutation operates on the source-as-modified-by-prior-mutations.`

export function buildPatchPrompt(input: BuildPatchPromptInput): BuildPatchPromptOutput {
  const { file, originalSource, mutations, projectStyleContext, projectKnowledge } =
    input

  const systemBlocks: BuildPatchPromptOutput['systemBlocks'] = [
    {
      type: 'text',
      // The project-knowledge guidance is appended unconditionally — it is
      // harmless when no conventions block is present and keeps the cached
      // system prefix identical whether or not a given prototype has rules.
      text: `${SYSTEM_PROMPT}\n\n${PROJECT_KNOWLEDGE_GUIDANCE}`,
      cache_control: { type: 'ephemeral' },
    },
  ]

  // Project style context: stable across saves → cacheable.
  const styleContextText = renderStyleGrounding(projectStyleContext)
  const sourceText = renderSourceBlock(file, originalSource)
  const mutationsText = renderMutationsBlock(mutations)

  const userContent: BuildPatchPromptOutput['userContent'] = [
    { type: 'text', text: styleContextText, cache_control: { type: 'ephemeral' } },
  ]

  // Project conventions block: stable per-commit (the digest only changes
  // when the repo's rules files change), so it is cacheable and sits right
  // after the style context. Omitted entirely when the repo documents
  // nothing — an empty cached block would just waste a cache breakpoint.
  const knowledgeText = projectKnowledge
    ? renderProjectKnowledgeBlock(projectKnowledge)
    : ''
  if (knowledgeText) {
    userContent.push({
      type: 'text',
      text: knowledgeText,
      cache_control: { type: 'ephemeral' },
    })
  }

  userContent.push(
    { type: 'text', text: sourceText, cache_control: { type: 'ephemeral' } },
    // No cache_control on mutations — they vary every save.
    { type: 'text', text: mutationsText },
  )

  return { systemBlocks, userContent, schema: SCHEMA }
}

/** Fixed category order tokens render in — mirrors {@link TokenCategory}. */
const TOKEN_CATEGORY_ORDER: readonly TokenCategory[] = [
  'color',
  'space',
  'font-size',
  'font-weight',
  'line-height',
  'border-radius',
  'border-width',
  'shadow',
  'other',
]

/** Per-category and aggregate caps on how many tokens the prompt renders. */
const TOKENS_PER_CATEGORY_CAP = 40
const TOKENS_TOTAL_CAP = 200

/** `DesignToken.source` label the app's own stylesheet tokens are stamped with (`CssCustomPropertiesTokenSource`'s app-CSS instance — see `src/editor/adapters/css-custom-properties/index.ts` / the grounding composition site). */
const APP_STYLESHEETS_SOURCE = 'app-stylesheets'

/**
 * Renders the `# Project style context` block: tokens (grouped by category,
 * capped), then the class taxonomy, then the preprocessor, then — only when
 * present — the raw fallback block verbatim (the escape hatch for
 * substrates the token seam couldn't parse).
 */
export function renderStyleGrounding(ctx: ProjectStyleContext): string {
  const parts: string[] = ['# Project style context\n']

  if (ctx.tokens.length > 0) {
    parts.push(renderTokensSection(ctx.tokens))
  }

  if (ctx.classTaxonomy.length > 0) {
    parts.push('## Most-used class names in this prototype\n')
    parts.push(ctx.classTaxonomy.slice(0, 50).join(', ') + '\n')
  }

  parts.push(`Preprocessor: ${ctx.preprocessor}\n`)

  if (ctx.rawStyleFallback) {
    parts.push(ctx.rawStyleFallback)
  }

  return parts.join('\n')
}

/**
 * Groups tokens by category (in {@link TOKEN_CATEGORY_ORDER}), capping each
 * category at {@link TOKENS_PER_CATEGORY_CAP} and the running total at
 * {@link TOKENS_TOTAL_CAP}. Any tokens dropped by either cap are summarized
 * with a `…and N more <category> tokens` line rather than silently omitted.
 */
function renderTokensSection(tokens: readonly DesignToken[]): string {
  const byCategory = new Map<string, DesignToken[]>()
  for (const token of tokens) {
    const bucket = byCategory.get(token.category)
    if (bucket) bucket.push(token)
    else byCategory.set(token.category, [token])
  }

  const orderedCategories = [
    ...TOKEN_CATEGORY_ORDER.filter((c) => byCategory.has(c)),
    ...[...byCategory.keys()].filter((c) => !TOKEN_CATEGORY_ORDER.includes(c as TokenCategory)),
  ]

  const lines: string[] = ['## Design tokens\n']
  let totalEmitted = 0
  for (const category of orderedCategories) {
    // App-first render order WITHIN the category (composite/collision
    // precedence — which token wins when names collide — is unaffected,
    // that stays package-first upstream in the composite source). A prototype
    // can easily have far more package tokens than app tokens in a
    // category (e.g. 300+ package color tokens vs. 3 app ones); sorting
    // app-stylesheets tokens first means the `TOKENS_PER_CATEGORY_CAP` cap
    // truncates package tokens before it ever reaches — and silently
    // crowds out — the user's own. `Array#sort` is stable (spec-guaranteed
    // since ES2019), so relative order within each group is preserved.
    const list = [...byCategory.get(category)!].sort((a, b) => {
      const aApp = a.source === APP_STYLESHEETS_SOURCE ? 0 : 1
      const bApp = b.source === APP_STYLESHEETS_SOURCE ? 0 : 1
      return aApp - bApp
    })
    if (totalEmitted >= TOKENS_TOTAL_CAP) {
      lines.push(`…and ${list.length} more ${category} tokens`)
      continue
    }
    const perCategoryLimit = Math.min(
      TOKENS_PER_CATEGORY_CAP,
      TOKENS_TOTAL_CAP - totalEmitted,
    )
    const shown = list.slice(0, perCategoryLimit)
    lines.push(`### ${category}`)
    for (const token of shown) {
      const description = token.description ? ` — ${token.description}` : ''
      lines.push(`- \`${token.name}\`: ${token.value}${description}`)
    }
    totalEmitted += shown.length
    if (shown.length < list.length) {
      lines.push(`…and ${list.length - shown.length} more ${category} tokens`)
    }
  }
  return lines.join('\n') + '\n'
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`
}

function renderSourceBlock(file: string, source: string): string {
  return `# Original source\n\nFile: \`${file}\`\n\n\`\`\`vue\n${source}\n\`\`\``
}

function renderMutationsBlock(mutations: readonly Mutation[]): string {
  const payload = mutations.map((m) => ({
    id: m.id,
    kind: m.kind,
    sourceLoc: m.sourceLoc,
    scope: m.scope,
    callsiteLoc: m.callsiteLoc,
    instancePath: m.instancePath,
    disambiguationChoice: m.disambiguationChoice,
    target: m.target,
    before: m.before,
    after: m.after,
    // Style/class context only when present (omit verbose payload otherwise).
    context: m.context
      ? {
          classListBefore: m.context.classListBefore,
          classListAfter: m.context.classListAfter,
          inlineStyleBefore: m.context.inlineStyleBefore,
          inlineStyleAfter: m.context.inlineStyleAfter,
          computedStyleDelta: m.context.computedStyleDelta,
          siblingClasses: m.context.siblingClasses,
          // domSnippet is heavy; truncate before sending.
          domSnippet: truncate(m.context.domSnippet, 1_000),
        }
      : undefined,
  }))
  return `# Mutations to apply\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``
}

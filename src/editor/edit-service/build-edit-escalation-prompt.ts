/**
 * Builds the chat seed prompt for a direct-manipulation edit that the
 * deterministic lane couldn't apply (`'chat'` fallback mode, i.e.
 * `edit.llmFallback === 'chat'`). The shell submits this to the
 * chat agent, which can read the file, reason about bound vs. static
 * source, ask when ambiguous, and edit with tools.
 *
 * Pure function: no React, no I/O. Accepts the structural subset of
 * {@link Mutation} it needs so it stays trivially unit-testable and
 * decoupled from the full edit type.
 */

export interface EscalationMutation {
  kind: "text" | "attr" | "class" | "style"
  /** `data-desde-src` "file:line:column" of the edited node, or null. */
  sourceLoc: string | null
  /** CSS selector for the edited element (human anchor). */
  selector: string
  /** Attribute / prop name for `attr` edits. Absent for text edits. */
  target?: string
  before: string
  after: string
}

/** Strip the trailing `:column` so the prompt reads `file:line`. */
function formatLocation(sourceLoc: string | null): string | null {
  if (!sourceLoc) return null
  const parts = sourceLoc.split(":")
  if (parts.length >= 3) {
    // file may itself contain ':' on exotic paths — keep all but the last
    // two segments (line, column) as the file, then show file:line.
    const column = parts.pop()
    void column
    const line = parts.pop()
    return `${parts.join(":")}:${line}`
  }
  return sourceLoc
}

function quote(value: string): string {
  if (value.length === 0) return '""'
  return `"${value}"`
}

function describeMutation(m: EscalationMutation): string {
  const where = formatLocation(m.sourceLoc)
  const at = where ? ` at ${where}` : ""
  const on = ` (selector: ${m.selector})`
  if (m.kind === "attr" && m.target) {
    return `Change the \`${m.target}\` attribute from ${quote(m.before)} to ${quote(m.after)}${at}${on}.`
  }
  if (m.kind === "text") {
    return `Change the text from ${quote(m.before)} to ${quote(m.after)}${at}${on}.`
  }
  // class / style fall through to a generic description.
  return `Change ${m.kind} from ${quote(m.before)} to ${quote(m.after)}${at}${on}.`
}

export function buildEditEscalationPrompt(
  mutations: readonly EscalationMutation[],
): string {
  const lines = mutations.map((m) => `- ${describeMutation(m)}`)
  const intro =
    mutations.length === 1
      ? "I tried to make this edit by directly manipulating the prototype, but it couldn't be applied automatically and needs your help."
      : `I tried to make ${mutations.length} edits by directly manipulating the prototype, but they couldn't be applied automatically and need your help.`
  return [
    intro,
    "",
    "Requested change:",
    ...lines,
    "",
    "Please apply this to the source. The rendered value may come from a binding, computed value, or expression — edit the right place in the template, and ask me if the intent is ambiguous.",
  ].join("\n")
}

/**
 * Strip the `@[Display Name](email)` mention encoding back to plain
 * `@Display Name` so the seed prompt reads naturally (the agent doesn't
 * care about the email-anchored encoding the UI uses for notifications).
 * Mirrors {@link MentionText}'s parse regex.
 */
export function decodeCommentMentions(body: string): string {
  return body.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, "@$1")
}

export interface CommentFixSeed {
  /** The comment text. Encoded mentions are decoded by the builder. */
  body: string
  /** CSS selector the comment is anchored to (`position.anchorSelector`). */
  selector: string
  /** The page the comment lives on (`position.page`). */
  page: string
  /**
   * Resolved `file:line` of the anchored element's source, when the shell
   * could resolve it (INSPECT_SELECTOR → editTarget). `null` when the
   * selector no longer matches or resolution wasn't attempted — the agent
   * then locates the element itself via the selector + a screenshot.
   */
  sourceLoc?: string | null
  /** Sequential comment number, for a human-readable reference. */
  number?: number
}

/**
 * Build the chat seed prompt for the per-comment "Fix with AI" affordance:
 * hand an anchored review comment to the agent so it reads the source and
 * applies the requested change, instead of the user re-typing the request
 * into chat. Pure — no React, no I/O.
 *
 * The selector alone is a weak anchor (often a long nth-of-type path the
 * agent can't map to source), so the prompt tells the agent to
 * `capture_screenshot` that selector to SEE the element, then locate it in
 * source. When `sourceLoc` is known it's stated up front as the strong
 * anchor.
 */
export function buildCommentFixPrompt(seed: CommentFixSeed): string {
  const body = decodeCommentMentions(seed.body).trim()
  const ref = seed.number ? ` (comment #${seed.number})` : ""
  const where = formatLocation(seed.sourceLoc ?? null)
  const anchorLines = [
    `  selector: ${seed.selector}`,
    ...(where ? [`  source: ${where}`] : []),
  ]
  return [
    `A reviewer left this comment on the prototype${ref} and wants it addressed:`,
    "",
    `"${body}"`,
    "",
    `It's anchored to an element on page "${seed.page}":`,
    ...anchorLines,
    "",
    "Please make the change the comment asks for by editing the prototype's source:",
    where
      ? `- Start from ${where} (the anchored element's source).`
      : `- To see exactly which element it refers to, call capture_screenshot with scope "selector" and the selector above.`,
    "- Locate the element in the source (use the grounding tools / the page's component) and apply the change.",
    "- If the comment is ambiguous or you can't find the element, ask me before editing.",
  ].join("\n")
}

export interface EscalationPropEdit {
  /** Prop / attribute name (e.g., 'placeholder', 'model-value'). */
  propName: string
  /**
   * New value the designer set. Type is preserved end-to-end (string for
   * text props, number for numeric props, boolean for boolean props) so the
   * chat prompt can render the value with correct JS semantics — e.g. a
   * numeric `42` rendered unquoted (not `"42"`) and `:disabled="true"` is
   * a literal boolean. Stringifying loses the distinction the agent needs
   * to edit the right kind of literal in source.
   */
  newValue: string | number | boolean
  /** Component name (e.g., 'KInput', 'DisplayNameInput'). */
  componentName?: string
  /** Consumer-file location of the component callsite. `file:line` form. */
  editTargetLocation: string | null
  /** CSS selector for the element (human anchor). */
  selector: string
}

/**
 * Render the new value the way it should appear as a JavaScript literal in
 * source: strings get quoted, numbers and booleans stay bare. The chat agent
 * uses this to decide between `placeholder="Filter"` and `:max="42"` /
 * `:disabled="true"` — getting the type wrong here causes wrong-literal
 * edits in source.
 */
function describePropValue(value: string | number | boolean): string {
  if (typeof value === "string") return quote(value)
  if (typeof value === "number") return `${value} (number literal)`
  return `${value} (boolean literal)`
}

/**
 * Build the chat seed prompt for a prop edit that BOTH the deterministic
 * applicator and the in-process source-aware LLM lane refused. The chat
 * agent has multi-file tool access — useful for the common case where the
 * binding traces to a prop, a parent SFC, or an imported constant.
 */
export function buildPropEditEscalationPrompt(edit: EscalationPropEdit): string {
  const where = edit.editTargetLocation ? ` at ${edit.editTargetLocation}` : ""
  const componentLabel = edit.componentName ? `<${edit.componentName}>` : "element"
  const intro =
    "I tried to change a prop on a component by directly manipulating the prototype, but the value comes from a binding or expression we couldn't rewrite automatically. I need your help to edit the right place in the source."
  return [
    intro,
    "",
    "Requested change:",
    `- Set the \`${edit.propName}\` prop on ${componentLabel}${where} to ${describePropValue(edit.newValue)} (selector: ${edit.selector}).`,
    "",
    "The current value is bound to a variable, prop, or computed expression — please trace the binding (possibly across files) and edit the source so the rendered value matches. Preserve the value's type (the requested change above tells you if it's a string, number, or boolean). Ask me if the intent is ambiguous.",
  ].join("\n")
}

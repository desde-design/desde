"use client"

/**
 * "From:" origin row — Layer 2 of inspector style provenance
 * (tasks/inspector-style-provenance.md). Renders an honest one-line
 * provenance summary under a style row (swatch/value), with a popover
 * exposing the full cascade chain (winning rule → var(--token) hops →
 * defining stylesheet). Solves "Failure B" (misleading reverse display):
 * the inspector stops guessing a Tailwind shade and shows where the
 * rendered value actually comes from.
 *
 * Polymorphic across every style row — it takes a single {@link StyleOrigin}
 * (one property's provenance) and renders nothing when there's nothing
 * useful to show (no winning rule, no inline override, no transient-state
 * explanation), so a row degrades silently to today's behavior.
 *
 * `transientRuleApplies` (N1) is the reason the third case exists. The bridge
 * resolves the winning rule for the element AT REST, but `computedValue` is a
 * live sample and clicking an element to inspect it puts the cursor on it — so
 * a hover-styled property showed a resting rule beside a hovered value, and a
 * hover-ONLY property showed no rule at all beside a real opaque colour. When
 * the flag is present the row says which state is live, which turns both cases
 * from a contradiction into an explanation.
 */
import type { StyleOrigin } from "@/types/bridge"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Callout, Eyebrow } from "@/components/blocks"
import { cn } from "@/lib/utils"

/**
 * Whether {@link StyleOriginRow} would render anything.
 *
 * Exported because callers that wrap the row in a bordered container have to
 * ask the SAME question the row asks, or they render an empty box. The style
 * scope dialog did exactly that: on the no-rule origin (no winning rule, no
 * inline style, no transient state) the row returned null inside a
 * `rounded-md border bg-muted/30` wrapper, so the user got a blank gray
 * rectangle where the provenance was meant to be. One predicate, two callers,
 * no drift.
 */
export function hasStyleOrigin(origin?: StyleOrigin): boolean {
  return (
    !!origin &&
    (!!origin.winningRule || !!origin.inline || !!origin.transientRuleApplies)
  )
}

export function StyleOriginRow({
  origin,
}: {
  origin?: StyleOrigin
}) {
  if (!hasStyleOrigin(origin) || !origin) return null

  const summary = summarize(origin)
  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* eslint-disable-next-line react/forbid-elements -- PopoverTrigger asChild integration; custom text-only link-style appearance (underline on hover, no border/bg) doesn't map to any Button variant without losing the inline text flow */}
        <button
          type="button"
          data-testid="style-origin-from"
          // 12px at full opacity, up from 10px at 70%. This row is the
          // grounding for the choice the dialog is asking the user to make, so
          // it has to be readable; at `text-2xs text-muted-foreground/70` it was
          // the faintest thing in a dialog it is meant to inform.
          // `focus-visible`, not `focus`: the plain `focus:` ring drew a teal
          // box around this row whenever it took focus at all, including the
          // focus the dialog hands out on open, so it read as a permanent
          // border on a line of text. Keyboard users still get the ring;
          // clicking into the dialog no longer paints one.
          className={cn(
            "block max-w-full truncate text-left underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            // The only caller left is the scope dialog, where a ValueReadout
            // already sets the mono face, size and colour for the value.
            "hover:underline",
          )}
          title="Where this value comes from. Click for the full chain."
        >
          {summary}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px] p-3 text-xs">
        <StyleOriginChain origin={origin} />
      </PopoverContent>
    </Popover>
  )
}

/** Compact one-line summary: token (if any) · winning selector · package. */
function summarize(origin: StyleOrigin): string {
  if (origin.inline) {
    return `inline style${origin.inline.important ? " !important" : ""}`
  }
  const transient = origin.transientRuleApplies
  const rule = origin.winningRule
  // Hover-only (or focus-only) property: at rest nothing declares it, so the
  // honest summary names the state instead of leaving the row blank.
  if (!rule) return `not set (only ${transient!.pseudoClass})`
  const parts: string[] = []
  // Flag inherited values so a blank-looking row reads honestly ("the value
  // comes from an ancestor, not this element").
  if (origin.inherited) parts.push("inherited")
  if (origin.varChain.length > 0) parts.push(origin.varChain[0].name)
  parts.push(rule.selector)
  const pkg = rule.stylesheet.package
  if (pkg) parts.push(pkg)
  // The rule shown is the resting one while a transient state is live — say so
  // on the collapsed line too, not only in the popover.
  if (transient) parts.push(`at rest · ${transient.pseudoClass} now`)
  return parts.join("  ·  ")
}

function StyleOriginChain({ origin }: { origin: StyleOrigin }) {
  const rule = origin.winningRule
  const transient = origin.transientRuleApplies
  return (
    <div className="space-y-2">
      <Eyebrow as="span" size="sm">
        {origin.property}
      </Eyebrow>

      {transient ? (
        <Callout
          tone="info"
          className="text-xs text-foreground"
          data-testid="style-origin-transient"
        >
          <span className="font-mono">{transient.pseudoClass}</span> currently
          applies, so the value on screen is the{" "}
          {transient.pseudoClass.replace(/^:/, "")} value.{" "}
          {rule
            ? `The rule below is the one that applies at rest: the one to edit.`
            : `No rule declares this property at rest; the only rule is the ${transient.pseudoClass} one.`}
        </Callout>
      ) : null}

      {origin.inline ? (
        <ChainEntry
          label="Inline style"
          value={`${origin.inline.value}${origin.inline.important ? " !important" : ""}`}
          sub="on this element"
        />
      ) : null}

      {rule ? (
        <ChainEntry
          label={origin.inherited ? "Inherited rule" : "Rule"}
          value={rule.declaration}
          sub={`${rule.selector}${rule.media ? `  @media ${rule.media}` : ""}${
            rule.pseudoClass ? `  ${rule.pseudoClass}` : ""
          }`}
          source={rule.stylesheet.package ?? rule.stylesheet.href}
        />
      ) : null}

      {origin.varChain.map((v) => (
        <ChainEntry
          key={v.name}
          label="Token"
          value={`${v.name}: ${v.value}`}
          sub={v.definedAt.selector}
          source={v.definedAt.stylesheet.package ?? v.definedAt.stylesheet.href}
        />
      ))}

      {origin.computedValue ? (
        <p className="border-t pt-1.5 text-xs text-muted-foreground/70">
          {transient ? "Computed (live, " + transient.pseudoClass + "): " : "Computed: "}
          <span className="font-mono">{origin.computedValue}</span>
        </p>
      ) : null}
    </div>
  )
}

function ChainEntry({
  label,
  value,
  sub,
  source,
}: {
  label: string
  value: string
  sub?: string
  source?: string
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline gap-1.5">
        <Eyebrow as="span" size="sm" className="shrink-0">
          {label}
        </Eyebrow>
        <span className="break-all font-mono text-code">{value}</span>
      </div>
      {sub ? <div className="font-mono text-code text-muted-foreground/70">{sub}</div> : null}
      {source ? (
        <div className="truncate font-mono text-code text-muted-foreground/50" title={source}>
          {source}
        </div>
      ) : null}
    </div>
  )
}

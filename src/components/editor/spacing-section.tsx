"use client"

import { useMemo, useState } from "react"
import { Maximize2, Minimize2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { SectionHeader, fieldRowClass, stackedLabelClass } from "./section-header"
import {
  applyClassMutation,
  parseGap,
  parseMargin,
  parsePadding,
  resolveSpacingSides,
  setGapAll,
  setMarginAll,
  setMarginSide,
  setPaddingAll,
  setPaddingSide,
  snapToSpacingScale,
  type ClassMutation,
  type ResolvedSpacingSides,
  type SpacingSide,
} from "./tailwind-classes"
import {
  inferGapAllAxes,
  inferSpacingAllSides,
  inferSpacingSides,
} from "./infer-from-computed"

/**
 * CSS properties the spacing section resolves provenance for. The all-sides
 * controls query the SHORTHANDS (`padding`/`margin`), not longhands: a rule
 * like `.acme-card { padding: var(--acme-space-…) }` declares the shorthand,
 * and CSSOM does NOT expand a shorthand whose value is an unresolved `var()`
 * into longhands — so a `padding-top` query would miss it. The shorthand is
 * also exactly what the all-sides control edits + what Tailwind `p-4` emits.
 */
export const SPACING_PROVENANCE_PROPERTIES = ["padding", "margin", "gap"]

interface SpacingSectionProps {
  /** Live class list from the bridge. */
  classes: readonly string[]
  /**
   * Live computed CSS from the bridge. Used as a fallback when the
   * class list carries no Tailwind utility for the property — e.g. a
   * Acme DS button styled by component-internal CSS shows its
   * actual padding instead of an empty input.
   */
  computedStyles?: Record<string, string>
  /** Phase 2/3 — route a style edit through the scope gate (property + next classes). */
  onScopedEdit?: (property: string, nextClasses: string[]) => void
  /**
   * Emit the new class list when the designer changes a value. Wired
   * up to `useEditorEditing.handleClassesEdit` which routes through
   * the bridge override + DOM-edit mutation log → llm-patch on save.
   */
  onClassesChange: (next: string[]) => void
}

/**
 * Designer-facing spacing controls. Reads `p-{n}` / `m-{n}` /
 * `gap-{n}` etc. out of the class list, exposes an all-sides numeric
 * input per property, and on change emits a class diff.
 *
 * **Mixed / per-side editing (Figma-style).** Padding and margin each
 * carry an expand toggle. Collapsed, they show a single all-sides input
 * (placeholder `mixed` when the sides disagree). Expanded, the all-sides
 * input is replaced in place by four thin top/right/bottom/left inputs
 * (labelless, side name on hover) so an asymmetric value is fully editable —
 * the all-sides input alone can't represent or edit `pt-2 pb-6`. Per-side
 * values resolve through the Tailwind cascade (side → axis → all) and fall
 * back to the live computed style when no class owns them, so a
 * component-CSS-styled element still surfaces real numbers per side.
 *
 * **Why number-snapping.** Tailwind doesn't ship classes for arbitrary
 * integers; only the spacing-scale steps (0, 0.5, 1, 1.5, 2, 2.5, …, 96)
 * resolve to actual utilities. Designer types `13` → snapped to `12`.
 */
export function SpacingSection({
  classes,
  computedStyles,
  onScopedEdit,
  onClassesChange,
}: SpacingSectionProps) {
  const padding = useMemo(() => parsePadding(classes), [classes])
  const margin = useMemo(() => parseMargin(classes), [classes])
  const gap = useMemo(() => parseGap(classes), [classes])

  const [expanded, setExpanded] = useState<{ padding: boolean; margin: boolean }>(
    { padding: false, margin: false },
  )

  // Computed-style fallbacks — only consulted when the class-derived
  // value is empty. Kept local so the existing SpacingSides shape used
  // by the mutators stays untouched (the mutator's `remove` list comes
  // from `padding.all?.raws` etc., which is correctly empty when the
  // displayed value comes from this fallback).
  const paddingFallback = useMemo(
    () =>
      isPaddingEmpty(padding)
        ? inferSpacingAllSides(computedStyles, "padding")
        : null,
    [padding, computedStyles],
  )
  const marginFallback = useMemo(
    () =>
      isMarginEmpty(margin)
        ? inferSpacingAllSides(computedStyles, "margin")
        : null,
    [margin, computedStyles],
  )
  const gapFallback = useMemo(
    () => (isGapEmpty(gap) ? inferGapAllAxes(computedStyles) : null),
    [gap, computedStyles],
  )

  // Per-side effective values: class cascade first, computed style as
  // the per-side fallback (so a component-CSS element shows real numbers).
  const paddingSides = useMemo(
    () => mergeSides(resolveSpacingSides(padding), inferSpacingSides(computedStyles, "padding")),
    [padding, computedStyles],
  )
  const marginSides = useMemo(
    () => mergeSides(resolveSpacingSides(margin), inferSpacingSides(computedStyles, "margin")),
    [margin, computedStyles],
  )

  function emit(property: string, mutation: ClassMutation): void {
    const next = applyClassMutation(classes, mutation)
    if (onScopedEdit) onScopedEdit(property, next)
    else onClassesChange(next)
  }

  function handleSet(
    kind: "padding" | "margin" | "gap",
    rawInput: string,
  ): void {
    const step = parseStep(rawInput)
    if (step === undefined) return
    const mutation =
      kind === "padding"
        ? setPaddingAll(padding, step)
        : kind === "margin"
          ? setMarginAll(margin, step)
          : setGapAll(gap, step)
    emit(kind, mutation)
  }

  function handleSetSide(
    kind: "padding" | "margin",
    side: SpacingSide,
    rawInput: string,
  ): void {
    const step = parseStep(rawInput)
    if (step === undefined) return
    const mutation =
      kind === "padding"
        ? setPaddingSide(padding, side, step)
        : setMarginSide(margin, side, step)
    emit(kind, mutation)
  }

  return (
    <section aria-label="Spacing" className="px-3 space-y-3">
      <SectionHeader title="Spacing" />
      <div className="grid grid-cols-2 gap-2">
        <NumericField
          label="Padding"
          value={padding.all?.step ?? paddingFallback}
          onCommit={(v) => handleSet("padding", v)}
          mixed={isPaddingMixed(padding)}
          expanded={expanded.padding}
          onToggleExpand={() =>
            setExpanded((s) => ({ ...s, padding: !s.padding }))
          }
          sides={paddingSides}
          onCommitSide={(side, v) => handleSetSide("padding", side, v)}
        />
        <NumericField
          label="Margin"
          value={margin.all?.step ?? marginFallback}
          onCommit={(v) => handleSet("margin", v)}
          mixed={isMarginMixed(margin)}
          expanded={expanded.margin}
          onToggleExpand={() =>
            setExpanded((s) => ({ ...s, margin: !s.margin }))
          }
          sides={marginSides}
          onCommitSide={(side, v) => handleSetSide("margin", side, v)}
        />
        <NumericField
          label="Gap"
          value={gap.all?.step ?? gapFallback}
          onCommit={(v) => handleSet("gap", v)}
          mixed={isGapMixed(gap)}
        />
      </div>
    </section>
  )
}

/**
 * Parse a raw input into a snapped scale step. Returns `null` to clear,
 * a number to set, or `undefined` when the input isn't a finite number
 * (the caller should ignore the commit).
 */
function parseStep(rawInput: string): number | null | undefined {
  const trimmed = rawInput.trim()
  if (trimmed === "") return null
  const n = parseFloat(trimmed)
  if (!Number.isFinite(n)) return undefined
  return snapToSpacingScale(n)
}

/** Prefer the class-resolved side; fall back to the computed-style side. */
function mergeSides(
  resolved: ResolvedSpacingSides,
  inferred: ResolvedSpacingSides,
): ResolvedSpacingSides {
  return {
    top: resolved.top ?? inferred.top,
    right: resolved.right ?? inferred.right,
    bottom: resolved.bottom ?? inferred.bottom,
    left: resolved.left ?? inferred.left,
  }
}

function NumericField({
  label,
  value,
  onCommit,
  mixed,
  expanded,
  onToggleExpand,
  sides,
  onCommitSide,
}: {
  label: string
  /** Current scale value, or null when unset. */
  value: number | null
  /** Called when the designer commits a new value (blur or Enter). */
  onCommit: (rawInput: string) => void
  /** True when per-side overrides exist that the all-sides input can't fully represent. */
  mixed: boolean
  /** When defined, render a per-side expand toggle. */
  expanded?: boolean
  onToggleExpand?: () => void
  /** Per-side values, shown as four thin inputs in place of the all-sides input when expanded. */
  sides?: ResolvedSpacingSides
  onCommitSide?: (side: SpacingSide, rawInput: string) => void
}) {
  // Local typing buffer. The input is controlled (so re-renders from a
  // bridge-driven class change reset the displayed value), but the
  // designer needs to be able to type intermediate states like "0.5"
  // without each keystroke firing a class edit. Commit on blur/Enter.
  const [draft, setDraft] = useState<string>(value === null ? "" : formatStep(value))

  // Re-sync the draft whenever the upstream value changes (e.g., a
  // different element gets selected, or another control's edit
  // produced a new class list). Avoids drift between the typed text
  // and the actual class state. Uses React's "adjust state during render"
  // pattern (the recommended alternative to a sync effect) so there's no
  // extra commit / cascading render.
  const [lastValue, setLastValue] = useState(value)
  if (value !== lastValue) {
    setLastValue(value)
    setDraft(value === null ? "" : formatStep(value))
  }

  return (
    <div className={fieldRowClass}>
      <div className="flex items-center justify-between">
        <label className={stackedLabelClass}>
          {label}
        </label>
        {onToggleExpand ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onToggleExpand}
            aria-label={
              expanded
                ? `Collapse ${label} to all sides`
                : `Edit ${label} per side`
            }
            aria-pressed={expanded}
            title={expanded ? "All sides" : "Edit per side"}
            className={cn(
              "h-4 w-4 rounded text-muted-foreground",
              expanded && "bg-accent text-foreground",
            )}
          >
            {expanded ? (
              <Minimize2 className="h-3 w-3" />
            ) : (
              <Maximize2 className="h-3 w-3" />
            )}
          </Button>
        ) : null}
      </div>
      {expanded && sides && onCommitSide ? (
        <TooltipProvider delayDuration={300}>
          <div className="flex gap-1" aria-label={`${label} per side`}>
            {SIDE_FIELDS.map(({ side, title }) => (
              <SideInput
                key={side}
                title={title}
                value={sides[side]}
                onCommit={(v) => onCommitSide(side, v)}
              />
            ))}
          </div>
        </TooltipProvider>
      ) : (
        <Input
          size="sm"
          type="text"
          inputMode="decimal"
          value={draft}
          placeholder={mixed ? "mixed" : "—"}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={(e) => onCommit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              onCommit((e.target as HTMLInputElement).value)
            }
          }}
        />
      )}
    </div>
  )
}

/** Side order for the inline per-side inputs: top, right, bottom, left. */
const SIDE_FIELDS: { side: SpacingSide; title: string }[] = [
  { side: "top", title: "Top" },
  { side: "right", title: "Right" },
  { side: "bottom", title: "Bottom" },
  { side: "left", title: "Left" },
]

/**
 * One thin per-side input. Labelless (the four sit in T/R/B/L order); the
 * side name surfaces as a hover tooltip + accessible label instead.
 */
function SideInput({
  title,
  value,
  onCommit,
}: {
  title: string
  value: number | null
  onCommit: (rawInput: string) => void
}) {
  const [draft, setDraft] = useState<string>(value === null ? "" : formatStep(value))
  const [lastValue, setLastValue] = useState(value)
  if (value !== lastValue) {
    setLastValue(value)
    setDraft(value === null ? "" : formatStep(value))
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Input
          size="sm"
          type="text"
          inputMode="decimal"
          aria-label={title}
          value={draft}
          placeholder="—"
          className="min-w-0 flex-1 px-1 text-center"
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={(e) => onCommit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              onCommit((e.target as HTMLInputElement).value)
            }
          }}
        />
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  )
}

function isPaddingMixed(p: ReturnType<typeof parsePadding>): boolean {
  return [p.x, p.y, p.top, p.right, p.bottom, p.left].some((s) => s !== null)
}
function isMarginMixed(m: ReturnType<typeof parseMargin>): boolean {
  return [m.x, m.y, m.top, m.right, m.bottom, m.left].some((s) => s !== null)
}
function isGapMixed(g: ReturnType<typeof parseGap>): boolean {
  return [g.x, g.y].some((s) => s !== null)
}

// True when the class list carries no padding/margin/gap utility — the
// signal that the computed-style fallback should fill in the input. Any
// per-side override counts as "set" so we don't overwrite a partial
// state with an all-sides fallback.
function isPaddingEmpty(p: ReturnType<typeof parsePadding>): boolean {
  return (
    p.all === null &&
    p.x === null &&
    p.y === null &&
    p.top === null &&
    p.right === null &&
    p.bottom === null &&
    p.left === null
  )
}
function isMarginEmpty(m: ReturnType<typeof parseMargin>): boolean {
  return (
    m.all === null &&
    m.x === null &&
    m.y === null &&
    m.top === null &&
    m.right === null &&
    m.bottom === null &&
    m.left === null
  )
}
function isGapEmpty(g: ReturnType<typeof parseGap>): boolean {
  return g.all === null && g.x === null && g.y === null
}

function formatStep(step: number): string {
  return Number.isInteger(step) ? String(step) : String(step)
}


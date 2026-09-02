"use client"

import { useMemo, useState, type ReactNode } from "react"
import { Maximize2, Minimize2 } from "lucide-react"
import {
  applyClassMutation,
  BORDER_RADII,
  BORDER_STYLES,
  BORDER_WIDTHS,
  parseBorder,
  resolveBorderRadiusCorners,
  resolveBorderWidthSides,
  setBorderRadius,
  setBorderRadiusCorner,
  setBorderStyle,
  setBorderWidth,
  setBorderWidthSide,
  type BorderCorner,
  type BorderSide,
  type ClassMutation,
  type ResolvedBorderRadiusCorners,
  type ResolvedBorderWidthSides,
} from "./tailwind-classes"
import {
  inferBorder,
  inferBorderRadiusCorners,
  inferBorderWidthSides,
} from "./infer-from-computed"
import { cn } from "@/lib/utils"
import { SectionHeader, fieldRowClass, stackedLabelClass } from "./section-header"
import { ColorControlRow } from "./color-section"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** CSS properties the border section resolves provenance for. */
export const BORDER_PROVENANCE_PROPERTIES = [
  "border-width",
  "border-style",
  "border-radius",
]

const MIXED = "__mixed"
const UNSET = "__unset"

interface BorderSectionProps {
  classes: readonly string[]
  /** Live computed CSS — fallback for `border` / `border-{n}` / `border-{style}` / `rounded-{size}`. */
  computedStyles?: Record<string, string>
  /** Phase 2/3 — route a style edit through the scope gate (property + next classes). */
  onScopedEdit?: (property: string, nextClasses: string[]) => void
  onClassesChange: (next: string[]) => void
}

/**
 * Three border controls (Width / Style / Radius). Each is a native
 * <select> over the supported V1 values:
 *
 * - Width: 0 / 1 (bare `border`) / 2 / 4 / 8 — covers ~all design
 *   needs without exposing arbitrary values.
 * - Style: solid (default) / dashed / dotted / double / none.
 * - Radius: none / sm / default (`rounded`) / md / lg / xl / 2xl /
 *   3xl / full.
 *
 * **Mixed / per-side editing (Figma-style).** Width and Radius each carry
 * an expand toggle. Collapsed, they show a single all-sides control
 * ("Mixed" when the sides/corners disagree). Expanded, the all-sides
 * control is replaced in place by four thin inputs — Width as
 * top/right/bottom/left, Radius as the four corners (labelless, name on
 * hover) — so an asymmetric border (`border-t-2 border-b-4`, `rounded-tl-lg`) is
 * fully editable instead of dead-ending on "Mixed". Per-side/-corner values
 * resolve through the Tailwind cascade (side/corner → axis → all) and fall
 * back to the live computed style when no class owns them.
 *
 * Style remains all-sides — Tailwind has no per-side border-style utility.
 *
 * The "(—)" value clears every owned class for that property.
 */
export function BorderSection({
  classes,
  computedStyles,
  onScopedEdit,
  onClassesChange,
}: BorderSectionProps) {
  const border = useMemo(() => parseBorder(classes), [classes])
  // Inferred fallbacks — surfaced field-by-field, not as a unit, so a
  // partially class-set border (`rounded-md` only) keeps the parser's
  // radius and adds the computed width/style next to it.
  const fallback = useMemo(
    () => inferBorder(computedStyles),
    [computedStyles],
  )

  const [expanded, setExpanded] = useState<{ width: boolean; radius: boolean }>(
    { width: false, radius: false },
  )

  // Per-side / per-corner effective values: class cascade first, computed
  // style as the fallback (so a component-CSS element shows real values).
  const widthSides = useMemo(
    () =>
      mergeWidthSides(
        resolveBorderWidthSides(border),
        inferBorderWidthSides(computedStyles),
      ),
    [border, computedStyles],
  )
  const radiusCorners = useMemo(
    () =>
      mergeRadiusCorners(
        resolveBorderRadiusCorners(border),
        inferBorderRadiusCorners(computedStyles),
      ),
    [border, computedStyles],
  )

  const widthMixed = !sidesEqual(widthSides)
  const radiusMixed = !cornersEqual(radiusCorners)

  // When uniform, the collapsed control shows the single resolved value
  // (derived from the same cascade as the mixed check, so they never
  // disagree — e.g. four equal `border-t-2`… classes still read as "2").
  const styleDisplay = border.style?.value ?? fallback.style

  function commit(mutation: ClassMutation): void {
    onClassesChange(applyClassMutation(classes, mutation))
  }
  // Route through the scope gate when one is wired (it decides direct-vs-dialog
  // per property and, for "This page", a scoped-css-override); else commit directly.
  function scopedCommit(property: string, mutation: ClassMutation): void {
    if (onScopedEdit) onScopedEdit(property, applyClassMutation(classes, mutation))
    else commit(mutation)
  }

  return (
    <section aria-label="Border" className="px-3 space-y-3">
      <SectionHeader title="Border" />
      <div className="grid grid-cols-2 gap-2">
        <SelectField
          label="Width"
          value={
            widthMixed
              ? MIXED
              : widthSides.top === null
                ? UNSET
                : String(widthSides.top)
          }
          onChange={(v) => {
            if (v === MIXED) return
            scopedCommit(
              "border-width",
              setBorderWidth(border, v === UNSET ? null : parseInt(v, 10)),
            )
          }}
          mixed={widthMixed}
          expanded={expanded.width}
          onToggleExpand={() => setExpanded((s) => ({ ...s, width: !s.width }))}
          options={[
            { value: UNSET, label: "—" },
            ...BORDER_WIDTHS.map((w) => ({
              value: String(w),
              label: w === 1 ? "1 (border)" : String(w),
            })),
          ]}
          expandedContent={
            <PerSideWidthEditor
              sides={widthSides}
              onCommitSide={(side, v) =>
                scopedCommit("border-width", setBorderWidthSide(border, side, v))
              }
            />
          }
        />
        <SelectField
          label="Style"
          value={styleDisplay ?? UNSET}
          onChange={(v) =>
            scopedCommit("border-style", setBorderStyle(border, v === UNSET ? null : v))
          }
          options={[
            { value: UNSET, label: "—" },
            ...BORDER_STYLES.map((s) => ({ value: s, label: s })),
          ]}
        />
        <SelectField
          label="Radius"
          value={
            radiusMixed ? MIXED : radiusCorners.topLeft ?? UNSET
          }
          onChange={(v) => {
            if (v === MIXED) return
            scopedCommit(
              "border-radius",
              setBorderRadius(border, v === UNSET ? null : v),
            )
          }}
          mixed={radiusMixed}
          expanded={expanded.radius}
          onToggleExpand={() => setExpanded((s) => ({ ...s, radius: !s.radius }))}
          options={[
            { value: UNSET, label: "—" },
            ...BORDER_RADII.map((r) => ({
              value: r,
              label: r === "default" ? "default (rounded)" : r,
            })),
          ]}
          expandedContent={
            <PerCornerRadiusEditor
              corners={radiusCorners}
              onCommitCorner={(corner, v) =>
                scopedCommit(
                  "border-radius",
                  setBorderRadiusCorner(border, corner, v),
                )
              }
            />
          }
        />
        <ColorControlRow
          property="border"
          label="Color"
          classes={classes}
          computedStyles={computedStyles}
          onScopedEdit={onScopedEdit}
          onClassesChange={onClassesChange}
        />
      </div>
    </section>
  )
}

/** Prefer the class-resolved side; fall back to the computed-style side. */
function mergeWidthSides(
  resolved: ResolvedBorderWidthSides,
  inferred: ResolvedBorderWidthSides,
): ResolvedBorderWidthSides {
  return {
    top: resolved.top ?? inferred.top,
    right: resolved.right ?? inferred.right,
    bottom: resolved.bottom ?? inferred.bottom,
    left: resolved.left ?? inferred.left,
  }
}
function mergeRadiusCorners(
  resolved: ResolvedBorderRadiusCorners,
  inferred: ResolvedBorderRadiusCorners,
): ResolvedBorderRadiusCorners {
  return {
    topLeft: resolved.topLeft ?? inferred.topLeft,
    topRight: resolved.topRight ?? inferred.topRight,
    bottomRight: resolved.bottomRight ?? inferred.bottomRight,
    bottomLeft: resolved.bottomLeft ?? inferred.bottomLeft,
  }
}

function sidesEqual(s: ResolvedBorderWidthSides): boolean {
  return s.top === s.right && s.right === s.bottom && s.bottom === s.left
}
function cornersEqual(c: ResolvedBorderRadiusCorners): boolean {
  return (
    c.topLeft === c.topRight &&
    c.topRight === c.bottomRight &&
    c.bottomRight === c.bottomLeft
  )
}

interface SelectOption {
  value: string
  label: string
}

function SelectField({
  label,
  value,
  onChange,
  options,
  mixed,
  expanded,
  onToggleExpand,
  expandedContent,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: readonly SelectOption[]
  /** When true, prepend a non-committing "Mixed" item and show it selected. */
  mixed?: boolean
  /** When defined, render a per-side/-corner expand toggle. */
  expanded?: boolean
  onToggleExpand?: () => void
  /** Inline per-side/-corner editor that replaces the all-sides select when expanded. */
  expandedContent?: ReactNode
}) {
  const items: SelectOption[] = mixed
    ? [{ value: MIXED, label: "Mixed" }, ...options]
    : [...options]
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
              "h-4 w-4 text-muted-foreground hover:text-foreground",
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
      {expanded && expandedContent ? (
        expandedContent
      ) : (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger size="sm" responsive className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  )
}

/**
 * Four thin per-side width selects (T/R/B/L order) that replace the
 * all-sides select inline when Width is expanded. Labelless — the side
 * name surfaces as a hover tooltip + accessible label.
 */
function PerSideWidthEditor({
  sides,
  onCommitSide,
}: {
  sides: ResolvedBorderWidthSides
  onCommitSide: (side: BorderSide, value: number | null) => void
}) {
  const fields: { side: BorderSide; title: string }[] = [
    { side: "top", title: "Top" },
    { side: "right", title: "Right" },
    { side: "bottom", title: "Bottom" },
    { side: "left", title: "Left" },
  ]
  const options: SelectOption[] = [
    { value: UNSET, label: "—" },
    ...BORDER_WIDTHS.map((w) => ({ value: String(w), label: String(w) })),
  ]
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex gap-1" aria-label="Border width per side">
        {fields.map(({ side, title }) => (
          <PartSelect
            key={side}
            title={title}
            value={sides[side] === null ? UNSET : String(sides[side])}
            options={options}
            onChange={(v) => onCommitSide(side, v === UNSET ? null : parseInt(v, 10))}
          />
        ))}
      </div>
    </TooltipProvider>
  )
}

/**
 * Four thin per-corner radius selects (TL/TR/BL/BR) that replace the
 * all-sides select inline when Radius is expanded. Labelless — the corner
 * name surfaces as a hover tooltip + accessible label.
 */
function PerCornerRadiusEditor({
  corners,
  onCommitCorner,
}: {
  corners: ResolvedBorderRadiusCorners
  onCommitCorner: (corner: BorderCorner, value: string | null) => void
}) {
  const fields: { corner: BorderCorner; title: string }[] = [
    { corner: "topLeft", title: "Top-left" },
    { corner: "topRight", title: "Top-right" },
    { corner: "bottomLeft", title: "Bottom-left" },
    { corner: "bottomRight", title: "Bottom-right" },
  ]
  const options: SelectOption[] = [
    { value: UNSET, label: "—" },
    ...BORDER_RADII.map((r) => ({ value: r, label: r })),
  ]
  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex gap-1" aria-label="Border radius per corner">
        {fields.map(({ corner, title }) => (
          <PartSelect
            key={corner}
            title={title}
            value={corners[corner] ?? UNSET}
            options={options}
            onChange={(v) => onCommitCorner(corner, v === UNSET ? null : v)}
          />
        ))}
      </div>
    </TooltipProvider>
  )
}

function PartSelect({
  title,
  value,
  options,
  onChange,
}: {
  title: string
  value: string
  options: readonly SelectOption[]
  onChange: (v: string) => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger
            size="sm"
            responsive
            aria-label={title}
            className="w-full min-w-0 flex-1 px-1.5"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  )
}


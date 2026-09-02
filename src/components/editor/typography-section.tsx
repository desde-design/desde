"use client"

import { useMemo } from "react"
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
} from "lucide-react"
import {
  applyClassMutation,
  FONT_FAMILIES,
  FONT_SIZES,
  FONT_WEIGHTS,
  LEADING_VALUES,
  parseTypography,
  setFontFamily,
  setFontSize,
  setFontWeight,
  setLeading,
  setTextAlign,
  setTracking,
  TRACKING_VALUES,
  withArbitraryOption,
  type ClassMutation,
  type TypographyValue,
} from "./tailwind-classes"
import { inferTypography } from "./infer-from-computed"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { SectionHeader, fieldRowClass, stackedLabelClass } from "./section-header"
import { ColorControlRow } from "./color-section"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/** CSS properties the typography section resolves provenance for. */
export const TYPOGRAPHY_PROVENANCE_PROPERTIES = [
  "font-size",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-align",
]

interface TypographySectionProps {
  /**
   * Classes for the active variant context. The panel feeds these already
   * `stripVariant`-ed (and suppresses `computedStyles` for non-base
   * contexts), so this section stays variant-agnostic.
   */
  classes: readonly string[]
  /** Live computed CSS — fallback for `text-{size}`, `font-{weight}`, `leading-*`, `tracking-*`, `text-{align}`. */
  computedStyles?: Record<string, string>
  /** Phase 2/3 — route a style edit through the scope gate (property + next classes). */
  onScopedEdit?: (property: string, nextClasses: string[]) => void
  onClassesChange: (next: string[]) => void
}

/**
 * Typography controls — size, weight, leading, tracking, alignment.
 *
 * **Layout.** 2-column grid for the four selects (size, weight,
 * leading, tracking), then a separate row for the alignment toggle
 * group. The alignment toggle uses lucide icons rather than a
 * select because alignment is the highest-frequency typography
 * change and worth the extra visual real estate.
 *
 * **Disambiguation.** `text-` is overloaded across font size,
 * alignment, and color. The parser anchors to closed keyword sets
 * for each — see tailwind-classes.ts FONT_SIZES / TEXT_ALIGNMENTS
 * — so a single text-sm doesn't get re-emitted as a color and
 * vice versa.
 *
 * Numeric leading (`leading-6`), font-family
 * (`font-mono`/`font-sans`/`font-serif`), and arbitrary values
 * (`text-[13px]`) are captured into their controls and shown
 * accurately — arbitrary/out-of-set values surface as their own
 * select option via {@link withArbitraryOption}.
 */
export function TypographySection({
  classes,
  computedStyles,
  onScopedEdit,
  onClassesChange,
}: TypographySectionProps) {
  const typography = useMemo(() => parseTypography(classes), [classes])
  // `computedStyles` is undefined for non-base contexts (the panel
  // suppresses it), so `inferTypography` returns all-null and the fallback
  // naturally disappears off-base.
  const fallback = useMemo(
    () => inferTypography(computedStyles),
    [computedStyles],
  )
  const sizeDisplay = typography.size?.value ?? fallback.size
  const weightDisplay = typography.weight?.value ?? fallback.weight
  const familyDisplay = typography.family?.value ?? null
  const leadingDisplay = typography.leading?.value ?? fallback.leading
  const trackingDisplay = typography.tracking?.value ?? fallback.tracking

  // Route through the scope gate when wired (the panel only wires it for
  // the base context); else commit the new class list directly.
  function emit(property: string, mutation: ClassMutation): void {
    const next = applyClassMutation(classes, mutation)
    if (onScopedEdit) onScopedEdit(property, next)
    else onClassesChange(next)
  }

  return (
    <section aria-label="Typography" className="px-3 space-y-3">
      <SectionHeader title="Typography" />
      <div className="grid grid-cols-2 gap-2">
        <SelectField
          label="Size"
          value={sizeDisplay ?? "__unset"}
          onChange={(v) =>
            emit("font-size", setFontSize(typography, v === "__unset" ? null : v))
          }
          options={withArbitraryOption(
            [
              { value: "__unset", label: "—" },
              ...FONT_SIZES.map((s) => ({ value: s, label: s })),
            ],
            sizeDisplay,
          )}
        />
        <SelectField
          label="Weight"
          value={weightDisplay ?? "__unset"}
          onChange={(v) =>
            emit("font-weight", setFontWeight(typography, v === "__unset" ? null : v))
          }
          options={[
            { value: "__unset", label: "—" },
            ...FONT_WEIGHTS.map((w) => ({ value: w, label: w })),
          ]}
        />
        <SelectField
          label="Family"
          value={familyDisplay ?? "__unset"}
          onChange={(v) =>
            emit("font-family", setFontFamily(typography, v === "__unset" ? null : v))
          }
          options={[
            { value: "__unset", label: "—" },
            ...FONT_FAMILIES.map((f) => ({ value: f, label: f })),
          ]}
        />
        <SelectField
          label="Leading"
          value={leadingDisplay ?? "__unset"}
          onChange={(v) =>
            emit("line-height", setLeading(typography, v === "__unset" ? null : v))
          }
          options={withArbitraryOption(
            [
              { value: "__unset", label: "—" },
              ...LEADING_VALUES.map((l) => ({ value: l, label: l })),
            ],
            leadingDisplay,
          )}
        />
        <SelectField
          label="Tracking"
          value={trackingDisplay ?? "__unset"}
          onChange={(v) =>
            emit("letter-spacing", setTracking(typography, v === "__unset" ? null : v))
          }
          options={withArbitraryOption(
            [
              { value: "__unset", label: "—" },
              ...TRACKING_VALUES.map((t) => ({ value: t, label: t })),
            ],
            trackingDisplay,
          )}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <AlignmentToggle
          typography={typography}
          fallbackAlign={fallback.align}
          onCommit={(m) => emit("text-align", m)}
        />
        <ColorControlRow
          property="text"
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

const ALIGN_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  left: AlignLeft,
  center: AlignCenter,
  right: AlignRight,
  justify: AlignJustify,
  start: AlignLeft, // logical → visually left in LTR; same icon
  end: AlignRight,
}

function AlignmentToggle({
  typography,
  fallbackAlign,
  onCommit,
}: {
  typography: TypographyValue
  fallbackAlign: string | null
  onCommit: (mutation: ReturnType<typeof setTextAlign>) => void
}) {
  // V1 surfaces the four physical alignments as buttons; logical
  // start/end stay accessible via the Classes input. Surfacing all
  // 6 would crowd the toggle group; keep it readable.
  const visible = ["left", "center", "right", "justify"] as const
  const active = typography.align?.value ?? fallbackAlign
  return (
    <div className={fieldRowClass}>
      <label className={stackedLabelClass}>Alignment</label>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        spacing={0}
        value={active ?? ""}
        onValueChange={(val) =>
          onCommit(setTextAlign(typography, val === "" ? null : (val as typeof visible[number])))
        }
        className="w-full"
      >
        {visible.map((align) => {
          const Icon = ALIGN_ICONS[align]
          return (
            <ToggleGroupItem
              key={align}
              value={align}
              aria-label={`Align ${align}`}
              title={`text-${align}`}
              className="flex-1"
            >
              <Icon />
            </ToggleGroupItem>
          )
        })}
      </ToggleGroup>
    </div>
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
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: readonly SelectOption[]
}) {
  return (
    <div className={fieldRowClass}>
      <label className={stackedLabelClass}>
        {label}
      </label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" responsive className="w-full">
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
    </div>
  )
}


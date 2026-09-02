"use client"

import { useMemo } from "react"
import { cn } from "@/lib/utils"
import { SectionHeader, fieldLabelClass, fieldRowClass } from "./section-header"
import {
  applyClassMutation,
  isFlexLikeContainer,
  parseAlignItems,
  parseJustify,
  parseWidth,
  setAlignItems,
  setJustify,
  setWidth,
  type AlignValue,
  type JustifyValue,
  type WidthPreset,
} from "./align-size"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

/**
 * Alignment & sizing inspector control (direct-manipulation Phase 1).
 *
 * The Figma-style 3×3 box-with-dots maps to flex `justify-*` (columns) ×
 * `items-*` (rows) — shown only for flex/grid containers. A text-align row and
 * a width-preset row are always shown. Every change commits through the
 * SAME `onClassesChange(next)` path the other style sections use — NO new
 * applicator/transport (the dispatch chain is inherited; see
 * tasks/editor-direct-manipulation.md).
 *
 * Element scope only in v1 (class splice on the element) — alignment is almost
 * always element-specific; "This page" scope for alignment can ride the scope
 * gate later (would need justify/align provenance, a bridge addition).
 */
interface AlignSizeSectionProps {
  classes: readonly string[]
  /** Live computed CSS from the bridge — used to detect a flex/grid container. */
  computedStyles?: Record<string, string>
  /** Emit the new class list on change (wired to handleClassesEdit). */
  onClassesChange: (next: string[]) => void
}

const JUSTIFY_ORDER: JustifyValue[] = ["start", "center", "end"]
const ALIGN_ORDER: AlignValue[] = ["start", "center", "end"]

export function AlignSizeSection({
  classes,
  computedStyles,
  onClassesChange,
}: AlignSizeSectionProps) {
  const justify = useMemo(() => parseJustify(classes), [classes])
  const align = useMemo(() => parseAlignItems(classes), [classes])
  const width = useMemo(() => parseWidth(classes), [classes])
  const flexLike = useMemo(
    () => isFlexLikeContainer(computedStyles),
    [computedStyles],
  )

  // Pick a grid cell: set BOTH axes in one commit (justify then items).
  function pickCell(jv: JustifyValue, av: AlignValue): void {
    let next = applyClassMutation(classes, setJustify(justify, jv))
    next = applyClassMutation(next, setAlignItems(parseAlignItems(next), av))
    onClassesChange(next)
  }

  function pickWidth(v: WidthPreset): void {
    const nextValue = width.value === v ? null : v
    onClassesChange(applyClassMutation(classes, setWidth(width, nextValue)))
  }

  return (
    <section aria-label="Alignment and sizing" className="px-3 space-y-3">
      <SectionHeader title="Align & size" />

      {flexLike ? (
        <div className={fieldRowClass}>
          <div className="flex flex-col gap-0.5">
            <label className={fieldLabelClass}>
              Align children
            </label>
            {justify.unrepresentable || align.unrepresentable ? (
              <span className="text-xs text-muted-foreground/70">
                custom
              </span>
            ) : null}
          </div>
          <div
            className="inline-grid grid-cols-3 gap-0.5 self-start rounded border bg-muted/30 p-0.5"
            role="group"
            aria-label="Flex alignment grid"
            data-testid="align-grid"
          >
            {ALIGN_ORDER.map((av) =>
              JUSTIFY_ORDER.map((jv) => {
                const active = justify.value === jv && align.value === av
                return (
                  <Toggle
                    key={`${jv}-${av}`}
                    variant="outline"
                    size="sm"
                    pressed={active}
                    onPressedChange={() => pickCell(jv, av)}
                    data-testid={`align-cell-${jv}-${av}`}
                    title={`justify-${jv} · items-${av}`}
                    aria-label={`justify-${jv} · items-${av}`}
                    className="h-4 w-4 min-w-0 rounded-sm p-0"
                  >
                    <span
                      className={cn(
                        "h-1 w-1 rounded-full",
                        active ? "bg-primary-foreground" : "bg-muted-foreground/40",
                      )}
                    />
                  </Toggle>
                )
              }),
            )}
          </div>
        </div>
      ) : null}

      <SegmentRow
        label="Width"
        options={[
          { value: "full" as const, label: "Full" },
          { value: "auto" as const, label: "Auto" },
          { value: "half" as const, label: "½" },
          { value: "fit" as const, label: "Fit" },
        ]}
        active={width.value}
        unrepresentable={width.unrepresentable}
        onPick={pickWidth}
        testid="width"
      />
    </section>
  )
}

function SegmentRow<V extends string>({
  label,
  options,
  active,
  unrepresentable,
  onPick,
  testid,
}: {
  label: string
  options: { value: V; label: string }[]
  active: V | null
  unrepresentable: boolean
  onPick: (v: V) => void
  testid: string
}) {
  return (
    <div className={fieldRowClass}>
      <div className="flex flex-col gap-0.5">
        <label className={fieldLabelClass}>
          {label}
        </label>
        {unrepresentable && active === null ? (
          <span className="text-xs text-muted-foreground/70">custom</span>
        ) : null}
      </div>
      <ToggleGroup
        size="sm"
        type="single"
        variant="outline"
        spacing={0}
        value={active ?? ""}
        onValueChange={(val) => {
          if (val) onPick(val as V)
        }}
        aria-label={label}
        data-testid={`${testid}-row`}
        className="w-full"
      >
        {options.map((o) => (
          <ToggleGroupItem
            key={o.value}
            value={o.value}
            data-testid={`${testid}-${o.value}`}
            className="flex-1"
          >
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}


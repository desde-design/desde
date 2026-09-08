"use client"

import { useMemo } from "react"
import { cn } from "@/lib/utils"
import { SectionHeader, fieldLabelClass, fieldRowClass } from "./section-header"
import {
  applyClassMutation,
  axesToCell,
  cellToAxes,
  isFlexLikeContainer,
  parseFlexAxes,
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

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

/**
 * What a cell does, in words: "Align top right", not
 * `justify-end · items-start` (Mo, 2026-09-08).
 *
 * The arguments are SCREEN positions, not CSS values: `col` is the screen
 * column left to right and `row` is the screen row top to bottom. Which CSS
 * property each one writes depends on `flex-direction` (see `cellToAxes`),
 * but the name never changes with it, because the name describes where the
 * children end up and that is the whole point of the grid.
 *
 * The two centres collapse to "Align center" rather than "middle center".
 */
export function describeCell(col: JustifyValue, row: AlignValue): string {
  const vertical = { start: "top", center: "middle", end: "bottom" }[row]
  const horizontal = { start: "left", center: "center", end: "right" }[col]
  if (row === "center" && col === "center") return "Align center"
  return `Align ${vertical} ${horizontal}`
}

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
  // Which screen axis each CSS property drives. A column container swaps
  // them; the `-reverse` directions mirror one. See `parseFlexAxes`.
  const axes = useMemo(() => parseFlexAxes(computedStyles), [computedStyles])

  // An UNSET justify is the CSS default, `flex-start`, so `flex
  // items-center` with no justify class lays children out at the middle left
  // and that is the cell to light; before 2026-09-08 it lit nothing until
  // both classes were present. A justify the grid cannot show
  // (`justify-between`) is `unrepresentable`, and lights nothing. No such
  // default for the cross axis: an unset `items-*` is `stretch`, which is
  // not a cell.
  const justifyValue: JustifyValue | null =
    justify.value ?? (justify.unrepresentable ? null : "start")

  // The lit cell, as a SCREEN position. Translating here rather than at each
  // cell keeps one direction-aware step in the render.
  const lit = axesToCell(justifyValue, align.value, axes)

  // Pick a grid cell: set BOTH axes in one commit (justify then items). The
  // cell is a screen position, so it goes through `cellToAxes` first.
  function pickCell(col: JustifyValue, row: AlignValue): void {
    const { justify: jv, align: av } = cellToAxes(col, row, axes)
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
          {/* 1s before a tooltip, not the rail's usual 300ms (Mo,
              2026-09-08: "hovering over for a second or two"). Nine cells
              two pixels apart: at 300ms a cursor crossing the grid to reach
              one flashes the names of the others on the way. */}
          <TooltipProvider delayDuration={1000}>
            <div
              className="inline-grid grid-cols-3 gap-0.5 self-start rounded border bg-muted/30 p-0.5"
              role="group"
              aria-label="Flex alignment grid"
              data-testid="align-grid"
            >
              {ALIGN_ORDER.map((av) =>
                JUSTIFY_ORDER.map((jv) => {
                  // `jv` is the screen COLUMN and `av` the screen ROW here,
                  // not the CSS values they are named for. The names are the
                  // grid's own axes, kept so the testids stay stable.
                  const active = lit !== null && lit.col === jv && lit.row === av
                  const name = describeCell(jv, av)
                  return (
                    <Tooltip key={`${jv}-${av}`}>
                      <TooltipTrigger asChild>
                        {/* `default`, not `outline` (Mo, 2026-09-08: no
                            border around each cell). The grid's own frame is
                            the border; nine more inside it were a table.
                            Selected: the accent at 10% under a solid accent
                            dot, the same pair the tool picker uses. The
                            primitive's grey `on` fill was invisible on the
                            grid's grey ground, and the white dot on it was
                            the least visible thing in the rail.
                            Keyed on `aria-pressed`, not `data-state`: the
                            tooltip trigger above writes its OWN open/closed
                            `data-state` onto this button, over the toggle's
                            on/off. `aria-pressed` is the toggle's alone. */}
                        <Toggle
                          variant="default"
                          size="sm"
                          pressed={active}
                          onPressedChange={() => pickCell(jv, av)}
                          data-testid={`align-cell-${jv}-${av}`}
                          aria-label={name}
                          className="h-4 w-4 min-w-0 rounded-sm p-0 aria-pressed:bg-primary/10 aria-pressed:hover:bg-primary/15"
                        >
                          <span
                            className={cn(
                              "h-1 w-1 rounded-full",
                              active ? "bg-primary" : "bg-muted-foreground/40",
                            )}
                          />
                        </Toggle>
                      </TooltipTrigger>
                      <TooltipContent side="top">{name}</TooltipContent>
                    </Tooltip>
                  )
                }),
              )}
            </div>
          </TooltipProvider>
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


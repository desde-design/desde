"use client"

/**
 * Segmented control. Takes any number of options, though in practice they run
 * two or three wide: the editor toolbar's tool picker
 * (`Navigate | Select | Comment`), its view toggle (`Editor | Canvas`), its
 * canvas mode (`Read | Edit`), and the breakpoint menu's width list.
 *
 * It has always been N-option capable; only this comment said otherwise.
 *
 * Thin wrapper over shadcn's native `Tabs` (TabsList/TabsTrigger) used
 * purely as a segmented control — the muted-pill look, roving keyboard
 * focus, and active-state styling all come from the primitive, so
 * these toggles match the rest of the app's tabbed surfaces. No
 * TabsContent: the active value drives external state, not local panels.
 * Radix no-ops when the already-active item is re-clicked, so the
 * control always keeps a selection.
 *
 * ## Why activation is MANUAL here, for every caller
 *
 * Radix's `Tabs` defaults to `activationMode="automatic"`: moving focus with
 * the arrow keys selects each segment it passes through. That default is
 * written for a tab strip, where the only cost of passing through a tab is
 * rendering its panel. This component never has a panel — there is no
 * `TabsContent` — so every value change is a side effect somewhere else in
 * the app, and arrowing across the control fires all of them.
 *
 * The measured case is the toolbar's tool picker. Arrowing from Navigate to
 * Comment passes through Select, which posts `ACTIVATE_INSPECTOR` into the
 * user's running prototype and then immediately tears it down again. Before
 * the picker existed those were two different controls, so no keyboard path
 * could reach that.
 *
 * The rule is set here rather than on that one instance because the reason is
 * true of the whole component, not of that caller: a segmented control is a
 * COMMIT control, so arrow keys should move focus and Enter or Space should
 * choose. Fixing only the picker would leave the hazard armed for the next
 * caller, and would also mean two keyboard rules for controls that sit two
 * segments apart in the same toolbar.
 */

import * as React from "react"
import { cn } from "@/lib/utils"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

export interface SegmentedToggleOption<TValue extends string> {
  value: TValue
  label: string
  /** Optional shortcut hint shown as a small badge after the label. */
  shortcut?: string
  /** Optional icon element rendered before the label. */
  icon?: React.ReactNode
  /** Optional disabled-state reason for the tooltip. */
  disabled?: boolean
}

interface SegmentedToggleProps<TValue extends string> {
  value: TValue
  options: ReadonlyArray<SegmentedToggleOption<TValue>>
  onChange: (next: TValue) => void
  /** Accessible name; rendered as `aria-label` on the tablist. */
  ariaLabel: string
  className?: string
  /** Retained for call-site compatibility; Tabs has a single size. */
  size?: "sm" | "md"
  /**
   * How the strip draws itself.
   *
   * - `contained` (default) — the shadcn look: a muted track behind the
   *   segments, active one lifted onto the page ground.
   * - `plain` — no track at all, active segment filled with the accent at
   *   10%. For a strip that already sits inside chrome of its own, where a
   *   second container is a box inside a box (Mo, 2026-08-18, on the
   *   toolbar pill: "remove the container around the navigate, select and
   *   comment buttons").
   */
  variant?: "contained" | "plain"
}

export function SegmentedToggle<TValue extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  variant = "contained",
}: SegmentedToggleProps<TValue>) {
  const plain = variant === "plain"
  return (
    <Tabs
      value={value}
      onValueChange={(next) => onChange(next as TValue)}
      // See the header: arrows move focus, Enter/Space chooses. Automatic
      // activation would fire every segment the focus travels over.
      activationMode="manual"
      className={className}
    >
      <TabsList
        aria-label={ariaLabel}
        data-testid="segmented-toggle"
        // The track, the padding and the rounding all belong to the
        // container look; `plain` drops the three together, or a track-less
        // strip keeps a 3px inset nothing sits in.
        className={plain ? "gap-0.5 bg-transparent p-0" : undefined}
      >
        {options.map((opt) => (
          <TabsTrigger
            key={opt.value}
            value={opt.value}
            disabled={opt.disabled}
            // Explicit accessible name. The visible `<span>` below already
            // carries the label as text, but MEASURED live (2026-09-01, the
            // editor surface gallery, a fresh page load with no DOM
            // mutation): a tab whose content is an icon followed by that
            // span reaches the accessibility tree with NO computed name —
            // three unnamed tabs in a "Prototype tool" tablist, unusable
            // with a screen reader. A plain-text tab (no icon, e.g. the
            // right rail's Edit/Chat/Comments/Activity strip, same
            // `TabsTrigger`) gets its name fine, so the icon is what's
            // breaking name-from-content here. An explicit `aria-label`
            // matching the visible text (also required for WCAG 2.5.3 Label
            // in Name) sidesteps that rather than depending on it.
            aria-label={opt.label}
            // `data-active:` is the primitive's own selector, so this
            // replaces its white-card treatment rather than layering over
            // it. The accent at 10% is the same fill the option cards use
            // for a chosen row — one idea, one weight, two surfaces.
            className={
              plain
                ? // `font-medium` on the active segment (Mo, 2026-08-18).
                  // Without a track behind it, colour was carrying the whole
                  // signal; weight is the second cue, and it is the one that
                  // still reads when the fill is only 10%.
                  // `hover:` too, or the primitive's own `hover:text-foreground`
                  // wins on the active segment and the teal label goes near-black
                  // under the cursor — a picked tool looking momentarily unpicked
                  // (Mo, 2026-08-18).
                  "data-active:bg-primary/10 data-active:font-medium data-active:text-primary data-active:hover:text-primary"
                : undefined
            }
          >
            {opt.icon}
            <span>{opt.label}</span>
            {opt.shortcut ? (
              <kbd className={cn(
                "ml-0.5 rounded bg-muted px-1 font-mono text-code leading-none text-muted-foreground",
              )}>
                {opt.shortcut}
              </kbd>
            ) : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}

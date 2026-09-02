"use client"

/**
 * Style scope dialog — Phase 2 of tasks/inspector-style-provenance.md
 * (provenance-gated). Shown only when a style edit is scope-AMBIGUOUS (the
 * value is token-driven, inherited, or library-rendered — see
 * {@link needsScopeDialog}). Forces an explicit choice of WHERE to apply the
 * change instead of silently splicing a class onto the consumer (which
 * mis-targets or no-ops on library-rendered elements — the `(none)` trap).
 *
 * Modeled on iteration-scope-dialog. The provenance chain is shown inline (the
 * "From:" row) so the choice is grounded. "This element", "This page", and "The
 * token" are wired; any scope offered by `availableScopes` but not yet wired
 * (e.g. "The component") is shown disabled with an honest "coming soon" reason —
 * never silently missing. Which scopes are enabled is decided by the caller
 * (the inspector) via `enabledScopes`.
 */
import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { EDITOR_REMEMBER_SCOPE_CHOICE } from "@/lib/editor-feature-flags"
import { OptionCard, OptionCardGroup, ValueReadout } from "@/components/blocks"
import type { StyleOrigin } from "@/types/bridge"
import { scopeDialogReasons, type StyleScope } from "./style-scope-decision"
import { hasStyleOrigin, StyleOriginRow } from "./style-origin-row"

const SCOPE_META: Record<
  StyleScope,
  { label: string; hint: (origin: StyleOrigin) => string }
> = {
  element: {
    label: "This element",
    hint: () => "Override the value on just this element (inline style).",
  },
  page: {
    label: "This page",
    hint: () => "Add a scoped style block targeting this element in its page.",
  },
  token: {
    label: "The token",
    hint: (o) => {
      const root = o.varChain[o.varChain.length - 1]
      if (!root) return "Change the design token. Affects every use."
      // Blast radius: the bridge counts how many declaration sites reference
      // var(--root). We report that literal usage count ("used in N places")
      // rather than claiming the patch reaches all of them or that the selected
      // element is one of them — both over-claim. It's accurate whether the
      // value is authored here or inherited from an ancestor, and a reasonable
      // heads-up even when the token is redefined per theme (some of those N
      // sites may resolve to a different definition — an honest usage count, not
      // a reachability guarantee). Fall back to generic when count is absent
      // (older bridge).
      const n = o.tokenUsageCount
      if (typeof n === "number" && n >= 1) {
        return `Change ${root.name}, used in ${n} ${n === 1 ? "place" : "places"} across the prototype.`
      }
      return `Change ${root.name}. Affects every use of the token.`
    },
  },
  component: {
    label: "The component",
    hint: () => "Edit the component's own CSS. Affects every instance.",
  },
}

/**
 * Extra hint sentence appended to "This element" on a substrate where that scope
 * is architecturally outranked (see `availableScopes`' `elementScopeOutranked`).
 * The tile stays enabled — a user may still deliberately want a local override —
 * but it is offered LAST and says why it probably won't show.
 */
const OUTRANKED_ELEMENT_HINT =
  "Unlikely to take effect here: this project's utility CSS is !important and outranks a rule added at this element."

interface StyleScopeDialogProps {
  open: boolean
  /** The CSS property being edited (for the title). */
  property: string
  /** Provenance for the edited property — drives the inline "From:" context. */
  origin: StyleOrigin
  /**
   * Scopes that apply to this origin (from `availableScopes`), **in presentation
   * order** — the first is the preferred choice. Rendered as given rather than
   * re-sorted, so a substrate that deprioritises a scope (element-last on an
   * important-utilities project) actually shows up that way.
   */
  scopes: StyleScope[]
  /** Which of those are actually wired today (Phase 2: just "element"). */
  enabledScopes: StyleScope[]
  /**
   * True when the element scope can't win the cascade on this substrate
   * (`EDITOR_ELEMENT_SCOPE_OUTRANKED`). Sharpens the reason lines and annotates
   * the element tile; the tile stays selectable.
   */
  elementScopeOutranked?: boolean
  onConfirm: (scope: StyleScope, remember: boolean) => void
  onCancel: () => void
}

export function StyleScopeDialog({
  open,
  property,
  origin,
  scopes,
  enabledScopes,
  elementScopeOutranked = false,
  onConfirm,
  onCancel,
}: StyleScopeDialogProps) {
  const [remember, setRemember] = useState(false)
  // Default to the first ENABLED scope in presentation order. `scopes` is
  // ordered deliberately (element moves last when it can't win the cascade),
  // so "first enabled" is the product's own recommendation, not an assumption.
  const [picked, setPicked] = useState<StyleScope | undefined>(() =>
    scopes.find((s) => enabledScopes.includes(s)),
  )
  const enabled = new Set(enabledScopes)
  const reasons = scopeDialogReasons(origin, { elementScopeOutranked })

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      {/*
        Radix focuses the first tabbable child on open, which here is the "From:"
        provenance trigger, because the readout sits above the options. That put
        the ring on a line of explanatory text and left the actual decision
        unfocused, so a keyboard user's first arrow key did nothing useful.
        Hand focus to the chosen option instead: it is what the dialog is asking
        about, and from there arrow keys move between scopes.
      */}
      <DialogContent
        size="xl"
        data-testid="style-scope-dialog"
        onOpenAutoFocus={(event) => {
          const content = event.currentTarget
          if (!(content instanceof HTMLElement)) return
          const checked = content.querySelector<HTMLElement>(
            '[role="radio"][data-state="checked"]:not([disabled])',
          )
          if (!checked) return
          event.preventDefault()
          checked.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Where should {property} change?</DialogTitle>
          {/*
            One description, not a caption plus a warning banner. The reasons
            used to live in a tinted Callout below the provenance row, which
            made four stacked blocks before the user reached a control. They are
            already whole sentences, so joining them reads as the paragraph a
            person would have written, and the generic "the edit could mean
            different things" line is dropped whenever they are present: the
            reasons ARE the different things, so keeping both said it twice.
          */}
          <DialogDescription data-testid="style-scope-reasons">
            {reasons.length > 0
              ? `${reasons.join(" ")} Choose where to apply it.`
              : "This value isn't a plain class on this element, so the edit could mean different things. Choose where to apply it."}
          </DialogDescription>
        </DialogHeader>

        {/* Grounding: the provenance chain for the edited property. Gated on
            the row's own emptiness test, or the no-rule origin renders this
            container around nothing. */}
        {hasStyleOrigin(origin) ? (
          <ValueReadout label="From">
            <StyleOriginRow origin={origin} />
          </ValueReadout>
        ) : null}

        <OptionCardGroup
          value={picked}
          onValueChange={(v) => setPicked(v as StyleScope)}
          aria-label="Style scope"
        >
          {scopes.map((scope) => {
            const meta = SCOPE_META[scope]
            const isEnabled = enabled.has(scope)
            const hint =
              scope === "element" && elementScopeOutranked
                ? `${meta.hint(origin)} ${OUTRANKED_ELEMENT_HINT}`
                : meta.hint(origin)
            return (
              <OptionCard
                key={scope}
                value={scope}
                disabled={!isEnabled}
                data-testid={`style-scope-${scope}`}
                title={
                  <>
                    {meta.label}
                    {!isEnabled ? (
                      <span className="ml-1.5 text-2xs font-normal text-muted-foreground">
                        (coming soon)
                      </span>
                    ) : null}
                  </>
                }
                hint={hint}
              />
            )
          })}
        </OptionCardGroup>

        {EDITOR_REMEMBER_SCOPE_CHOICE ? (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={remember}
              onCheckedChange={(checked) => setRemember(checked === true)}
              data-testid="style-scope-remember"
            />
            Remember my choice for style edits this session
          </label>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} data-testid="style-scope-cancel">
            Cancel
          </Button>
          <Button
            onClick={() => picked && onConfirm(picked, remember)}
            disabled={!picked}
            data-testid="style-scope-confirm"
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

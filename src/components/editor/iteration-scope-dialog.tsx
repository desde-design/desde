"use client"

/**
 * Iteration-scope dialog.
 *
 * Shown when the designer triggers a structural edit (delete, prop change,
 * duplicate, move, insert) on an element that's one of N renderings of a
 * framework loop (Vue `v-for`, React `.map`, etc.). The shared template
 * position is ambiguous — a naive edit would rewrite the template and
 * affect every iteration. This dialog forces an explicit choice:
 *
 *   - 'this-row'   — mutate just the data array entry that produced this
 *                    rendering (e.g. drop one item from `configPropertyCollections`).
 *   - 'all-rows'   — rewrite the template position (today's behavior).
 *
 * v1 has no default per `tasks/_archive/one-shot-tasks/iteration-aware-edits.md` decision D —
 * always prompt, collect telemetry on choices for ~2 weeks, pick defaults
 * later.
 *
 * The per-session `remember` checkbox is DORMANT — see
 * {@link EDITOR_REMEMBER_SCOPE_CHOICE}. The parameter and the caller's memory
 * map stay wired so restoring it is one constant.
 *
 * The component is edit-kind-agnostic: callers pass `editKind` for copy
 * (the dialog labels accordingly) and `siblingCount` so the prompt can
 * say "1 of 8 rows."
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
import { OptionCard, OptionCardGroup } from "@/components/blocks"

export type IterationScope = "this-row" | "all-rows"

/**
 * The user-facing reason the this-item path is unavailable for slot text.
 *
 * Exported so the ONE call site (editor-surface.tsx) and the gallery fixture
 * share a single string. It used to be duplicated in both, which is exactly how
 * a fixture drifts into showing copy the product doesn't say.
 */
export const THIS_ITEM_UNAVAILABLE_REASON =
  "Editing a single item's text isn't wired up yet. Use All items, or describe the change in chat."

/**
 * Display copy keyed by edit kind.
 *
 * Vocabulary rules, decided 2026-08-09 — keep new kinds consistent with them:
 *
 * - **"item", never "row".** These are as often cards, tabs or list entries as
 *   table rows; "row" quietly presumes a table.
 * - **"a loop", never "the v-for template".** Desde is framework-neutral
 *   above the adapter layer, and this dialog fires for React `.map` and Svelte
 *   `#each` too — a React user being told about `v-for` is a product bug, not a
 *   wording nit. Nothing user-facing here may name a framework construct.
 * - **The all-items hint must carry the consequence**, not just the count.
 *   "All items" alone reads as "empty the list"; what actually changes is the
 *   code that renders them, so items added later are affected too. That
 *   asymmetry is the whole reason this dialog exists.
 *
 * Hints take `count` so they can name the blast radius. Use {@link others} to
 * phrase it: "the other 7 stay" reads fine, "the other 1 stay" does not, and
 * siblingCount 2 is the commonest case this dialog fires on.
 */
/** "the other 7" / "the one other", agreeing with the verb that follows. */
function others(count: number): { subject: string; verb: (s: string, p: string) => string } {
  const n = Math.max(count - 1, 0)
  return {
    subject: n === 1 ? "The one other" : `The other ${n}`,
    verb: (singular, plural) => (n === 1 ? singular : plural),
  }
}

const EDIT_LABELS: Record<IterationEditKind, {
  /** The dialog title, written as a whole question. */
  title: string
  verb: string
  thisItem: string
  allItems: string
  thisItemHint: (count: number) => string
  /**
   * The hint shown INSTEAD of `thisItemHint` when the element the designer
   * picked sits inside the item rather than being the item. Only `delete` and
   * `move` have one: they are the two kinds whose row edit names no field, so
   * a nested element cannot be expressed as a change to one data entry and the
   * edit goes to chat. See `thisRowOperationAllowed`.
   */
  thisItemChatHint?: string
  allItemsHint: string
  /**
   * The hint shown INSTEAD of `allItemsHint` when the picked element sits
   * inside the item rather than being the item.
   *
   * "All items" edits the shared template, and what that DOES depends on which
   * element in the template was picked. On the loop element it is the loop:
   * deleting removes the loop, moving moves the whole set. On something nested
   * inside a row it is that element in every item, and every item keeps
   * rendering. The two are different edits and the plain hint described only
   * the first, so a designer reading it would have expected the set to vanish
   * when one label inside each item was about to.
   *
   * Only `delete` and `move` have one, for the same reason as
   * {@link thisItemChatHint}: they are the kinds whose effect changes with the
   * element. `prop` and `dom-text` name a field either way.
   */
  allItemsNestedHint?: string
}> = {
  delete: {
    title: "Delete this item or all items?",
    verb: "Delete",
    thisItem: "This item",
    allItems: "All items",
    thisItemHint: (n) => {
      const o = others(n)
      return `Removes one entry from the data. ${o.subject} ${o.verb("stays", "stay")}.`
    },
    thisItemChatHint:
      "Goes to chat. What you picked sits inside the item, so removing it from the data would remove the whole item.",
    allItemsHint:
      "Removes the loop that renders them, so nothing will show here, including items added later.",
    allItemsNestedHint: "Removes this element from every item. The items themselves stay.",
  },
  prop: {
    title: "Change this item or all items?",
    verb: "Edit",
    thisItem: "This item",
    allItems: "All items",
    thisItemHint: (n) => {
      const o = others(n)
      return `Changes one entry in the data. ${o.subject} ${o.verb("keeps", "keep")} its value.`
    },
    allItemsHint:
      "Changes the loop itself, so every item updates, including items added later.",
  },
  duplicate: {
    title: "Duplicate this item or all items?",
    verb: "Duplicate",
    thisItem: "This item",
    allItems: "All items",
    thisItemHint: () => "Adds a copy of this entry to the data. The others stay as they are.",
    allItemsHint:
      "Duplicates the whole loop, so the entire set renders twice. Usually not the intent.",
  },
  move: {
    title: "Move this item or all items?",
    verb: "Move",
    thisItem: "This item",
    allItems: "All items",
    thisItemHint: () => "Reorders this entry within the data.",
    thisItemChatHint:
      "Goes to chat. What you picked sits inside the item, so reordering the data would move the whole item instead.",
    allItemsHint: "Moves the whole set on the page, relative to what's around it.",
    allItemsNestedHint: "Moves this element within every item.",
  },
  // Spec only: `PendingIterationEdit` has no `insert` (or `duplicate`) variant,
  // so nothing can open the dialog with these kinds today. Kept so the
  // vocabulary is already decided when they land.
  insert: {
    title: "Add inside the set or outside it?",
    verb: "Insert",
    // Insert is the one kind where the two choices aren't "one vs all" — you're
    // adding something, so the question is whether it joins the set or sits
    // beside it. Same vocabulary, different framing.
    thisItem: "Inside the set",
    allItems: "Outside the set",
    thisItemHint: () => "Adds a new entry to the data, next to this item.",
    allItemsHint: "Adds an element beside the whole set, not part of the loop.",
  },
  "dom-text": {
    title: "Change the text on this item or all items?",
    verb: "Edit text",
    thisItem: "This item",
    allItems: "All items",
    thisItemHint: (n) => {
      const o = others(n)
      return `Changes the text on this entry. ${o.subject} ${o.verb("keeps", "keep")} its own.`
    },
    allItemsHint:
      "Rewrites the shared text, so every item shows the new value, including items added later. Only useful when they all show the same text today.",
  },
}

export type IterationEditKind = "delete" | "prop" | "duplicate" | "move" | "insert" | "dom-text"

interface IterationScopeDialogProps {
  /** Truthy → dialog open. */
  open: boolean
  /** Which edit triggered the prompt — drives copy. */
  editKind: IterationEditKind
  /** Total iterations on screen (e.g. 8). Used to label "1 of N rows". */
  siblingCount: number
  /** The this-row index (0-based) for the row preview. */
  rowIndex: number
  /**
   * The picked element sits INSIDE the item rather than being the item, so
   * "This item" hands the edit to chat instead of editing the data.
   *
   * Gated at both ends: `dispatchIterationEdit` refuses the same case, and
   * this is what stops the dialog promising a data edit it will not make.
   * Only `delete` and `move` can set it.
   */
  thisItemGoesToChat?: boolean
  /**
   * The picked element sits INSIDE the item, as the loop check established.
   * Changes what "All items" means: the shared template edit lands on that
   * element in every item, and every item goes on rendering.
   *
   * Separate from {@link thisItemGoesToChat}, which is the gate. The gate
   * fails closed and so is also true when a position is missing; this one is
   * only ever true when the nesting was actually measured, because it is the
   * basis of a sentence describing what will happen.
   */
  clickedInsideItem?: boolean
  /** Designer picked a scope. `remember` is the checkbox state at submit. */
  onConfirm: (scope: IterationScope, remember: boolean) => void
  /** Designer dismissed — no edit is buffered. */
  onCancel: () => void
}

export function IterationScopeDialog({
  open,
  editKind,
  siblingCount,
  rowIndex,
  thisItemGoesToChat = false,
  clickedInsideItem = false,
  onConfirm,
  onCancel,
}: IterationScopeDialogProps) {
  const [remember, setRemember] = useState(false)
  // Pre-select the narrower blast radius. Every edit kind can produce a
  // this-row edit as of 2026-08-16, so there is no longer a case where this
  // default is unavailable — the gate that used to guard it is gone.
  const [scope, setScope] = useState<IterationScope>("this-row")
  const labels = EDIT_LABELS[editKind]
  // The chat hint replaces the data hint rather than sitting beside it: the
  // data hint describes an edit that will not happen in this case.
  const thisItemHint =
    thisItemGoesToChat && labels.thisItemChatHint
      ? labels.thisItemChatHint
      : labels.thisItemHint(siblingCount)
  // Same substitution on the other card, for the same reason: with a nested
  // element picked, "Removes the loop that renders them" and "Moves the whole
  // set" are both descriptions of an edit this dialog will not make.
  const allItemsHint =
    clickedInsideItem && labels.allItemsNestedHint
      ? labels.allItemsNestedHint
      : labels.allItemsHint

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent size="xl" data-testid="iteration-scope-dialog">
        <DialogHeader>
          <DialogTitle>{labels.title}</DialogTitle>
          {/*
            No verb spliced in here. It used to end "choose what this {verb}
            applies to", which produced "choose what this edit text applies to"
            for the dom-text kind. The title already asks the question and the
            two options say what each one does, so the description only has to
            supply the fact that makes the question necessary.
          */}
          <DialogDescription>
            This is item {rowIndex + 1} of {siblingCount}, rendered by a loop,
            and they all come from the same code.
          </DialogDescription>
        </DialogHeader>

        <OptionCardGroup
          value={scope}
          onValueChange={(v) => setScope(v as IterationScope)}
          aria-label="Iteration scope"
        >
          <OptionCard
            value="this-row"
            title={labels.thisItem}
            hint={thisItemHint}
            data-testid="iteration-scope-this-row"
          />

          <OptionCard
            value="all-rows"
            title={labels.allItems}
            hint={allItemsHint}
            data-testid="iteration-scope-all-rows"
          />
        </OptionCardGroup>

        {EDITOR_REMEMBER_SCOPE_CHOICE ? (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={remember}
              onCheckedChange={(checked) => setRemember(checked === true)}
              data-testid="iteration-scope-remember"
            />
            Remember my choice for {labels.verb.toLowerCase()} this session
          </label>
        ) : null}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={onCancel}
            data-testid="iteration-scope-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={() => scope && onConfirm(scope, remember)}
            disabled={!scope}
            data-testid="iteration-scope-confirm"
          >
            {labels.verb}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

"use client"

/**
 * Delete-scope dialog.
 *
 * When the designer deletes an element that lives inside a reused component,
 * a deterministic source edit can't remove just that one sub-element from
 * just one instance — the element is authored once in the component's SFC.
 * This modal forces an explicit choice between the two edits that *are*
 * expressible:
 *   - 'callsite'   — delete the whole component usage at the parent call site
 *                    (only that usage is affected)
 *   - 'definition' — delete the element from the component's own SFC
 *                    (affects every place the component is used)
 *
 * `useEditorEditing.handleLayerDelete` opens this only when the
 * element's `editTarget` lives in a different file from its
 * `authoredAt` (i.e. it really is inside a reused component);
 * elements where the two coincide get buffered immediately, with no
 * prompt.
 *
 * ## The dead end (no scope available)
 *
 * Both scopes can be unavailable at once: the commonest case is an element
 * whose call site AND definition both live in `node_modules`, which editor
 * never rewrites. This used to render two greyed-out option cards, each
 * repeating a variant of "can't edit X: it's library source", above a greyed
 * Delete and a Cancel.
 *
 * That is a decision screen for a decision that does not exist. Three controls
 * were on screen and none of them did anything; the only real content was the
 * reason, said twice, in the quietest text in the dialog. It now renders as a
 * plain "this can't be done, here is why" modal with a single Close, per
 * `docs/design.md` § "A dialog with no options is not a dialog".
 */

import { useState } from "react"
import type { OutlineNode } from "@/types/bridge"
import { deleteScopeAvailability } from "@/editor/core"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { OptionCard, OptionCardGroup } from "@/components/blocks"

type DeleteScope = "definition" | "callsite"

interface DeleteScopeDialogProps {
  /** Truthy → modal open. */
  open: boolean
  /** The element pending deletion; null when the dialog is closed. */
  node: OutlineNode | null
  /** Designer picked a scope — the deferred DeleteEdit is buffered with it. */
  onConfirm: (scope: DeleteScope) => void
  /** Designer dismissed — no edit is buffered. */
  onCancel: () => void
}

/** Last path segment — "src/ui/Card.vue" → "Card.vue". */
function baseName(file: string): string {
  return file.split("/").pop() ?? file
}

/** Mirrors the `editable()` test inside `deleteScopeAvailability`. */
function isLibrarySource(file: string | undefined): boolean {
  return !!file && file.split("/").includes("node_modules")
}

/**
 * The external library a `node_modules` path belongs to, or undefined.
 *
 * Deliberately a local six-liner rather than an import of the bridge's
 * `extractPackageName`: no file under `src/components/` imports from
 * `src/bridge/` today, and this dialog is not the place to open that edge.
 *
 * Scoped packages take two segments (`@acme/design-system`), unscoped take one.
 * Returns undefined for a layout that yields neither, so the copy can fall back
 * rather than print a fragment.
 */
function packageNameFromPath(file: string | undefined): string | undefined {
  if (!file) return undefined
  const segments = file.split("/")
  const at = segments.lastIndexOf("node_modules")
  if (at === -1) return undefined
  const first = segments[at + 1]
  if (!first) return undefined
  // A package name must be a DIRECTORY, so something has to follow it.
  // Without this, `node_modules/stray.css` reports "stray.css" as the package.
  // An extension check would not do instead: `lodash.merge` is a real package.
  const scoped = first.startsWith("@")
  const nameEnd = scoped ? at + 2 : at + 1
  if (segments.length <= nameEnd + 1) return undefined
  if (!scoped) return first
  const second = segments[at + 2]
  return second ? `${first}/${second}` : undefined
}

/**
 * Why neither delete scope is available, for the dead-end modal.
 *
 * Exported for the colocated test: the copy is the entire product of that
 * screen, so it is worth pinning independently of rendering.
 *
 * ## Why this names the PACKAGE and not the files
 *
 * The first version of this copy said "authored in `UiCard.vue` and
 * `UiButton.vue`, which are library source". Two problems, and the phrase was
 * the smaller one.
 *
 * The identifiers were wrong. A designer installed `@acme/design-system`, or at
 * least has heard it named. They have never opened `UiCard.vue` and do not know
 * it exists, so two basenames they cannot place is strictly worse than one
 * package name they might. A bare basename is also ambiguous when they forward
 * it to an engineer; a package name is not.
 *
 * `package` is therefore the primary identifier and `files` is the fallback,
 * used only when the path yields no package name. The fallback is not a
 * degraded variant, it trades one identifier for another.
 *
 * `files` stays deduplicated: the two locations genuinely coincide for a
 * component leaf, and "UiButton.vue and UiButton.vue" is the kind of sentence
 * that makes a user doubt the tool.
 */
export function deleteUnavailableReason(node: OutlineNode | null): {
  kind: "library" | "unlocatable"
  package?: string
  files: string[]
} {
  const candidates = [node?.editTarget?.file, node?.authoredAt?.file]
  const libraryFiles = candidates.filter(isLibrarySource) as string[]
  const files = [...new Set(libraryFiles.map(baseName))]
  // Call site first: it is the outer, more recognisable package when the two
  // differ (the card the designer placed, rather than the button inside it).
  const pkg = libraryFiles.map(packageNameFromPath).find(Boolean)
  // No library file named means the scopes failed the other way: the editor
  // never resolved a source file at all. Claiming it came from a package there
  // would be a confident wrong answer, so the copy branches instead.
  return {
    kind: files.length > 0 ? "library" : "unlocatable",
    package: pkg,
    files,
  }
}

/**
 * The greyed hint under an unavailable delete option.
 *
 * One component for both options so the two cards cannot drift into saying the
 * same thing two ways, which is how the previous copy ended up repeating "it's
 * library source" verbatim under both.
 *
 * It branches on the actual cause. A scope can be unavailable because its file
 * is in an external library, but `callsite` is ALSO unavailable when it
 * resolves to the same file as the definition, and there "it's part of an
 * external library" would be a confident wrong reason. In practice
 * `handleLayerDelete` only opens this dialog for distinct files, so the second
 * branch is unreachable from the product today. It is written anyway because
 * this is a dumb component and the gate lives two layers away.
 *
 * No advice here, unlike the dead-end modal: the live option sitting next to
 * this one is the advice.
 */
function UnavailableHint({
  file,
  fallbackLabel,
}: {
  file: string | undefined
  fallbackLabel: string
}) {
  const name = file ? <span className="font-mono">{baseName(file)}</span> : null
  if (!isLibrarySource(file)) {
    return <>This would be the same edit as the other option.</>
  }
  const pkg = packageNameFromPath(file)
  return (
    <>
      Can&apos;t edit {name ?? fallbackLabel}: it&apos;s part of{" "}
      {pkg ? (
        <>
          <span className="font-mono">{pkg}</span>, an external library.
        </>
      ) : (
        <>an external library.</>
      )}
    </>
  )
}

export function DeleteScopeDialog({
  open,
  node,
  onConfirm,
  onCancel,
}: DeleteScopeDialogProps) {
  const elementName = node?.name ?? "element"
  const callsiteFile = node?.editTarget?.file
  const definitionFile = node?.authoredAt?.file
  // A scope is unavailable when its file is missing or library source —
  // editor never rewrites node_modules. Shared with the pending-edit toggle
  // and the adapter so the three stay in sync.
  const avail = node
    ? deleteScopeAvailability(node)
    : { definition: false, callsite: false }

  // Default to the narrower blast radius when it is available: removing one
  // usage is recoverable in a way that editing the shared definition is not.
  const defaultScope = avail.callsite
    ? "callsite"
    : avail.definition
      ? "definition"
      : undefined
  // Neither scope is expressible. Not a decision, so not a decision screen.
  const deadEnd = !avail.callsite && !avail.definition

  // Re-seed on every new node, because this dialog is MOUNTED FOR THE WHOLE
  // SESSION (editor-surface renders it with `open={!!prompt}`, not inside a
  // conditional). A `useState` initializer therefore runs exactly once, on the
  // first render, when `node` is still null. Left as an initializer the default
  // was never computed for any real node: the dialog opened with nothing
  // selected and a dead Delete button, and once the user did pick, that pick
  // survived into the NEXT element's prompt, where the scope may not even be
  // available. Same setState-during-render idiom as save-progress-dialog.
  const [scope, setScope] = useState<DeleteScope | undefined>(defaultScope)
  const [prevNode, setPrevNode] = useState(node)
  if (node !== prevNode) {
    setPrevNode(node)
    setScope(defaultScope)
  }

  if (deadEnd) {
    const reason = deleteUnavailableReason(node)
    return (
      <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
        {/* `md`, not `xl`: two sentences in a decision-width box is mostly
            empty. Width follows the content, not the surface it replaced.

            No `X`: the footer button is already named Close and does the same
            thing, so keeping both puts two buttons with the identical
            accessible name in a modal that has exactly one action. Esc still
            closes it. (The decision branch below keeps its `X`, where the
            footer says Cancel and Delete.) */}
        <DialogContent
          size="md"
          showCloseButton={false}
          data-testid="delete-scope-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              Can&apos;t delete{" "}
              <span className="font-mono">&lt;{elementName}&gt;</span>
            </DialogTitle>
            {/* One description, no Callout: the reason IS the dialog, so
                putting it in a tinted banner adds a second block of prose
                under a header that now has nothing else to say. */}
            {/* "an external library", never "library source". Both words in
                the old phrase were broken: "source" reads as origin rather
                than as files, and to a designer coming from Figma a "library"
                is a shared asset you CAN edit. It was also sometimes just
                wrong, since a node_modules package need not be a component
                library at all. See docs/design.md § "Installed packages".

                Ownership carries the reason here, not the reinstall
                consequence. "The next install would erase it" is true but it
                is the weaker half, and it only makes sense where a write was
                actually attempted, which is Site D in edit-handler.ts.

                The product is not the subject of either sentence. It said
                "Desde only changes files in your project" and "Desde couldn't
                work out which file", which names the tool where the reader
                only cares what happened to their work. See docs/design.md
                § "The product is not a character in its own copy". */}
            <DialogDescription data-testid="delete-scope-unavailable-reason">
              {reason.kind === "library" ? (
                <>
                  <span className="font-mono">&lt;{elementName}&gt;</span> comes
                  from{" "}
                  {reason.package ? (
                    <>
                      <span className="font-mono">{reason.package}</span>, an
                      external library.
                    </>
                  ) : (
                    <>
                      an external library, not from your project (
                      {reason.files.map((file, index) => (
                        <span key={file}>
                          {index > 0 ? " and " : null}
                          <span className="font-mono">{file}</span>
                        </span>
                      ))}
                      ).
                    </>
                  )}{" "}
                  You can only edit files in your own project, so there is no
                  change here that removes it. Ask chat how to remove{" "}
                  <span className="font-mono">&lt;{elementName}&gt;</span> from
                  this screen.
                </>
              ) : (
                <>
                  <span className="font-mono">&lt;{elementName}&gt;</span>{" "}
                  couldn&apos;t be traced back to a file, so there is no place
                  to make the change. Try selecting it again.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button onClick={onCancel} data-testid="delete-scope-close">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent size="xl" data-testid="delete-scope-dialog">
        <DialogHeader>
          <DialogTitle>
            Delete <span className="font-mono">&lt;{elementName}&gt;</span>
          </DialogTitle>
          <DialogDescription>
            This element lives inside a reused component, so a source edit
            can&apos;t remove it from just one instance. Choose what to delete.
          </DialogDescription>
        </DialogHeader>

        <OptionCardGroup value={scope} onValueChange={(v) => setScope(v as DeleteScope)} aria-label="Delete scope">
          <OptionCard
            value="callsite"
            disabled={!avail.callsite}
            title="Delete this instance"
            hint={
              !avail.callsite ? (
                <UnavailableHint
                  file={callsiteFile}
                  fallbackLabel="the call site"
                />
              ) : (
                <>
                  Removes the whole component usage
                  {callsiteFile ? (
                    <>
                      {" "}
                      from{" "}
                      <span className="font-mono">
                        {baseName(callsiteFile)}
                      </span>
                    </>
                  ) : null}
                  . Other usages stay.
                </>
              )
            }
            data-testid="delete-scope-callsite"
          />

          <OptionCard
            value="definition"
            disabled={!avail.definition}
            title="Delete from component"
            hint={
              !avail.definition ? (
                <UnavailableHint
                  file={definitionFile}
                  fallbackLabel="this component"
                />
              ) : (
                <>
                  Removes this element from{" "}
                  <span className="font-mono">
                    {definitionFile
                      ? baseName(definitionFile)
                      : "the component"}
                  </span>
                  . Affects every place it&apos;s used.
                </>
              )
            }
            data-testid="delete-scope-definition"
          />
        </OptionCardGroup>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={onCancel}
            data-testid="delete-scope-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => scope && onConfirm(scope)}
            disabled={!scope}
            data-testid="delete-scope-confirm"
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

"use client"

/**
 * The "add a design system" modal — source first, then that source's details.
 *
 * Replaces the inline 3-radio-card flow inside the New Project step (Mo,
 * 2026-08-17). The step is now a LIST of design systems with an Add button
 * under it, and adding is a modal rather than a form living permanently at the
 * bottom of the step.
 *
 * ## Two sources here, not three
 *
 * `AddDesignSystem` offered Detected / npm / Git repo. "Detected" is gone from
 * the choice, because the things it found are now seeded into the list
 * automatically — asking someone to pick "already installed here" and then
 * pick again from a list of what was found was asking the same question twice.
 * What is left is the two sources a person actually types: an npm package or a
 * Git repository.
 *
 * ## Why a modal, when the house rule says steps-not-tabs
 *
 * That rule is about how to ask "where does this come from" ONCE, and it still
 * applies: radio cards, then that source's form. The change is where the
 * asking happens. Inline, the form sat at the bottom of the step for everyone,
 * including the majority who only wanted to glance at the list and continue —
 * `docs/design.md` § "Steps, not tabs" makes exactly that complaint about a
 * permanent half-filled form. A modal is the same flow, entered deliberately.
 *
 * ## Editing reuses this
 *
 * Pass `initial` and it opens on the details step with the fields filled and
 * the source fixed — you are editing that entry, not re-choosing what it is.
 * That is the same reason `docs/design.md` gives for a deep link skipping the
 * picker: the question is already answered, so returning to it goes backwards.
 */

import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogCopy,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Field, OptionCard, OptionCardGroup } from "@/components/blocks"
import type { DesignSystemDeclaration } from "@/editor/core/design-system-declarations"

/** The two sources a person types in. "Detected" is seeded, never chosen. */
export type AddDialogSource = "npm" | "repo"

export interface AddDesignSystemDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Editing an existing entry. Opens straight on the details step with the
   * source fixed. Undefined means adding a new one.
   */
  initial?: DesignSystemDeclaration | null
  /** Resolve truthy to close; falsy leaves the form up with what was typed. */
  onSubmit: (declaration: DesignSystemDeclaration) => Promise<unknown> | unknown
  busy?: boolean
}

/**
 * Identity for the re-seed check only. Same shape as `pendingIdentity`, kept
 * local because this dialog must not import from the page that hosts it — the
 * settings panel is meant to be able to use it too.
 */
function pendingKey(decl: DesignSystemDeclaration): string {
  const s = decl.source
  if (s.kind === "installed") return `installed:${s.package}`
  if (s.kind === "npm") return `npm:${s.spec}`
  return `repo:${s.url}|${s.ref ?? ""}|${s.subdir ?? ""}`
}

function sourceOf(decl: DesignSystemDeclaration | null | undefined): AddDialogSource | null {
  if (!decl) return null
  // A seeded `installed` entry has no editable source, so it never opens this.
  return decl.source.kind === "repo" ? "repo" : decl.source.kind === "npm" ? "npm" : null
}

export function AddDesignSystemDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
  busy = false,
}: AddDesignSystemDialogProps) {
  const editing = !!initial
  const [source, setSource] = useState<AddDialogSource | null>(null)
  const [spec, setSpec] = useState("")
  const [repoUrl, setRepoUrl] = useState("")
  const [repoRef, setRepoRef] = useState("")
  const [repoSubdir, setRepoSubdir] = useState("")
  const [allowBuild, setAllowBuild] = useState(false)

  /**
   * Re-seed whenever this opens, or opens onto a different entry.
   *
   * Set during RENDER, not in an effect — the same idiom `delete-scope-dialog`
   * and `save-progress-dialog` use, and `react-hooks/set-state-in-effect`
   * flags the effect version. The defect it prevents is the one those files
   * document: this dialog is mounted for the life of the step, so a `useState`
   * initializer runs once with `initial` undefined and never again, and one
   * entry's half-typed spec would survive into the next entry's form.
   */
  const [seedKey, setSeedKey] = useState<string | null>(null)
  const nextSeedKey = open ? (initial ? pendingKey(initial) : "new") : null
  if (nextSeedKey !== seedKey) {
    setSeedKey(nextSeedKey)
    setSource(sourceOf(initial))
    setSpec(initial?.source.kind === "npm" ? initial.source.spec : "")
    setRepoUrl(initial?.source.kind === "repo" ? initial.source.url : "")
    setRepoRef(initial?.source.kind === "repo" ? (initial.source.ref ?? "") : "")
    setRepoSubdir(initial?.source.kind === "repo" ? (initial.source.subdir ?? "") : "")
    setAllowBuild(initial?.allowBuild ?? false)
  }

  const build = (): DesignSystemDeclaration | null => {
    if (source === "npm") {
      const value = spec.trim()
      return value ? { source: { kind: "npm", spec: value } } : null
    }
    if (source === "repo") {
      const url = repoUrl.trim()
      if (!url) return null
      const ref = repoRef.trim()
      const subdir = repoSubdir.trim()
      return {
        source: { kind: "repo", url, ...(ref ? { ref } : {}), ...(subdir ? { subdir } : {}) },
        allowBuild,
      }
    }
    return null
  }

  const ready = build() !== null

  const submit = async () => {
    const declaration = build()
    if (!declaration) return
    const result = await onSubmit(declaration)
    // Falsy means the caller refused it (a duplicate, a failed validate), so
    // the form stays up with what was typed rather than closing over the loss.
    if (result) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" data-testid="add-design-system-dialog">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit design system" : "Add a design system"}
          </DialogTitle>
          <DialogCopy
            description={
              source === null
                ? "Where does it come from?"
                : source === "npm"
                  ? "It is installed from the registry, then read so the agent can build with its components."
                  : "It is cloned with the git credentials already on this machine, then read so the agent can build with its components."
            }
          />
        </DialogHeader>

        {source === null ? (
          <OptionCardGroup
            value={undefined}
            onValueChange={(next) => setSource(next as AddDialogSource)}
            aria-label="Where the design system comes from"
            data-testid="add-design-system-source-step"
          >
            <OptionCard
              value="npm"
              title="npm package"
              hint="Published to a registry."
              data-testid="add-design-system-source-npm"
            />
            <OptionCard
              value="repo"
              title="GitHub repository"
              hint="Cloned from a git URL."
              data-testid="add-design-system-source-repo"
            />
          </OptionCardGroup>
        ) : source === "npm" ? (
          <div className="flex flex-col gap-3" data-testid="add-design-system-npm-step">
            <Field label="Package" htmlFor="add-ds-spec">
              <Input
                id="add-ds-spec"
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && ready) {
                    e.preventDefault()
                    void submit()
                  }
                }}
                placeholder="@scope/package or package@version"
                disabled={busy}
                autoFocus
              />
            </Field>
          </div>
        ) : (
          <div className="flex flex-col gap-3" data-testid="add-design-system-repo-step">
            <Field label="Repository URL" htmlFor="add-ds-repo-url">
              <Input
                id="add-ds-repo-url"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/org/design-system.git"
                disabled={busy}
                autoFocus
              />
            </Field>
            <div className="flex items-start gap-2">
              <Field label="Branch or tag" htmlFor="add-ds-ref" className="flex-1">
                <Input
                  id="add-ds-ref"
                  value={repoRef}
                  onChange={(e) => setRepoRef(e.target.value)}
                  placeholder="Optional"
                  disabled={busy}
                />
              </Field>
              <Field label="Subdirectory" htmlFor="add-ds-subdir" className="flex-1">
                <Input
                  id="add-ds-subdir"
                  value={repoSubdir}
                  onChange={(e) => setRepoSubdir(e.target.value)}
                  placeholder="Optional"
                  disabled={busy}
                />
              </Field>
            </div>
            {/*
              The warning stays with the control that causes it. Ticking this
              runs the repo's own build script on the user's machine, which is
              the one thing on this screen with a consequence outside the app.
            */}
            <label className="flex items-start gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={allowBuild}
                onCheckedChange={(v) => setAllowBuild(v === true)}
                disabled={busy}
                className="mt-0.5"
                aria-label="Allow build"
              />
              <span>
                Run the repo&apos;s build script if it ships no types.{" "}
                <span className="text-warning">
                  This executes the repo&apos;s code on your machine, so only enable
                  it for repos you trust.
                </span>
              </span>
            </label>
          </div>
        )}

        <DialogFooter>
          {/*
            Back returns to the source picker, and only when there is one to
            return to. Editing opened straight on the details with the source
            already settled, so a Back there would walk the user into a
            question they were not asked.

            Back JOINS Cancel rather than replacing it (Mo, 2026-08-29): a
            step whose only footer buttons are Back and the primary has no
            visible way out of the dialog. Back parks left as wizard
            navigation; Cancel stays beside the primary.
          */}
          {source !== null && !editing ? (
            <Button
              variant="ghost"
              className="sm:mr-auto"
              onClick={() => setSource(null)}
              disabled={busy}
              data-testid="add-design-system-back"
            >
              Back
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || !ready}
            data-testid="add-design-system-submit"
          >
            {editing ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

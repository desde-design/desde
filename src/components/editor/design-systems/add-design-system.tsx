"use client"

/**
 * `<AddDesignSystem>` — pick where a design system comes from (Detected / npm /
 * Git repo), then fill in that source's form. Extracted out of
 * `design-systems-panel.tsx` (Phase 3 attach/refresh, task 3) so a second
 * surface (the onboarding launcher) can reuse the exact same behavior instead
 * of forking it.
 *
 * **Stepped, not tabbed.** The three sources used to be a `TabsList` pinned to
 * the bottom of the Design systems panel. Tabs are for switching between views
 * of the same thing; these are three different one-time answers to "where is it
 * coming from", and rendering them as tabs put a permanent, half-filled form at
 * the bottom of a panel that is mostly a list. Radio cards then Next matches
 * the New Project dialog, which asks the same shape of question.
 *
 * Purely props-driven: the caller owns data (suggestions, loading, busy) and
 * the mutation callbacks; this component owns only its own step and form-field
 * state, and clears the fields on a successful add.
 *
 * `density` controls visual compactness only:
 * - `'panel'` (default) keeps the existing compact `h-7`/`text-xs` sizing
 *   the right-rail panel has always used.
 * - `'launcher'` drops those overrides in favor of the shadcn defaults, for
 *   use inside a roomier dialog surface.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Field, OptionCard, OptionCardGroup } from "@/components/blocks"
import { cn } from "@/lib/utils"

export type AddDesignSystemSource = "detected" | "npm" | "repo"

export interface AddDesignSystemProps {
  suggestions: ReadonlyArray<{ package: string; componentCount: number; framework: string }>
  loading: boolean
  busy: boolean
  /**
   * The three add callbacks. **Resolve truthy on success, falsy on failure** —
   * that result is what clears the form and closes the flow, so a `void`
   * return would add the system and then strand the user on a filled-in form.
   * The type used to allow `void`; it does not now, because the flow cannot
   * honour it. (`useDesignSystems`'s `onboard` already resolves the result or
   * `null`, which is exactly this contract.)
   */
  onAddInstalled: (pkg: string) => Promise<unknown>
  onAddNpm: (spec: string) => Promise<unknown>
  onAddRepo: (opts: {
    url: string
    ref?: string
    subdir?: string
    allowBuild: boolean
  }) => Promise<unknown>
  /** 'panel' keeps the compact h-7 sizing; 'launcher' uses default control sizes inside the dialog. */
  density?: "panel" | "launcher"
  /**
   * Deep-link support (Phase 5 Task 5 — the Drift panel's "Add design
   * system" row action): which source to open ON, skipping the picker, and a
   * pre-filled npm spec. Both are read once at mount only (plain `useState`
   * initializers) — callers that need to re-seed an already-mounted instance
   * for a DIFFERENT entry should remount via a `key` change rather than
   * expect a prop update to take effect.
   */
  initialSource?: AddDesignSystemSource
  initialNpmSpec?: string
  /**
   * Called after an add succeeds. The Design systems panel uses it to leave
   * add mode and show the newly registered row; the New Project dialog omits
   * it and stays put so several can be queued up.
   */
  onAdded?: () => void
  /** Rendered next to the form's Add button. The host's way back out. */
  onCancel?: () => void
}

export function AddDesignSystem({
  suggestions,
  loading,
  busy,
  onAddInstalled,
  onAddNpm,
  onAddRepo,
  density = "panel",
  initialSource,
  initialNpmSpec = "",
  onAdded,
  onCancel,
}: AddDesignSystemProps) {
  // A deep link has already answered "where from", so asking again would be
  // a step the caller explicitly skipped past.
  const [source, setSource] = useState<AddDesignSystemSource | null>(initialSource ?? null)
  const [picking, setPicking] = useState(initialSource === undefined)
  const [spec, setSpec] = useState(initialNpmSpec)
  const [repoUrl, setRepoUrl] = useState("")
  const [repoRef, setRepoRef] = useState("")
  const [repoSubdir, setRepoSubdir] = useState("")
  const [allowBuild, setAllowBuild] = useState(true)

  const compact = density === "panel"
  const buttonClass = cn("shrink-0", compact && "h-7 px-3 text-xs")

  const handleAddInstalled = async (pkg: string) => {
    const result = await onAddInstalled(pkg)
    if (result) onAdded?.()
  }

  const handleAddNpm = async () => {
    const trimmed = spec.trim()
    if (!trimmed) return
    const result = await onAddNpm(trimmed)
    if (result) {
      setSpec("")
      onAdded?.()
    }
  }

  const handleAddRepo = async () => {
    const url = repoUrl.trim()
    if (!url) return
    const result = await onAddRepo({
      url,
      ref: repoRef.trim() || undefined,
      subdir: repoSubdir.trim() || undefined,
      allowBuild,
    })
    if (result) {
      setRepoUrl("")
      setRepoRef("")
      setRepoSubdir("")
      onAdded?.()
    }
  }

  /**
   * The way back out of a form, in precedence order:
   *
   * 1. The picker, when the picker is where we came from.
   * 2. The host's Cancel, for a deep link that skipped the picker: "back" would
   *    otherwise land somewhere the user never was.
   * 3. The picker anyway, for a deep link whose host gave no Cancel. Landing
   *    somewhere the user has not been beats a form with no way off it, which
   *    is what `initialSource="detected"` with nothing detected would be.
   */
  const backAction =
    source && (initialSource === undefined || !onCancel)
      ? { label: "Choose a different source", run: () => setPicking(true) }
      : onCancel
        ? { label: "Cancel", run: onCancel }
        : null

  const backButton = backAction ? (
    <Button
      type="button"
      variant="ghost"
      size={compact ? "xs" : "sm"}
      onClick={backAction.run}
      disabled={busy}
      data-testid="add-design-system-back"
    >
      {backAction.label}
    </Button>
  ) : null

  if (picking) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="add-design-system-source">
        <OptionCardGroup
          value={source ?? undefined}
          onValueChange={(next) => setSource(next as AddDesignSystemSource)}
          aria-label="Where the design system comes from"
        >
          <OptionCard
            value="detected"
            title="Already installed here"
            hint={
              loading
                ? "Scanning this prototype's dependencies…"
                : suggestions.length === 0
                  ? "Nothing unregistered found in this prototype."
                  : `${suggestions.length} unregistered ${suggestions.length === 1 ? "library" : "libraries"} found.`
            }
            disabled={busy || (!loading && suggestions.length === 0)}
            data-testid="add-design-system-detected"
          />
          <OptionCard
            value="npm"
            title="npm package"
            hint="Install it from the registry, then learn its components."
            disabled={busy}
            data-testid="add-design-system-npm"
          />
          <OptionCard
            value="repo"
            title="Git repository"
            hint="Clone and install it, then learn its components."
            disabled={busy}
            data-testid="add-design-system-repo"
          />
        </OptionCardGroup>

        <div className="flex items-center justify-end gap-1.5">
          {onCancel ? (
            <Button
              type="button"
              variant="ghost"
              size={compact ? "xs" : "sm"}
              onClick={onCancel}
              disabled={busy}
              data-testid="add-design-system-cancel"
            >
              Cancel
            </Button>
          ) : null}
          <Button
            type="button"
            size={compact ? "xs" : "sm"}
            className="shrink-0"
            disabled={busy || !source}
            onClick={() => setPicking(false)}
            data-testid="add-design-system-next"
          >
            Next
          </Button>
        </div>
      </div>
    )
  }

  if (source === "detected") {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="add-design-system-detected-step">
        {loading ? (
          <p className="px-1 py-2 text-sm text-muted-foreground">Scanning…</p>
        ) : suggestions.length === 0 ? (
          <p className="px-1 py-2 text-sm text-muted-foreground">
            No unregistered design-system libraries detected in this prototype.
          </p>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <ul className="space-y-1 pr-2">
              {suggestions.map((s) => (
                <li
                  key={s.package}
                  className="flex items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-1.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-normal">{s.package}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {s.componentCount} components · {s.framework}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    className={cn("shrink-0", compact && "h-6 px-2 text-xs")}
                    disabled={busy}
                    onClick={() => void handleAddInstalled(s.package)}
                  >
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
        <div className="flex items-center justify-end">{backButton}</div>
      </div>
    )
  }

  if (source === "npm") {
    return (
      <div className="flex flex-col gap-3" data-testid="add-design-system-npm-step">
        <Field
          label="Package"
          htmlFor="add-design-system-spec"
          hint="Already installed here, so its components just need to be learned."
        >
          <Input
            id="add-design-system-spec"
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void handleAddNpm()
              }
            }}
            placeholder="@scope/package or package@version"
            disabled={busy}
            className={cn(compact && "h-7 text-sm")}
            autoFocus
          />
        </Field>
        <div className="flex items-center justify-end gap-1.5">
          {backButton}
          <Button
            size={compact ? "xs" : "sm"}
            className={buttonClass}
            disabled={busy || !spec.trim()}
            onClick={() => void handleAddNpm()}
          >
            Add
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3" data-testid="add-design-system-repo-step">
      <Field
        label="Repository URL"
        htmlFor="add-design-system-repo-url"
        hint="Cloned with the git credentials already on this machine."
      >
        <Input
          id="add-design-system-repo-url"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/org/design-system.git"
          disabled={busy}
          className={cn(compact && "h-7 text-sm")}
          autoFocus
        />
      </Field>
      <div className="flex items-start gap-2">
        <Field label="Branch or tag" htmlFor="add-design-system-ref" className="flex-1">
          <Input
            id="add-design-system-ref"
            value={repoRef}
            onChange={(e) => setRepoRef(e.target.value)}
            placeholder="Optional"
            disabled={busy}
            className={cn(compact && "h-7 text-sm")}
          />
        </Field>
        <Field label="Subdirectory" htmlFor="add-design-system-subdir" className="flex-1">
          <Input
            id="add-design-system-subdir"
            value={repoSubdir}
            onChange={(e) => setRepoSubdir(e.target.value)}
            placeholder="Optional"
            disabled={busy}
            className={cn(compact && "h-7 text-sm")}
          />
        </Field>
      </div>
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
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
            This executes the repo&apos;s code on your machine, so only enable it for
            repos you trust.
          </span>
        </span>
      </label>
      <div className="flex items-center justify-end gap-1.5">
        {backButton}
        <Button
          size={compact ? "xs" : "sm"}
          className={buttonClass}
          disabled={busy || !repoUrl.trim()}
          onClick={() => void handleAddRepo()}
        >
          Add
        </Button>
      </div>
    </div>
  )
}

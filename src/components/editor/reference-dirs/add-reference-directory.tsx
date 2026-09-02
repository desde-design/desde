"use client"

/**
 * `<AddReferenceDirectory>` — the form for granting the agent read access to a
 * local folder. Shared by the New Project wizard's last step and the in-editor
 * settings dialog, the same way `AddDesignSystem` serves both surfaces.
 *
 * **Not a source picker.** `AddDesignSystem` opens with radio cards because a
 * design system genuinely comes from three structurally different places
 * (installed, npm, a git repo), and the answer changes which fields exist.
 * There is only one kind of thing here: a folder on this machine. So this
 * follows the wizard's own local-folder step instead — a path field with a
 * Browse button beside it, per `docs/design.md`'s rule that a picker filling a
 * field is a convenience, not a second submit.
 *
 * The three fields are not equally important, and the layout says so. The path
 * is the answer. The name is derived from it and only matters because the agent
 * says it out loud. The description is what actually makes the directory
 * useful, because it is the only thing telling the agent when this folder is
 * worth opening, so it is a first-class field rather than an "advanced" one.
 *
 * Purely props-driven: the caller owns inspection, the add itself, and busy
 * state. This component owns only its own field state and clears it on a
 * successful add.
 */

import { useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/blocks"
import { cn } from "@/lib/utils"

/** What the server reports back about a folder the user picked or typed. */
export interface ReferenceDirectoryInspection {
  path: string
  suggestedName: string
  isGit: boolean
}

/**
 * One reference directory, as the UI carries it.
 *
 * Structurally identical to `ReadRootDeclaration` in
 * `src/editor/core/read-root-declarations.ts`, and declared here rather than
 * imported for the same reason `pendingIdentity` is duplicated in
 * `new-project-page.tsx`: that module does `node:fs` work at module scope,
 * so importing it — even for a type — puts a Node built-in in the browser
 * bundle's resolution graph.
 */
export interface ReferenceDirectoryEntry {
  name: string
  path: string
  description?: string
}

export interface AddReferenceDirectoryProps {
  /**
   * Resolve a folder: is it usable, what should it be called, is it a git repo.
   * Resolves null when the path is unusable (the caller surfaces why).
   */
  onInspect: (path: string) => Promise<ReferenceDirectoryInspection | null>
  /**
   * Pop the native folder chooser. Resolves null when the platform has no
   * picker or the user dismissed it. When it resolves an inspection the form
   * fills straight from it, so Browse costs one round trip, not two.
   */
  onBrowse?: () => Promise<ReferenceDirectoryInspection | null>
  /** Resolves truthy on success, which is what clears the form. */
  onAdd: (entry: ReferenceDirectoryEntry) => Promise<unknown>
  /** Names already taken, so a collision is caught before the request. */
  takenNames: readonly string[]
  busy?: boolean
  /** 'panel' keeps the compact rail sizing; 'launcher' uses default control sizes. */
  density?: "panel" | "launcher"
  /**
   * Rendered in the action row before the Add button — the dialog hosts put
   * their Cancel here, so the one row holds every button and the dialog
   * never grows a second footer under the form's own (every modal footer
   * needs a visible Cancel, not just the header X). Renders inside this
   * component's `<form>`, so pass `type="button"` on any button.
   */
  footerStart?: ReactNode
  className?: string
}

/** Mirrors READ_ROOT_NAME_RE in `src/editor/core/read-roots.ts`. */
const NAME_RE = /^[a-z][a-z0-9-]{0,30}$/

export function AddReferenceDirectory({
  onInspect,
  onBrowse,
  onAdd,
  takenNames,
  busy = false,
  density = "panel",
  footerStart,
  className,
}: AddReferenceDirectoryProps) {
  const [path, setPath] = useState("")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [isGit, setIsGit] = useState<boolean | null>(null)
  /**
   * Whether the user typed the name themselves. Without this the rule was
   * "only fill an EMPTY name", which preserved a hand-edit but also pinned the
   * FIRST folder's generated name onto every folder picked afterwards, so a
   * second Browse could save the new path under the old folder's name.
   */
  const [nameEdited, setNameEdited] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const compact = density === "panel"
  const controlClass = compact ? "h-7 text-xs" : undefined
  const disabled = busy || checking

  function applyInspection(result: ReferenceDirectoryInspection | null): void {
    if (!result) return
    setPath(result.path)
    setIsGit(result.isGit)
    // A generated name follows the folder; a name the user typed does not.
    if (!nameEdited) setName(result.suggestedName)
  }

  async function handleBrowse(): Promise<void> {
    if (!onBrowse) return
    setError(null)
    setChecking(true)
    try {
      applyInspection(await onBrowse())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setChecking(false)
    }
  }

  /**
   * Resolve a typed path when the field loses focus. Doing it on blur rather
   * than per keystroke keeps this off the critical path of typing, and means a
   * half-typed path never reports itself as missing.
   */
  async function handlePathBlur(): Promise<void> {
    const trimmed = path.trim()
    if (trimmed.length === 0) return
    setError(null)
    setChecking(true)
    try {
      const result = await onInspect(trimmed)
      if (result) {
        applyInspection(result)
      } else {
        setIsGit(null)
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setChecking(false)
    }
  }

  const trimmedName = name.trim()
  const nameTaken = takenNames.includes(trimmedName)
  const nameMalformed = trimmedName.length > 0 && !NAME_RE.test(trimmedName)
  const nameError = nameTaken
    ? "That name is already used by another reference directory."
    : nameMalformed
      ? "Use lowercase letters, numbers and hyphens, starting with a letter."
      : undefined

  const canSubmit =
    path.trim().length > 0 && trimmedName.length > 0 && !nameError && !disabled

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!canSubmit) return
    setError(null)
    const result = await onAdd({
      name: trimmedName,
      path: path.trim(),
      ...(description.trim().length > 0 ? { description: description.trim() } : {}),
    })
    if (!result) return
    setPath("")
    setName("")
    setDescription("")
    setIsGit(null)
    setNameEdited(false)
  }

  return (
    <form
      className={cn("flex flex-col gap-3", className)}
      data-testid="add-reference-directory"
      onSubmit={(e) => void handleSubmit(e)}
    >
      <div className="flex items-end gap-2">
        <Field label="Folder" htmlFor="reference-dir-path" className="flex-1">
          <Input
            id="reference-dir-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onBlur={() => void handlePathBlur()}
            placeholder="/path/to/production-repo"
            spellCheck={false}
            disabled={disabled}
            className={controlClass}
            data-testid="reference-dir-path"
          />
        </Field>
        {/*
          Hidden, not disabled, where the platform has no native picker — the
          same call the wizard's local-folder step makes, for the same reason:
          a permanently dead button is worse than no button, and the field
          beside it already takes a typed path.
        */}
        {onBrowse ? (
          <Button
            type="button"
            variant="outline"
            size={compact ? "sm" : "default"}
            onClick={() => void handleBrowse()}
            disabled={disabled}
            data-testid="reference-dir-browse"
          >
            Browse
          </Button>
        ) : null}
      </div>

      <Field
        label="Name the agent uses"
        htmlFor="reference-dir-name"
        hint="Lowercase letters, numbers and hyphens."
        error={nameError}
      >
        <Input
          id="reference-dir-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setNameEdited(e.target.value.trim().length > 0)
          }}
          placeholder="billing-web"
          spellCheck={false}
          disabled={disabled}
          className={controlClass}
          data-testid="reference-dir-name"
        />
      </Field>

      <Field
        label="What is it for?"
        htmlFor="reference-dir-description"
        hint="Tells the agent when this folder is worth reading."
      >
        <Input
          id="reference-dir-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Production billing UI, match these table patterns"
          disabled={disabled}
          className={controlClass}
          data-testid="reference-dir-description"
        />
      </Field>

      {/*
        Stated once the folder resolves, because it changes what the agent can
        do with it. A plain line rather than a Callout on purpose: a plain
        folder is a perfectly good reference directory, so this is information,
        not a warning, and a tinted banner would both overstate it and spend a
        section (docs/design.md, "2 sections good, 3 max").
      */}
      {isGit === false ? (
        <p className="text-sm text-muted-foreground" data-testid="reference-dir-not-git">
          Not a git repository. The agent can read and search this folder, but
          cannot look at its history.
        </p>
      ) : null}

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        {footerStart}
        <Button
          type="submit"
          size={compact ? "sm" : "default"}
          disabled={!canSubmit}
          data-testid="reference-dir-add"
        >
          {checking ? "Checking" : "Add"}
        </Button>
      </div>
    </form>
  )
}

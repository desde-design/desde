"use client"

/**
 * Project settings, as a full page with tabs.
 *
 * The edit counterpart to `NewProjectPage` (Mo, 2026-08-17: "there is a
 * project create page now, so do the same for edit, reusing as much as
 * possible"). It shares that page's shell exactly — the narrow column, the
 * full-bleed sticky action bar, the hash-routed view — and swaps the stepper
 * for tabs, because a stepper says "there is an order and an end" and settings
 * have neither.
 *
 * ## What "All" is for
 *
 * The default tab lists every section stacked, each in its own container.
 * Picking any other tab filters to that one section. So the tabs are a FILTER
 * over one page, not four pages: someone who came to change one thing goes
 * straight to it, and someone who came to see how a project is configured
 * reads the whole thing without clicking four times.
 *
 * ## The save model, and why the footer says so
 *
 * The NAME stages behind "Save changes". Design systems and reference folders
 * write immediately, because that is what the panels reused here already do
 * and what the launcher API offers (an append and a remove, not a replace).
 *
 * That split is stated in the page rather than hidden, because the alternative
 * is a footer that implies a transaction it does not have: Cancel would appear
 * to undo a removed design system and would not. Making it real means turning
 * both panels into fully controlled draft editors — a genuine refactor of two
 * components plus the New Project page that shares them — and it can be done
 * later without moving this page.
 *
 * ## Source is read-only
 *
 * Deliberate. Re-pointing a project at a different folder is closer to
 * creating a new project than editing this one: the manifest cache, the
 * declared design systems, the reference roots and any viewer link are all
 * keyed to the current repo, and silently carrying them across would be wrong
 * in a way the user could not see. Shown, with the path, so the page is a
 * complete picture.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { FolderOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { BusyOverlay, Callout, Field, FieldGroup, SettingsSection } from "@/components/blocks"
import { DesignSystemList } from "@/components/editor/design-systems/design-system-list"
import { AddDesignSystemDialog } from "@/components/editor/design-systems/add-design-system-dialog"
import { AddReferenceDirectory } from "@/components/editor/reference-dirs/add-reference-directory"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useProjectSettings } from "./use-project-settings"
import { pendingIdentity } from "./new-project-page"
import type { DesignSystemDeclaration } from "@/editor/core/design-system-declarations"
import type { ReferenceDirectoryInspection } from "@/components/editor/reference-dirs/add-reference-directory"

/**
 * The tabs, in reading order.
 *
 * `all` is first and is the default, so the page opens as a document rather
 * than as a decision about which quarter of it to look at.
 */
const TABS = [
  { id: "all", label: "All" },
  { id: "general", label: "General" },
  { id: "design-systems", label: "Design systems" },
  { id: "reference-dirs", label: "Reference folders" },
] as const

export type SettingsTab = (typeof TABS)[number]["id"]

export interface ProjectSettingsPageProps {
  /** Absolute path of the project being edited. */
  path: string
  onClose: () => void
  /**
   * Inspect a candidate reference folder, and pick one with the native
   * dialog. The SAME two props `NewProjectPage` takes, deliberately: both
   * pages hand them to the same form, so a divergence here would be two
   * behaviours for one control.
   */
  onInspectReadRoot: (
    path: string,
    taken: string[],
    projectPath?: string,
  ) => Promise<ReferenceDirectoryInspection | null>
  onPickReadRoot?: (
    taken?: string[],
    projectPath?: string,
  ) => Promise<ReferenceDirectoryInspection | null>
}

export function ProjectSettingsPage({
  path,
  onClose,
  onInspectReadRoot,
  onPickReadRoot,
}: ProjectSettingsPageProps) {
  const settings = useProjectSettings(path)
  const [tab, setTab] = useState<SettingsTab>("all")
  const [nameDraft, setNameDraft] = useState("")
  const [addDesignSystemOpen, setAddDesignSystemOpen] = useState(false)
  const [editingDeclaration, setEditingDeclaration] =
    useState<DesignSystemDeclaration | null>(null)
  const [addReferenceOpen, setAddReferenceOpen] = useState(false)

  const loadedName = settings.data?.name ?? ""
  /**
   * Seed the draft from what loaded, and re-seed after a rename lands.
   *
   * Keyed on the loaded name rather than on a mount flag: a successful rename
   * refreshes, and without re-seeding the field would keep showing the draft
   * while the page around it had already moved on.
   */
  useEffect(() => {
    setNameDraft(loadedName)
  }, [loadedName])

  const nameDirty = nameDraft.trim() !== loadedName && nameDraft.trim() !== ""

  const handleSave = useCallback(async () => {
    if (!nameDirty) return
    await settings.rename(nameDraft.trim())
  }, [nameDirty, nameDraft, settings])

  const designSystemEntries = useMemo(
    () =>
      (settings.data?.designSystems ?? []).map((entry) => ({
        id: entry.identity,
        label: entry.identity,
        // Nothing here was seeded by a scan — every row in the config was put
        // there deliberately, in the create flow or on this page. `detected`
        // is the create flow's concept and would be a lie after the fact.
        detected: false,
        declaration: entry.declaration,
      })),
    [settings.data],
  )

  const takenReferenceNames = useMemo(
    () => (settings.data?.readRoots ?? []).map((r) => r.name),
    [settings.data],
  )

  const show = (section: SettingsTab) => tab === "all" || tab === section

  return (
    <div className="relative flex flex-1 flex-col" data-testid="project-settings-page">
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-5 px-6 py-8">
        <div className="flex flex-col gap-4">
          {/*
            Same three-level hierarchy the create page uses: the flow name
            never changes, the navigation sits under it, and anything
            conditional on the navigation sits under that.
          */}
          <h1 className="text-xl font-medium">Project settings</h1>
          <Tabs value={tab} onValueChange={(next) => setTab(next as SettingsTab)}>
            <TabsList>
              {TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id} data-testid={`settings-tab-${t.id}`}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        {settings.error ? (
          <Callout tone="destructive" role="alert" data-testid="project-settings-error">
            {settings.error}
          </Callout>
        ) : null}

        {settings.data && settings.data.warnings.length > 0 ? (
          <Callout tone="warning" data-testid="project-settings-warnings">
            {settings.data.warnings.join(" ")}
          </Callout>
        ) : null}

        {settings.loading ? (
          <p className="text-base text-muted-foreground">Reading this project&apos;s settings</p>
        ) : (
          <div className="flex flex-col gap-4">
            {show("general") ? (
              <SettingsSection
                title="General"
                description="What this project is called, and where it lives."
                data-testid="settings-section-general"
              >
                <FieldGroup>
                <Field label="Project name" htmlFor="settings-project-name">
                  <Input
                    id="settings-project-name"
                    value={nameDraft}
                    disabled={settings.busy}
                    onChange={(e) => setNameDraft(e.target.value)}
                    data-testid="settings-project-name"
                  />
                </Field>
                {/*
                  Read-only, and it says why rather than showing a disabled
                  control the reader would poke at. A disabled input reads as
                  "not yet"; a plain path reads as "this is a fact about the
                  project".
                */}
                <Field
                  label="Folder"
                  hint="Moving a project to a different folder means adding it again. Its design systems, reference folders and cached component data are all tied to this one."
                >
                  <p className="flex items-center gap-1.5 rounded-md border bg-muted px-2 py-1.5">
                    <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate font-mono text-code text-foreground">
                      {settings.data?.path ?? path}
                    </span>
                  </p>
                </Field>
                </FieldGroup>
              </SettingsSection>
            ) : null}

            {show("design-systems") ? (
              <SettingsSection
                title="Design systems"
                description="The component libraries the agent builds with, so it reaches for yours instead of inventing its own."
                savesImmediately
                data-testid="settings-section-design-systems"
              >
                <DesignSystemList
                  entries={designSystemEntries}
                  busy={settings.busy}
                  onAdd={() => {
                    setEditingDeclaration(null)
                    setAddDesignSystemOpen(true)
                  }}
                  onEdit={(entry) => {
                    setEditingDeclaration(entry.declaration)
                    setAddDesignSystemOpen(true)
                  }}
                  onRemove={(id) => void settings.removeDesignSystem(id)}
                />
              </SettingsSection>
            ) : null}

            {show("reference-dirs") ? (
              <SettingsSection
                title="Reference folders"
                description="Folders the agent may read but never writes to, like a production repo this prototype should match."
                savesImmediately
                data-testid="settings-section-reference-dirs"
              >
                {settings.data && settings.data.readRoots.length > 0 ? (
                  <ul className="flex flex-col divide-y rounded-md border">
                    {settings.data.readRoots.map((root) => (
                      <li
                        key={root.name}
                        className="flex items-start gap-2 px-3 py-2"
                        data-testid={`settings-reference-row-${root.name}`}
                      >
                        <div className="min-w-0 flex-1">
                          <span className="truncate text-base">{root.name}</span>
                          <p className="truncate font-mono text-code text-muted-foreground">
                            {root.path}
                          </p>
                          {root.description ? (
                            <p className="mt-0.5 text-sm text-muted-foreground">
                              {root.description}
                            </p>
                          ) : null}
                        </div>
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={settings.busy}
                          onClick={() => void settings.removeReadRoot(root.name)}
                          data-testid={`settings-reference-remove-${root.name}`}
                        >
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-base text-muted-foreground">
                    None yet. Point the agent at a production repo, or any other folder
                    this prototype should match.
                  </p>
                )}
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={settings.busy}
                    onClick={() => setAddReferenceOpen(true)}
                    data-testid="settings-reference-add-open"
                  >
                    Add reference folder
                  </Button>
                </div>
              </SettingsSection>
            ) : null}
          </div>
        )}
      </main>

      {/*
        The action bar mirrors the create page's exactly, column classes
        included. They are duplicated on purpose and coupled to <main>'s above:
        change one and change the other, or the buttons stop lining up.
      */}
      <footer className="sticky bottom-0 z-40 shrink-0 border-t bg-background">
        <div className="mx-auto flex w-full max-w-2xl items-center justify-end gap-2 px-6 py-3">
          <Button variant="ghost" onClick={onClose} disabled={settings.busy}>
            {/*
              "Cancel" when there is something staged to cancel, "Done"
              otherwise. Calling it Cancel on a page where nothing is pending
              would promise to undo the design system you just removed.
            */}
            {nameDirty ? "Cancel" : "Done"}
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={settings.busy || !nameDirty}
            data-testid="settings-save"
          >
            Save changes
          </Button>
        </div>
      </footer>

      {settings.busy ? <BusyOverlay label="Saving" className="z-50 rounded-none" /> : null}

      <AddDesignSystemDialog
        open={addDesignSystemOpen}
        onOpenChange={setAddDesignSystemOpen}
        initial={editingDeclaration}
        busy={settings.busy}
        onSubmit={(declaration) => {
          // Editing is remove-then-add, because identity is derived from the
          // source: a changed spec mints a new id, so the old row would
          // otherwise survive beside its own replacement.
          const previous = editingDeclaration
          void (async () => {
            if (previous) await settings.removeDesignSystem(pendingIdentity(previous.source))
            await settings.addDesignSystem(declaration)
          })()
          return true
        }}
      />

      <Dialog open={addReferenceOpen} onOpenChange={setAddReferenceOpen}>
        <DialogContent size="lg" data-testid="settings-add-reference-dialog">
          <DialogHeader>
            <DialogTitle>Add a reference folder</DialogTitle>
            <DialogDescription>
              A folder the agent may read but never writes to, like a production
              repo this prototype should match.
            </DialogDescription>
          </DialogHeader>
          {/* The form owns its own submit; Cancel rides its action row via
              `footerStart` so the footer still has a visible way out (Mo,
              2026-08-29) without a second "Add" row — the confusion
              docs/design.md warns about for nested flows. */}
          <AddReferenceDirectory
            density="launcher"
            busy={settings.busy}
            takenNames={takenReferenceNames}
            footerStart={
              <Button type="button" variant="outline" onClick={() => setAddReferenceOpen(false)}>
                Cancel
              </Button>
            }
            onInspect={(candidate) =>
              onInspectReadRoot(candidate, takenReferenceNames, settings.data?.path ?? path)
            }
            onBrowse={
              onPickReadRoot
                ? () => onPickReadRoot(takenReferenceNames, settings.data?.path ?? path)
                : undefined
            }
            onAdd={async (entry) => {
              const ok = await settings.addReadRoot(entry)
              // Only close on success: a refused add has to leave the form up
              // with what was typed.
              if (ok) setAddReferenceOpen(false)
              return ok
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}

"use client"

/**
 * Editor Canvas top-bar view body. Phase 3 fan-out closes the
 * `<CanvasViewStub>` placeholder with a real canvas surface:
 *
 *  - On first mount, lists existing canvases via `useLocalCanvases`.
 *  - Renders a sidebar of canvas picker entries on the left, the
 *    canvas surface on the right.
 *  - When the user selects a canvas, the hook loads frames + edges +
 *    annotations into the slice and `<CanvasView>` renders them.
 *  - Bottom-left affordance: "Create blank" + (per saved flow)
 *    "Migrate flow → canvas".
 *
 * The Read/Edit mode toggle in the top bar gates the canvas's
 * `editable` prop. Read mode disables drag / resize / connect /
 * delete; selection still works.
 */

import { useCallback, useEffect, useState } from "react"
import { useAppStore } from "@/stores"
import { CanvasView } from "@/components/canvas/canvas-view"
import { useLocalCanvases } from "@/hooks/useLocalCanvases"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Plus,
  Trash2,
  Pencil,
  Compass,
  Check,
  X,
  Sparkles,
  Loader2,
} from "lucide-react"
import { formatRelativeTimeShort } from "@/lib/relative-time"
import { EmptyState, ListRow } from "@/components/blocks"
import { cn } from "@/lib/utils"
import { TONE_SURFACE } from "@/lib/tone-surface"

export interface EditorCanvasSurfaceProps {
  /**
   * Read or Edit per the top-bar mode toggle. Defaults to Edit when
   * not specified.
   */
  editable?: boolean
  /**
   * Generate a screenshot flow onto a canvas from an NL prompt (the agent
   * decides which screens; the shell replays + drops frames). Owned by the
   * surface (it holds the chat + replay + canvas plumbing).
   */
  onGenerateFlow?: (prompt: string, canvasId: string) => Promise<void>
  /** True while a flow is being generated (gates the prompt bar). */
  generatingFlow?: boolean
}

export function EditorCanvasSurface({
  editable = true,
  onGenerateFlow,
  generatingFlow = false,
}: EditorCanvasSurfaceProps) {
  const canvases = useAppStore((s) => s.canvases)
  const activeCanvasId = useAppStore((s) => s.activeCanvasId)
  const canvasLoading = useAppStore((s) => s.canvasLoading)
  const setActiveCanvasId = useAppStore((s) => s.setActiveCanvasId)
  const clearActiveCanvas = useAppStore((s) => s.clearActiveCanvas)

  const local = useLocalCanvases()

  // First load: auto-open the most recent canvas (highest updatedAt).
  // Avoids a "nothing selected" empty state for users with existing
  // canvases. New users see the picker + Create entry naturally.
  useEffect(() => {
    if (local.loading) return
    if (activeCanvasId) return
    if (canvases.length === 0) return
    const sorted = [...canvases].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    )
    const target = sorted[0]
    if (target) {
      setActiveCanvasId(target.id)
      void local.loadCanvas(target.id)
    }
    // intentionally one-shot on the first non-loading render; the user
    // can switch canvases manually after that
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local.loading])

  const handleSelectCanvas = useCallback(
    (canvasId: string) => {
      if (activeCanvasId === canvasId) return
      setActiveCanvasId(canvasId)
      void local.loadCanvas(canvasId)
    },
    [activeCanvasId, setActiveCanvasId, local],
  )

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const handleCreate = useCallback(async () => {
    const name = newName.trim() || "Untitled Canvas"
    const created = await local.createCanvas(name)
    if (created) {
      setActiveCanvasId(created.id)
      void local.loadCanvas(created.id)
    }
    setCreating(false)
    setNewName("")
  }, [newName, local, setActiveCanvasId])

  const handleDelete = useCallback(
    async (canvasId: string) => {
      if (activeCanvasId === canvasId) clearActiveCanvas()
      await local.deleteCanvas(canvasId)
    },
    [activeCanvasId, clearActiveCanvas, local],
  )

  return (
    <div className="flex h-full w-full" data-testid="editor-canvas-surface">
      {/* Canvas picker sidebar */}
      <aside
        className="flex h-full w-56 flex-none flex-col border-r bg-muted/20"
        data-testid="canvas-picker-sidebar"
      >
        <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
          <h2 className="text-sm font-semibold">Canvases</h2>
          {!creating ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setCreating(true)}
              title="New canvas"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
        {creating ? (
          <div className="shrink-0 space-y-1 border-b p-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Canvas name"
              className="h-7 text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreate()
                else if (e.key === "Escape") {
                  setCreating(false)
                  setNewName("")
                }
              }}
            />
            <div className="flex gap-1">
              <Button
                size="sm"
                className="h-7 flex-1 gap-1 text-sm"
                onClick={() => void handleCreate()}
              >
                <Check className="h-3 w-3" /> Create
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-sm"
                onClick={() => {
                  setCreating(false)
                  setNewName("")
                }}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>
        ) : null}
        {local.error ? (
          <div
            // A full-bleed strip, not a rounded Alert, so it composes the
            // shared tone recipe rather than being one. `border-b` picks the
            // side; TONE_SURFACE supplies the colour.
            className={cn(
              "shrink-0 border-b px-3 py-2 text-2xs",
              TONE_SURFACE.destructive,
            )}
            role="alert"
          >
            {local.error}{" "}
            <Button
              type="button"
              variant="link"
              className="h-auto p-0 text-2xs underline hover:no-underline"
              onClick={() => void local.refresh()}
            >
              Retry
            </Button>
          </div>
        ) : null}
        <ScrollArea className="flex-1">
          {canvases.length === 0 && !local.loading ? (
            <EmptyState
              icon={<Compass />}
              description="No canvases"
              data-testid="canvas-picker-empty"
            />
          ) : (
            canvases.map((canvas) => (
              <CanvasPickerRow
                key={canvas.id}
                name={canvas.name}
                updatedAt={canvas.updatedAt}
                isActive={canvas.id === activeCanvasId}
                onSelect={() => handleSelectCanvas(canvas.id)}
                onRename={(name) => local.renameCanvas(canvas.id, name)}
                onDelete={() => handleDelete(canvas.id)}
                editable={editable}
              />
            ))
          )}
        </ScrollArea>
      </aside>

      {/* Canvas surface */}
      <div className="relative h-full min-w-0 flex-1">
        {activeCanvasId ? (
          canvasLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading canvas…
            </div>
          ) : (
            <div className="flex h-full flex-col">
              {editable && onGenerateFlow ? (
                <GenerateFlowBar
                  disabled={generatingFlow}
                  onGenerate={(prompt) => onGenerateFlow(prompt, activeCanvasId)}
                />
              ) : null}
              <div className="min-h-0 flex-1">
                <CanvasView
                  canvasId={activeCanvasId}
                  store={local.store}
                  editable={editable}
                />
              </div>
            </div>
          )
        ) : (
          <div
            className="flex h-full flex-col items-center justify-center gap-3 bg-muted/10 p-6 text-center"
            data-testid="canvas-no-selection"
          >
            <Compass className="h-10 w-10 text-muted-foreground/40" />
            <div className="space-y-1">
              <h2 className="text-base font-semibold">No canvas selected</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Pick a canvas on the left or create a new one, then add
                screens with the Screenshot&nbsp;→&nbsp;canvas button in
                the Editor view.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

interface CanvasPickerRowProps {
  name: string
  updatedAt: string
  isActive: boolean
  onSelect: () => void
  onRename: (name: string) => void | Promise<void>
  onDelete: () => void | Promise<void>
  editable: boolean
}

function CanvasPickerRow({
  name,
  updatedAt,
  isActive,
  onSelect,
  onRename,
  onDelete,
  editable,
}: CanvasPickerRowProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  return (
    <ListRow
      asChild
      selected={isActive}
      className="group gap-1 rounded-none border-b transition-colors"
    >
      <div>
        {editing ? (
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft.trim()) void onRename(draft.trim())
              setEditing(false)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (draft.trim()) void onRename(draft.trim())
                setEditing(false)
              } else if (e.key === "Escape") {
                setDraft(name)
                setEditing(false)
              }
            }}
            className="h-6 text-sm"
            autoFocus
          />
        ) : (
          <>
            {/* eslint-disable-next-line react/forbid-elements -- full-height flex-column card click target; Button inline-flex would break the multi-line name/date column layout */}
            <button
              className="flex min-w-0 flex-1 flex-col items-start text-left"
              onClick={onSelect}
            >
              <span className="w-full truncate text-sm font-normal">{name}</span>
              <span className="text-2xs text-muted-foreground">
                {formatRelativeTimeShort(updatedAt)}
              </span>
            </button>
            {editable ? (
              <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5"
                  onClick={() => {
                    setDraft(name)
                    setEditing(true)
                  }}
                  title="Rename"
                >
                  <Pencil className="h-2.5 w-2.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5 w-5 text-destructive/70 hover:text-destructive"
                  onClick={() => void onDelete()}
                  title="Delete"
                >
                  <Trash2 className="h-2.5 w-2.5" />
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </ListRow>
  )
}

interface GenerateFlowBarProps {
  disabled: boolean
  onGenerate: (prompt: string) => void | Promise<void>
}

/** Prompt bar above the canvas: describe a flow → the agent generates the
 * screens and they land here as connected frames. */
function GenerateFlowBar({ disabled, onGenerate }: GenerateFlowBarProps) {
  const [prompt, setPrompt] = useState("")

  const submit = () => {
    const p = prompt.trim()
    if (!p || disabled) return
    void onGenerate(p)
    setPrompt("")
  }

  return (
    <div className="flex shrink-0 items-center gap-2 border-b bg-background px-3 py-2">
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <Input
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder="Generate a flow on this canvas, e.g. “walk creating a model and screenshot each step”"
        disabled={disabled}
        className="h-8 flex-1 text-sm"
      />
      <Button size="sm" onClick={submit} disabled={disabled || prompt.trim().length === 0} className="shrink-0 gap-1">
        {disabled ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        {disabled ? "Generating…" : "Generate"}
      </Button>
    </div>
  )
}

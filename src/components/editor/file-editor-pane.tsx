"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import CodeMirror, {
  EditorView,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror"
import { vue } from "@codemirror/lang-vue"
import { javascript } from "@codemirror/lang-javascript"
import { oneDark } from "@codemirror/theme-one-dark"
import { ArrowLeft, Save as SaveIcon, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { editorFetch } from "@/lib/editor-fetch"
import { buildFileEditorSaveRequest } from "@/components/editor/build-file-editor-save-request"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/blocks"

/**
 * Replaces the prototype iframe with a focused single-file code editor.
 *
 * Reads via `GET /api/editor/file`, writes via the existing
 * `POST /api/editor/edit { kind: "overwrite" }` path. The save lands on the
 * working tree as an ordinary uncommitted change, routed through the same
 * write broker (backup journal under `.desde/backups/`) every other
 * edit lane uses — no auto-commit; the user commits via the top-bar
 * Commit. The overwrite kind's `baseHash` precondition catches concurrent
 * writes from another chat session or the user's IDE between open and
 * save — we surface that as a banner with "Reload from disk" / "Save
 * anyway".
 *
 * Scope (v1): one file at a time, no file tree, no diff view, no
 * autocomplete (deliberate — we don't want LSP-style model interference
 * inside a tool whose value prop is "edit by hand for the small
 * cases"). Entry point is the right-click context menu over the
 * prototype; the editor closes back to the iframe via Esc / the
 * Back-to-prototype button.
 */

interface FileEditorPaneProps {
  /** Path relative to the worktree root. */
  filePath: string
  /** 1-based line to scroll to and place the cursor on. */
  initialLine?: number
  /** 1-based column. */
  initialColumn?: number
  /** Returns to the prototype view (handled by editor-surface). */
  onExit: () => void
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; reason: string }
  | { kind: "ready"; baseHash: string; relativePath: string }

function languageExtension(filePath: string) {
  const lower = filePath.toLowerCase()
  if (lower.endsWith(".vue")) return vue()
  if (lower.endsWith(".tsx")) return javascript({ typescript: true, jsx: true })
  if (lower.endsWith(".ts")) return javascript({ typescript: true })
  if (lower.endsWith(".jsx")) return javascript({ jsx: true })
  if (lower.endsWith(".js")) return javascript()
  // Unreachable in practice: the file-read endpoint restricts to .vue/.ts.
  return vue()
}

async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export function FileEditorPane({
  filePath,
  initialLine,
  initialColumn,
  onExit,
}: FileEditorPaneProps) {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" })
  const [content, setContent] = useState<string>("")
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<string | null>(null)
  const editorRef = useRef<ReactCodeMirrorRef | null>(null)
  // Stash `dirty` in a ref so the keydown handler doesn't need to re-bind
  // on every keystroke (the user is generating a lot of keystrokes; a
  // ref dodges the listener re-add churn).
  const dirtyRef = useRef(false)
  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  // Load the file on mount / filePath change.
  useEffect(() => {
    let cancelled = false
    setLoadState({ kind: "loading" })
    setConflict(null)
    setDirty(false)
    const url = `/api/editor/file?path=${encodeURIComponent(filePath)}`
    editorFetch(url)
      .then(async (r) => {
        const body = (await r.json().catch(() => null)) as
          | { ok: true; content: string; sha: string; relativePath: string }
          | { ok: false; reason: string }
          | null
        if (cancelled) return
        if (!r.ok || !body || !body.ok) {
          setLoadState({
            kind: "error",
            reason: body && !body.ok ? body.reason : `HTTP ${r.status}`,
          })
          return
        }
        setContent(body.content)
        setLoadState({
          kind: "ready",
          baseHash: body.sha,
          relativePath: body.relativePath,
        })
      })
      .catch((err) => {
        if (cancelled) return
        setLoadState({ kind: "error", reason: (err as Error).message })
      })
    return () => {
      cancelled = true
    }
  }, [filePath])

  // Jump to (line, column) once the editor is ready. Re-fires on
  // line/column change so a follow-up right-click on a different element
  // in the same file re-positions the cursor.
  useEffect(() => {
    if (loadState.kind !== "ready") return
    const view = editorRef.current?.view
    if (!view || !initialLine || initialLine < 1) return
    const lineCount = view.state.doc.lines
    if (initialLine > lineCount) return
    const line = view.state.doc.line(initialLine)
    const col = Math.max(0, (initialColumn ?? 1) - 1)
    const anchor = line.from + Math.min(col, line.length)
    view.dispatch({
      selection: { anchor, head: anchor },
      scrollIntoView: true,
    })
    view.focus()
  }, [loadState.kind, initialLine, initialColumn])

  const handleChange = useCallback((next: string) => {
    setContent(next)
    setDirty(true)
  }, [])

  const performSave = useCallback(
    async (opts: { force?: boolean } = {}) => {
      if (loadState.kind !== "ready") return
      setSaving(true)
      setConflict(null)
      try {
        const body = buildFileEditorSaveRequest({
          file: loadState.relativePath,
          newSource: content,
          ...(opts.force ? {} : { baseHash: loadState.baseHash }),
        })
        const res = await editorFetch("/api/editor/edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        type AutoCommit =
          | { ok: true; sha: string }
          | { ok: true; empty: true }
          | { ok: false; reason: string }
        const json = (await res.json().catch(() => null)) as
          | { ok: true; file: string; autoCommit?: AutoCommit }
          | {
              ok: false
              reason?: string
              conflicts?: Array<{ file: string; expected: string; actual: string }>
            }
          | null
        if (!res.ok || !json || !json.ok) {
          if (
            res.status === 409 &&
            json &&
            !json.ok &&
            json.conflicts &&
            json.conflicts.length > 0
          ) {
            setConflict(
              "File changed on disk since you opened it. Saving will overwrite the on-disk version.",
            )
            return
          }
          const reason = json && !json.ok ? json.reason ?? "" : `HTTP ${res.status}`
          toast.error("Save failed", { description: reason })
          return
        }
        const newSha = await sha256Hex(content)
        setLoadState({
          kind: "ready",
          baseHash: newSha,
          relativePath: loadState.relativePath,
        })
        setDirty(false)
        // The file landed on disk. Auto-commit is best-effort
        // (see auto-commit.ts header) — if it failed, the file
        // is saved but the granular-undo property degrades, so
        // surface a warning toast distinct from the success case.
        const autoCommit = json.autoCommit
        if (autoCommit && autoCommit.ok === false) {
          toast.warning("Saved (auto-commit failed)", {
            description: `${loadState.relativePath}: ${autoCommit.reason}`,
          })
        } else {
          toast.success("Saved", { description: loadState.relativePath })
        }
      } catch (err) {
        toast.error("Save failed", { description: (err as Error).message })
      } finally {
        setSaving(false)
      }
    },
    [loadState, content],
  )

  const reloadFromDisk = useCallback(async () => {
    setConflict(null)
    setDirty(false)
    setLoadState({ kind: "loading" })
    const url = `/api/editor/file?path=${encodeURIComponent(filePath)}`
    try {
      const r = await editorFetch(url)
      const body = (await r.json().catch(() => null)) as
        | { ok: true; content: string; sha: string; relativePath: string }
        | { ok: false; reason: string }
        | null
      if (!r.ok || !body || !body.ok) {
        setLoadState({
          kind: "error",
          reason: body && !body.ok ? body.reason : `HTTP ${r.status}`,
        })
        return
      }
      setContent(body.content)
      setLoadState({
        kind: "ready",
        baseHash: body.sha,
        relativePath: body.relativePath,
      })
    } catch (err) {
      setLoadState({ kind: "error", reason: (err as Error).message })
    }
  }, [filePath])

  const handleExitClick = useCallback(() => {
    if (dirtyRef.current && !window.confirm("Discard unsaved changes?")) return
    onExit()
  }, [onExit])

  // Cmd/Ctrl+S to save; Esc to exit. CodeMirror panels (search, etc.)
  // call `preventDefault` on Esc to close themselves but don't
  // reliably stop propagation, so check `defaultPrevented` AND the
  // target's containment to keep Esc inside CM6 from exiting the
  // whole pane.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmdSave =
        (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "s"
      if (cmdSave) {
        e.preventDefault()
        if (loadState.kind === "ready" && !saving && dirtyRef.current) {
          void performSave()
        }
        return
      }
      if (e.key === "Escape") {
        if (e.defaultPrevented) return
        const target = e.target as HTMLElement | null
        if (target && typeof target.closest === "function" && target.closest(".cm-editor")) {
          // Esc inside the editor — let CodeMirror handle panel close,
          // selection clear, etc. The user can click "Back to
          // prototype" or Esc with focus outside the editor to exit.
          return
        }
        e.preventDefault()
        handleExitClick()
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [loadState.kind, saving, performSave, handleExitClick])

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-muted/40 px-3 text-sm">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2"
          onClick={handleExitClick}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to prototype
        </Button>
        <div className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
          {loadState.kind === "ready" ? loadState.relativePath : filePath}
          {dirty ? <span className="ml-1 text-foreground">•</span> : null}
        </div>
        <Button
          size="sm"
          className="h-7 gap-1.5 px-2"
          disabled={loadState.kind !== "ready" || saving || !dirty}
          onClick={() => void performSave()}
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <SaveIcon className="h-3.5 w-3.5" />
          )}
          Save
        </Button>
      </div>
      {conflict ? (
        <Callout
          tone="warning"
          className="flex shrink-0 items-center gap-3 rounded-none border-x-0 border-t-0 px-3 py-1.5 text-sm"
        >
          <span className="flex-1 text-foreground">{conflict}</span>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2"
            onClick={() => void reloadFromDisk()}
          >
            Reload from disk
          </Button>
          <Button
            variant="default"
            size="sm"
            className="h-6 px-2"
            onClick={() => void performSave({ force: true })}
          >
            Save anyway
          </Button>
        </Callout>
      ) : null}
      <div className="relative flex-1 overflow-hidden">
        {loadState.kind === "loading" ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : loadState.kind === "error" ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm text-destructive">
            <div>Failed to load {filePath}</div>
            <div className="text-muted-foreground">{loadState.reason}</div>
          </div>
        ) : (
          <CodeMirror
            ref={editorRef}
            value={content}
            height="100%"
            theme={oneDark}
            extensions={[
              languageExtension(loadState.relativePath),
              EditorView.lineWrapping,
            ]}
            onChange={handleChange}
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              dropCursor: true,
              allowMultipleSelections: true,
              indentOnInput: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: false,
              rectangularSelection: true,
              crosshairCursor: false,
              highlightActiveLine: true,
              highlightSelectionMatches: true,
              searchKeymap: true,
            }}
            className="h-full"
          />
        )}
      </div>
    </div>
  )
}

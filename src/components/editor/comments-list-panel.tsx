"use client"

/**
 * The right rail's Comments panel. Renders a single chronological
 * list of Comments and Notes — both DOM-anchored, both behave
 * identically at the UI layer (per `tasks/cli-viewer-architecture.md`
 * line 168: "Comments and Notes are merged into one panel — no
 * separation value at the UI layer").
 *
 * The surface is named "Comments" (Mo, 2026-08-14) even though the
 * list also carries Notes. That was a deliberate call made looking at
 * the UI: Comments is the word users reach for, and splitting Notes
 * into a second tab was rejected.
 *
 * Notes then went DORMANT on the same day, which is what makes that name
 * exact rather than merely chosen. The panel drops every note affordance
 * when its four note handlers are absent, so with the dormancy in force the
 * list holds one kind of thing and the tab says what it holds. See
 * `EDITOR_NOTES`; the flag itself is read by the container, never here.
 *
 * Replaces the two separate `CommentPanel` and `NotePanel` mounts in
 * the editor surface. The web project route still uses the
 * dedicated panels via its browse-mode UI; this merged panel is
 * CLI-only at v1.
 *
 * Each row is keyed by `kind:id` to keep React stable when the two
 * types share interleaved keys. Type icon distinguishes Comment
 * (MessageSquare) from Note (StickyNote); colors stay neutral — only
 * the icon and the row-active highlight differ.
 *
 * The row test id stays `annotation-row-<kind>-<id>`. It names an item
 * of either kind, so it belongs to the shared Annotation vocabulary in
 * `src/types/annotation.ts`, not to this surface's name. A live
 * Playwright harness reads it too
 * (`tasks/scripts/comment-fix-affordance-smoke.mts`).
 *
 * Pure-presentational: store reads + write side effects come in via
 * the handler props. The container (EditorCommentsContainer)
 * owns the data hooks.
 */

import { useCallback, useMemo } from "react"
import { useAppStore } from "@/stores"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { MentionText } from "@/components/comments/mention-text"
import { EmptyState, ListRow } from "@/components/blocks"
import { CommentModeButton } from "@/components/editor/comment-mode-button"
import {
  CloudOff,
  MapPinOff,
  MessageSquare,
  MoreVertical,
  StickyNote,
} from "lucide-react"
import { formatRelativeTimeShort } from "@/lib/relative-time"
import { avatarInitial } from "@/lib/initials"
import type { Comment } from "@/types/bridge"
import type { Note } from "@/types/note"

/**
 * Where the viewer setup instructions live. The docs site in this repo
 * (`website/content/docs/viewer/`) covers standing one up, creating a project
 * on it, and minting the access token, in that order.
 */
// desde.design, not desde.dev — the site lives at desde.design (see
// website/README.md), and this constant had drifted to a domain nothing owns.
const VIEWER_SETUP_DOCS = "https://desde.design/docs/viewer/projects"

interface CommentsListPanelProps {
  onHighlightComment: (commentId: string) => void
  /**
   * Toggle comment placement mode. Same handler the toolbar's Comment
   * button fires, and the button itself is the same component, so the two
   * controls cannot disagree about what a click does.
   */
  onCommentModeChange: (next: boolean) => void
  /** Hide-all toggle: shell informs both bridges in parallel. */
  onPinsHiddenChange: (hidden: boolean) => void
  /** Show-resolved toggle: applies to both types. */
  onShowResolvedChange: (show: boolean) => void
  /**
   * The four NOTE handlers below travel as a group, and an absent group
   * means Notes do not exist on this surface. That is the same rule the
   * dormant edit lanes use for their menu items, and it keeps the
   * `EDITOR_NOTES` flag out of this leaf: only the container reads it.
   *
   * With them absent the panel drops the "Note" button, drops note rows
   * from the merged list, drops the minimize-all-notes item, and says
   * "comments" rather than "comments and notes" in its empty state.
   */
  onHighlightNote?: (noteId: string) => void
  onAddNote?: () => void
  onNotesHiddenChange?: (hidden: boolean) => void
  onShowResolvedNotesChange?: (show: boolean) => void
  /**
   * Comment storage mode — `"viewer"` (shared project, synced with a
   * linked viewer) or `"local"` (this machine only). Drives the header
   * badge. Omitted → no badge (e.g. contexts where sync doesn't apply).
   */
  syncMode?: "viewer" | "local"
  /** Viewer configured for this repo, but no token stored on this machine. */
  needsViewerToken?: boolean
  /** Comment ids whose anchor didn't resolve on the current build —
   *  flagged so a stale anchor isn't silently invisible. */
  offTargetCommentIds?: Set<string>
}

type RowKind = "comment" | "note"
interface Row {
  kind: RowKind
  id: string
  number: number
  body: string
  author: { displayName: string; photoURL: string }
  createdAt: string
  resolved: boolean
  replies: { id: string }[]
  page: string
}

export function CommentsListPanel({
  onHighlightComment,
  onHighlightNote,
  onCommentModeChange,
  onAddNote,
  onPinsHiddenChange,
  onNotesHiddenChange,
  onShowResolvedChange,
  onShowResolvedNotesChange,
  syncMode,
  needsViewerToken,
  offTargetCommentIds,
}: CommentsListPanelProps) {
  const comments = useAppStore((s) => s.comments)
  const notes = useAppStore((s) => s.notes)
  const activeCommentId = useAppStore((s) => s.activeCommentId)
  const activeNoteId = useAppStore((s) => s.activeNoteId)
  const pinsHidden = useAppStore((s) => s.pinsHidden)
  const notesHidden = useAppStore((s) => s.notesHidden)
  const showResolved = useAppStore((s) => s.showResolved)
  const showResolvedNotes = useAppStore((s) => s.showResolvedNotes)
  const setActiveComment = useAppStore((s) => s.setActiveComment)
  const setActiveNote = useAppStore((s) => s.setActiveNote)
  const setPinsHidden = useAppStore((s) => s.setPinsHidden)
  const setNotesHidden = useAppStore((s) => s.setNotesHidden)
  const setShowResolved = useAppStore((s) => s.setShowResolved)
  const setShowResolvedNotes = useAppStore((s) => s.setShowResolvedNotes)
  const setPopupAnchorRect = useAppStore((s) => s.setPopupAnchorRect)
  const setNotePopupAnchorRect = useAppStore((s) => s.setNotePopupAnchorRect)
  const minimizedNoteIds = useAppStore((s) => s.minimizedNoteIds)
  const minimizeAllNotes = useAppStore((s) => s.minimizeAllNotes)
  const expandAllNotes = useAppStore((s) => s.expandAllNotes)
  const toggleNoteMinimized = useAppStore((s) => s.toggleNoteMinimized)

  // Does this surface carry Notes at all? An absent `onAddNote` is the
  // signal — see the props doc above.
  const notesEnabled = onAddNote !== undefined

  // Unified hide/show-resolved state: both types are gated together,
  // mirroring the merged-panel design (one panel, one set of filters).
  // We collapse "any one type hidden" to the checkbox-on state so the
  // user can never get into a "two checkboxes disagree" state through
  // this panel.
  //
  // With Notes dormant the note half of each pair drops out of the
  // reduction entirely. Leaving it in would break the Hide toggle: nothing
  // sets `notesHidden`, so `pinsHidden && notesHidden` could never become
  // true and the switch would refuse to latch.
  const hideAll = notesEnabled ? pinsHidden && notesHidden : pinsHidden
  const showResolvedAny = notesEnabled
    ? showResolved || showResolvedNotes
    : showResolved

  const allNotesMinimized =
    notes.length > 0 && notes.every((n) => minimizedNoteIds.has(n.id))

  const rows = useMemo<Row[]>(() => {
    const fromComments: Row[] = (
      showResolvedAny ? comments : comments.filter((c) => !c.resolved)
    ).map((c: Comment) => ({
      kind: "comment",
      id: c.id,
      number: c.number,
      body: c.body,
      author: { displayName: c.author.displayName, photoURL: c.author.photoURL },
      createdAt: c.createdAt,
      resolved: c.resolved,
      replies: c.replies,
      page: c.position.page,
    }))
    const fromNotes: Row[] = (
      !notesEnabled
        ? []
        : showResolvedAny
          ? notes
          : notes.filter((n) => !n.resolved)
    ).map((n: Note) => ({
      kind: "note",
      id: n.id,
      number: n.number,
      body: n.body,
      author: { displayName: n.author.displayName, photoURL: n.author.photoURL },
      createdAt: n.createdAt,
      resolved: n.resolved,
      replies: n.replies,
      page: n.position.page,
    }))
    return [...fromComments, ...fromNotes].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )
  }, [comments, notes, showResolvedAny, notesEnabled])

  const handleToggleHide = useCallback(() => {
    const next = !hideAll
    setPinsHidden(next)
    setNotesHidden(next)
    onPinsHiddenChange(next)
    onNotesHiddenChange?.(next)
  }, [
    hideAll,
    setPinsHidden,
    setNotesHidden,
    onPinsHiddenChange,
    onNotesHiddenChange,
  ])

  const handleToggleShowResolved = useCallback(() => {
    const next = !showResolvedAny
    setShowResolved(next)
    setShowResolvedNotes(next)
    onShowResolvedChange(next)
    onShowResolvedNotesChange?.(next)
  }, [
    showResolvedAny,
    setShowResolved,
    setShowResolvedNotes,
    onShowResolvedChange,
    onShowResolvedNotesChange,
  ])

  const handleToggleMinimizeAllNotes = useCallback(() => {
    if (allNotesMinimized) {
      expandAllNotes()
    } else {
      minimizeAllNotes()
    }
  }, [allNotesMinimized, minimizeAllNotes, expandAllNotes])

  const handleRowClick = useCallback(
    (row: Row) => {
      if (row.kind === "comment") {
        // Clear stale anchor rect so popup doesn't use old position;
        // the bridge will send the correct pin rect via
        // COMMENT_PIN_CLICKED.
        setPopupAnchorRect(null)
        setActiveComment(row.id)
        onHighlightComment(row.id)
        return
      }
      // Note: un-minimize so the card becomes visible in the iframe.
      if (minimizedNoteIds.has(row.id)) {
        toggleNoteMinimized(row.id)
      }
      setNotePopupAnchorRect(null)
      setActiveNote(row.id)
      onHighlightNote?.(row.id)
    },
    [
      setPopupAnchorRect,
      setActiveComment,
      onHighlightComment,
      minimizedNoteIds,
      toggleNoteMinimized,
      setNotePopupAnchorRect,
      setActiveNote,
      onHighlightNote,
    ],
  )

  const synced = syncMode === "viewer"

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex flex-none items-center justify-between border-b px-3 py-2"
        data-testid="comments-list-panel-header"
      >
        <div className="flex items-center gap-1.5">
          {/* The same component the toolbar renders, reading the same
              state. It used to be a look-alike here: a different icon, a
              different variant, and enter-only, so a mode started from the
              toolbar could not be ended from this panel. */}
          <CommentModeButton
            onCommentModeChange={onCommentModeChange}
            testId="comments-panel-comment"
          />
          {onAddNote ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={onAddNote}
              title="Add note"
            >
              <StickyNote className="h-3.5 w-3.5" />
              Note
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {/*
            No sync badge. It read "Local" or "Synced" with the explanation
            buried in a `title` tooltip, so the common state — no viewer
            attached — showed a word that means nothing on its own and hid the
            one sentence that would have explained it.

            The state still matters, and it is about to be said properly: the
            empty state gets a message about attaching a viewer and project
            (see the gating task). A badge is the wrong place for a setup
            instruction.
          */}
          <div
            className="flex items-center gap-1.5"
            title={hideAll ? "Show comments" : "Hide comments"}
          >
            <Switch
              size="sm"
              id="comments-hide-toggle"
              checked={hideAll}
              onCheckedChange={handleToggleHide}
            />
            <Label htmlFor="comments-hide-toggle" className="cursor-pointer text-muted-foreground font-normal">
              Hide
            </Label>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuCheckboxItem
                checked={showResolvedAny}
                onCheckedChange={handleToggleShowResolved}
              >
                Show resolved
              </DropdownMenuCheckboxItem>
              {notesEnabled && notes.length > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleToggleMinimizeAllNotes}>
                    {allNotesMinimized ? "Expand all notes" : "Minimize all notes"}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ScrollArea className="flex-1">
        {/*
          `p-2` only while empty. `EmptyState` carries a dashed border now, and
          this wrapper has no padding of its own, so an unpadded empty state
          would draw its box flush against the panel's edges. The populated
          list wants to stay flush (rows are full-bleed), which is why this is
          conditional rather than padding on the wrapper.
        */}
        <div className={rows.length === 0 ? "p-2" : undefined}>
          {rows.length === 0 && !synced ? (
            /*
              Comments with nowhere to go.
              
              Without a viewer and a project, a comment is written to this
              machine and read by nobody — which is the opposite of what a
              comment is for. Saying "No comments yet. Add a comment to get
              started" there invites work that quietly goes nowhere.
              
              This replaces the "Local" / "Synced" badge that used to carry the
              same fact in one word, with the explanation hidden in a `title`
              tooltip. A setup instruction is not a badge.
            */
            <EmptyState
              data-testid="comments-needs-viewer"
              icon={<CloudOff />}
              title={
                needsViewerToken
                  ? "This machine has no access token"
                  : "Connect a viewer to share comments"
              }
              description={
                needsViewerToken
                  ? "A viewer is set up for this repo, but comments cannot reach it without a token. Add one from the project menu."
                  : "Comments are only useful when the people reviewing can see them. That needs a viewer server and a project on it; until then anything written here stays on this machine."
              }
            >
              <a
                className="text-base text-primary underline underline-offset-4"
                href={VIEWER_SETUP_DOCS}
                target="_blank"
                rel="noreferrer"
                data-testid="comments-viewer-docs-link"
              >
                How to set up a viewer and project
              </a>
            </EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState
              data-testid="comments-list-empty"
              icon={<MessageSquare />}
              title="No comments"
              description={
                notesEnabled
                  ? "Add a comment or note to get started"
                  : "Add a comment to get started"
              }
            />
          ) : (
            rows.map((row) => {
              const isActive =
                (row.kind === "comment" && activeCommentId === row.id) ||
                (row.kind === "note" && activeNoteId === row.id)
              const TypeIcon =
                row.kind === "note" ? StickyNote : MessageSquare
              const isOffTarget =
                row.kind === "comment" && !!offTargetCommentIds?.has(row.id)
              return (
                <ListRow
                  key={`${row.kind}:${row.id}`}
                  data-testid={`annotation-row-${row.kind}-${row.id}`}
                  selected={isActive}
                  className="flex-col items-stretch rounded-none border-b border-border px-3 py-2.5"
                  onClick={() => handleRowClick(row)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <TypeIcon
                        className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                        aria-label={row.kind}
                      />
                      {row.author.photoURL ? (
                        <img
                          src={row.author.photoURL}
                          alt={row.author.displayName}
                          className="h-5 w-5 rounded-full object-cover"
                        />
                      ) : (
                        <span
                          aria-label={row.author.displayName}
                          className="flex h-5 w-5 items-center justify-center rounded-full bg-muted text-2xs font-normal text-muted-foreground"
                        >
                          {avatarInitial(row.author.displayName)}
                        </span>
                      )}
                      <span className="text-sm font-normal">
                        {row.author.displayName}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {isOffTarget ? (
                        <span
                          className="flex items-center"
                          title="This comment's anchor didn't resolve on this build, so it's shown at a fallback position."
                        >
                          <MapPinOff
                            className="h-3 w-3 shrink-0 text-warning"
                            aria-label="Off-target anchor"
                          />
                        </span>
                      ) : null}
                      <span className="text-sm text-muted-foreground">
                        {formatRelativeTimeShort(row.createdAt)}
                      </span>
                    </div>
                  </div>
                  <p className="mt-1 line-clamp-2 text-base text-muted-foreground">
                    <MentionText text={row.body} />
                  </p>
                  <div className="mt-1.5 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-muted px-1 py-0.5 text-code text-muted-foreground">
                        {row.page}
                      </code>
                      {row.resolved && (
                        <Badge variant="secondary">
                          Resolved
                        </Badge>
                      )}
                    </div>
                    {row.replies.length > 0 && (
                      <span className="text-sm text-muted-foreground">
                        {row.replies.length}{" "}
                        {row.replies.length === 1 ? "reply" : "replies"}
                      </span>
                    )}
                  </div>
                </ListRow>
              )
            })
          )}
        </div>
      </ScrollArea>
    </div>
  )
}


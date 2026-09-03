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

import { useCallback, useMemo, useState } from "react"
import { useAppStore } from "@/stores"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { MentionText } from "@/components/comments/mention-text"
import { EmptyState } from "@/components/blocks"
import { CommentModeButton } from "@/components/editor/comment-mode-button"
import { MapPinOff, MoreVertical, Search, StickyNote } from "lucide-react"
import { cn } from "@/lib/utils"
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
const VIEWER_SETUP_DOCS = "https://desde.design/docs/viewer/deploy-a-prototype"

interface CommentsListPanelProps {
  onHighlightComment: (commentId: string) => void
  /**
   * Toggle comment placement mode. Same handler the toolbar's Comment
   * button fires, and the button itself is the same component, so the two
   * controls cannot disagree about what a click does.
   */
  onCommentModeChange: (next: boolean) => void
  /** Show-resolved toggle: applies to both types. */
  onShowResolvedChange: (show: boolean) => void
  /**
   * The three NOTE handlers below travel as a group, and an absent group
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
  /** Everything the search matches against, lower-cased once. */
  searchText: string
}

export function CommentsListPanel({
  onHighlightComment,
  onHighlightNote,
  onCommentModeChange,
  onAddNote,
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
  const showResolved = useAppStore((s) => s.showResolved)
  const showResolvedNotes = useAppStore((s) => s.showResolvedNotes)
  const setActiveComment = useAppStore((s) => s.setActiveComment)
  const setActiveNote = useAppStore((s) => s.setActiveNote)
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

  // Unified show-resolved state: both types are gated together, mirroring
  // the merged-panel design (one panel, one set of filters). "Any one type
  // shown" collapses to the switch-on state so the user can never get into a
  // "two switches disagree" state through this panel.
  //
  // With Notes dormant the note half drops out of the reduction entirely.
  //
  // The Hide switch that sat beside this moved to the floating toolbar
  // (`pins-hidden-toggle.tsx`, 2026-09-02), so the hidden pair and the two
  // hide handlers are gone from this panel.
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
      searchText: [
        c.body,
        c.position.page,
        c.author.displayName,
        ...c.replies.map((r) => r.body),
        ...c.replies.map((r) => r.author.displayName),
      ]
        .join("\n")
        .toLowerCase(),
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
      searchText: [
        n.body,
        n.position.page,
        n.author.displayName,
        ...n.replies.map((r) => r.body),
        ...n.replies.map((r) => r.author.displayName),
      ]
        .join("\n")
        .toLowerCase(),
    }))
    return [...fromComments, ...fromNotes].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )
  }, [comments, notes, showResolvedAny, notesEnabled])

  /**
   * The rail's filter, as in the Viewer. It narrows THE LIST ONLY: the pins
   * in the prototype are unaffected, and so is the Resolved switch.
   */
  const [query, setQuery] = useState("")
  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((row) => row.searchText.includes(q))
  }, [rows, query])

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
    <div className="flex h-full min-h-0 flex-col">
      {/* The Viewer's action row, copied (Mo, 2026-09-02: "look at how the
          viewer does it"): `px-2 py-2`, the placement button on the left,
          the Resolved switch on the right. Same button component the toolbar
          renders, reading the same state, so a mode started from the toolbar
          can be ended from here. */}
      <div
        className="flex flex-none items-center gap-2 px-2 py-2"
        data-testid="comments-list-panel-header"
      >
        <CommentModeButton
          onCommentModeChange={onCommentModeChange}
          testId="comments-panel-comment"
        />
        {onAddNote ? (
          <Button size="sm" variant="ghost" onClick={onAddNote} title="Add note">
            <StickyNote data-icon="inline-start" />
            Note
          </Button>
        ) : null}
        {/* A switch, labelled "Resolved", as in the Viewer: a persistent view
            setting, not an action. It was a "Show resolved" checkbox item
            inside the ⋮ menu here, one click further away than the Viewer
            keeps it. `aria-label` keeps the full sentence for anyone who
            cannot see that the label and the switch are one pair. */}
        <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs font-normal text-muted-foreground">
          Resolved
          <Switch
            size="sm"
            checked={showResolvedAny}
            onCheckedChange={handleToggleShowResolved}
            aria-label="Show resolved comments"
            data-testid="show-resolved"
          />
        </label>
        {/* The menu only ever carried the notes item once Show resolved
            became a switch, so it renders only when there is a note to act
            on. Notes are dormant, so this is unreachable today. */}
        {notesEnabled && notes.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="More">
                <MoreVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleToggleMinimizeAllNotes}>
                {allNotesMinimized ? "Expand all notes" : "Minimize all notes"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Every message here is `frame="panel"`, as in the Viewer: the empty
            and setup states replace each other in the same space, and a rail
            that centres one and top-aligns the other reads as two surfaces. */}
        {rows.length === 0 && !synced ? (
          /*
            Comments with nowhere to go.

            Without a viewer and a project, a comment is written to this
            machine and read by nobody, which is the opposite of what a
            comment is for. Saying "No comments yet. Add a comment to get
            started" there invites work that quietly goes nowhere.
          */
          <EmptyState
            size="sm"
            frame="panel"
            data-testid="comments-needs-viewer"
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
            size="sm"
            frame="panel"
            data-testid="comments-list-empty"
            title="No comments"
            description={
              notesEnabled
                ? "Add a comment or note to get started"
                : "Add a comment to get started"
            }
          />
        ) : (
          /*
            The Viewer's group: a bordered, rounded box inset 8px from the
            card, rows divided by their `<li>`s, the last divider dropped
            because the group's own bottom edge ends the list. `mt-1` against
            the action row's `pb-2` puts 12px above it, as the Viewer does.
          */
          <div className="mx-2 mt-1 mb-2 flex flex-col overflow-hidden rounded-md border border-border">
            {/* Search is the group's FIRST ROW, as in the Viewer: it shares the
                group's border and divider, and strips the Input's own border,
                background, radius and focus ring so it reads as a row rather
                than a box inside a box. A background tint marks focus instead;
                the ring would be clipped by the group's overflow. It wraps the
                no-matches state too, so the query can still be edited. */}
            <div className="relative border-b border-border">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                type="search"
                size="sm"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search comments"
                className="rounded-none border-0 bg-transparent pl-8 focus-visible:ring-0 focus-visible:bg-muted/50"
                data-testid="comment-search"
              />
            </div>
            {filteredRows.length === 0 ? (
              <EmptyState
                size="sm"
                title="No matching comments"
                description={`Nothing here matches "${query.trim()}".`}
                data-testid="comment-search-no-matches"
              >
                <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                  Clear search
                </Button>
              </EmptyState>
            ) : (
            <ul className="flex flex-col">
              {filteredRows.map((row) => {
                const isActive =
                  (row.kind === "comment" && activeCommentId === row.id) ||
                  (row.kind === "note" && activeNoteId === row.id)
                const isOffTarget =
                  row.kind === "comment" && !!offTargetCommentIds?.has(row.id)
                return (
                  <li
                    key={`${row.kind}:${row.id}`}
                    className="border-b border-border last:border-b-0"
                  >
                    <AnnotationRow
                      row={row}
                      selected={isActive}
                      offTarget={isOffTarget}
                      onClick={() => handleRowClick(row)}
                    />
                  </li>
                )
              })}
            </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * One row of the list. The Viewer's `CommentRow`, with a note glyph added
 * for the (dormant) note kind and the off-target marker kept in the status
 * slot.
 *
 * The hierarchy is the Viewer's: the body is the only `text-foreground` on
 * the row and the only `text-sm`. Everything else is `text-xs
 * text-muted-foreground`, and the author is told apart from the rest of the
 * metadata by weight rather than by contrast. It used to be the other way
 * round here, with the body muted and the author at full weight, so the one
 * thing a reader came for was the quietest text on the row.
 *
 * One status slot beside the timestamp: "Resolved" when the thread is
 * closed, the reply count while it is open, never both. A `Badge` for
 * "Resolved" drew more attention than the comment above it.
 *
 * `bg-clip-border` matters: `Button` clips its background to the padding
 * box, which on a full-bleed row leaves a hairline of un-tinted ground down
 * both edges of the selected state. See the Viewer's row for the contrast
 * measurements behind `primary/6` and `primary/10`.
 */
function AnnotationRow({
  row,
  selected,
  offTarget,
  onClick,
}: {
  row: Row
  selected: boolean
  offTarget: boolean
  onClick: () => void
}) {
  const replies = row.replies.length
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      aria-current={selected ? "true" : undefined}
      data-testid={`annotation-row-${row.kind}-${row.id}`}
      className={cn(
        "h-auto w-full flex-col items-stretch gap-1 rounded-none px-3 py-2.5 text-left whitespace-normal",
        "bg-clip-border hover:bg-primary/6",
        selected && "bg-primary/10 hover:bg-primary/10",
      )}
    >
      <span className="flex items-center gap-2">
        {row.kind === "note" ? (
          <StickyNote
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-label="note"
          />
        ) : null}
        <Avatar size="xs" className="flex-none" aria-label={row.author.displayName}>
          <AvatarImage src={row.author.photoURL} alt="" />
          <AvatarFallback>{avatarInitial(row.author.displayName)}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {row.author.displayName}
        </span>
        <span className="flex flex-none items-center gap-1 text-xs font-normal text-muted-foreground">
          {offTarget ? (
            <span
              className="flex items-center"
              title="This comment's anchor didn't resolve on this build, so it's shown at a fallback position."
            >
              <MapPinOff
                className="size-3 shrink-0 text-warning"
                aria-label="Off-target anchor"
              />
            </span>
          ) : null}
          {row.resolved ? (
            <>
              <span>Resolved</span>
              <span aria-hidden>·</span>
            </>
          ) : replies > 0 ? (
            <>
              <span>
                {replies} {replies === 1 ? "reply" : "replies"}
              </span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <span>{formatRelativeTimeShort(row.createdAt)}</span>
        </span>
      </span>
      <span
        className={cn(
          "line-clamp-2 text-sm font-normal",
          row.resolved ? "text-muted-foreground" : "text-foreground",
        )}
      >
        <MentionText text={row.body} />
      </span>
      {/* Sans at 10px, not mono: a location matched at a glance, never
          transcribed, so the face buys nothing and costs width. */}
      <span className="min-w-0 truncate text-2xs text-muted-foreground">{row.page}</span>
    </Button>
  )
}


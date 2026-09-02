"use client"

import { memo, useCallback, useEffect, useRef, useState } from "react"
import { Handle, Position, useViewport, type NodeProps } from "@xyflow/react"
import {
  MessageSquare,
  Check,
  X,
  ArrowUp,
  Bold,
  Italic,
  AlignLeft,
  AlignCenter,
  AlignRight,
  ChevronDown,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { AnnotationCard } from "@/components/annotations/annotation-card"
import {
  MentionInput,
  encodeBodyMentions,
} from "@/components/annotations/mention-input"
import type {
  CanvasAnnotationKind,
  TextAlign,
  TextColor,
  TextSize,
  TextStyle,
} from "@/types/canvas"
import {
  TEXT_ALIGN_ORDER,
  TEXT_COLOR_ORDER,
  TEXT_COLOR_VAR,
  TEXT_SIZE_LABEL,
  TEXT_SIZE_ORDER,
  TEXT_SIZE_PX,
  resolveTextStyle,
} from "@/utils/text-annotation-style"
import type { CommentAuthor, CommentReply } from "@/types/bridge"

interface MentionSelection {
  displayName: string
  email: string
  startIndex: number
}

export interface AnnotationNodeData {
  kind: CanvasAnnotationKind
  body: string
  author: CommentAuthor | null
  replies: CommentReply[]
  resolved: boolean
  size: { width: number; height: number }
  /** Only meaningful for text annotations. */
  style?: TextStyle
  /** When false, hide editing affordances (toolbar, dblclick-to-edit). */
  editable?: boolean
  onBodyCommit: (id: string, body: string) => void
  onStyleChange?: (id: string, style: TextStyle) => void
  onReply?: (
    id: string,
    encodedBody: string,
  ) => void | Promise<void | { ok?: boolean }>
  onToggleResolved?: (id: string) => void
  onDelete?: (id: string) => void
  onClose?: () => void
  [key: string]: unknown
}

type AnnotationNodeProps = NodeProps & { data: AnnotationNodeData }

const HANDLE_CLASS =
  "!h-2 !w-2 !rounded-sm !border !border-primary/60 !bg-background"

export const CommentNode = memo(function CommentNode({
  id,
  data,
  selected,
}: AnnotationNodeProps) {
  const isEmpty =
    data.body.trim().length === 0 && data.replies.length === 0
  const author = data.author ?? { displayName: "Unknown" }

  return (
    <div className="relative">
      {selected ? (
        // Card replaces the pin in-place. `nodrag`/`nowheel` keep React Flow
        // from hijacking drag/wheel events inside the card. `top-0 left-0`
        // anchors it where the pin would have been.
        <div
          className="nodrag nowheel absolute left-0 top-0 z-50"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {isEmpty ? (
            <NewCommentEditor
              id={id}
              onSubmit={(encodedBody) => {
                data.onBodyCommit(id, encodedBody)
              }}
              onCancel={() => {
                // Empty new comments are discarded if the user closes
                // without typing — matches the prototype "pendingPosition"
                // flow where canceling never persists a comment.
                data.onDelete?.(id)
              }}
            />
          ) : (
            <AnnotationCard
              variant="comment"
              body={data.body}
              author={author}
              replies={data.replies}
              resolved={data.resolved}
              onReply={(encodedBody) => data.onReply?.(id, encodedBody)}
              onResolve={() => data.onToggleResolved?.(id)}
              onDelete={() => data.onDelete?.(id)}
              onClose={() => data.onClose?.()}
            />
          )}
        </div>
      ) : (
        <div
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-full shadow-md ring-1 ring-amber-500/40 transition",
            data.resolved
              ? "bg-success/10 text-success"
              : "bg-warning/10 text-warning-foreground"
          )}
        >
          {data.resolved ? (
            <Check className="h-4 w-4" />
          ) : (
            <MessageSquare className="h-3.5 w-3.5" />
          )}
        </div>
      )}
    </div>
  )
})

interface NewCommentEditorProps {
  id: string
  onSubmit: (encodedBody: string) => void
  onCancel: () => void
}

function NewCommentEditor({ onSubmit, onCancel }: NewCommentEditorProps) {
  const [text, setText] = useState("")
  const mentionsRef = useRef<MentionSelection[]>([])

  const handleSubmit = useCallback(() => {
    if (!text.trim()) return
    const encoded = encodeBodyMentions(text.trim(), mentionsRef.current)
    onSubmit(encoded)
  }, [text, onSubmit])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === "Escape") {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="flex w-80 flex-col overflow-hidden rounded-sm border border-border bg-background shadow-xl">
      <div className="flex flex-none items-center justify-between px-3 py-1.5">
        <span className="text-xs text-muted-foreground">New comment</span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onCancel}
        >
          <X className="h-2.5 w-2.5" />
        </Button>
      </div>
      <div className="border-t border-border p-3">
        <div className="relative">
          <MentionInput
            placeholder="Add a comment… (@ to mention)"
            value={text}
            onChange={setText}
            onKeyDown={handleKeyDown}
            onMentionsChange={(m) => {
              mentionsRef.current = m
            }}
            className="min-h-[56px] resize-none pr-10 text-base"
            autoFocus
          />
          <Button
            size="icon-sm"
            className="absolute bottom-2 right-2 rounded-full"
            onClick={handleSubmit}
            disabled={!text.trim()}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

export const TextNode = memo(function TextNode({
  id,
  data,
  selected,
}: AnnotationNodeProps) {
  const { zoom } = useViewport()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(data.body)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const editable = data.editable ?? true
  const isSelected = selected ?? false
  const style = resolveTextStyle(data.style)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- external body updates override the local draft
    setDraft(data.body)
  }, [data.body])

  useEffect(() => {
    if (editing) {
      textareaRef.current?.focus()
      textareaRef.current?.select()
    }
  }, [editing])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- exit edit mode when the node is deselected from outside
    if (!isSelected && editing) setEditing(false)
  }, [isSelected, editing])

  const commit = useCallback(() => {
    data.onBodyCommit(id, draft)
    setEditing(false)
  }, [draft, data, id])

  const cancel = useCallback(() => {
    setDraft(data.body)
    setEditing(false)
  }, [data.body])

  const handleStyleChange = useCallback(
    (next: TextStyle) => {
      data.onStyleChange?.(id, next)
    },
    [data, id]
  )

  const { width, height } = data.size
  const fontSize = TEXT_SIZE_PX[style.size]
  const color = TEXT_COLOR_VAR[style.color]

  const textStyle: React.CSSProperties = {
    fontSize,
    lineHeight: 1.3,
    color,
    fontWeight: style.bold ? 700 : 400,
    fontStyle: style.italic ? "italic" : "normal",
    textAlign: style.align,
  }

  return (
    <div
      className={cn(
        "relative rounded-sm bg-transparent p-3",
        isSelected && "ring-2 ring-primary"
      )}
      style={{ width, minHeight: height }}
      onDoubleClick={(e) => {
        if (!editable) return
        e.stopPropagation()
        setEditing(true)
      }}
    >
      <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
      <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />

      {isSelected && editable && (
        <div
          className="nodrag nowheel absolute left-0 z-50"
          style={{
            bottom: "100%",
            marginBottom: 8 / Math.max(zoom, 0.3),
            transform: `scale(${1 / Math.max(zoom, 0.3)})`,
            transformOrigin: "bottom left",
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <TextStyleToolbar style={style} onChange={handleStyleChange} />
        </div>
      )}

      {editing ? (
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault()
              cancel()
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              commit()
            }
          }}
          className="nodrag nowheel h-full w-full resize-none border-none bg-transparent p-0 outline-none shadow-none focus-visible:ring-0"
          style={textStyle}
        />
      ) : (
        <div
          className="whitespace-pre-wrap break-words"
          style={textStyle}
        >
          {data.body.trim().length > 0 ? (
            data.body
          ) : (
            <span className="italic opacity-60">Add text</span>
          )}
        </div>
      )}
    </div>
  )
})

interface TextStyleToolbarProps {
  style: TextStyle
  onChange: (next: TextStyle) => void
}

function TextStyleToolbar({ style, onChange }: TextStyleToolbarProps) {
  const AlignIcon =
    style.align === "center"
      ? AlignCenter
      : style.align === "right"
        ? AlignRight
        : AlignLeft

  return (
    <div className="flex items-center gap-1 rounded-lg border bg-popover px-1.5 py-1 text-popover-foreground shadow-md">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1"
            aria-label="Text color"
          >
            <span
              className="h-3.5 w-3.5 rounded-full border border-border"
              style={{ background: TEXT_COLOR_VAR[style.color] }}
            />
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-auto p-2">
          <div className="grid grid-cols-4 gap-1">
            {TEXT_COLOR_ORDER.map((c: TextColor) => (
              <Button
                key={c}
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => onChange({ ...style, color: c })}
                className={cn(
                  "rounded-full border border-border",
                  style.color === c && "ring-2 ring-ring ring-offset-1"
                )}
                style={{ background: TEXT_COLOR_VAR[c] }}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <Separator orientation="vertical" className="!h-5" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 font-normal"
          >
            {TEXT_SIZE_LABEL[style.size]}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {TEXT_SIZE_ORDER.map((s: TextSize) => (
            <DropdownMenuItem
              key={s}
              onSelect={() => onChange({ ...style, size: s })}
              className={cn(
                "flex items-center justify-between gap-4",
                style.size === s && "bg-accent"
              )}
            >
              <span style={{ fontSize: Math.min(TEXT_SIZE_PX[s], 22) }}>
                {TEXT_SIZE_LABEL[s]}
              </span>
              <span className="text-sm uppercase text-muted-foreground">
                {s}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Separator orientation="vertical" className="!h-5" />

      <Button
        variant={style.bold ? "secondary" : "ghost"}
        size="icon"
        onClick={() => onChange({ ...style, bold: !style.bold })}
        aria-label="Bold"
        aria-pressed={style.bold}
      >
        <Bold className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant={style.italic ? "secondary" : "ghost"}
        size="icon"
        onClick={() => onChange({ ...style, italic: !style.italic })}
        aria-label="Italic"
        aria-pressed={style.italic}
      >
        <Italic className="h-3.5 w-3.5" />
      </Button>

      <Separator orientation="vertical" className="!h-5" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Text alignment"
          >
            <AlignIcon className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {TEXT_ALIGN_ORDER.map((a: TextAlign) => {
            const Icon =
              a === "center"
                ? AlignCenter
                : a === "right"
                  ? AlignRight
                  : AlignLeft
            return (
              <DropdownMenuItem
                key={a}
                onSelect={() => onChange({ ...style, align: a })}
                className={cn(
                  "gap-2 capitalize",
                  style.align === a && "bg-accent"
                )}
              >
                <Icon className="h-4 w-4" />
                {a}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

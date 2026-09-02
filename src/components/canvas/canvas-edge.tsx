"use client"

import { memo, useCallback, useEffect, useRef, useState } from "react"
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"

export interface CanvasEdgeData {
  onLabelCommit: (edgeId: string, label: string | null) => void
  [key: string]: unknown
}

function CanvasEdgeInner(props: EdgeProps) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    label,
    markerEnd,
    data,
    selected,
  } = props
  const edgeData = data as CanvasEdgeData | undefined

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(typeof label === "string" ? label : "")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local draft with the authoritative label when it changes externally
    setDraft(typeof label === "string" ? label : "")
  }, [label])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })

  const commit = useCallback(() => {
    const trimmed = draft.trim()
    edgeData?.onLabelCommit(id, trimmed.length > 0 ? trimmed : null)
    setEditing(false)
  }, [draft, edgeData, id])

  const cancel = useCallback(() => {
    setDraft(typeof label === "string" ? label : "")
    setEditing(false)
  }, [label])

  const style: React.CSSProperties = {
    stroke: selected ? "var(--primary)" : "var(--border)",
    strokeWidth: selected ? 2.5 : 1.5,
    cursor: "pointer",
    // Subtle outer glow that matches the selected-node ring color, so a
    // selected edge reads the same as a selected frame.
    filter: selected
      ? "drop-shadow(0 0 3px color-mix(in oklch, var(--primary) 55%, transparent))"
      : undefined,
  }

  const hasLabel = typeof label === "string" && label.length > 0

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={style}
        interactionWidth={24}
      />
      <EdgeLabelRenderer>
        <div
          className={cn(
            "nodrag nopan pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2",
            "rounded-sm border bg-background/90 px-1.5 py-0.5 text-2xs text-muted-foreground"
          )}
          style={{ left: labelX, top: labelY }}
          onDoubleClick={() => setEditing(true)}
        >
          {editing ? (
            <Input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  commit()
                } else if (e.key === "Escape") {
                  e.preventDefault()
                  cancel()
                }
              }}
              className="border-none bg-transparent p-0 shadow-none focus-visible:ring-0"
              style={{ width: `${Math.max(draft.length + 1, 8)}ch` }}
            />
          ) : hasLabel ? (
            <span>{label as string}</span>
          ) : (
            <span className="italic opacity-60">double-click to label</span>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

export const CanvasEdge = memo(CanvasEdgeInner)

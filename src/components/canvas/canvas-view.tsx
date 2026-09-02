"use client"

/**
 * Phase 3 — ported from Desde. The original drove persistence
 * through a cloud project registry keyed on `projectId`; the CLI
 * variant accepts a `CanvasStore` prop and routes every mutation
 * through it. The store is the seam — local-file impl in CLI mode,
 * Firestore impl when the viewer extracts.
 *
 * Notable shape difference from the original:
 *  - `handleConnect` calls `store.createEdge(...)` (which assigns the
 *    server id), then upserts the returned edge into the slice. The
 *    original optimistically inserted with a crypto.randomUUID and
 *    relied on Firestore to accept the client-generated id.
 */

import {
  useMemo,
  useCallback,
  useEffect,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react"
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Position,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
  type EdgeChange,
  type Connection,
  type NodeTypes,
  type EdgeTypes,
  type NodeChange,
  type NodePositionChange,
  type NodeDimensionChange,
  type NodeSelectionChange,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { FrameNode, type FrameNodeData } from "./frame-node"
import { CanvasEdge as CanvasEdgeComponent, type CanvasEdgeData } from "./canvas-edge"
import {
  CommentNode,
  TextNode,
  type AnnotationNodeData,
} from "./annotation-nodes"
import { useAppStore } from "@/stores"
import { getActiveCliUser } from "@/lib/cli-user-identity"
import type { CanvasStore } from "@/editor/core"
import type {
  CanvasFrame,
  CanvasEdge,
  CanvasAnnotation,
  FrameLayout,
  TextStyle,
} from "@/types/canvas"
import type { CommentAuthor } from "@/types/bridge"

/**
 * Fallback author when the CLI bootstrap hasn't populated a real
 * identity (mirrors `FALLBACK_COMMENT_AUTHOR` in
 * `useLocalComments.ts` / `FALLBACK_NOTE_AUTHOR` in
 * `useLocalNotes.ts` — same shape, kept local since canvas doesn't
 * share their hook).
 */
const FALLBACK_CANVAS_AUTHOR: CommentAuthor = {
  uid: "cli-local",
  displayName: "Local user",
  email: "",
  photoURL: "",
}

const nodeTypes: NodeTypes = {
  frameNode: FrameNode,
  commentNode: CommentNode,
  textNode: TextNode,
}

const edgeTypes: EdgeTypes = {
  canvasEdge: CanvasEdgeComponent,
}

const LAYOUT_PERSIST_DELAY_MS = 300

interface CanvasViewProps {
  canvasId: string
  store: CanvasStore
  /**
   * When false, the canvas is read-only: nodes can't be dragged,
   * resized, connected, or deleted. Selection still works (Open /
   * Continue / etc).
   */
  editable?: boolean
}

export interface CanvasViewHandle {
  /** Center of the visible canvas in flow coordinates, or null if not mounted. */
  getViewportCenter: () => { x: number; y: number } | null
}

const CanvasViewInner = forwardRef<CanvasViewHandle, CanvasViewProps>(
  function CanvasViewInner({ canvasId, store, editable = true }, ref) {
  const { fitView, screenToFlowPosition } = useReactFlow()
  const wrapperRef = useRef<HTMLDivElement>(null)

  useImperativeHandle(
    ref,
    () => ({
      getViewportCenter: () => {
        const el = wrapperRef.current
        if (!el) return null
        const rect = el.getBoundingClientRect()
        return screenToFlowPosition({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        })
      },
    }),
    [screenToFlowPosition]
  )

  const frames = useAppStore((s) => s.frames)
  const edges = useAppStore((s) => s.edges)
  const selectedFrameId = useAppStore((s) => s.selectedFrameId)
  const setSelectedFrameId = useAppStore((s) => s.setSelectedFrameId)
  const selectedAnnotationId = useAppStore((s) => s.selectedAnnotationId)
  const setSelectedAnnotationId = useAppStore((s) => s.setSelectedAnnotationId)
  const updateFrameLayout = useAppStore((s) => s.updateFrameLayout)
  const removeFrame = useAppStore((s) => s.removeFrame)
  const upsertEdge = useAppStore((s) => s.upsertEdge)
  const removeEdge = useAppStore((s) => s.removeEdge)
  const annotations = useAppStore((s) => s.annotations)
  const upsertAnnotation = useAppStore((s) => s.upsertAnnotation)
  const removeAnnotation = useAppStore((s) => s.removeAnnotation)

  const framesRef = useRef<CanvasFrame[]>(frames)
  useEffect(() => {
    framesRef.current = frames
  }, [frames])

  const annotationsRef = useRef<CanvasAnnotation[]>(annotations)
  useEffect(() => {
    annotationsRef.current = annotations
  }, [annotations])

  const pendingLayouts = useRef<Map<string, FrameLayout>>(new Map())
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Layout persistence: debounce a per-frame batch. Unlike the
  // Desde original (Firestore had an `upsertFrameLayouts` bulk
  // call), the CanvasStore is one PATCH per frame. The debounce keeps
  // the network chatter bounded — only the last layout per frame in
  // the window actually goes out.
  //
  // Two flushes back-to-back can produce parallel PATCHes for the
  // SAME frame if the first one is still in flight when the second
  // debounce window expires. Even with the local file lock
  // serializing writes, request arrival order at the server isn't
  // guaranteed to match client intent — a later (newer) layout could
  // be clobbered by an earlier (older) one that arrived second.
  // Codex round-1 should-fix: serialize per-frame by chaining each
  // frame's next PATCH off its last in-flight promise. Different
  // frames still write in parallel.
  const inFlightByFrame = useRef<Map<string, Promise<unknown>>>(new Map())
  const flushLayouts = useCallback(() => {
    if (pendingLayouts.current.size === 0) return
    const entries = Array.from(pendingLayouts.current.entries())
    pendingLayouts.current.clear()
    for (const [frameId, layout] of entries) {
      const prior =
        inFlightByFrame.current.get(frameId) ?? Promise.resolve()
      const next = prior
        .catch(() => undefined)
        .then(() => store.updateFrame(canvasId, frameId, { layout }))
      inFlightByFrame.current.set(frameId, next)
      next
        .catch((err) =>
          console.warn("[canvas] layout persist failed:", err),
        )
        .finally(() => {
          // Only clear the chain entry if no further PATCH has been
          // queued for this frame in the meantime.
          if (inFlightByFrame.current.get(frameId) === next) {
            inFlightByFrame.current.delete(frameId)
          }
        })
    }
  }, [store, canvasId])

  const queueLayoutPersist = useCallback(
    (frameId: string, layout: FrameLayout) => {
      pendingLayouts.current.set(frameId, layout)
      if (persistTimer.current) clearTimeout(persistTimer.current)
      persistTimer.current = setTimeout(flushLayouts, LAYOUT_PERSIST_DELAY_MS)
    },
    [flushLayouts]
  )

  useEffect(() => {
    return () => {
      if (persistTimer.current) clearTimeout(persistTimer.current)
      flushLayouts()
    }
  }, [flushLayouts])

  const handleAnnotationBodyCommit = useCallback(
    (annotationId: string, body: string) => {
      const existing = annotationsRef.current.find((a) => a.id === annotationId)
      if (!existing) return
      const next: CanvasAnnotation = {
        ...existing,
        body,
        updatedAt: new Date().toISOString(),
      }
      upsertAnnotation(next)
      store
        .updateAnnotation(canvasId, annotationId, { body })
        .catch((err) =>
          console.warn("[canvas] annotation persist failed:", err),
        )
    },
    [canvasId, store, upsertAnnotation],
  )

  const handleAnnotationReply = useCallback(
    async (
      annotationId: string,
      encodedBody: string,
    ): Promise<{ ok: boolean }> => {
      const existing = annotationsRef.current.find((a) => a.id === annotationId)
      if (!existing) return { ok: false }
      const author = getActiveCliUser() ?? FALLBACK_CANVAS_AUTHOR
      const reply = {
        id: crypto.randomUUID(),
        body: encodedBody,
        author,
        createdAt: new Date().toISOString(),
        mentions: [] as string[],
      }
      const nextReplies = [...existing.replies, reply]
      const next: CanvasAnnotation = {
        ...existing,
        replies: nextReplies,
        updatedAt: new Date().toISOString(),
      }
      upsertAnnotation(next)
      // Codex round-1 fix + round-2 self-review: persist replies AND
      // await + return the envelope so AnnotationCard keeps the draft
      // on failure (originally fire-and-forget — UI cleared the draft
      // before knowing the PATCH succeeded). Rollback the optimistic
      // insert on failure so the slice doesn't drift from disk.
      try {
        await store.updateAnnotation(canvasId, annotationId, {
          replies: nextReplies,
        })
        return { ok: true }
      } catch (err) {
        console.warn("[canvas] annotation reply persist failed:", err)
        upsertAnnotation(existing)
        return { ok: false }
      }
    },
    [canvasId, store, upsertAnnotation],
  )

  const handleAnnotationToggleResolved = useCallback(
    (annotationId: string) => {
      const existing = annotationsRef.current.find((a) => a.id === annotationId)
      if (!existing) return
      const nextResolved = !existing.resolved
      const next: CanvasAnnotation = {
        ...existing,
        resolved: nextResolved,
        updatedAt: new Date().toISOString(),
      }
      upsertAnnotation(next)
      store
        .updateAnnotation(canvasId, annotationId, { resolved: nextResolved })
        .catch((err) =>
          console.warn("[canvas] annotation resolve persist failed:", err),
        )
    },
    [canvasId, store, upsertAnnotation],
  )

  const handleAnnotationDelete = useCallback(
    (annotationId: string) => {
      removeAnnotation(annotationId)
      store
        .deleteAnnotation(canvasId, annotationId)
        .catch((err) =>
          console.warn("[canvas] annotation delete failed:", err),
        )
    },
    [canvasId, store, removeAnnotation],
  )

  const handleAnnotationClose = useCallback(() => {
    setSelectedAnnotationId(null)
  }, [setSelectedAnnotationId])

  const handleAnnotationStyleChange = useCallback(
    (annotationId: string, style: TextStyle) => {
      const existing = annotationsRef.current.find((a) => a.id === annotationId)
      if (!existing) return
      const next: CanvasAnnotation = {
        ...existing,
        style,
        updatedAt: new Date().toISOString(),
      }
      upsertAnnotation(next)
      store
        .updateAnnotation(canvasId, annotationId, { style })
        .catch((err) =>
          console.warn("[canvas] annotation style persist failed:", err),
        )
    },
    [canvasId, store, upsertAnnotation],
  )

  const frameNodes = useMemo<Node<FrameNodeData>[]>(
    () =>
      frames.map((frame) => ({
        id: frame.id,
        type: "frameNode",
        position: { x: frame.layout.x, y: frame.layout.y },
        width: frame.layout.width,
        height: frame.layout.height,
        handles: [
          { id: "top",    type: "target", position: Position.Top,    x: frame.layout.width / 2, y: 0 },
          { id: "left",   type: "target", position: Position.Left,   x: 0,                       y: frame.layout.height / 2 },
          { id: "right",  type: "source", position: Position.Right,  x: frame.layout.width,      y: frame.layout.height / 2 },
          { id: "bottom", type: "source", position: Position.Bottom, x: frame.layout.width / 2,  y: frame.layout.height },
        ],
        selected: selectedFrameId === frame.id,
        data: {
          label: frame.label,
          url: frame.baseUrl,
          layout: frame.layout,
          crop: frame.crop,
          screenshot: frame.screenshot,
          editable,
        },
      })),
    [frames, selectedFrameId, editable],
  )

  const annotationNodes = useMemo<Node<AnnotationNodeData>[]>(
    () =>
      annotations.map((a) => {
        const renderSize =
          a.kind === "comment"
            ? { width: 32, height: 32 }
            : a.size
        const isSelected = selectedAnnotationId === a.id
        return {
          id: a.id,
          type: a.kind === "comment" ? "commentNode" : "textNode",
          position: { x: a.position.x, y: a.position.y },
          width: renderSize.width,
          height: renderSize.height,
          selected: isSelected,
          zIndex: isSelected ? 1000 : undefined,
          data: {
            kind: a.kind,
            body: a.body,
            author: a.author,
            replies: a.replies,
            resolved: a.resolved,
            size: renderSize,
            style: a.style,
            editable,
            onBodyCommit: handleAnnotationBodyCommit,
            onStyleChange: handleAnnotationStyleChange,
            onReply: handleAnnotationReply,
            onToggleResolved: handleAnnotationToggleResolved,
            onDelete: handleAnnotationDelete,
            onClose: handleAnnotationClose,
          },
        }
      }),
    [
      annotations,
      selectedAnnotationId,
      editable,
      handleAnnotationBodyCommit,
      handleAnnotationStyleChange,
      handleAnnotationReply,
      handleAnnotationToggleResolved,
      handleAnnotationDelete,
      handleAnnotationClose,
    ],
  )

  const nodes = useMemo(
    () => [...frameNodes, ...annotationNodes],
    [frameNodes, annotationNodes]
  )

  const handleLabelCommit = useCallback(
    (edgeId: string, label: string | null) => {
      const existing = edges.find((e) => e.id === edgeId)
      if (!existing) return
      const next: CanvasEdge = { ...existing, label }
      upsertEdge(next)
      store
        .updateEdge(canvasId, edgeId, { label })
        .catch((err) =>
          console.warn("[canvas] edge label persist failed:", err),
        )
    },
    [edges, upsertEdge, canvasId, store],
  )

  const [selectedEdgeIds, setSelectedEdgeIds] = useState<Set<string>>(new Set())

  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.sourceFrameId,
        target: edge.targetFrameId,
        sourceHandle: edge.sourceHandleId ?? undefined,
        targetHandle: edge.targetHandleId ?? undefined,
        label: edge.label ?? undefined,
        type: "canvasEdge",
        selected: selectedEdgeIds.has(edge.id),
        data: {
          onLabelCommit: handleLabelCommit,
        } satisfies CanvasEdgeData,
      })),
    [edges, handleLabelCommit, selectedEdgeIds],
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      setSelectedEdgeIds((prev) => {
        let next = prev
        for (const change of changes) {
          if (change.type === "select") {
            if (next === prev) next = new Set(prev)
            if (change.selected) next.add(change.id)
            else next.delete(change.id)
          } else if (change.type === "remove") {
            if (next === prev) next = new Set(prev)
            next.delete(change.id)
          }
        }
        return next
      })
    },
    [],
  )

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      if (connection.source === connection.target) return
      // Unlike the Desde original, the CLI store assigns the id.
      // Create on the store first, then upsert the returned record into
      // the slice. (A slower-than-optimistic create — the edge appears
      // after the round trip — but avoids client/server id divergence.)
      store
        .createEdge(canvasId, {
          sourceFrameId: connection.source,
          targetFrameId: connection.target,
          sourceHandleId: connection.sourceHandle ?? null,
          targetHandleId: connection.targetHandle ?? null,
          label: null,
        })
        .then((edge) => upsertEdge(edge))
        .catch((err) => console.warn("[canvas] edge create failed:", err))
    },
    [canvasId, store, upsertEdge],
  )

  const handleEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      for (const e of deleted) {
        removeEdge(e.id)
        store
          .deleteEdge(canvasId, e.id)
          .catch((err) => console.warn("[canvas] edge delete failed:", err))
      }
    },
    [canvasId, store, removeEdge],
  )

  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      for (const change of changes) {
        if (change.type === "position") {
          const posChange = change as NodePositionChange
          if (posChange.position === undefined) continue
          const frame = framesRef.current.find((f) => f.id === posChange.id)
          if (frame) {
            const nextLayout: FrameLayout = {
              ...frame.layout,
              x: posChange.position.x,
              y: posChange.position.y,
            }
            updateFrameLayout(frame.id, nextLayout)
            if (posChange.dragging === false) {
              queueLayoutPersist(frame.id, nextLayout)
            }
            continue
          }
          const annotation = annotationsRef.current.find(
            (a) => a.id === posChange.id
          )
          if (annotation && posChange.dragging === false) {
            const nextPosition = {
              x: posChange.position.x,
              y: posChange.position.y,
            }
            const next: CanvasAnnotation = {
              ...annotation,
              position: nextPosition,
              updatedAt: new Date().toISOString(),
            }
            upsertAnnotation(next)
            store
              .updateAnnotation(canvasId, annotation.id, {
                position: nextPosition,
              })
              .catch((err) =>
                console.warn("[canvas] annotation move persist failed:", err),
              )
          } else if (annotation) {
            // Optimistic move during drag
            upsertAnnotation({
              ...annotation,
              position: {
                x: posChange.position.x,
                y: posChange.position.y,
              },
            })
          }
        } else if (change.type === "dimensions") {
          const dimChange = change as NodeDimensionChange
          if (!dimChange.dimensions) continue
          const frame = framesRef.current.find((f) => f.id === dimChange.id)
          if (!frame) continue
          const nextLayout: FrameLayout = {
            ...frame.layout,
            width: dimChange.dimensions.width,
            height: dimChange.dimensions.height,
          }
          updateFrameLayout(frame.id, nextLayout)
          if (dimChange.resizing === false) {
            queueLayoutPersist(frame.id, nextLayout)
          }
        } else if (change.type === "select") {
          const selChange = change as NodeSelectionChange
          const frame = framesRef.current.find((f) => f.id === selChange.id)
          if (frame) {
            if (selChange.selected) {
              setSelectedFrameId(selChange.id)
            } else if (selectedFrameId === selChange.id) {
              setSelectedFrameId(null)
            }
            continue
          }
          const annotation = annotationsRef.current.find(
            (a) => a.id === selChange.id
          )
          if (annotation) {
            if (selChange.selected) {
              setSelectedAnnotationId(selChange.id)
            } else if (selectedAnnotationId === selChange.id) {
              setSelectedAnnotationId(null)
            }
          }
        }
      }
    },
    [
      updateFrameLayout,
      queueLayoutPersist,
      setSelectedFrameId,
      selectedFrameId,
      setSelectedAnnotationId,
      selectedAnnotationId,
      upsertAnnotation,
      canvasId,
      store,
    ],
  )

  const handleNodesDelete = useCallback(
    (deleted: Node[]) => {
      for (const n of deleted) {
        if (n.type === "commentNode" || n.type === "textNode") {
          removeAnnotation(n.id)
          store
            .deleteAnnotation(canvasId, n.id)
            .catch((err) =>
              console.warn("[canvas] annotation delete failed:", err),
            )
        } else if (n.type === "frameNode") {
          pendingLayouts.current.delete(n.id)
          removeFrame(n.id)
          store
            .deleteFrame(canvasId, n.id)
            .catch((err) =>
              console.warn("[canvas] frame delete failed:", err),
            )
        }
      }
    },
    [canvasId, store, removeAnnotation, removeFrame],
  )

  const handlePaneClick = useCallback(() => {
    setSelectedFrameId(null)
    setSelectedAnnotationId(null)
  }, [setSelectedFrameId, setSelectedAnnotationId])

  const handleInit = useCallback(() => {
    setTimeout(() => fitView({ padding: 0.2 }), 50)
  }, [fitView])

  return (
    <div ref={wrapperRef} className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={handleInit}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onNodesDelete={editable ? handleNodesDelete : undefined}
        onPaneClick={handlePaneClick}
        onConnect={editable ? handleConnect : undefined}
        onEdgesDelete={editable ? handleEdgesDelete : undefined}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={editable}
        nodesConnectable={editable}
        elementsSelectable
        connectionMode={ConnectionMode.Loose}
        deleteKeyCode={editable ? ["Backspace", "Delete"] : null}
        minZoom={0.1}
        maxZoom={8}
        fitView
      >
        <Controls showInteractive={false} />
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      </ReactFlow>
    </div>
  )
})

export const CanvasView = forwardRef<CanvasViewHandle, CanvasViewProps>(
  function CanvasView(props, ref) {
    return (
      <ReactFlowProvider>
        <CanvasViewInner {...props} ref={ref} />
      </ReactFlowProvider>
    )
  }
)

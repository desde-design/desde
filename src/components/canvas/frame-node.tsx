"use client"

import { memo } from "react"
import {
  Handle,
  NodeResizer,
  Position,
  useViewport,
  type NodeProps,
} from "@xyflow/react"
import { cn } from "@/lib/utils"
import { Monitor } from "lucide-react"
import type { FrameCrop, FrameScreenshot, FrameLayout } from "@/types/canvas"

export type FrameNodeData = {
  label: string
  url: string
  layout: FrameLayout
  crop: FrameCrop | null
  screenshot: FrameScreenshot | null
  editable: boolean
  [key: string]: unknown
}

type FrameNodeProps = NodeProps & { data: FrameNodeData }

const HANDLE_CLASS =
  "!h-2.5 !w-2.5 !rounded-full !border !border-muted-foreground/50 !bg-background"

export const FrameNode = memo(function FrameNode({
  data,
  selected,
}: FrameNodeProps) {
  const { zoom } = useViewport()
  const { layout, screenshot, crop, label, url, editable } = data

  return (
    // Wrapper bounds === image bounds so the connection handles, which
    // position to the wrapper edges, line up with the image edges. The
    // label (above) is absolutely positioned outside the wrapper — it
    // overflows visually but doesn't affect layout.
    <div
      className={cn(
        "relative overflow-visible rounded-sm border bg-muted",
        selected && "ring-2 ring-primary shadow-[0_0_0_5px_color-mix(in_oklch,var(--primary)_18%,transparent)]"
      )}
      style={{ width: layout.width, height: layout.height }}
    >
      <NodeResizer
        isVisible={selected && editable}
        minWidth={120}
        minHeight={80}
        lineClassName="!border-primary/60"
        handleClassName="!h-2 !w-2 !rounded-sm !border !border-primary !bg-background"
      />
      {editable && (
        <>
          <Handle
            id="top"
            type="target"
            position={Position.Top}
            className={HANDLE_CLASS}
          />
          <Handle
            id="left"
            type="target"
            position={Position.Left}
            className={HANDLE_CLASS}
          />
          <Handle
            id="right"
            type="source"
            position={Position.Right}
            className={HANDLE_CLASS}
          />
          <Handle
            id="bottom"
            type="source"
            position={Position.Bottom}
            className={HANDLE_CLASS}
          />
        </>
      )}

      {/* Label — absolutely positioned above the wrapper */}
      <div
        className="absolute left-0 right-0 truncate text-muted-foreground"
        style={{
          bottom: "100%",
          marginBottom: 4 / zoom,
          fontSize: 11 / zoom,
          lineHeight: `${16 / zoom}px`,
        }}
        title={url}
      >
        {label}
      </div>

      {/* Image area — fills the wrapper */}
      <div className="relative h-full w-full overflow-hidden rounded-sm">
        {screenshot ? (
          <FrameImage
            screenshot={screenshot}
            crop={crop}
            width={layout.width}
            height={layout.height}
            label={url}
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted-foreground/50">
            <Monitor className="h-8 w-8" />
            <span className="text-2xs">No screenshot</span>
          </div>
        )}
      </div>
    </div>
  )
})

interface FrameImageProps {
  screenshot: FrameScreenshot
  crop: FrameCrop | null
  width: number
  height: number
  label: string
}

/**
 * Renders the full screenshot when `crop` is null, or the cropped region
 * scaled to fill the node when `crop` is set. Uses CSS background positioning
 * so the source image is never mutated — the crop is a view.
 */
function FrameImage({ screenshot, crop, width, height, label }: FrameImageProps) {
  if (!crop) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- data URLs aren't optimizable
      <img
        src={screenshot.dataUrl}
        alt={`Screenshot of ${label}`}
        className="block h-full w-full"
        draggable={false}
      />
    )
  }

  const scaleX = width / crop.width
  const scaleY = height / crop.height

  return (
    <div
      role="img"
      aria-label={`Cropped screenshot of ${label}`}
      style={{
        width,
        height,
        backgroundImage: `url(${screenshot.dataUrl})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${screenshot.width * scaleX}px ${screenshot.height * scaleY}px`,
        backgroundPosition: `-${crop.x * scaleX}px -${crop.y * scaleY}px`,
      }}
    />
  )
}

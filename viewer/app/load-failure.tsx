"use client"

import type { ReactNode } from "react"
import { EmptyState } from "@/components/blocks"
import { cn } from "@/lib/utils"

export interface LoadFailureProps {
  /** What failed, in the reader's terms. "Couldn't load comments". */
  title: string
  /** What they can do about it — see `failureMessage` in `api-client.ts`. */
  description: string
  /** A Retry button, when the surface has something to retry with. */
  children?: ReactNode
  size?: "default" | "sm"
  /** `"panel"` centres it in a rail's full height — see `EmptyState`. */
  frame?: "default" | "panel" | "page"
  className?: string
}

/**
 * The viewer's "this went wrong" block.
 *
 * One component rather than an `EmptyState` per surface, because a failure
 * should look the same wherever it happens — six hand-assembled variants is
 * how you end up with six different ideas of how bad a failure is.
 *
 * `tone="failure"` is the whole of what this adds: the sleeping cat rather
 * than the cat at an empty bowl. Nothing else differs from an empty state any
 * more — the dashed box that used to separate them went away on 2026-08-25,
 * and the spacing is the block's for both. "Nothing here" and "this went
 * wrong" are different facts, and the picture is where that difference is
 * carried.
 */
export function LoadFailure({
  title,
  description,
  children,
  size = "default",
  frame,
  className,
}: LoadFailureProps) {
  return (
    <EmptyState
      tone="failure"
      size={size}
      frame={frame}
      title={title}
      description={description}
      className={cn(className)}
    >
      {children}
    </EmptyState>
  )
}

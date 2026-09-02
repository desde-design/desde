"use client"

/**
 * Lightweight unified-diff renderer for Tier 2 LLM-proposed rewrites.
 *
 * V1 deliberately avoids a heavy diff library (e.g. react-diff-viewer):
 *   - We're rendering one SFC's worth of source per proposal, in a
 *     scrollable side panel — performance is not the constraint.
 *   - The dependency footprint of a full diff library is larger than
 *     a 40-line LCS implementation tuned for line-level diffs.
 *   - Visual fidelity needed for this UX is "added line green, removed
 *     line red" — no syntax highlighting, no inline-token diffing.
 *
 * Computes a line-level longest-common-subsequence to produce a unified
 * patch view. For 1k-line files this is fine; if perf bites later, swap
 * the implementation to `diff` or `diff-match-patch`.
 */

import { cn } from "@/lib/utils"

interface DiffViewProps {
  before: string
  after: string
  /** Optional one-line caption shown above the diff (e.g. LLM explanation). */
  caption?: string
  /** Max height before the diff scrolls internally. */
  className?: string
}

type DiffLine =
  | { kind: "context"; text: string; lineNumBefore: number; lineNumAfter: number }
  | { kind: "added"; text: string; lineNumAfter: number }
  | { kind: "removed"; text: string; lineNumBefore: number }

export function DiffView({ before, after, caption, className }: DiffViewProps) {
  const lines = computeUnifiedDiff(before, after)
  const stats = lines.reduce(
    (acc, l) => {
      if (l.kind === "added") acc.added++
      else if (l.kind === "removed") acc.removed++
      return acc
    },
    { added: 0, removed: 0 },
  )

  return (
    <div
      className={cn("flex flex-col text-sm", className)}
      data-testid="diff-view"
    >
      {caption ? (
        <div
          className="border-b px-3 py-2 text-muted-foreground"
          data-testid="diff-caption"
        >
          {caption}
        </div>
      ) : null}
      <div className="flex gap-2 border-b bg-muted/50 px-3 py-1 font-mono text-code">
        <span className="text-success">+{stats.added}</span>
        <span className="text-destructive">-{stats.removed}</span>
      </div>
      <pre
        className="m-0 overflow-auto bg-muted/10 p-0 font-mono text-code leading-relaxed"
        data-testid="diff-lines"
      >
        {lines.map((line, i) => (
          <DiffLineRow key={i} line={line} />
        ))}
      </pre>
    </div>
  )
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const sign =
    line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "
  const cls =
    line.kind === "added"
      ? "bg-success/10 text-foreground"
      : line.kind === "removed"
      ? "bg-destructive/10 text-foreground"
      : "text-foreground/80"
  return (
    <div className={cn("flex items-baseline gap-2 px-3 py-px", cls)}>
      <span className="w-4 shrink-0 text-center opacity-60">{sign}</span>
      <span className="whitespace-pre-wrap">{line.text}</span>
    </div>
  )
}

/**
 * Compute a unified line-level diff using LCS. Returns a flat list of
 * lines tagged as context / added / removed in order. Same algorithm
 * git uses for `git diff` (the LCS itself, not the patience or histogram
 * variants). For editor's "one SFC per repair" use case the simpler
 * algorithm is correct AND fast enough.
 */
function computeUnifiedDiff(before: string, after: string): DiffLine[] {
  const A = before.split("\n")
  const B = after.split("\n")
  const m = A.length
  const n = B.length

  // LCS length table — m+1 x n+1.
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  )
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  // Walk the table to produce the unified diff.
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  let lineBefore = 1
  let lineAfter = 1
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({
        kind: "context",
        text: A[i],
        lineNumBefore: lineBefore++,
        lineNumAfter: lineAfter++,
      })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "removed", text: A[i], lineNumBefore: lineBefore++ })
      i++
    } else {
      out.push({ kind: "added", text: B[j], lineNumAfter: lineAfter++ })
      j++
    }
  }
  while (i < m) {
    out.push({ kind: "removed", text: A[i], lineNumBefore: lineBefore++ })
    i++
  }
  while (j < n) {
    out.push({ kind: "added", text: B[j], lineNumAfter: lineAfter++ })
    j++
  }
  return out
}

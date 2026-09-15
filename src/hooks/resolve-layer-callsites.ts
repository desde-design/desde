/**
 * The Structure tree's rows for components the runtime has no instance for,
 * re-targeted at their callsites.
 *
 * A server-rendered component that ignores its props (a Next.js App Router
 * section component, say) reaches the browser as bare markup: no fiber, no
 * stamp from the caller. Its row shows as `section` and its `editTarget` is
 * the root markup inside the component's own file, so a move among its
 * siblings — written on the next line of the page — is a different-file
 * drop. The callsite is on disk. This asks the CLI, once per structure
 * fetch, for every row whose file differs from its nearest stamped
 * ancestor's, and rewrites the rows the CLI could resolve: the callsite as
 * `editTarget`, the tag written there as the name, `authoredAt` kept.
 *
 * Best-effort at every step: an unresolved row stays exactly as the bridge
 * reported it, and a failed request leaves the whole tree as it was.
 */
import type { OutlineNode } from "@/types/bridge"
import { editorFetch } from "@/lib/editor-fetch"

export interface CallsiteCandidate {
  nodeId: string
  /** The nearest ancestor row with a source position — the row the element is displayed inside. */
  parentNodeId: string
  file: string
  line: number
  column: number
  parentFile: string
}

export interface ResolvedCallsite {
  /** The tag written at the callsite(s): the component's name. */
  name: string
  /** Every place `parentFile` writes it, in source order. */
  callsites: Array<{ line: number; column: number }>
}

function inNodeModules(file: string): boolean {
  return file.split("/").includes("node_modules")
}

/**
 * Element rows whose source file differs from their nearest stamped
 * ancestor's. A row the runtime already identified as a component carries
 * its callsite and is not a candidate; neither is a library row.
 */
export function collectCallsiteCandidates(roots: OutlineNode[]): CallsiteCandidate[] {
  const out: CallsiteCandidate[] = []
  const walk = (node: OutlineNode, ancestor: OutlineNode | null): void => {
    const target = node.editTarget
    if (
      target &&
      ancestor?.editTarget &&
      node.type !== "component" &&
      !node.isLibrary &&
      !inNodeModules(target.file) &&
      ancestor.editTarget.file !== target.file
    ) {
      out.push({
        nodeId: node.id,
        parentNodeId: ancestor.id,
        file: target.file,
        line: target.line,
        column: target.column,
        parentFile: ancestor.editTarget.file,
      })
    }
    const next = target ? node : ancestor
    for (const child of node.children ?? []) walk(child, next)
  }
  for (const root of roots) walk(root, null)
  return out
}

/**
 * Rewrite the resolved rows. When one component is written several times in
 * the parent file, DOM order maps onto source order among the rows that
 * share one definition under one parent; a row past the last callsite is
 * left alone rather than guessed.
 */
export function applyResolvedCallsites(
  roots: OutlineNode[],
  candidates: CallsiteCandidate[],
  results: ReadonlyArray<ResolvedCallsite | null>,
): OutlineNode[] {
  const ordinalByGroup = new Map<string, number>()
  const rewrite = new Map<string, { name: string; editTarget: { file: string; line: number; column: number } }>()
  candidates.forEach((candidate, i) => {
    const result = results[i]
    if (!result) return
    const group = `${candidate.parentNodeId}|${candidate.file}:${candidate.line}:${candidate.column}`
    const ordinal = ordinalByGroup.get(group) ?? 0
    ordinalByGroup.set(group, ordinal + 1)
    const callsite = result.callsites[ordinal]
    if (!callsite) return
    rewrite.set(candidate.nodeId, {
      name: result.name,
      editTarget: { file: candidate.parentFile, line: callsite.line, column: callsite.column },
    })
  })
  if (rewrite.size === 0) return roots

  const rebuild = (node: OutlineNode): OutlineNode => {
    const hit = rewrite.get(node.id)
    const children = node.children ? node.children.map(rebuild) : undefined
    if (!hit) return children ? { ...node, children } : node
    return {
      ...node,
      name: hit.name,
      type: "component",
      editTarget: hit.editTarget,
      ...(children ? { children } : {}),
    }
  }
  return roots.map(rebuild)
}

/** One round trip for the whole tree. Null when the CLI could not answer. */
export async function fetchResolvedCallsites(
  items: ReadonlyArray<Pick<CallsiteCandidate, "file" | "line" | "column" | "parentFile">>,
): Promise<Array<ResolvedCallsite | null> | null> {
  try {
    const res = await editorFetch("/api/editor/resolve-callsites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ items }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { ok?: boolean; results?: Array<ResolvedCallsite | null> }
    if (!data.ok || !Array.isArray(data.results) || data.results.length !== items.length) return null
    return data.results
  } catch {
    return null
  }
}

/** The tree with every resolvable row re-targeted, or the tree as given. */
export async function enrichLayersWithCallsites(roots: OutlineNode[]): Promise<OutlineNode[]> {
  const candidates = collectCallsiteCandidates(roots)
  if (candidates.length === 0) return roots
  const results = await fetchResolvedCallsites(
    candidates.map(({ file, line, column, parentFile }) => ({ file, line, column, parentFile })),
  )
  if (!results) return roots
  return applyResolvedCallsites(roots, candidates, results)
}

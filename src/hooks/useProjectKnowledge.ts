"use client"

import { useEffect, useState } from "react"
import type { ProjectKnowledge } from "@/editor/core/project-knowledge"
import { editorFetch } from "@/lib/editor-fetch"

/**
 * Client-side shape of `GET /api/editor/project-knowledge` — uniform
 * across the Next.js route and the editor-cli endpoint.
 */
export interface ProjectKnowledgeResponse {
  /** Effective "Use repo conventions" toggle for this session. */
  useRepoConventions: boolean
  /** Effective repo-relative exclusion list. */
  excludeFiles: readonly string[]
  /**
   * True when the SDK runtime is in play. The SDK loads CLAUDE.md natively,
   * so it's excluded from `knowledge` here — the badge surfaces this so the
   * file's absence from the digest reads as "handled natively", not "lost".
   */
  sdkRuntime: boolean
  /**
   * Rule files the SDK loads itself (not through the digest), e.g. CLAUDE.md.
   * Populated only in SDK mode; the badge lists these as "loaded by the
   * agent" so a CLAUDE.md-only repo still shows a grounding indicator.
   */
  nativeFiles: readonly string[]
  /** The digest the AI tiers inject, or `null` when conventions are off. */
  knowledge: ProjectKnowledge | null
}

/**
 * What the hook returns before the fetch resolves or when it fails:
 * conventions nominally on, nothing excluded, no digest — the badge
 * renders nothing for this, same as a substrate with no rules files.
 */
const DEGRADED: ProjectKnowledgeResponse = {
  useRepoConventions: true,
  excludeFiles: [],
  sdkRuntime: false,
  nativeFiles: [],
  knowledge: null,
}

let cached: ProjectKnowledgeResponse | null = null
let inflight: Promise<ProjectKnowledgeResponse> | null = null

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object"
}

/** Structural guard — a malformed-but-`ok` response must not crash the
 *  header. The digest AND every `rulesFiles` / `docIndex` entry must have
 *  the shape the badge dereferences; anything else degrades to `null`. */
function isValidKnowledge(k: unknown): k is ProjectKnowledge {
  if (!isRecord(k)) return false
  if (
    typeof k.rules !== "string" ||
    typeof k.truncated !== "boolean" ||
    !Array.isArray(k.rulesFiles) ||
    !Array.isArray(k.docIndex)
  ) {
    return false
  }
  const rulesFilesOk = k.rulesFiles.every(
    (f) =>
      isRecord(f) &&
      typeof f.path === "string" &&
      typeof f.chars === "number" &&
      typeof f.truncated === "boolean",
  )
  const docIndexOk = k.docIndex.every(
    (d) => isRecord(d) && typeof d.path === "string" && typeof d.title === "string",
  )
  return rulesFilesOk && docIndexOk
}

/**
 * Coerce a raw `/api/editor/project-knowledge` body into the client
 * shape. Exported for testing — any malformed input degrades safely.
 */
export function normalizeProjectKnowledgeResponse(
  body: unknown,
): ProjectKnowledgeResponse {
  if (!body || typeof body !== "object") return DEGRADED
  const b = body as Record<string, unknown>
  if (b.ok === false) return DEGRADED
  return {
    useRepoConventions: b.useRepoConventions !== false,
    excludeFiles: Array.isArray(b.excludeFiles)
      ? (b.excludeFiles as string[])
      : [],
    sdkRuntime: b.sdkRuntime === true,
    nativeFiles:
      Array.isArray(b.nativeFiles) &&
      b.nativeFiles.every((f) => typeof f === "string")
        ? (b.nativeFiles as string[])
        : [],
    knowledge: isValidKnowledge(b.knowledge) ? b.knowledge : null,
  }
}

/**
 * Fetch the prototype's project-knowledge digest once per session and
 * share it across callers — drives the Editor's "Following rules from
 * CLAUDE.md…" indicator. Mirrors `useDesignTokens`: module-level cache,
 * relative `/api/editor/*` fetch, graceful degrade (treated as "no
 * indicator to show") on any failure.
 */
export function useProjectKnowledge(): ProjectKnowledgeResponse {
  const [data, setData] = useState<ProjectKnowledgeResponse>(cached ?? DEGRADED)
  useEffect(() => {
    if (cached) return
    if (!inflight) {
      inflight = editorFetch("/api/editor/project-knowledge", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
        .then((body) => normalizeProjectKnowledgeResponse(body))
        .catch(() => DEGRADED)
        .then((resp) => {
          cached = resp
          inflight = null
          return resp
        })
    }
    inflight.then((resp) => setData(resp))
  }, [])
  return data
}

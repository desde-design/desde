/**
 * Mock backend for the self-host harness.
 *
 * The real `EditorPage` (`@/editor-ui/editor-page`) and its
 * `EditorSurface` chrome fan out to ~30 `/api/editor/*` endpoints —
 * sessions, commit/push state, manifests, tokens, icon sets, the chat
 * stream, etc. To render the FULL chrome with no live CLI behind it, we
 * patch `window.fetch` and answer those routes from fixtures here.
 *
 * Both `editorFetch` (`@/lib/editor-fetch`) and bare `fetch` call
 * sites funnel through `window.fetch`, so this single interception point
 * covers everything. Non-`/api/` requests (Vite HMR, the bridge, the
 * iframe) pass straight through.
 *
 * Fixtures are intentionally populated (sessions, ahead/behind counts, a
 * commit log) so the panels look alive rather than empty. Endpoints not
 * listed fall through to a generic `{ ok: true }` so nothing throws.
 */

import type { ChatSessionSummary } from "@/editor/agent-chat/session-store"
import { defaultModelConfig } from "@/editor/core/model-catalog"
import { ANTHROPIC_MODEL_CATALOG } from "@/editor/llm-providers/anthropic-model-catalog"
import { sampleCatalogEntries } from "@/components/editor/gallery/fixtures/sample-catalog"
import { mockChatSession, mockThinkingStream } from "./mock-chat"

const MOCK_SESSIONS: ChatSessionSummary[] = [
  {
    sessionId: "sess-aaaa1111",
    projectId: "self-host-harness",
    createdAt: "2026-06-22T09:00:00.000Z",
    updatedAt: "2026-06-22T09:12:00.000Z",
    turnCount: 4,
    lastUserMessagePreview: "Tighten the spacing on the commit dialog",
    status: "idle",
  },
  {
    sessionId: "sess-bbbb2222",
    projectId: "self-host-harness",
    createdAt: "2026-06-22T09:20:00.000Z",
    updatedAt: "2026-06-22T09:31:00.000Z",
    turnCount: 2,
    lastUserMessagePreview: "Make the inspector panel header sticky",
    status: "in-flight",
  },
  {
    sessionId: "sess-cccc3333",
    projectId: "self-host-harness",
    createdAt: "2026-06-22T08:40:00.000Z",
    updatedAt: "2026-06-22T08:55:00.000Z",
    turnCount: 7,
    lastUserMessagePreview: "Rename the New button label",
    status: "idle",
  },
]

const COMMIT_PUSH_STATE = {
  worktreeAhead: 2,
  worktreeBehind: 0,
  mergeInProgress: false,
  mergeConflictFiles: [] as string[],
  mainAhead: 0,
  mainBehind: 0,
  hasUpstream: true,
  canonicalBranch: "main",
}

// Commit timestamps are unix SECONDS (session-log-panel's
// formatRelativeTime does `Date.now()/1000 - timestamp`). Anchor them a
// couple minutes back so they read "2m ago" / "10m ago".
const NOW_SECONDS = Math.floor(Date.now() / 1000)
const SESSION_LOG = {
  ok: true,
  commits: [
    {
      sha: "0000000000000000000000000000000000000001",
      shortSha: "0000001",
      message: "Editor: edit chat-session-tabs.tsx",
      timestamp: NOW_SECONDS - 120,
      graduated: false,
    },
    {
      sha: "0000000000000000000000000000000000000002",
      shortSha: "0000002",
      message: "Editor: edit commit-push-controls.tsx",
      timestamp: NOW_SECONDS - 600,
      graduated: false,
    },
  ],
  files: [
    { path: "src/components/editor/chat-session-tabs.tsx", status: "M" },
    { path: "src/components/editor/commit-push-controls.tsx", status: "M" },
  ],
}

const PROJECT_KNOWLEDGE = {
  useRepoConventions: true,
  excludeFiles: [] as string[],
  sdkRuntime: true,
  nativeFiles: [] as string[],
  knowledge: null,
}

/** JSON `Response` helper. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/**
 * Resolve a single `/api/editor/*` request to a mock `Response`, or
 * `null` to let it pass through to the network.
 */
async function route(
  path: string,
  method: string,
  init?: RequestInit,
): Promise<Response | null> {
  const p = path.split("?")[0]

  // ── Chat: live "thinking" stream. The harness auto-fires one submit
  //    on boot (main.tsx); this answers it with a held-open SSE stream
  //    (reasoning + Grep tool-use, never completes) so the panel parks
  //    on the pulsing "Thinking…" state. ─────────────────────────────
  if (p === "/api/editor/chat" && method === "POST") {
    // Echo the submitted sessionId so the stream's `session` event
    // matches the bucket the turn was submitted into — no mid-stream
    // re-key (which would drop the live "thinking" running state).
    let sessionId = "sess-live-thinking"
    try {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null
      if (body && typeof body.sessionId === "string") sessionId = body.sessionId
    } catch {
      /* non-JSON body — fall back to the default id */
    }
    return mockThinkingStream(sessionId)
  }

  // ── Chat: per-session transcript (tab hydration). Matches the real
  //    route's `{ ok, session, worktreeRoot }` shape. Must be checked
  //    before the bare `/chat/sessions` list below — this is the
  //    `/chat/sessions/<id>` GET, excluding the action sub-paths
  //    (lock-events / apply-merge-resolution / POST messages). ───────
  if (
    method === "GET" &&
    p.startsWith("/api/editor/chat/sessions/") &&
    !p.endsWith("/lock-events") &&
    !p.endsWith("/apply-merge-resolution")
  ) {
    const id = p.slice("/api/editor/chat/sessions/".length)
    if (id.length > 0 && !id.includes("/")) {
      return json({
        ok: true,
        session: mockChatSession(id),
        worktreeRoot: "/mock/worktree",
      })
    }
  }

  // ── On-mount reads (populate the chrome) ──────────────────────────
  // Real route shape is `{ ok, projectId, sessions }` — a bare array
  // makes `useChatSessions` treat `body.ok` as falsy and surface an
  // error (empty tab strip).
  if (p === "/api/editor/chat/sessions") {
    return json({ ok: true, projectId: "self-host-harness", sessions: MOCK_SESSIONS })
  }
  if (p === "/api/editor/state") return json(COMMIT_PUSH_STATE)
  if (p === "/api/editor/session/log") return json(SESSION_LOG)
  if (p === "/api/editor/session/orphans") return json({ ok: true, orphans: [] })
  if (p === "/api/editor/manifest") return json([])
  // Real route shape is a bare `CatalogEntry[]` (manifest-handler.ts:94).
  // Was `{ components: [] }` — SwapDialog does `for (const entry of catalog)`
  // over the resolved body, which threw "catalog is not iterable" on an
  // object and crashed the whole harness (no error boundary above it).
  // Surfaced by the surface-gallery swap fixtures, which are the first thing
  // in this harness to actually open SwapDialog against a live browser.
  //
  // Populated (not `[]`) so the harness's own working layout for Swap /
  // Edit-component isn't permanently empty — a handful of realistic
  // Acme DS-shaped manifests, projected through the real `buildCatalog`
  // (see sample-catalog.ts). The `swap/empty-catalog` gallery fixture no
  // longer depends on this default being empty — it patches this same
  // endpoint locally to force `[]` regardless — so changing this default
  // doesn't make that state untruthful.
  if (p === "/api/editor/catalog") return json(sampleCatalogEntries())
  if (p === "/api/editor/design-tokens") return json([])
  // `ModelPickerChip` fetches this on mount and reads `catalog.catalogs[0]`
  // unconditionally once the response resolves — the generic catch-all
  // `{ ok: true }` below has no `catalogs` field, which throws and takes
  // the whole chrome down with it (no error boundary above the chip).
  // Reuse the real catalog data so the chip renders exactly as it would
  // against a live CLI.
  if (p === "/api/editor/chat/model-catalog") {
    return json({
      catalogs: [ANTHROPIC_MODEL_CATALOG],
      default: defaultModelConfig(ANTHROPIC_MODEL_CATALOG),
      lastChosenModel: null,
    })
  }
  if (p === "/api/editor/icon-sets") return json({ ok: true, sets: [] })
  if (p === "/api/editor/project-knowledge") return json(PROJECT_KNOWLEDGE)
  if (p === "/api/editor/design-systems/suggestions") return json({ suggestions: [] })
  if (p === "/api/editor/design-systems") return json({ designSystems: [] })
  if (p === "/api/editor/smoke-test" && method === "GET") return json({ ok: true, runs: [] })
  // The mock selection is a literal-text element, not conditional text —
  // `ok: false` makes the inspector's ConditionalTextSection not render
  // (a generic `{ ok: true }` would set data with undefined branches → crash).
  if (p === "/api/editor/text-branches") return json({ ok: false })

  // ── Long-poll: hold ~25s then 204 (no query), mimicking the server's
  //    held connection so the hook doesn't hot-loop. ─────────────────
  if (p === "/api/editor/shell-bridge/poll") {
    await new Promise((r) => setTimeout(r, 25_000))
    return new Response(null, { status: 204 })
  }

  // ── Fire-and-forget / action endpoints — succeed quietly. ─────────
  if (
    p === "/api/editor/shell-bridge/reply" ||
    p === "/api/editor/chat/bridge-reply" ||
    p === "/api/editor/chat/edit-ack"
  ) {
    return new Response(null, { status: 204 })
  }

  // ── Catch-all for anything else under /api/editor/* so an
  //    unmocked action endpoint can't throw an unhandled rejection. ──
  if (p === "/api/editor/chat/model-catalog") {
    // Explicit, because the catch-all below is actively harmful here: the chip
    // reads `catalogs[0]` and `default`, and a bare `{ ok: true }` took the
    // SUCCESS path and then threw on `catalog.catalogs.length`, crashing the
    // whole right rail. (The chip now validates the shape too — but a harness
    // that answers a route it does not implement should answer it correctly.)
    return json({
      catalogs: [
        {
          provider: "anthropic",
          label: "Anthropic",
          models: [
            { id: "claude-opus-5", label: "Opus 5", supportsEffort: true },
            { id: "claude-sonnet-5", label: "Sonnet 5", supportsEffort: true },
          ],
        },
      ],
      default: { provider: "anthropic", model: "claude-opus-5" },
      lastChosenModel: null,
    })
  }

  if (p.startsWith("/api/editor/")) {
    // Optimistic catch-all: unrecognised editor routes answer 200 so the
    // harness boots without implementing all of them. Add an explicit handler
    // ABOVE whenever a caller reads the BODY — this shape satisfies almost
    // nothing, and a consumer that trusts a 200 will crash on it.
    return json({ ok: true })
  }

  return null
}

/**
 * Patch `window.fetch` once. Idempotent — calling twice is a no-op.
 */
export function installMockBackend(): void {
  const w = window as Window & { __selfHostMockInstalled__?: boolean }
  if (w.__selfHostMockInstalled__) return
  w.__selfHostMockInstalled__ = true

  const realFetch = window.fetch.bind(window)
  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    // Only the path matters; routes are origin-relative.
    let path = url
    try {
      path = new URL(url, window.location.origin).pathname + new URL(url, window.location.origin).search
    } catch {
      /* non-URL input — use as-is */
    }
    if (path.startsWith("/api/")) {
      const method = (init?.method ?? "GET").toUpperCase()
      const mocked = await route(path, method, init)
      if (mocked) return mocked
    }
    return realFetch(input, init)
  }
}

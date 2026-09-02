/**
 * Task 4b — the ledger's `correlationId` join key, driven end to end
 * over the real HTTP routes.
 *
 * The defect this closes: the Activity panel used to join a verification
 * record to a ledger row by `row.id === verification.editId`. Those are
 * disjoint id spaces — `row.id` is a `randomUUID()` minted server-side
 * inside `brokeredWrite` and never sent back to the client;
 * `verification.editId` is the client's own edit id. No real edit's pill
 * could ever show.
 *
 * The fix: the client sends its own edit id as an opaque `correlationId`
 * on `POST /api/editor/edit`; the server records it on the resulting
 * ledger entry and returns it verbatim on `GET /api/editor/ledger`.
 *
 * This suite drives BOTH ends against a REAL server — a producer/consumer
 * test at either end alone would have looked green on the original bug,
 * because each half faithfully implemented its OWN idea of the join key.
 * Only a round trip through the real routes proves they agree.
 *
 * Harness copied from `ledger-route.test.ts` / `http-server-dormant-lanes.
 * integration.test.ts`: `startHttpServer` against a bare (non-git) temp
 * repo — the ledger route's reconcile step degrades gracefully with no
 * `.git` (see `ledger-route.test.ts`'s own "no git repo" case), and this
 * suite only cares about the row shape, not commit reconciliation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let origin: string

async function pickFreePort(): Promise<number> {
  const net = await import("node:net")
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      server.close(() => resolve(port))
    })
  })
}

const ORIGINAL = [
  "<template>",
  '  <KButton variant="primary">Save</KButton>',
  "</template>",
  "",
].join("\n")

beforeEach(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-corr-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")
  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-corr-repo-"))
  await writeFile(join(repoDir, "App.vue"), ORIGINAL)

  const port = await pickFreePort()
  origin = `http://127.0.0.1:${port}`
  const security = newSecurityContext(origin)
  token = security.token

  handle = await startHttpServer({
    host: "127.0.0.1",
    port,
    repoRoot: repoDir,
    uiBundleRoot: bundleDir,
    viteUrl: "http://localhost:5173",
    security,
  })
})

afterEach(async () => {
  await handle.close()
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
})

function post(path: string, body: unknown) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Origin: origin,
    },
    body: JSON.stringify(body),
  })
}

function get(path: string) {
  return fetch(`${origin}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Origin: origin },
  })
}

async function ledgerRows(): Promise<Array<Record<string, unknown>>> {
  const res = await get("/api/editor/ledger")
  expect(res.status).toBe(200)
  const body = (await res.json()) as { entries: Array<Record<string, unknown>> }
  return body.entries
}

describe("POST /api/editor/edit correlationId -> GET /api/editor/ledger (Task 4b)", () => {
  it("round-trips a client-sent correlationId onto the resulting ledger row", async () => {
    const res = await post("/api/editor/edit", {
      edit: { kind: "prop", file: "App.vue", line: 2, column: 3, propName: "variant", value: "danger" },
      correlationId: "client-edit-abc",
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)

    const rows = await ledgerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "prop", correlationId: "client-edit-abc" })
  })

  it("a row from an edit that sent no correlationId carries none — not null, not a match against anything", async () => {
    const res = await post("/api/editor/edit", {
      edit: { kind: "prop", file: "App.vue", line: 2, column: 3, propName: "variant", value: "danger" },
    })
    expect(res.status).toBe(200)

    const rows = await ledgerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe("prop")
    // Genuinely ABSENT, not present-and-falsy — `JSON.stringify` drops an
    // `undefined`-valued key, so a naive `row.correlationId ?? ''` style
    // read on the client can't confuse "absent" with "empty string".
    expect("correlationId" in rows[0]).toBe(false)
  })

  it("distinguishes two edits: one carries its correlationId through, the other has none", async () => {
    const withId = await post("/api/editor/edit", {
      edit: { kind: "prop", file: "App.vue", line: 2, column: 3, propName: "variant", value: "danger" },
      correlationId: "client-edit-1",
    })
    expect(withId.status).toBe(200)

    // Second edit on the SAME element (now `variant="danger"` at the same
    // coordinates) — no correlationId this time, simulating a chat/SDK-tool
    // write or an older client.
    const withoutId = await post("/api/editor/edit", {
      edit: { kind: "prop", file: "App.vue", line: 2, column: 3, propName: "variant", value: "success" },
    })
    expect(withoutId.status).toBe(200)

    const rows = await ledgerRows()
    expect(rows).toHaveLength(2)
    // Newest first.
    expect(rows[0]).toMatchObject({ kind: "prop" })
    expect("correlationId" in rows[0]).toBe(false)
    expect(rows[1]).toMatchObject({ kind: "prop", correlationId: "client-edit-1" })
  })

  it("round-trips a correlationId through the llm-patch lane (the deterministic attr fast-path) — the case verification actually uses", async () => {
    // `useEditorEditing.ts`'s branch-text / attr dispatch sends `kind:
    // "llm-patch"`, not `kind: "prop"` — this is the lane the task's own
    // defect writeup names (`useEditorEditing.ts:2642`'s `editId:
    // edit.id` sits inside exactly this dispatch). A single `attr`
    // mutation applies through the deterministic fast-path (no LLM
    // call), so this needs no LLM stub.
    const res = await post("/api/editor/edit", {
      edit: {
        kind: "llm-patch",
        mutations: [
          {
            id: "m-1",
            kind: "attr",
            sourceLoc: "App.vue:2:3",
            resolutionKind: "direct",
            scope: "definition",
            callsiteLoc: null,
            instancePath: "[0]",
            selector: "button",
            target: "variant",
            before: "primary",
            after: "danger",
          },
        ],
      },
      correlationId: "client-edit-llm-1",
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)

    const rows = await ledgerRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "llm-patch", correlationId: "client-edit-llm-1" })
  })

  it("refuses a 400 for an empty-string correlationId", async () => {
    const res = await post("/api/editor/edit", {
      edit: { kind: "prop", file: "App.vue", line: 2, column: 3, propName: "variant", value: "danger" },
      correlationId: "",
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { reason?: string }
    expect(body.reason).toContain("correlationId")

    // Refused before any write — the ledger stays empty.
    expect(await ledgerRows()).toHaveLength(0)
  })

  it("refuses a 400 for a correlationId over 200 characters", async () => {
    const res = await post("/api/editor/edit", {
      edit: { kind: "prop", file: "App.vue", line: 2, column: 3, propName: "variant", value: "danger" },
      correlationId: "x".repeat(201),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { reason?: string }
    expect(body.reason).toContain("correlationId")
  })

  it("is opaque: an edit still applies and writes the same bytes regardless of what correlationId names", async () => {
    const a = await post("/api/editor/edit", {
      edit: { kind: "prop", file: "App.vue", line: 2, column: 3, propName: "variant", value: "danger" },
      correlationId: "not-a-real-uuid-just-some-client-string",
    })
    expect(a.status).toBe(200)
    const aBody = (await a.json()) as { newHashes?: Record<string, string> }
    expect(aBody.newHashes?.["App.vue"]).toBeTruthy()
  })
})

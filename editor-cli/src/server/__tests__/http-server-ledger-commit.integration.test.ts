/**
 * End-to-end: a real commit through each of the three `commitWorkingTree`
 * call sites (the Commit button, Push, Create-PR) must produce a `commit`
 * line in the edit ledger, and `GET /api/editor/ledger` must render it —
 * `committed: true` with the real `sha`, alongside a correctly-derived
 * `description` for the edit it covers.
 *
 * This is deliberately NOT three separate unit tests of
 * `recordCommitInLedger` and `handleLedgerRequest` in isolation. This
 * plan has twice shipped a producer and consumer that individually
 * tested green but disagreed when wired together (see the task-6/7
 * history) — the only test that can see that is one that drives the
 * real HTTP write path and then the real HTTP read path and checks they
 * agree.
 *
 * Harness copied from `http-server-commit-retention-gc.integration.test.ts`
 * (the pattern for booting a REAL git repo under this server).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { startHttpServer, type HttpServerHandle } from "../http-server.js"
import { newSecurityContext } from "../auth.js"
import { appendLedgerEntry, hashContent } from "../../../../src/editor/ledger/index.js"

const run = promisify(execFile)

let handle: HttpServerHandle
let bundleDir: string
let repoDir: string
let token: string
let shellOrigin: string

async function pickFreePort(): Promise<number> {
  const net = await import("node:net")
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const p = typeof addr === "object" && addr ? addr.port : 0
      server.close(() => resolve(p))
    })
  })
}

beforeEach(async () => {
  bundleDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgercommit-bundle-"))
  await writeFile(join(bundleDir, "index.html"), "<!doctype html><title>test</title>")

  repoDir = await mkdtemp(join(tmpdir(), "editor-cli-ledgercommit-repo-"))
  await run("git", ["-C", repoDir, "init", "--initial-branch=main", "--quiet"])
  await run("git", ["-C", repoDir, "config", "user.email", "t@e.com"])
  await run("git", ["-C", repoDir, "config", "user.name", "T"])
  await run("git", ["-C", repoDir, "config", "commit.gpgsign", "false"])
  await writeFile(join(repoDir, "App.vue"), "<template><h1>Hi</h1></template>\n")
  await run("git", ["-C", repoDir, "add", "App.vue"])
  await run("git", ["-C", repoDir, "commit", "-m", "init", "--quiet"])

  const port = await pickFreePort()
  shellOrigin = `http://127.0.0.1:${port}`
  const security = newSecurityContext(shellOrigin)
  token = security.token

  handle = await startHttpServer({
    host: "127.0.0.1",
    port,
    repoRoot: repoDir,
    uiBundleRoot: bundleDir,
    viteUrl: "http://localhost:5173",
    security,
    branchMode: true,
  })
})

afterEach(async () => {
  await handle.close()
  await rm(bundleDir, { recursive: true, force: true })
  await rm(repoDir, { recursive: true, force: true })
})

function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${handle.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: shellOrigin,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  })
}

interface LedgerRow {
  id: string
  description: string
  committed: boolean
  sha?: string
}

describe("commit sites record a ledger line the read route renders correctly", () => {
  it("POST /api/editor/branches/commit — marks a pending edit committed with the real sha", async () => {
    // Simulate an edit the product already made: the file is dirty on
    // disk, and the ledger has a pending `edit` entry for it whose
    // `afterHashes` matches what's actually there.
    const newContent = "<template><h1>Pricing</h1></template>\n"
    await writeFile(join(repoDir, "App.vue"), newContent)
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e1",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent(newContent) },
      fields: { propName: "title", value: "Pricing" },
    })

    const commitRes = await authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "ship pricing copy" }),
    })
    expect(commitRes.status).toBe(200)
    const commitBody = (await commitRes.json()) as { ok: boolean; sha: string }
    expect(commitBody.ok).toBe(true)

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      id: "e1",
      description: 'title = "Pricing"',
      committed: true,
      sha: commitBody.sha,
    })

    // The commit line itself carries the real message and sha — assert
    // against the raw file too, not just the derived route response.
    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    const commitLine = lines.find((l) => l.type === "commit")
    expect(commitLine).toMatchObject({ sha: commitBody.sha, message: "ship pricing copy" })
  })

  it("a clean-tree commit at the Commit button does not fabricate a ledger commit line", async () => {
    // No edits, no dirty files — commitWorkingTree refuses with "clean",
    // and the handler returns before recordCommitInLedger is even reached.
    const res = await authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "noop" }),
    })
    expect(res.status).toBe(400)

    const ledgerRes = await authedFetch("/api/editor/ledger")
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    expect(entries).toEqual([])

    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8").catch(
      () => "",
    )
    expect(raw).toBe("")
  })

  it("a clean-tree Push (nothing pending) does not fabricate a ledger commit line", async () => {
    // Push's own pre-push commit TOLERATES "clean" and continues on to
    // push (see handleBranchPushRequest) — unlike the Commit button, it
    // does NOT return early on that case. This is what actually exercises
    // `recordCommitInLedger`'s own `!commit.ok` guard: without it, a Push
    // on a clean tree would invent a `commit` line carrying no real sha.
    // No remote is configured, so the push itself fails after — that's
    // fine, only the ledger side effect is under test here.
    const res = await authedFetch("/api/editor/branches/push", { method: "POST" })
    expect(res.status).toBe(400)

    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8").catch(
      () => "",
    )
    expect(raw).toBe("")
  })

  it("Publish's own inline pre-publish commit is not a `commitWorkingTree` call — it is still caught, via reconcile rather than a sha", async () => {
    // `publishBranch` (src/editor/worktree/git-branches.ts) commits
    // pending edits on the branch itself, but with its OWN inline
    // `git add -A && git commit`, never through `commitWorkingTree` — so
    // `recordCommitInLedger` (wired at the three `commitWorkingTree` call
    // sites only) never sees it and appends no `commit` line for it. This
    // is not a hole: the NEXT ledger read reconciles, and the edit's
    // files are genuinely clean on the branch after publish's own
    // commit, so `reconcileLedger`'s "committed outside the product"
    // fallback marks it committed anyway — just via a `reconcile` line
    // (no `sha`) rather than a `commit` line (with one). Documented here
    // because it is a real, easy-to-miss gap in the direct wiring that
    // only the pre-existing self-heal path closes.
    await run("git", ["-C", repoDir, "branch", "feature"])
    await run("git", ["-C", repoDir, "checkout", "feature", "--quiet"])

    const newContent = "<template><h1>Pricing</h1></template>\n"
    await writeFile(join(repoDir, "App.vue"), newContent)
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e1",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent(newContent) },
      fields: { propName: "title", value: "Pricing" },
    })

    const publishRes = await authedFetch("/api/editor/branches/publish", {
      method: "POST",
      body: JSON.stringify({ branch: "feature" }),
    })
    expect(publishRes.status).toBe(200)

    const ledgerRes = await authedFetch("/api/editor/ledger")
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    expect(entries).toHaveLength(1)
    expect(entries[0].committed).toBe(true)
    expect(entries[0].sha).toBeUndefined()

    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.some((l) => l.type === "commit")).toBe(false)
    expect(lines.some((l) => l.type === "reconcile")).toBe(true)
  })

  // Whole-branch review finding (Important, 2026-08-18): the reconcile
  // dirty-check used plain `git status --porcelain`, which reports a
  // brand-new directory as ONE collapsed `?? newdir/` entry — a file
  // created inside it never appears as its own dirty path. The first GET
  // after such a write durably marked the (never-committed) edit
  // "committed": true.
  it("an edit that creates a file inside a brand-new untracked directory stays pending on the first poll", async () => {
    // Nothing under `assets/` is tracked yet — plain `git status`
    // collapses this whole subtree to `?? assets/`.
    await mkdir(join(repoDir, "assets", "icons"), { recursive: true })
    const content = "<svg></svg>\n"
    await writeFile(join(repoDir, "assets", "icons", "logo.svg"), content)
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e1",
      at: new Date().toISOString(),
      kind: "download_asset",
      lane: "direct",
      files: ["assets/icons/logo.svg"],
      afterHashes: { "assets/icons/logo.svg": hashContent(content) },
    })

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    expect(entries).toHaveLength(1)
    // Before the fix this was `committed: true` on the very first GET —
    // `assets/icons/logo.svg` was never in the (collapsed) dirty set, so
    // reconcile read it as clean and wrote a false "committed" reconcile
    // line. That line is durable; a second poll could not have undone it.
    expect(entries[0]).toMatchObject({ id: "e1", committed: false })

    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.some((l) => l.type === "reconcile")).toBe(false)
  })

  // Whole-branch review finding (Important, 2026-08-18): reconcile ran
  // over every pending edit regardless of which branch recorded it, using
  // only the CURRENT branch's working tree to judge cleanliness. A
  // stash-and-switch (dirty edit stashed away on branch A, tree now clean
  // while the user works on branch B) durably marked branch A's pending
  // edit "committed" from branch B's clean tree.
  it("does not reconcile a pending edit recorded on a different branch against this branch's clean tree", async () => {
    // The checked-out repo never leaves "main" in this test, and App.vue
    // is byte-identical to HEAD (clean). The ledger entry below claims
    // branch "feature" regardless — reproducing the load-bearing part of
    // a stash-and-switch without the git branch-switch choreography: a
    // CLEAN current tree that must not be credited to a DIFFERENT
    // branch's pending edit.
    //
    // "feature" is created here (never checked out) so it's a REAL,
    // still-existing branch, same as a real stash-and-switch — the user
    // never deletes the branch they stashed work on. F3 (round-5
    // whole-branch review finding, 2026-08-19) made the row filter fail
    // open for a branch that exists under NO name at all; without this,
    // that fix would (correctly) reveal this synthetic entry, since
    // nothing in this test previously bothered to make "feature" real.
    await run("git", ["-C", repoDir, "branch", "feature"])
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e1",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      branch: "feature",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent("<template><h1>Hi</h1></template>\n") },
      fields: { propName: "title", value: "Feature branch pricing" },
    })

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    // The existing row filter already hides foreign-branch entries from
    // the response, so an empty list here is not proof by itself — the
    // real assertion is on the raw ledger below.
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    expect(entries).toEqual([])

    // Before the fix, this GET durably wrote a `reconcile` line naming
    // e1 committed — App.vue was clean on the CURRENT ("main") tree, and
    // reconcile applied no branch filter at all.
    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.some((l) => l.type === "reconcile")).toBe(false)
  })

  // P2 (round-4 whole-branch review finding, 2026-08-19): `git status`
  // never reports a `.gitignore`d path as dirty — that's what "ignored"
  // means — and `git add -A` will not commit one either. So an edit to
  // an ignored path is absent from the dirty set for the OPPOSITE reason
  // a genuinely-committed file is: reconcile's "not dirty ⇒ committed"
  // inference could not tell the two apart, and durably marked the
  // ignored edit committed even though nothing was ever committed
  // anywhere. This is not hypothetical — this product's OWN
  // `.desde/` directory is locally ignored, so anything written
  // there hit exactly this case.
  it("an edit to a .gitignore'd file stays pending, while a genuinely clean edit in the same poll still reconciles", async () => {
    await writeFile(join(repoDir, ".gitignore"), "ignored-dir/\n")
    await run("git", ["-C", repoDir, "add", ".gitignore"])
    await run("git", ["-C", repoDir, "commit", "-m", "add gitignore", "--quiet"])

    await mkdir(join(repoDir, "ignored-dir"), { recursive: true })
    const ignoredContent = '{"count":1}\n'
    await writeFile(join(repoDir, "ignored-dir", "data.json"), ignoredContent)
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e-ignored",
      at: new Date().toISOString(),
      kind: "unknown",
      lane: "direct",
      files: ["ignored-dir/data.json"],
      afterHashes: { "ignored-dir/data.json": hashContent(ignoredContent) },
    })

    // Control case in the SAME poll: App.vue is untouched since the
    // initial commit, so it's genuinely clean — this entry SHOULD still
    // reconcile. Proves the fix didn't just make reconcile refuse
    // everything.
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e-clean",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent("<template><h1>Hi</h1></template>\n") },
    })

    const ledgerRes = await authedFetch("/api/editor/ledger")
    expect(ledgerRes.status).toBe(200)
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }

    const ignoredEntry = entries.find((e) => e.id === "e-ignored")
    const cleanEntry = entries.find((e) => e.id === "e-clean")
    expect(ignoredEntry).toBeDefined()
    expect(cleanEntry).toBeDefined()
    // The load-bearing assertion. Before the fix this reads `true` —
    // `ignored-dir/data.json` is invisible to a plain `git status`, so
    // the pre-fix dirty check read it as clean and reconcile durably
    // marked it committed.
    expect(ignoredEntry?.committed).toBe(false)
    // And the fix must not be so conservative it stops reconciling
    // anything at all.
    expect(cleanEntry?.committed).toBe(true)

    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    const reconcileLine = lines.find((l) => l.type === "reconcile") as
      | { committedIds: string[] }
      | undefined
    expect(reconcileLine?.committedIds).toEqual(["e-clean"])
  })

  // F1 (round-5)/P1 (round-7 whole-branch review findings, 2026-08-19): a
  // `commit` line used to mark EVERY pending edit on its branch
  // committed, on the assumption `git add -A` (what `commitWorkingTree`
  // just ran) staged all of them. It doesn't stage a `.gitignore`d path —
  // so a pending edit touching only an ignored file was marked committed
  // even though its bytes never entered git. Round 7 replaced the
  // sweep-plus-exclusion design with an inclusion list
  // (`committedIds`) — this test now asserts the ignored edit is simply
  // absent from that list, rather than named in a separate exclusion
  // field.
  it("a commit line's committedIds excludes a pending edit whose file is .gitignore'd, even though the same commit covers a normal pending edit", async () => {
    await writeFile(join(repoDir, ".gitignore"), "ignored-dir/\n")
    await run("git", ["-C", repoDir, "add", ".gitignore"])
    await run("git", ["-C", repoDir, "commit", "-m", "add gitignore", "--quiet"])

    // The normal, genuinely-committable pending edit.
    const newContent = "<template><h1>Pricing</h1></template>\n"
    await writeFile(join(repoDir, "App.vue"), newContent)
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e-clean",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent(newContent) },
      fields: { propName: "title", value: "Pricing" },
    })

    // The ignored pending edit `git add -A` will silently skip.
    await mkdir(join(repoDir, "ignored-dir"), { recursive: true })
    const ignoredContent = '{"count":1}\n'
    await writeFile(join(repoDir, "ignored-dir", "data.json"), ignoredContent)
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e-ignored",
      at: new Date().toISOString(),
      kind: "unknown",
      lane: "direct",
      files: ["ignored-dir/data.json"],
      afterHashes: { "ignored-dir/data.json": hashContent(ignoredContent) },
    })

    const commitRes = await authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "ship pricing copy" }),
    })
    expect(commitRes.status).toBe(200)
    const commitBody = (await commitRes.json()) as { ok: boolean; sha: string }
    expect(commitBody.ok).toBe(true)

    const ledgerRes = await authedFetch("/api/editor/ledger")
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    const cleanEntry = entries.find((e) => e.id === "e-clean")
    const ignoredEntry = entries.find((e) => e.id === "e-ignored")
    expect(cleanEntry).toMatchObject({ committed: true, sha: commitBody.sha })
    // The load-bearing assertion. Before the fix this reads `committed:
    // true` with the SAME sha as e-clean — the commit line swept every
    // pending edit on the branch with no notion that `git add -A` had
    // silently skipped this one's only file.
    expect(ignoredEntry?.committed).toBe(false)
    expect(ignoredEntry?.sha).toBeUndefined()

    // And the commit line itself must name exactly what it covers, so a
    // later replay of the same log reaches the same answer without
    // re-asking git.
    const raw = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    const commitLine = lines.find((l) => l.type === "commit") as
      | { sha: string; committedIds: string[] }
      | undefined
    expect(commitLine?.sha).toBe(commitBody.sha)
    expect(commitLine?.committedIds).toEqual(["e-clean"])
  })

  // F2 (round-9 whole-branch review finding, 2026-08-19): `captureCommitCoverage`
  // filtered `pendingOnBranch` only against `ignoredPrefixes` — it never
  // checked whether a pending entry's file was actually dirty at
  // snapshot time. An edit committed from the user's OWN terminal stays
  // `pending` in the ledger (the product never observed that commit), so
  // when the user later commits an UNRELATED file through the Editor,
  // the stale pending id rode along into `committedIds` purely because
  // its file wasn't `.gitignore`d — permanently stamping an unrelated
  // commit's sha onto a change that commit never made.
  it("a commit's committedIds excludes a pending edit already committed outside the product, even in the same poll as a genuinely dirty one", async () => {
    // A second tracked file, independent of App.vue, so it can be
    // modified and committed on its own.
    await writeFile(join(repoDir, "Other.vue"), "<template><p>Other</p></template>\n")
    await run("git", ["-C", repoDir, "add", "Other.vue"])
    await run("git", ["-C", repoDir, "commit", "-m", "add other", "--quiet"])

    // The product edits App.vue and appends its ledger entry — ordinary
    // pending state.
    const externalContent = "<template><h1>Pricing</h1></template>\n"
    await writeFile(join(repoDir, "App.vue"), externalContent)
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e-external",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      files: ["App.vue"],
      afterHashes: { "App.vue": hashContent(externalContent) },
      fields: { propName: "title", value: "Pricing" },
    })

    // The user commits that edit from their OWN terminal. The product
    // never observes this — the ledger entry is still `pending`, and
    // App.vue is now byte-identical to HEAD again.
    await run("git", ["-C", repoDir, "add", "App.vue"])
    await run("git", ["-C", repoDir, "commit", "-m", "external commit", "--quiet"])

    // A second, unrelated edit — genuinely dirty, and the one this
    // Editor commit is actually meant to cover.
    const otherContent = "<template><p>Other v2</p></template>\n"
    await writeFile(join(repoDir, "Other.vue"), otherContent)
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e-other",
      at: new Date().toISOString(),
      kind: "prop",
      lane: "direct",
      files: ["Other.vue"],
      afterHashes: { "Other.vue": hashContent(otherContent) },
      fields: { propName: "text", value: "Other v2" },
    })

    const commitRes = await authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "ship other copy" }),
    })
    expect(commitRes.status).toBe(200)
    const commitBody = (await commitRes.json()) as { ok: boolean; sha: string }
    expect(commitBody.ok).toBe(true)

    // Read the raw log directly, before any `GET /api/editor/ledger` runs
    // — nothing has triggered a `reconcile` pass yet, so this isolates
    // exactly what the commit's OWN marker claims. The load-bearing
    // assertion: before the fix, `e-external` rode into `committedIds`
    // because its file wasn't `.gitignore`d — never because it was
    // actually dirty at snapshot time (it wasn't: the terminal command
    // above had already committed it).
    const rawAfterCommit = await readFile(join(repoDir, ".desde", "edit-log.jsonl"), "utf8")
    const linesAfterCommit = rawAfterCommit
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const commitLine = linesAfterCommit.find((l) => l.type === "commit") as
      | { sha: string; committedIds: string[] }
      | undefined
    expect(commitLine?.sha).toBe(commitBody.sha)
    expect(commitLine?.committedIds).toEqual(["e-other"])

    // A `GET` afterward triggers a routine reconcile pass, which legitimately
    // self-heals `e-external` to `committed: true` — its file has been
    // clean since the terminal commit, independent of anything this
    // Editor commit did. That is correct and is not what F2 is about.
    // What matters is that it never carries the UNRELATED commit's sha —
    // the permanent misattribution the finding describes.
    const ledgerRes = await authedFetch("/api/editor/ledger")
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    const otherEntry = entries.find((e) => e.id === "e-other")
    const externalEntry = entries.find((e) => e.id === "e-external")
    expect(otherEntry).toMatchObject({ committed: true, sha: commitBody.sha })
    expect(externalEntry?.committed).toBe(true)
    expect(externalEntry?.sha).toBeUndefined()
  })

  // Same finding, the partially-clean shape: ONE ledger entry naming
  // several files, only some of which are dirty at snapshot time (the
  // rest already committed externally). Decision: exclude the whole
  // entry from `committedIds` rather than guess it's covered — an
  // append-only marker that's wrong can never be corrected, so a
  // multi-file entry is only claimed when EVERY one of its files is
  // actually part of the commit about to run. It self-heals: once this
  // commit lands, the previously-dirty file is clean too, so the very
  // next reconcile poll marks the entry committed (no sha).
  it("a multi-file pending entry with only some files dirty is left pending, not partially credited", async () => {
    await writeFile(join(repoDir, "Other.vue"), "<template><p>Other</p></template>\n")
    await run("git", ["-C", repoDir, "add", "Other.vue"])
    await run("git", ["-C", repoDir, "commit", "-m", "add other", "--quiet"])

    // One ledger entry spans both files.
    const appContent = "<template><h1>Pricing</h1></template>\n"
    const otherContent = "<template><p>Other v2</p></template>\n"
    await writeFile(join(repoDir, "App.vue"), appContent)
    await writeFile(join(repoDir, "Other.vue"), otherContent)
    await appendLedgerEntry(repoDir, {
      type: "edit",
      id: "e-mixed",
      at: new Date().toISOString(),
      kind: "unknown",
      lane: "direct",
      files: ["App.vue", "Other.vue"],
      afterHashes: {
        "App.vue": hashContent(appContent),
        "Other.vue": hashContent(otherContent),
      },
    })

    // Only App.vue's half is committed externally — Other.vue stays
    // dirty on disk.
    await run("git", ["-C", repoDir, "add", "App.vue"])
    await run("git", ["-C", repoDir, "commit", "-m", "external partial commit", "--quiet"])

    const commitRes = await authedFetch("/api/editor/branches/commit", {
      method: "POST",
      body: JSON.stringify({ message: "ship other copy" }),
    })
    expect(commitRes.status).toBe(200)
    const commitBody = (await commitRes.json()) as { ok: boolean; sha: string }
    expect(commitBody.ok).toBe(true)

    const rawAfterCommit = await readFile(
      join(repoDir, ".desde", "edit-log.jsonl"),
      "utf8",
    )
    const linesAfterCommit = rawAfterCommit
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    const commitLine = linesAfterCommit.find((l) => l.type === "commit") as
      | { sha: string; committedIds: string[] }
      | undefined
    // Not claimed by this commit's marker at all.
    expect(commitLine?.committedIds ?? []).toEqual([])

    const ledgerRes = await authedFetch("/api/editor/ledger")
    const { entries } = (await ledgerRes.json()) as { entries: LedgerRow[] }
    const mixedEntry = entries.find((e) => e.id === "e-mixed")
    // Self-healed by the SAME poll's reconcile pass — both files are
    // clean now that the commit above landed — but with no sha, since
    // this commit's own marker never named it.
    expect(mixedEntry?.committed).toBe(true)
    expect(mixedEntry?.sha).toBeUndefined()
  })
})

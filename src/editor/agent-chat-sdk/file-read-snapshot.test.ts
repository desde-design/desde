/**
 * Phase 4 spike: prove the PreToolUse-hook-on-Read snapshot pattern
 * works before committing to it as the Phase 4 §2 implementation.
 *
 * The hook is a non-blocking observer: returns `{ continue: true }`
 * and captures a `FileReadRecord` per SDK Read call. These tests pin
 * the contract Phase 4 will rely on: always continues, best-effort
 * on errors, content-addressed within the session.
 *
 * History: this module originally used a `canUseTool` decorator
 * (commit history). End-to-end testing via
 * `scripts/editor-detached-sessions-phase-4-spike.ts` proved
 * canUseTool only fires for "dangerous" tools — never for Read. Moved
 * to PreToolUse hooks which fire for every tool.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk"

import {
  createReadSnapshotHook,
  type FileReadRecord,
} from "./file-read-snapshot"

function preToolUseInput(toolName: string, toolInput: Record<string, unknown>): PreToolUseHookInput {
  return {
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "test-tool-use-id",
  } as PreToolUseHookInput
}

function fakeHookOpts(): { signal: AbortSignal } {
  return { signal: new AbortController().signal }
}

describe("createReadSnapshotHook — Phase 4 spike", () => {
  let dir: string
  let snapshotRoot: string
  let records: FileReadRecord[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "phase4-spike-"))
    snapshotRoot = join(dir, ".desde", "chat-sessions", "sess-spike")
    records = []
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("captures the snapshot when the SDK PreToolUse fires for Read", async () => {
    const targetPath = join(dir, "App.vue")
    writeFileSync(targetPath, "<template>Original</template>\n")

    const hook = createReadSnapshotHook({
      worktreeRoot: dir,
      snapshotRoot,
      onReadObserved: (r) => records.push(r),
    })
    const result = await hook(
      preToolUseInput("Read", { file_path: "App.vue" }),
      "test-tool-use-id",
      fakeHookOpts(),
    )

    expect(result).toEqual({ continue: true })
    expect(records).toHaveLength(1)
    const rec = records[0]
    // resolveRepoPath canonicalizes via realpath, which on macOS prefixes
    // /var with /private. Match against the realpath'd form.
    expect(rec.absolutePath).toBe(realpathSync(targetPath))
    expect(rec.hashAtRead).toMatch(/^[a-f0-9]{64}$/)
    expect(existsSync(rec.baseContentPath)).toBe(true)
    expect(readFileSync(rec.baseContentPath, "utf8")).toBe(
      "<template>Original</template>\n",
    )
  })

  it("returns {continue: true} so the SDK proceeds with the Read", async () => {
    const hook = createReadSnapshotHook({
      worktreeRoot: dir,
      snapshotRoot,
    })
    const result = await hook(
      preToolUseInput("Read", { file_path: "nope.vue" }),
      "x",
      fakeHookOpts(),
    )
    expect(result).toEqual({ continue: true })
  })

  it("does not capture for non-Read tools", async () => {
    writeFileSync(join(dir, "App.vue"), "<template>x</template>\n")
    const hook = createReadSnapshotHook({
      worktreeRoot: dir,
      snapshotRoot,
      onReadObserved: (r) => records.push(r),
    })
    await hook(
      preToolUseInput("Write", { file_path: "App.vue", content: "y" }),
      "x",
      fakeHookOpts(),
    )
    await hook(preToolUseInput("Bash", { command: "ls" }), "x", fakeHookOpts())
    expect(records).toEqual([])
  })

  it("ignores non-PreToolUse hook events", async () => {
    const hook = createReadSnapshotHook({
      worktreeRoot: dir,
      snapshotRoot,
      onReadObserved: (r) => records.push(r),
    })
    const result = await hook(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: { file_path: "App.vue" },
        tool_use_id: "x",
        tool_response: "",
      } as unknown as PreToolUseHookInput,
      "x",
      fakeHookOpts(),
    )
    expect(result).toEqual({ continue: true })
    expect(records).toEqual([])
  })

  it("swallows snapshot errors and still returns continue:true", async () => {
    const hook = createReadSnapshotHook({
      worktreeRoot: dir,
      snapshotRoot,
      onReadObserved: (r) => records.push(r),
    })
    const result = await hook(
      preToolUseInput("Read", { file_path: "does-not-exist.vue" }),
      "x",
      fakeHookOpts(),
    )
    expect(result).toEqual({ continue: true })
    expect(records).toEqual([])
  })

  it("swallows path-escape errors without throwing", async () => {
    const hook = createReadSnapshotHook({
      worktreeRoot: dir,
      snapshotRoot,
      onReadObserved: (r) => records.push(r),
    })
    const result = await hook(
      preToolUseInput("Read", { file_path: "../../etc/passwd" }),
      "x",
      fakeHookOpts(),
    )
    expect(result).toEqual({ continue: true })
    expect(records).toEqual([])
  })

  it("content-addressed dedup: two Reads of the same unchanged file → one sidecar", async () => {
    const targetPath = join(dir, "App.vue")
    writeFileSync(targetPath, "<template>same</template>\n")

    const hook = createReadSnapshotHook({
      worktreeRoot: dir,
      snapshotRoot,
      onReadObserved: (r) => records.push(r),
    })

    await hook(preToolUseInput("Read", { file_path: "App.vue" }), "1", fakeHookOpts())
    await hook(preToolUseInput("Read", { file_path: "App.vue" }), "2", fakeHookOpts())

    expect(records).toHaveLength(2)
    expect(records[0].hashAtRead).toBe(records[1].hashAtRead)
    expect(records[0].baseContentPath).toBe(records[1].baseContentPath)
  })

  it("captures distinct sidecars for distinct content within the same session", async () => {
    const a = join(dir, "A.vue")
    const b = join(dir, "B.vue")
    writeFileSync(a, "<template>A</template>\n")
    writeFileSync(b, "<template>B</template>\n")

    const hook = createReadSnapshotHook({
      worktreeRoot: dir,
      snapshotRoot,
      onReadObserved: (r) => records.push(r),
    })

    await hook(preToolUseInput("Read", { file_path: "A.vue" }), "1", fakeHookOpts())
    await hook(preToolUseInput("Read", { file_path: "B.vue" }), "2", fakeHookOpts())

    expect(records).toHaveLength(2)
    expect(records[0].hashAtRead).not.toBe(records[1].hashAtRead)
    expect(records[0].baseContentPath).not.toBe(records[1].baseContentPath)
    expect(readFileSync(records[0].baseContentPath, "utf8")).toBe(
      "<template>A</template>\n",
    )
    expect(readFileSync(records[1].baseContentPath, "utf8")).toBe(
      "<template>B</template>\n",
    )
  })

  it("subsequent Read after content changes captures the new content as a NEW sidecar", async () => {
    const targetPath = join(dir, "App.vue")
    writeFileSync(targetPath, "<template>V1</template>\n")

    const hook = createReadSnapshotHook({
      worktreeRoot: dir,
      snapshotRoot,
      onReadObserved: (r) => records.push(r),
    })

    await hook(preToolUseInput("Read", { file_path: "App.vue" }), "1", fakeHookOpts())

    // Something external (e.g. another session) edited the file
    // between Reads. The next Read snapshots the new content with a
    // new hash, leaving the V1 sidecar in place so a Phase 4 conflict
    // detector can still locate the prior base if it needs to.
    writeFileSync(targetPath, "<template>V2</template>\n")
    await hook(preToolUseInput("Read", { file_path: "App.vue" }), "2", fakeHookOpts())

    expect(records).toHaveLength(2)
    expect(records[0].hashAtRead).not.toBe(records[1].hashAtRead)
    expect(existsSync(records[0].baseContentPath)).toBe(true)
    expect(existsSync(records[1].baseContentPath)).toBe(true)
    expect(readFileSync(records[0].baseContentPath, "utf8")).toBe(
      "<template>V1</template>\n",
    )
    expect(readFileSync(records[1].baseContentPath, "utf8")).toBe(
      "<template>V2</template>\n",
    )
  })

  it("rejects empty / non-string file_path gracefully (no snapshot, no throw)", async () => {
    const hook = createReadSnapshotHook({
      worktreeRoot: dir,
      snapshotRoot,
      onReadObserved: (r) => records.push(r),
    })
    await hook(preToolUseInput("Read", { file_path: "" }), "x", fakeHookOpts())
    await hook(
      preToolUseInput("Read", { file_path: 42 } as unknown as Record<string, unknown>),
      "x",
      fakeHookOpts(),
    )
    await hook(preToolUseInput("Read", {}), "x", fakeHookOpts())
    expect(records).toEqual([])
  })
})

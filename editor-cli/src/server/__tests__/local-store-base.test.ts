/**
 * Tests for the shared file-IO helpers under the local artifact
 * stores. Atomic write + per-path mutex are the two correctness
 * primitives every per-store impl leans on, so they get their own
 * test file separate from the CRUD round-trip tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { promises as fs } from "node:fs"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  mutate,
  newId,
  nextNumber,
  nowIso,
  readJsonFile,
  resolveStorePath,
  writeJsonFile,
} from "../stores/local-store-base"

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "local-store-base-test-"))
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe("resolveStorePath", () => {
  it("anchors paths under <repoRoot>/.desde/", () => {
    expect(resolveStorePath("/repo", "comments.json")).toBe(
      "/repo/.desde/comments.json",
    )
    expect(resolveStorePath("/repo", "canvases", "abc", "frames.json")).toBe(
      "/repo/.desde/canvases/abc/frames.json",
    )
  })
})

describe("readJsonFile", () => {
  it("returns the fallback when the file does not exist", async () => {
    const result = await readJsonFile(path.join(tmp, "missing.json"), {
      sentinel: 1,
    })
    expect(result).toEqual({ sentinel: 1 })
  })

  it("returns the fallback when the file is empty", async () => {
    const filePath = path.join(tmp, "empty.json")
    await fs.writeFile(filePath, "", "utf8")
    const result = await readJsonFile(filePath, [])
    expect(result).toEqual([])
  })

  it("parses and returns valid JSON", async () => {
    const filePath = path.join(tmp, "data.json")
    await fs.writeFile(filePath, '{"hello":"world"}', "utf8")
    const result = await readJsonFile<{ hello: string }>(filePath, { hello: "" })
    expect(result).toEqual({ hello: "world" })
  })

  it("throws on malformed JSON (does not silently return fallback)", async () => {
    const filePath = path.join(tmp, "broken.json")
    await fs.writeFile(filePath, "{not valid", "utf8")
    await expect(readJsonFile(filePath, [])).rejects.toThrow()
  })
})

describe("writeJsonFile", () => {
  it("creates parent directories as needed", async () => {
    const filePath = path.join(tmp, "deeply", "nested", "data.json")
    await writeJsonFile(filePath, { a: 1 })
    const round = JSON.parse(await fs.readFile(filePath, "utf8"))
    expect(round).toEqual({ a: 1 })
  })

  it("leaves no temp files behind on success", async () => {
    const filePath = path.join(tmp, "clean.json")
    await writeJsonFile(filePath, [1, 2, 3])
    const entries = await fs.readdir(tmp)
    // Only the target should remain, no .tmp siblings.
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([])
  })

  it("overwrites atomically (intermediate read returns old or new, never half-written)", async () => {
    // Write a large payload, then concurrently start an overwrite
    // and a read. The read must succeed and return either the old
    // payload or the new one — never a parse error from half-written
    // content.
    const filePath = path.join(tmp, "race.json")
    const big = "x".repeat(50_000)
    await writeJsonFile(filePath, { v: 1, big })

    const writes = Promise.all([
      writeJsonFile(filePath, { v: 2, big }),
      writeJsonFile(filePath, { v: 3, big }),
      writeJsonFile(filePath, { v: 4, big }),
    ])
    const reads = await Promise.all(
      Array.from({ length: 30 }, () => readJsonFile<{ v: number; big: string }>(filePath, { v: 0, big: "" })),
    )
    await writes

    for (const r of reads) {
      expect([1, 2, 3, 4]).toContain(r.v)
    }
  })
})

describe("mutate", () => {
  it("serializes writes to the same path", async () => {
    // Without the mutex, the read-then-write race would cause some
    // increments to be lost. With it, all three end up applied.
    const filePath = path.join(tmp, "counter.json")
    await writeJsonFile(filePath, { count: 0 })

    const increment = async () => {
      await mutate(filePath, async () => {
        const cur = await readJsonFile<{ count: number }>(filePath, { count: 0 })
        await new Promise((r) => setTimeout(r, 5)) // amplify the race window
        await writeJsonFile(filePath, { count: cur.count + 1 })
      })
    }

    await Promise.all([increment(), increment(), increment(), increment(), increment()])

    const final = await readJsonFile<{ count: number }>(filePath, { count: 0 })
    expect(final.count).toBe(5)
  })

  it("allows parallel writes to different paths", async () => {
    const a = path.join(tmp, "a.json")
    const b = path.join(tmp, "b.json")

    // Trace observable order — if the mutex serialized across paths,
    // we'd see a-start, a-end, b-start, b-end (or vice versa). With
    // per-path locking, the two enters interleave.
    const trace: string[] = []
    await Promise.all([
      mutate(a, async () => {
        trace.push("a-start")
        await new Promise((r) => setTimeout(r, 30))
        trace.push("a-end")
      }),
      mutate(b, async () => {
        trace.push("b-start")
        await new Promise((r) => setTimeout(r, 30))
        trace.push("b-end")
      }),
    ])

    // Verify the two operations actually overlapped (b started before a ended).
    expect(trace.indexOf("b-start")).toBeLessThan(trace.indexOf("a-end"))
  })

  it("releases the lock even when the operation throws", async () => {
    const filePath = path.join(tmp, "throws.json")
    await expect(
      mutate(filePath, async () => {
        throw new Error("intentional")
      }),
    ).rejects.toThrow("intentional")

    // A subsequent mutate on the same path must still succeed.
    const result = await mutate(filePath, async () => "ok")
    expect(result).toBe("ok")
  })
})

describe("newId", () => {
  it("produces UUID-shaped strings", () => {
    const id = newId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it("is collision-free across many calls", () => {
    const ids = new Set<string>()
    for (let i = 0; i < 10_000; i++) ids.add(newId())
    expect(ids.size).toBe(10_000)
  })
})

describe("nowIso", () => {
  it("returns an ISO-8601 timestamp", () => {
    const t = nowIso()
    expect(() => new Date(t).toISOString()).not.toThrow()
    expect(new Date(t).toISOString()).toBe(t)
  })
})

describe("nextNumber", () => {
  it("returns 1 for an empty list", () => {
    expect(nextNumber([])).toBe(1)
  })

  it("returns max + 1 (handles gaps)", () => {
    expect(nextNumber([{ number: 1 }, { number: 5 }, { number: 3 }])).toBe(6)
  })
})

describe("DESDE_DIR placement", () => {
  it("writes JSON files inside <repoRoot>/.desde/", async () => {
    const filePath = resolveStorePath(tmp, "demo.json")
    await writeJsonFile(filePath, { ok: true })
    expect(existsSync(path.join(tmp, ".desde", "demo.json"))).toBe(true)
  })
})

/**
 * F6 (whole-branch review, Minor). `listCandidateFiles` (macho-scan.mjs)
 * pushes a SYMLINK's own path into its candidate list, and its doc comment
 * claims symlinks are "followed for classification" — but `classifyBatch`
 * ran plain `file` with no `-L`/`--dereference`, which reports "symbolic
 * link to …" for a symlink and never classifies what it points at. These
 * tests shell out to the REAL `file` binary (macOS ships it at
 * `/usr/bin/file`) against a real symlink to `/bin/ls` (a real Mach-O
 * executable on every macOS host this test runs on) — the smallest available
 * proof that the fix (`-L` added to the invocation) is what's actually being
 * exercised, not a mocked stand-in for it.
 */
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { findMachOFiles } from "../scripts/macho-scan.mjs"

describe("findMachOFiles", () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("F6: classifies a SYMLINKED Mach-O by its target, not as 'symbolic link'", async () => {
    dir = mkdtempSync(join(tmpdir(), "pt-macho-scan-"))
    symlinkSync("/bin/ls", join(dir, "ls-link"))

    const found = await findMachOFiles(dir)

    expect(found).toEqual(["ls-link"])
  })

  it("still classifies a REGULAR (non-symlink) Mach-O file — the fix must not regress the already-working case", async () => {
    dir = mkdtempSync(join(tmpdir(), "pt-macho-scan-"))
    copyFileSync("/bin/ls", join(dir, "ls-copy"))

    const found = await findMachOFiles(dir)

    expect(found).toEqual(["ls-copy"])
  })

  it("does not flag a non-Mach-O file, symlinked or not", async () => {
    dir = mkdtempSync(join(tmpdir(), "pt-macho-scan-"))
    writeFileSync(join(dir, "notes.txt"), "just some text\n")
    symlinkSync(join(dir, "notes.txt"), join(dir, "notes-link.txt"))

    const found = await findMachOFiles(dir)

    expect(found).toEqual([])
  })
})

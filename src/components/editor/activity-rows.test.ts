import { describe, expect, it } from "vitest"
import { buildActivityRows } from "./activity-rows"
import type { LedgerRow } from "@/hooks/useEditorLedger"
import type { WorkingTreeChange } from "@/hooks/useEditorBranches"

function ledgerRow(overrides: Partial<LedgerRow> & { id: string; files: string[] }): LedgerRow {
  return {
    at: "2026-08-19T00:00:00.000Z",
    kind: "prop",
    lane: "direct",
    afterHashes: {},
    description: `edited ${overrides.files[0]}`,
    committed: false,
    ...overrides,
  }
}

function change(
  path: string,
  status: WorkingTreeChange["status"] = "modified",
  from?: string,
): WorkingTreeChange {
  return from === undefined ? { path, status } : { path, status, from }
}

describe("buildActivityRows", () => {
  it("returns an empty list for an empty ledger and a clean tree", () => {
    expect(buildActivityRows([], [])).toEqual([])
  })

  // The double-count risk the design spec flagged directly: three ledger
  // entries touching the same file must yield three rows, not four — the
  // git side must contribute nothing for a path any ledger entry claims.
  it("does not double-count a file with three ledger entries", () => {
    const ledger = [
      ledgerRow({ id: "l1", files: ["src/App.vue"] }),
      ledgerRow({ id: "l2", files: ["src/App.vue"] }),
      ledgerRow({ id: "l3", files: ["src/App.vue"] }),
    ]
    const changes = [change("src/App.vue")]

    const rows = buildActivityRows(ledger, changes)

    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.source === "ledger")).toBe(true)
  })

  it("yields exactly one git row for a dirty path no ledger entry claims", () => {
    const ledger = [ledgerRow({ id: "l1", files: ["src/App.vue"] })]
    const changes = [change("src/App.vue"), change("src/Other.vue")]

    const rows = buildActivityRows(ledger, changes)

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ source: "ledger", id: "l1" })
    expect(rows[1]).toMatchObject({
      source: "git",
      path: "src/Other.vue",
      status: "modified",
    })
  })

  // A rename claims BOTH its `from` and its `path` — otherwise the old path
  // shows up as an unexplained change alongside the ledger row that caused
  // the rename.
  it("a renamed path claims both its from and its path", () => {
    const ledger = [
      ledgerRow({ id: "l1", files: ["src/New.vue", "src/Old.vue"] }),
    ]
    const changes = [change("src/New.vue", "renamed", "src/Old.vue")]

    const rows = buildActivityRows(ledger, changes)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: "ledger", id: "l1" })
  })

  // `WorkingTreeChange` is ONE entry per rename, keyed by its current
  // `path`, with `from` naming where it came from. A ledger entry might
  // only have recorded the PRE-rename name (e.g. an edit made to the file
  // before something outside the editor renamed it) — that still has to
  // claim the rename, or the same event would resurface as a second,
  // unexplained git row for a rename the ledger row already accounts for.
  it("claims a rename when the ledger names only its pre-rename path", () => {
    const ledger = [ledgerRow({ id: "l1", files: ["src/Old.vue"] })]
    const changes = [change("src/New.vue", "renamed", "src/Old.vue")]

    const rows = buildActivityRows(ledger, changes)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ source: "ledger", id: "l1" })
  })

  it("does not claim a rename when neither name is in the ledger", () => {
    const ledger = [ledgerRow({ id: "l1", files: ["src/Unrelated.vue"] })]
    const changes = [change("src/New.vue", "renamed", "src/Old.vue")]

    const rows = buildActivityRows(ledger, changes)

    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({
      source: "git",
      path: "src/New.vue",
      from: "src/Old.vue",
      status: "renamed",
    })
  })

  it("orders ledger rows newest-first (as given) with unclaimed git rows after", () => {
    const ledger = [
      ledgerRow({ id: "newest", files: ["a.ts"] }),
      ledgerRow({ id: "oldest", files: ["b.ts"] }),
    ]
    const changes = [change("a.ts"), change("b.ts"), change("c.ts"), change("d.ts")]

    const rows = buildActivityRows(ledger, changes)

    expect(rows.map((r) => r.id)).toEqual(["newest", "oldest", "c.ts", "d.ts"])
    expect(rows[0].source).toBe("ledger")
    expect(rows[1].source).toBe("ledger")
    expect(rows[2].source).toBe("git")
    expect(rows[3].source).toBe("git")
  })

  // P2-1 (codex review finding, 2026-08-20): a committed row is a past
  // fact. It must not hide a path that is dirty again right now — the
  // scenario is an Editor edit that gets committed, then the SAME file
  // is edited again outside the editor (an IDE, say).
  it("does not let a committed entry hide a fresh dirty path", () => {
    const ledger = [
      ledgerRow({ id: "l1", files: ["src/App.vue"], committed: true }),
    ]
    const changes = [change("src/App.vue")]

    const rows = buildActivityRows(ledger, changes)

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ source: "ledger", id: "l1" })
    expect(rows[1]).toMatchObject({ source: "git", path: "src/App.vue" })
  })

  it("still claims a path when an uncommitted entry names it, even alongside a committed one for the same path", () => {
    const ledger = [
      ledgerRow({ id: "l1", files: ["src/App.vue"], committed: true }),
      ledgerRow({ id: "l2", files: ["src/App.vue"], committed: false }),
    ]
    const changes = [change("src/App.vue")]

    const rows = buildActivityRows(ledger, changes)

    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.source === "ledger")).toBe(true)
  })

  it("gives each git row a stable id derived from its path", () => {
    const rows = buildActivityRows([], [change("src/App.vue")])
    expect(rows).toEqual([
      { source: "git", id: "src/App.vue", path: "src/App.vue", status: "modified" },
    ])
  })

  // F3 (codex review round 8, 2026-08-20): `ledgerAvailable` distinguishes
  // "the ledger was read and this path has no entry" (the default, every
  // test above) from "the ledger couldn't be read at all when this list
  // was built." The second case must not produce the same plain git row
  // the first one does — a caller reading `ledgerUnavailable` off the row
  // is how `ActivityRow` avoids asserting a change is external when it
  // simply doesn't know yet.
  describe("ledgerAvailable = false", () => {
    it("marks every unclaimed git row as ledger-unavailable instead of confirmed external", () => {
      const rows = buildActivityRows([], [change("src/App.vue")], false)
      expect(rows).toEqual([
        {
          source: "git",
          id: "src/App.vue",
          path: "src/App.vue",
          status: "modified",
          ledgerUnavailable: true,
        },
      ])
    })

    it("defaults to ledgerAvailable = true when the third argument is omitted", () => {
      // Same call as the "stable id" test above, just re-asserting the
      // default explicitly so a future signature change can't quietly
      // flip it without a test noticing.
      const rows = buildActivityRows([], [change("src/App.vue")])
      expect(rows[0]).not.toHaveProperty("ledgerUnavailable")
    })

    it("still lets a real ledger entry claim its path even while ledgerAvailable is false", () => {
      // A ledger entry present (however briefly, e.g. mid-transition) is
      // real data, regardless of the availability flag on THIS call — the
      // flag only governs what an UNCLAIMED path gets labeled.
      const ledger = [ledgerRow({ id: "l1", files: ["src/App.vue"] })]
      const rows = buildActivityRows(ledger, [change("src/App.vue")], false)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ source: "ledger", id: "l1" })
    })
  })
})

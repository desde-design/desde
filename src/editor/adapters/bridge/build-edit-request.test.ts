/**
 * Colocated tests for `buildEditRequest` — the shell-side mapping from a
 * neutral `StructuralEdit` to the wire body POSTed to `/api/editor/edit`.
 *
 * Focus: the stale-target stamp (`data-desde-v` → `baseHash`). Audit Task 23
 * widened the server's guard from prop/move to every coordinate-matched
 * kind, which only bites if the SHELL actually captures the stamp — a server
 * guard with no client capture is inert. These pin the capture per kind, and
 * pin that the stamp always comes from the SAME location the coordinates did.
 */

import { describe, expect, it } from "vitest"
import { buildEditRequest } from "./build-edit-request"
import type { StructuralEdit } from "../../core"

const FILE = "src/Demo.vue"
const HASH = "a1b2c3d4e5f6"

/** Source location WITH a data-desde-v stamp (what a stamped substrate sends). */
const stamped = { file: FILE, line: 4, column: 6, fileHash: HASH }
/** Same location with no stamp (substrate whose plugin doesn't emit data-desde-v). */
const unstamped = { file: FILE, line: 4, column: 6 }

function target(loc: { file: string; line: number; column: number; fileHash?: string }) {
  return {
    targetId: "btn",
    selector: "button",
    componentName: "KButton",
    authoredAt: loc,
    editTarget: loc,
  }
}

/** The `edit` sub-object of a successfully-built request. */
function editBodyOf(edit: StructuralEdit): Record<string, unknown> {
  const built = buildEditRequest(edit)
  expect(built.ok).toBe(true)
  if (!built.ok) throw new Error("expected buildEditRequest to succeed")
  return built.requestBody.edit as Record<string, unknown>
}

/** The FULL request body — used by the correlationId tests below, which
 *  need to see a sibling of `edit`, not `edit` itself. */
function requestBodyOf(edit: StructuralEdit): Record<string, unknown> {
  const built = buildEditRequest(edit)
  expect(built.ok).toBe(true)
  if (!built.ok) throw new Error("expected buildEditRequest to succeed")
  return built.requestBody
}

/**
 * Every coordinate-matched kind that carries the stamp, as (name → edit
 * factory). `loc` is spliced in so each case can be run twice: stamped and
 * unstamped. Hoisted to module scope so the correlationId describe block
 * below can reuse the same fixtures rather than re-deriving them.
 */
const KINDS: Array<{
  name: string
  make: (loc: typeof stamped | typeof unstamped) => StructuralEdit
}> = [
  {
    name: "prop",
    make: (loc) =>
      ({
        kind: "prop",
        id: "e1",
        target: target(loc),
        propName: "variant",
        value: "danger",
      }) as unknown as StructuralEdit,
  },
  {
    name: "delete",
    make: (loc) =>
      ({ kind: "delete", id: "e2", target: target(loc) }) as unknown as StructuralEdit,
  },
  {
    name: "unwrap",
    make: (loc) =>
      ({ kind: "unwrap", id: "e3", target: target(loc) }) as unknown as StructuralEdit,
  },
  {
    name: "flatten-conditional",
    make: (loc) =>
      ({
        kind: "flatten-conditional",
        id: "e4",
        target: target(loc),
        branchToKeep: 0,
      }) as unknown as StructuralEdit,
  },
  {
    name: "detach",
    make: (loc) =>
      ({
        kind: "detach",
        id: "e5",
        target: { ...target(loc), componentName: "KButton" },
        componentFile: "src/KButton.vue",
      }) as unknown as StructuralEdit,
  },
  {
    name: "swap",
    make: (loc) =>
      ({
        kind: "swap",
        id: "e6",
        target: target(loc),
        fromComponentName: "KButton",
        toComponentName: "KExternalLink",
      }) as unknown as StructuralEdit,
  },
]

describe("buildEditRequest — stale-target stamp capture", () => {
  for (const { name, make } of KINDS) {
    it(`${name}: carries baseHash when the substrate stamped data-desde-v`, () => {
      expect(editBodyOf(make(stamped)).baseHash).toBe(HASH)
    })

    it(`${name}: OMITS baseHash entirely when unstamped (guard stays opt-in)`, () => {
      const body = editBodyOf(make(unstamped))
      // Omitted, not `undefined` — the validator rejects a present-but-empty
      // baseHash, and JSON.stringify would drop an undefined anyway.
      expect("baseHash" in body).toBe(false)
    })
  }

  it("move: carries both the source and destination stamps", () => {
    const destLoc = { file: FILE, line: 1, column: 1, fileHash: HASH }
    const body = editBodyOf({
      kind: "move",
      id: "e7",
      target: target(stamped),
      destination: { parentEditTarget: destLoc, index: 0 },
    } as unknown as StructuralEdit)
    expect(body.baseHash).toBe(HASH)
    expect(body.destBaseHash).toBe(HASH)
  })
})

/**
 * `correlationId` is the single line (`return { ok: true, requestBody: {
 * ...requestBody, correlationId: edit.id } }`, set unconditionally after
 * every kind's own branching) that makes the Activity panel's verification
 * pill and destructive-row tint reachable at all (Task 4b — see
 * `activity-panel.tsx`'s module doc comment on "the verification join
 * key"). Nothing else in this file's `toMatchObject` assertions looks at
 * it, so a regression here shipped past 119 green tests across six files
 * before this block existed. These assert the field directly, on the same
 * fixtures the stamp-capture block above already built, so a future
 * refactor of that chokepoint cannot drop it without turning this red.
 */
describe("buildEditRequest — correlationId join key", () => {
  for (const { name, make } of KINDS) {
    it(`${name}: request body's correlationId is the edit's own id`, () => {
      const edit = make(stamped)
      expect(requestBodyOf(edit).correlationId).toBe(edit.id)
    })
  }

  it("move: request body's correlationId is the edit's own id", () => {
    const destLoc = { file: FILE, line: 1, column: 1, fileHash: HASH }
    const edit = {
      kind: "move",
      id: "e7-corr",
      target: target(stamped),
      destination: { parentEditTarget: destLoc, index: 0 },
    } as unknown as StructuralEdit
    expect(requestBodyOf(edit).correlationId).toBe(edit.id)
  })
})

describe("buildEditRequest — delete scope picks the matching stamp", () => {
  /**
   * A delete rewrites `authoredAt` for 'definition' scope and `editTarget` for
   * 'callsite'. The stamp MUST come from whichever location supplied the
   * coordinates — pairing a stamp with a different file's coordinates would
   * make the server compare the wrong file and either 409 a valid edit or, far
   * worse, pass a stale one.
   */
  const authoredAt = {
    file: "src/Child.vue",
    line: 2,
    column: 3,
    fileHash: "definitionhash",
  }
  const editTarget = {
    file: "src/Parent.vue",
    line: 9,
    column: 4,
    fileHash: "callsitehash1",
  }
  const splitTarget = {
    targetId: "btn",
    selector: "button",
    componentName: "KButton",
    authoredAt,
    editTarget,
  }

  it("callsite scope sends editTarget's file AND editTarget's hash", () => {
    const body = editBodyOf({
      kind: "delete",
      id: "d1",
      target: splitTarget,
      scope: "callsite",
    } as unknown as StructuralEdit)
    expect(body.file).toBe("src/Parent.vue")
    expect(body.baseHash).toBe("callsitehash1")
  })

  it("definition scope sends authoredAt's file AND authoredAt's hash", () => {
    const body = editBodyOf({
      kind: "delete",
      id: "d2",
      target: splitTarget,
      scope: "definition",
    } as unknown as StructuralEdit)
    expect(body.file).toBe("src/Child.vue")
    expect(body.baseHash).toBe("definitionhash")
  })

  it("definition scope omits baseHash when authoredAt has no stamp", () => {
    // The bridge stamps `fileHash` on `editTarget` only today, so this is the
    // live shape for a definition-scoped delete: coordinates without a stamp.
    // It must NOT borrow editTarget's hash — that would guard the wrong file.
    const body = editBodyOf({
      kind: "delete",
      id: "d3",
      target: {
        ...splitTarget,
        authoredAt: { file: "src/Child.vue", line: 2, column: 3 },
      },
      scope: "definition",
    } as unknown as StructuralEdit)
    expect(body.file).toBe("src/Child.vue")
    expect("baseHash" in body).toBe(false)
  })
})

/**
 * The scoped-css-override wire body carries TWO coordinates, and the whole
 * point is that they are allowed to disagree.
 *
 * `file`/`line`/`column` is the DESTINATION — the only path the handler
 * resolves, so every traversal/symlink/root guard applies to it unchanged.
 * `anchorFile`/`anchorLine`/`anchorColumn` is what the rule HEAD names, read
 * off the rendered DOM. On Vue they coincide (an SFC holds both the callsite
 * and the stylesheet); on React the rule lives in a `.css` and names a `.tsx`.
 * Collapsing them is what let the shipped lane anchor on a coordinate no
 * element carried — see `tasks/dev-server-hosts.md` § 9g.8.
 */
describe("buildEditRequest — scoped-css-override anchor vs destination", () => {
  it("emits the anchor separately from the destination file", () => {
    const body = editBodyOf({
      kind: "scoped-css-override",
      id: "s1",
      target: {
        targetId: ".MuiAlert-message",
        selector: ".MuiAlert-message",
        editTarget: { file: "src/index.css", line: 33, column: 46 },
      },
      anchor: { file: "src/App.tsx", line: 33, column: 46 },
      deepSelector: ".MuiAlert-message",
      declarations: { "padding-left": "41px" },
    } as unknown as StructuralEdit)
    expect(body.file).toBe("src/index.css")
    expect(body.anchorFile).toBe("src/App.tsx")
    expect(body.anchorLine).toBe(33)
    expect(body.anchorColumn).toBe(46)
  })

  it("forwards the anchor's content version when the stamper emitted one", () => {
    const body = editBodyOf({
      kind: "scoped-css-override",
      id: "s2",
      target: {
        targetId: ".x",
        selector: ".x",
        editTarget: { file: "src/index.css", line: 1, column: 1 },
      },
      anchor: { file: "src/App.tsx", line: 1, column: 1, version: "abc123" },
      declarations: { color: "red" },
    } as unknown as StructuralEdit)
    expect(body.anchorVersion).toBe("abc123")
  })

  it("refuses to build a request with no anchor at all", () => {
    // Without one there is nothing to put in the rule head, and the rule
    // would match nothing — refuse at the boundary rather than write bytes.
    const result = buildEditRequest({
      kind: "scoped-css-override",
      id: "s3",
      target: {
        targetId: ".x",
        selector: ".x",
        editTarget: { file: "src/index.css", line: 1, column: 1 },
      },
      declarations: { color: "red" },
    } as unknown as StructuralEdit)
    expect(result.ok).toBe(false)
  })
})

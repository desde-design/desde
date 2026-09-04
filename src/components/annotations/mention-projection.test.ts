/**
 * The display/storage translation under `MentionInput`.
 *
 * The table cases pin the shapes a writer actually produces. The property
 * tests at the bottom are the ones that matter: they assert the two
 * invariants the whole design rests on, over randomly generated edit
 * sequences, because hand-written cases cannot cover a diff.
 */

import { describe, expect, it } from "vitest"
import {
  displayToStorage,
  isInsideMention,
  project,
  projectWithMap,
  reconcile,
} from "./mention-projection"
import { MENTION_PATTERN, encodeMention, extractMentionIds } from "./mention-encoding"

const ANA = encodeMention("Ana Whitfield", "p_ana")
const SAM = encodeMention("Sam Okafor", "p_sam")

describe("project", () => {
  it("shows the name and hides the id", () => {
    expect(project(`over to ${ANA} does this work?`)).toBe("over to @Ana Whitfield does this work?")
  })

  it("leaves text with no mentions exactly alone", () => {
    expect(project("just a plain comment")).toBe("just a plain comment")
  })

  it("handles several mentions, including back to back", () => {
    expect(project(`${ANA}${SAM} hi`)).toBe("@Ana Whitfield@Sam Okafor hi")
  })

  it("locates each mention in both coordinate systems", () => {
    const { display, mentions } = projectWithMap(`hi ${ANA}!`)
    expect(display).toBe("hi @Ana Whitfield!")
    expect(mentions).toHaveLength(1)
    const [m] = mentions
    expect(display.slice(m.displayStart, m.displayEnd)).toBe("@Ana Whitfield")
    expect(`hi ${ANA}!`.slice(m.storageStart, m.storageEnd)).toBe(ANA)
    expect(m.id).toBe("p_ana")
  })
})

describe("reconcile: ordinary typing", () => {
  it("appends after a mention and keeps it", () => {
    const prev = `over to ${ANA}`
    const next = reconcile(prev, "over to @Ana Whitfield please")
    expect(next).toBe(`over to ${ANA} please`)
    expect(extractMentionIds(next)).toEqual(["p_ana"])
  })

  it("types before a mention and keeps it", () => {
    const prev = `${ANA} hi`
    const next = reconcile(prev, "hey @Ana Whitfield hi")
    expect(next).toBe(`hey ${ANA} hi`)
  })

  // Half-open ranges: an edit exactly at a boundary does not intersect the
  // mention. Typing a character right after a name must not destroy it.
  it("keeps the mention when a character lands flush against its end", () => {
    const prev = `${ANA}`
    const next = reconcile(prev, "@Ana Whitfield!")
    expect(next).toBe(`${ANA}!`)
    expect(extractMentionIds(next)).toEqual(["p_ana"])
  })

  it("keeps other mentions when one is edited", () => {
    const prev = `${ANA} and ${SAM}`
    const next = reconcile(prev, "@Ana Whitfiel and @Sam Okafor")
    expect(extractMentionIds(next)).toEqual(["p_sam"])
    expect(project(next)).toBe("@Ana Whitfiel and @Sam Okafor")
  })
})

describe("reconcile: editing a mention drops it", () => {
  it("backspacing the last letter degrades it to plain text", () => {
    const next = reconcile(`${ANA}`, "@Ana Whitfiel")
    expect(next).toBe("@Ana Whitfiel")
    expect(extractMentionIds(next)).toEqual([])
  })

  it("typing inside the name degrades it", () => {
    const next = reconcile(`${ANA}`, "@Ana WhitXfield")
    expect(next).toBe("@Ana WhitXfield")
    expect(extractMentionIds(next)).toEqual([])
  })

  // The degraded form is exactly the characters that were already on screen.
  // That is what keeps React's write-back a no-op, so the caret is never
  // touched on an ordinary keystroke.
  it("degrades display-neutrally", () => {
    const nextDisplay = "@Ana Whitfiel"
    expect(project(reconcile(`${ANA}`, nextDisplay))).toBe(nextDisplay)
  })

  it("splits a mention edited in the middle into plain text either side", () => {
    const next = reconcile(`${ANA}`, "@Ana XX Whitfield")
    expect(next).toBe("@Ana XX Whitfield")
    expect(extractMentionIds(next)).toEqual([])
  })

  it("select-all-and-retype clears every id", () => {
    const next = reconcile(`${ANA} and ${SAM}`, "start over")
    expect(next).toBe("start over")
    expect(extractMentionIds(next)).toEqual([])
  })

  it("deleting the whole field leaves nothing", () => {
    expect(reconcile(`${ANA}`, "")).toBe("")
  })
})

describe("reconcile: paste", () => {
  it("pastes over part of one mention and leaves the others", () => {
    const prev = `${ANA} and ${SAM}`
    const next = reconcile(prev, "@Ana WPASTEDeld and @Sam Okafor")
    expect(extractMentionIds(next)).toEqual(["p_sam"])
  })

  // The one documented way an id can appear that was not in `prev`. It is
  // what the field already did before there was a projection, and the server
  // still refuses an id that is not a participant of this prototype.
  it("turns pasted token-shaped text into a live mention", () => {
    const next = reconcile("hi ", `hi ${ANA}`)
    expect(extractMentionIds(next)).toEqual(["p_ana"])
    expect(project(next)).toBe("hi @Ana Whitfield")
  })
})

// Every one of these shipped green under a character-level prefix/suffix diff
// and was found by adversarial review. They are the reason the alignment works
// over whole mentions, tail first.
describe("regressions: an ambiguous deletion must not move an id", () => {
  it("deleting the first mention leaves the second one live", () => {
    const storage = `${encodeMention("Sam", "p_sam")} ${encodeMention("Rin", "p_rin")}`
    expect(project(storage)).toBe("@Sam @Rin")
    // A one-character `@` prefix used to match, cutting through BOTH tokens
    // and leaving a bare `@Rin` with no id: the person still on screen was
    // never notified.
    const next = reconcile(storage, "@Rin")
    expect(extractMentionIds(next)).toEqual(["p_rin"])
    expect(project(next)).toBe("@Rin")
  })

  it("deleting the second mention leaves the first one live", () => {
    const storage = `${encodeMention("Sam", "p_sam")} ${encodeMention("Rin", "p_rin")}`
    const next = reconcile(storage, "@Sam")
    expect(extractMentionIds(next)).toEqual(["p_sam"])
  })

  // The worst of the set: the surviving text said Annabel and the surviving id
  // was Ann's, so the wrong person would have been mailed.
  it("keeps the right person when one name is a prefix of the other", () => {
    const storage = `${encodeMention("Ann", "p_ann")} ${encodeMention("Annabel", "p_annabel")}`
    expect(extractMentionIds(reconcile(storage, "@Annabel"))).toEqual(["p_annabel"])
    expect(extractMentionIds(reconcile(storage, "@Ann"))).toEqual(["p_ann"])
  })

  it("keeps a mention when the text around it aliases", () => {
    const storage = `x${encodeMention("Ana", "p_ana")}x`
    expect(extractMentionIds(reconcile(storage, "x@Anax"))).toEqual(["p_ana"])
    expect(extractMentionIds(reconcile(storage, "@Anax"))).toEqual(["p_ana"])
  })

  // Undecidable by construction: the string is identical either way. The tail
  // bias makes it deterministic, and the survivor is still a person of that
  // name. Pinned so the behaviour is a decision rather than an accident.
  it("is deterministic, not correct, when two people share a name", () => {
    const storage = `${encodeMention("Ana", "p1")} ${encodeMention("Ana", "p2")}`
    expect(extractMentionIds(reconcile(storage, "@Ana"))).toEqual(["p2"])
  })
})

// A known limit, pinned so it stays a decision. Raised in review with a
// suggestion to consult the caret, which the module refuses on purpose.
describe("what an alignment without a caret cannot know", () => {
  it("keeps a mention when an in-name edit is indistinguishable from an append", () => {
    const storage = encodeMention("Ana", "p_ana")
    // Doubling the last letter reads the same either way, and the appending
    // case has to keep the mention: `@Ana,` and `@Ana's` are ordinary.
    const next = reconcile(storage, "@Anaa")
    expect(project(next)).toBe("@Anaa")
    expect(extractMentionIds(next)).toEqual(["p_ana"])
  })

  // The flush-append side of the same ambiguity, which is the common one and
  // the reason the trade goes this way.
  it("keeps a mention when punctuation lands straight after it", () => {
    const storage = encodeMention("Ana", "p_ana")
    expect(extractMentionIds(reconcile(storage, "@Ana, thanks"))).toEqual(["p_ana"])
    expect(extractMentionIds(reconcile(storage, "@Ana's idea"))).toEqual(["p_ana"])
  })

  // Degrading is one-way: a mention edited into never comes back, because
  // re-attaching a bare name to a directory id is the module's permanent no.
  it("does not restore a mention when the edit that dropped it is undone", () => {
    const storage = encodeMention("Ana", "p_ana")
    const typo = reconcile(storage, "@Anaa")
    expect(extractMentionIds(reconcile(typo, "@Ana"))).toEqual([])
  })
})

// A literal `@[` used to start a match that ran through the NEXT real mention,
// swallowing `@[Name` as part of its own name and stealing its id. The field
// then rewrote characters the writer had typed and threw the caret to the end.
describe("regressions: a stray bracket cannot hijack the next mention", () => {
  it("projects an unclosed @[ as the literal text it is", () => {
    const storage = `@[design review ${encodeMention("Bo", "p_bo")} `
    expect(project(storage)).toBe("@[design review @Bo ")
    expect(extractMentionIds(storage)).toEqual(["p_bo"])
  })

  it("keeps a typed [ where the writer put it", () => {
    const storage = `x${encodeMention("Bo", "p_bo")} `
    const next = reconcile(storage, "x@[@Bo ")
    expect(project(next)).toBe("x@[@Bo ")
    expect(extractMentionIds(next)).toEqual(["p_bo"])
  })

  it("still matches a closed bracketed aside before a mention", () => {
    const storage = `@[see thread] then ${encodeMention("Bo", "p_bo")}`
    expect(project(storage)).toBe("@[see thread] then @Bo")
  })
})

describe("displayToStorage", () => {
  it("maps an offset in literal text", () => {
    const storage = `hi ${ANA} there`
    expect(displayToStorage(storage, 0)).toBe(0)
    expect(displayToStorage(storage, 2)).toBe(2)
    // Just past the mention in display space is just past the token in storage.
    expect(displayToStorage(storage, "hi @Ana Whitfield".length)).toBe(`hi ${ANA}`.length)
  })

  it("clamps outside the string", () => {
    const storage = `hi ${ANA}`
    expect(displayToStorage(storage, -5)).toBe(0)
    expect(displayToStorage(storage, 999)).toBe(storage.length)
  })

  it("snaps an offset stranded inside a mention to the chosen edge", () => {
    const storage = `${ANA}`
    expect(displayToStorage(storage, 4, "start")).toBe(0)
    expect(displayToStorage(storage, 4, "end")).toBe(ANA.length)
  })
})

describe("isInsideMention", () => {
  it("covers the @ through the last letter, but not the offset past it", () => {
    const { mentions } = projectWithMap(`${ANA} x`)
    expect(isInsideMention(mentions, 0)).toBe(true)
    expect(isInsideMention(mentions, 5)).toBe(true)
    expect(isInsideMention(mentions, "@Ana Whitfield".length)).toBe(false)
  })
})

// ── The invariants ────────────────────────────────────────────────────────
//
// A diff cannot be covered by hand-written cases. These run random edit
// sequences and assert the two properties the design rests on.

/** Deterministic PRNG, so a failure is reproducible from its seed. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

const PEOPLE = [
  ["Ana Whitfield", "p_ana"],
  ["Sam Okafor", "p_sam"],
  ["Mo Chang", "p_mo"],
]

/**
 * The alphabet includes the token's own punctuation.
 *
 * It did not, and that is exactly how a real defect shipped green: a stray
 * `@[` in the body hijacked the following mention's token, and no generated
 * edit could ever produce one. A fuzzer that cannot type the characters the
 * format is built from is not fuzzing the format.
 */
const EDIT_ALPHABET = "abc XY.@[]()"

/** True when the string carries token syntax, which is the one documented
 *  exception to the projection invariant (pasted `@[Name](id)` becomes live). */
function looksLikeToken(text: string): boolean {
  return new RegExp(MENTION_PATTERN).test(text)
}

function randomEdit(display: string, rand: () => number): string {
  const at = Math.floor(rand() * (display.length + 1))
  const kind = rand()
  if (kind < 0.45) {
    const ch = EDIT_ALPHABET.charAt(Math.floor(rand() * EDIT_ALPHABET.length))
    return display.slice(0, at) + ch + display.slice(at)
  }
  if (kind < 0.8) {
    const len = 1 + Math.floor(rand() * 5)
    return display.slice(0, at) + display.slice(at + len)
  }
  if (kind < 0.92) {
    const len = 1 + Math.floor(rand() * 8)
    return display.slice(0, at) + "PASTED" + display.slice(at + len)
  }
  return ""
}

/**
 * Edits drawn FROM the text itself, rather than from a fixed alphabet.
 *
 * This is what actually stresses a common-prefix / common-suffix diff: when
 * the inserted character equals its neighbour, the boundary is ambiguous and
 * the diff picks the SMALLEST changed span, which is the direction that keeps
 * more mentions alive. That is the dangerous direction, so it needs the
 * nastiest generator, not the friendliest.
 */
function ambiguousEdit(display: string, rand: () => number): string {
  const at = Math.floor(rand() * (display.length + 1))
  const kind = rand()
  const pick = () => (display.length ? display.charAt(Math.floor(rand() * display.length)) : "a")
  if (kind < 0.35) return display.slice(0, at) + pick() + display.slice(at)
  if (kind < 0.55) return display.slice(0, at) + pick() + pick() + display.slice(at)
  if (kind < 0.85) return display.slice(0, at) + display.slice(at + 1 + Math.floor(rand() * 4))
  return display.slice(0, at) + pick() + display.slice(at + 1 + Math.floor(rand() * 3))
}

/** Shapes chosen because each one makes the diff boundary ambiguous. */
const AMBIGUOUS_SHAPES: Array<[string, string]> = [
  ["two mentions with nothing between them", `${encodeMention("Ann", "p1")}${encodeMention("Anna", "p2")}`],
  ["one name a prefix of the other", `${encodeMention("Ann", "p1")} x ${encodeMention("Annabel", "p2")}`],
  ["runs of the same letter either side", `${encodeMention("aaa", "p1")}aaa${encodeMention("aa", "p2")}`],
  ["single-character names", `${encodeMention("a", "p1")}a${encodeMention("a", "p2")}`],
  ["a stray bracket beside a mention", `@[note ${encodeMention("Ana", "p1")} ]x`],
  ["two different people with the same name", `${encodeMention("Ana", "p1")} and ${encodeMention("Ana", "p2")}`],
]

describe("invariants under an ambiguous diff", () => {
  for (const [label, seedText] of AMBIGUOUS_SHAPES) {
    it(label, () => {
      for (let seed = 1; seed <= 400; seed++) {
        const rand = rng(seed)
        let storage = seedText
        const pickedNames = new Map(projectWithMap(seedText).mentions.map((m) => [m.id, m.name]))
        for (let step = 0; step < 10; step++) {
          const before = extractMentionIds(storage)
          const nextDisplay = ambiguousEdit(project(storage), rand)
          const next = reconcile(storage, nextDisplay)
          const where = `${label} seed ${seed} step ${step} ${JSON.stringify({ storage, nextDisplay, next })}`
          if (looksLikeToken(nextDisplay)) { storage = next; continue }
          expect(project(next), `projection ${where}`).toBe(nextDisplay)
          expect(
            extractMentionIds(next).every((id) => before.includes(id)),
            `no invented id ${where}`,
          ).toBe(true)
          for (const m of projectWithMap(next).mentions) {
            expect(m.name, `name still its own ${where}`).toBe(pickedNames.get(m.id))
          }
          storage = next
        }
      }
    })
  }
})

describe("invariants over random edit sequences", () => {
  it("the projection of a reconciled edit is the display the browser produced", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed)
      let storage = `hey ${encodeMention(PEOPLE[0][0], PEOPLE[0][1])} and ${encodeMention(PEOPLE[1][0], PEOPLE[1][1])} ok`
      for (let step = 0; step < 12; step++) {
        const display = project(storage)
        const nextDisplay = randomEdit(display, rand)
        const nextStorage = reconcile(storage, nextDisplay)
        // Token-shaped text is the documented exception: it becomes a live
        // mention, so the projection legitimately differs from what was typed.
        if (!looksLikeToken(nextDisplay)) {
          expect(
            project(nextStorage),
            `seed ${seed} step ${step}: ${JSON.stringify({ storage, nextDisplay, nextStorage })}`,
          ).toBe(nextDisplay)
        }
        storage = nextStorage
      }
    }
  })

  // The wrong-person property, stated as one line: editing can only ever
  // REMOVE ids. It can never introduce one, and it can never move one onto
  // text it did not come from.
  it("never introduces an id that was not already there", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed)
      let storage = PEOPLE.map(([n, id]) => encodeMention(n, id)).join(" x ")
      for (let step = 0; step < 12; step++) {
        const before = extractMentionIds(storage)
        const nextDisplay = randomEdit(project(storage), rand)
        const nextStorage = reconcile(storage, nextDisplay)
        const after = extractMentionIds(nextStorage)
        if (!looksLikeToken(nextDisplay)) {
          expect(
            after.every((id) => before.includes(id)),
            `seed ${seed} step ${step}: ${JSON.stringify({ before, after, nextStorage })}`,
          ).toBe(true)
        }
        storage = nextStorage
      }
    }
  })

  // A surviving token still renders as the name it was picked with. This is
  // what stops a diff from leaving `@[Ana Whit](id)` in the body, which
  // MentionText would render as a mention of a person who does not exist.
  it("every surviving mention still shows the name it was picked with", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed)
      let storage = `${encodeMention("Ana Whitfield", "p_ana")} and ${encodeMention("Sam Okafor", "p_sam")}`
      const known = new Map(PEOPLE.map(([n, id]) => [id, n]))
      for (let step = 0; step < 12; step++) {
        const nextDisplay = randomEdit(project(storage), rand)
        storage = reconcile(storage, nextDisplay)
        if (looksLikeToken(nextDisplay)) break
        for (const m of projectWithMap(storage).mentions) {
          expect(m.name, `seed ${seed} step ${step}`).toBe(known.get(m.id))
        }
      }
    }
  })
})

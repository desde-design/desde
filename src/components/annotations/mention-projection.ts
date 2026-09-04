/**
 * The two coordinate systems a mention composer lives in, and the pure
 * functions that move between them.
 *
 * STORAGE is what `value` holds and what gets sent: `over to @[Ana
 * Whitfield](7f9b83f8-…) does this work?`. It is what `extractMentionIds`
 * reads, what the server notifies from, and what `MentionText` renders.
 *
 * DISPLAY is what the writer sees while composing: `over to @Ana Whitfield
 * does this work?`. Before this existed, the two were the same string, so a
 * 36-character UUID sat in the middle of the sentence being written. The
 * textarea also carries `field-sizing-content`, so the token did not merely
 * read badly, it grew the box by a line or two per mention.
 *
 * ## Why storage stays the source of truth
 *
 * The obvious alternative is to put display text in the field and keep the
 * ids in a side registry, encoded at submit. This component HAD that design.
 * It was dead code, and it would fail silently now: all three submitting call
 * sites (`annotation-card.tsx`, `comment-thread-popup.tsx`, and
 * `review-shell.tsx`'s `NewCommentCard`) pass the field's value straight
 * through as the message body. A parent that forgot to encode would ship a
 * plain string that notifies nobody, with no type error and no failing test.
 * That is the exact failure class this component was fixed for a commit ago.
 *
 * So `value` keeps carrying storage, every parent is untouched, and the
 * translation lives here where it can be unit-tested as pure string maths.
 *
 * ## The property that matters
 *
 * `reconcile` may DROP a mention, never invent or re-point one:
 * `extractMentionIds(reconcile(prev, …))` is always a subset of
 * `extractMentionIds(prev)`, with one stated exception (see `reconcile`).
 * That is the machine-checkable form of "this can never notify somebody the
 * writer did not pick", which is worse than notifying nobody.
 *
 * ## The permanent no
 *
 * Never re-attach a bare `@Name` run to a directory id by matching the name.
 * It is the obvious-looking fix for native undo and for pasting between
 * composers, and it is the one change here that can mail a person the writer
 * never chose: participants are keyed on email, `displayName` is updated in
 * place, and two people can share one. Losing an id fails toward no
 * notification. Guessing one fails toward the wrong human.
 */

import { MENTION_PATTERN } from "@/components/annotations/mention-encoding"

/** One resolved mention, located in both coordinate systems. */
export interface MentionSpan {
  id: string
  name: string
  storageStart: number
  storageEnd: number
  displayStart: number
  displayEnd: number
}

export interface Projection {
  /** What the textarea renders. */
  display: string
  /** Every live mention in `display`, in order. */
  mentions: MentionSpan[]
}

type Segment =
  | { kind: "literal"; storage: string; display: string; displayStart: number; displayEnd: number }
  | { kind: "mention"; storage: string; display: string; displayStart: number; displayEnd: number }

/**
 * Splits storage into literal runs and mention tokens, stamped with their
 * display extents. A mention's `display` is exactly `"@" + name`, which is
 * what makes a partly-edited mention degrade to the characters that were
 * already on screen (see `reconcile`).
 */
function segmentize(storage: string): { segments: Segment[]; projection: Projection } {
  const segments: Segment[] = []
  const mentions: MentionSpan[] = []
  let display = ""
  let last = 0
  // A fresh instance: the shared pattern is global, so reusing it would carry
  // `lastIndex` between calls.
  const re = new RegExp(MENTION_PATTERN)
  let match: RegExpExecArray | null

  const pushLiteral = (text: string) => {
    if (!text) return
    segments.push({
      kind: "literal",
      storage: text,
      display: text,
      displayStart: display.length,
      displayEnd: display.length + text.length,
    })
    display += text
  }

  while ((match = re.exec(storage)) !== null) {
    pushLiteral(storage.slice(last, match.index))
    const shown = `@${match[1]}`
    const displayStart = display.length
    segments.push({
      kind: "mention",
      storage: match[0],
      display: shown,
      displayStart,
      displayEnd: displayStart + shown.length,
    })
    mentions.push({
      id: match[2],
      name: match[1],
      storageStart: match.index,
      storageEnd: match.index + match[0].length,
      displayStart,
      displayEnd: displayStart + shown.length,
    })
    display += shown
    last = match.index + match[0].length
  }
  pushLiteral(storage.slice(last))

  return { segments, projection: { display, mentions } }
}

/** Storage text plus the location of every mention in it. */
export function projectWithMap(storage: string): Projection {
  return segmentize(storage).projection
}

/** What the writer sees for a given storage string. */
export function project(storage: string): string {
  return segmentize(storage).projection.display
}

/**
 * One indivisible unit of the display string: a whole mention, or a single
 * ordinary character.
 *
 * The alignment below works over these rather than over characters, and that
 * is the whole reason it is correct. A character-level common-prefix /
 * common-suffix diff aliases badly whenever the deleted run resembles the text
 * around it, and it aliases in the direction that silently keeps the WRONG id.
 * Deleting `@Sam ` from `@Sam @Rin` matched a one-character `@` prefix, cut
 * through BOTH tokens, and left a bare `@Rin` carrying no id at all, so the
 * person still on screen was never notified. Deleting `@Ann ` from
 * `@Ann @Annabel` was worse: it kept Ann's id under Annabel's name.
 */
interface Atom {
  storage: string
  display: string
}

function atomize(segments: Segment[]): Atom[] {
  const atoms: Atom[] = []
  for (const seg of segments) {
    if (seg.kind === "mention") {
      atoms.push({ storage: seg.storage, display: seg.display })
      continue
    }
    for (const ch of seg.display) atoms.push({ storage: ch, display: ch })
  }
  return atoms
}

/**
 * Folds an edit made in DISPLAY space back into storage.
 *
 * The unchanged ends are matched as whole ATOMS, so a mention is either kept
 * intact or dropped entirely and an alignment can never cut through one. It
 * deliberately does NOT consult the caret: `selectionStart` is unavailable or
 * untrustworthy for paste, drag-and-drop, dictation, autocorrect and native
 * undo.
 *
 * A mention only PARTLY covered by the unchanged ends falls into the replaced
 * middle and degrades to the display characters that were already on screen.
 * That is what makes an edit into a name drop the mention rather than leave
 * broken `@[Ana Whit](id)` markup in the body, and it keeps degrading
 * display-neutral: the projection of the result equals the string the browser
 * already holds, so React's controlled write-back is a no-op and the caret is
 * never touched on an ordinary keystroke.
 *
 * WHAT IT CANNOT KNOW. Typing a character INSIDE a name is sometimes
 * indistinguishable from typing one immediately after it. Doubling the last
 * letter of `@Ana` gives `@Anaa` either way, and appending is the case that
 * must keep the mention, because typing `,` or `.` or `'s` after a name is
 * ordinary. So `@Anaa` stays a live mention of Ana. She is the person the
 * writer was naming, the body still reads as her name, and none of the three
 * properties above is broken, so this is a limit rather than a defect.
 *
 * The fix would be to consult the caret, and that trade is refused: the caret
 * is unavailable or wrong for paste, drag-and-drop, dictation, autocorrect and
 * native undo, so it would buy a rare case and sell a common one. The real
 * answer is an atomic chip model, which a plain textarea cannot have.
 *
 * THE ONE EXCEPTION to "never invent a mention": if `nextDisplay` itself
 * contains token-shaped text, because the writer pasted or typed
 * `@[Name](id)` literally, that text lands in storage as-is and the next
 * projection collapses it into a live mention. This is what the field already
 * did before there was a projection, and the server still refuses an id that
 * is not a participant of the prototype (`resolveMentionIds`). It is the only
 * path by which an id can appear that was not in `prev`.
 */
export function reconcile(prevStorage: string, nextDisplay: string): string {
  const { segments, projection } = segmentize(prevStorage)
  if (projection.display === nextDisplay) return prevStorage

  const atoms = atomize(segments)

  // The TAIL is matched first, greedily, and that ordering is load-bearing.
  //
  // Both ends are heuristics for a genuinely ambiguous problem: `@X @Y` losing
  // one mention offers no direct evidence of which one went. Matching the tail
  // first attributes a shrinking string to a LEADING deletion, which is what
  // had actually happened in every aliasing case. `@Ann @Annabel` becoming
  // `@Annabel` keeps Annabel, where a head-first pass matched `@Ann` inside
  // `@Annabel` and kept the person the writer had just removed. A trailing
  // deletion is not harmed by the ordering: its tail scan simply finds nothing
  // and the head scan below picks it up.
  //
  // Two identical names stay undecidable, deliberately. `@Ana @Ana` losing one
  // is the same string either way, so the tail bias makes the outcome
  // deterministic rather than correct, and the survivor is at least still a
  // person of that name. Resolving it by matching names against the directory
  // is the one thing this module refuses to do (see the header).
  let tailAtom = atoms.length
  let tail = 0
  while (
    tailAtom > 0 &&
    nextDisplay.length - tail - atoms[tailAtom - 1].display.length >= 0 &&
    nextDisplay.endsWith(atoms[tailAtom - 1].display, nextDisplay.length - tail)
  ) {
    tail += atoms[tailAtom - 1].display.length
    tailAtom--
  }

  let headAtom = 0
  let head = 0
  while (
    headAtom < tailAtom &&
    head + atoms[headAtom].display.length <= nextDisplay.length - tail &&
    nextDisplay.startsWith(atoms[headAtom].display, head)
  ) {
    head += atoms[headAtom].display.length
    headAtom++
  }

  const kept = (from: number, to: number) =>
    atoms
      .slice(from, to)
      .map((a) => a.storage)
      .join("")

  return (
    kept(0, headAtom) +
    nextDisplay.slice(head, nextDisplay.length - tail) +
    kept(tailAtom, atoms.length)
  )
}

/**
 * The storage offset for a DISPLAY offset.
 *
 * An offset strictly inside a mention has no exact storage counterpart, since
 * the token is longer than what it renders as. Those snap outward: `edge`
 * picks which end. Callers that matter never land there anyway, because the
 * composer refuses to open its picker on an `@` belonging to a live mention.
 */
export function displayToStorage(
  storage: string,
  displayOffset: number,
  edge: "start" | "end" = "start",
): number {
  const { segments, projection } = segmentize(storage)
  if (displayOffset <= 0) return 0
  if (displayOffset >= projection.display.length) return storage.length

  let storageStart = 0
  for (const seg of segments) {
    if (displayOffset >= seg.displayStart && displayOffset <= seg.displayEnd) {
      if (seg.kind === "literal") return storageStart + (displayOffset - seg.displayStart)
      if (displayOffset === seg.displayStart) return storageStart
      if (displayOffset === seg.displayEnd) return storageStart + seg.storage.length
      return edge === "start" ? storageStart : storageStart + seg.storage.length
    }
    storageStart += seg.storage.length
  }
  return storage.length
}

/** True when `displayOffset` is the `@` of a live mention, or inside one. */
export function isInsideMention(mentions: MentionSpan[], displayOffset: number): boolean {
  return mentions.some((m) => displayOffset >= m.displayStart && displayOffset < m.displayEnd)
}

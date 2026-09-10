# `src/editor/session`

One bridge session is one document in the shell's iframe. This directory owns
what that means: when a session starts, when it ends, what it was holding when
it ended, and what a lane may do with an answer that arrives afterwards.

## The files

- `session-state.ts` is the pure decisions. Nothing here holds state. It answers
  questions like "does this handshake end the session", "does this reason retire
  the buffered edits", and "which drafts does the bridge get back".
- `modal-queue.ts` is the one-modal-owner rule, as values. Two dialogs can ask
  to open, and only one of them may be on screen, in either direction.
- `edit-session.ts` is the object the shell holds. It owns the generation, the
  abort controller, the document id, the two edit buffers, the dialog rows, the
  scope prompt, the modal queue, the bridge drafts, the in-flight markers, the
  debounce timers and the verify sequences.
- `lane-session.ts` is the prompt-free surface an edit lane is allowed to see.
  It also owns `LANE_IDS`, the one list of lanes. The class has to loop over
  them to cancel every timer and clear every marker, and a lane added to the
  type alone would be missed by those loops.

The lanes are `prop`, `text` and `selection`. The first two are writes. The
third is the stamp refresh that re-reads the selected element after our own
write landed: it arms timers and reads the other two lanes' markers, and takes
no marker of its own.

## How a lane uses it

A lane never checks the session by hand. It calls `session.run`, and every await
inside the body goes through `ctx.step`:

```ts
await session.run(async (ctx) => {
  const written = await ctx.step(adapter.applyEdit(edit, { signal: ctx.signal }))
  if (written.stale) return
  // `written.value` is only reachable past that check.
})
```

`SessionRunResult<T>` is `{ stale: true } | { stale: false; value: T }`, so
`stale` has to be narrowed before `value` can be read. That is the whole shape
of the thing. A lane cannot use an answer that arrived after its page went away,
because there is no way to reach the answer without asking first.

A read is a lane too. "Lane" reads like it means a write, and the writes are
the obvious ones, but the rule is about any await whose continuation installs
something the page decided. A manifest lookup, a Layers tree read, a stamp
refresh: each one asks a question about the page in front of the designer, and
each one can answer after that page is gone. The answer is then wrong in the
same way a write to the departed page's source file is wrong. So a read that
installs page-derived state goes through `session.run` and `ctx.step`, exactly
like a write.

An await that stays outside a run has to say why. The inventory is
`src/hooks/useEditorEditing.await-inventory.test.ts`: it scans the hook, lists
every await that is not inside a run body and not a `ctx.step`, and compares
that list against an allowlist of `{ snippet, sites, reason }` entries. A new
bare await fails the test, by line and by snippet, until someone writes down
what runs after it and why a page change may not stop it. The same file also
fails an await INSIDE a run body that skipped `ctx.step`, which is the other
half of the rule above.

Two details that are easy to get wrong and are handled here:

- `ctx.signal` is the session's lifetime, captured with the generation. Read the
  session's signal at request time instead and it could be the NEXT session's
  live controller, and the request would run on past the reload that should have
  cancelled it.
- A value that has to survive a stale answer comes off the promise, not off the
  step. `applyEdit(...).then((r) => { fileHashes = r.newHashes })` records the
  new hashes whatever the step then says, because those hashes are disk truth
  and the page changing does not undo a write.

## What it replaced

The session used to be four refs in `useEditorEditing.ts`, re-read by convention
at every await:

| Was | Is |
| --- | --- |
| `adapterAbortRef` | `session.signal`, renewed by `attach` and by `end` |
| `adapterGenerationRef` | `session.generation` and `session.isCurrent` |
| `sessionDocumentRef` | `session.documentId`, adopted by `session.start` |
| `verifySeqByKeyRef` | `session.nextVerifySeq` / `session.latestVerifySeq` |

The buffers, the dialog rows, the open question, the held drafts, the in-flight
markers and the debounce timers were thirteen more names beside them.
`edit-session.test.ts` lists all seventeen and fails if one comes back into the
hook.

## Why it exists

`useEditorEditing.ts` had no notion of "the page this edit was made on is gone"
until September 2026. It was added as refs across lanes, and nineteen fix waves
later the reviews were still finding one more lane, or one more await, without
the guard. Each fix was correct and each one was a copy of the same four lines.
See
`docs/superpowers/reports/2026-09-08-ambiguous-edits-hand-off-findings/`.

## Rules

Framework-neutral by rule: no React, no Vue, the same bar as `src/editor/core/`.
The scope prompt's payload reaches into the components layer (a
`PendingIterationEdit` carries a `LayersMovePayload`), so `EditSession` is
generic over it and the caller passes the one accessor the modal queue needs.

A lane takes `LaneSession` from `./lane-session`, never `EditSession` from
`./edit-session`. The class carries the dialogs and the scope prompt, which are
the shell's to raise, and a lane that could name them would be able to raise
them. `edit-session.ts` deliberately does not re-export `LaneSession`.

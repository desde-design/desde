/**
 * Override store — closed-loop optimistic preview for editor edits
 * (WS3 of tasks/edit-pipeline-rearchitecture.md).
 *
 * Before this store, optimistic previews were fire-and-forget: native
 * contentEditable text, raw `instance.props` pokes, direct
 * `el.textContent`/`className` writes. Nothing owned them — an unrelated
 * parent re-render clobbered a prop override, a failed dispatch left the
 * DOM showing an edit that never reached disk, and the only failure signal
 * was a shared single-ID toast. This store makes every optimistic preview
 * an explicit, owned transaction:
 *
 *   pending ──(shell resolves)──▶ confirmed   → release (source is truth now)
 *      │                       ▶ failed       → revert DOM to `before` + event
 *      │                       ▶ ineffective  → release + shell warns (source
 *      │                                        changed but rendering doesn't
 *      │                                        show it — post-HMR DOM is truth)
 *      └──(no resolution in time)▶ unverified  → keep DOM, stop asserting, event
 *
 * While unresolved, the store RE-ASSERTS the override on a short interval:
 * if the rendered state reverted to `before` (parent re-render passing the
 * original prop back down, HMR re-render from not-yet-written source), the
 * override is re-applied. This fixes the documented clobber caveat in
 * comment-bridge.ts's applyPropOverride.
 *
 * The store is deliberately GENERIC: registration supplies `apply` /
 * `revert` / `isApplied` closures, so framework-specific mechanics (Vue
 * instance pokes, contentEditable text, class lists) stay at the capture
 * sites in comment-bridge.ts. The store owns only the state machine, the
 * re-assert loop, and the shell events.
 *
 * Events emitted (bridge → shell):
 *   { type: 'OVERRIDE_REVERTED',   payload: { id, kind, selector, reason } }
 *   { type: 'OVERRIDE_UNVERIFIED', payload: { id, kind, selector } }
 *
 * Shell → bridge resolution arrives via `resolve()` (wired to the
 * RESOLVE_OVERRIDE message in comment-bridge.ts).
 */

export type OverrideKind = 'text' | 'prop' | 'attr' | 'class'

export type OverrideOutcome = 'confirmed' | 'failed' | 'ineffective'

export type OverrideState =
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'ineffective'
  | 'unverified'

export interface OverrideRegistration {
  /** Correlates with the edit/mutation id used on the wire. */
  id: string
  kind: OverrideKind
  /** Stable selector for shell-side display + diagnostics. */
  selector: string
  /** Re-apply the optimistic value. Must be idempotent. */
  apply: () => void
  /** Restore the captured `before` state. */
  revert: () => void
  /** True when the rendered state currently shows the optimistic value. */
  isApplied: () => boolean
}

export interface OverrideStoreOptions {
  sendToShell: (message: { type: string; payload?: unknown }) => void
  /** Re-assert cadence while unresolved. */
  reassertIntervalMs?: number
  /** Emit OVERRIDE_UNVERIFIED after this long without resolution. */
  unverifiedAfterMs?: number
  /** Stop re-asserting entirely after this long (state stays 'unverified'). */
  giveUpAfterMs?: number
}

interface Entry extends OverrideRegistration {
  state: OverrideState
  registeredAt: number
  unverifiedEmitted: boolean
  timer: ReturnType<typeof setInterval> | null
}

export class OverrideStore {
  private readonly entries = new Map<string, Entry>()
  private readonly sendToShell: OverrideStoreOptions['sendToShell']
  private readonly reassertIntervalMs: number
  private readonly unverifiedAfterMs: number
  private readonly giveUpAfterMs: number

  constructor(opts: OverrideStoreOptions) {
    this.sendToShell = opts.sendToShell
    this.reassertIntervalMs = opts.reassertIntervalMs ?? 300
    this.unverifiedAfterMs = opts.unverifiedAfterMs ?? 5_000
    this.giveUpAfterMs = opts.giveUpAfterMs ?? 20_000
  }

  /**
   * Register an optimistic override. The capture site has ALREADY applied
   * the visual change (or the browser did, for contentEditable) — the store
   * takes ownership from here: re-asserts until resolved, reverts on
   * failure, releases on confirmation.
   *
   * Re-registering an id replaces the previous entry WITHOUT reverting it —
   * the common case is the user editing the same field again before the
   * first dispatch resolves; the newest value owns the preview.
   */
  register(reg: OverrideRegistration): void {
    const existing = this.entries.get(reg.id)
    if (existing?.timer) clearInterval(existing.timer)
    const entry: Entry = {
      ...reg,
      state: 'pending',
      registeredAt: Date.now(),
      unverifiedEmitted: false,
      timer: null,
    }
    entry.timer = setInterval(() => this.tick(entry), this.reassertIntervalMs)
    this.entries.set(reg.id, entry)
  }

  /**
   * Shell-driven resolution.
   *  - confirmed:   the write landed AND post-HMR verification saw the value
   *                 rendered from source → release; DOM shows source truth.
   *  - failed:      the write never landed (refusal / 409 / network) →
   *                 revert the DOM to `before`, emit OVERRIDE_REVERTED.
   *  - ineffective: the write landed but the rendered DOM doesn't reflect it
   *                 (bound value shadows it, v-if hides it) → release WITHOUT
   *                 reverting: the post-HMR DOM already re-rendered from the
   *                 new source, so whatever it shows IS the truth — keeping
   *                 the override would lie, and "reverting" would fight HMR.
   */
  resolve(id: string, outcome: OverrideOutcome, reason?: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (entry.timer) clearInterval(entry.timer)
    entry.timer = null
    entry.state = outcome
    if (outcome === 'failed') {
      try {
        entry.revert()
      } catch {
        // Element may be gone (route change, HMR remount) — nothing to revert.
      }
      this.sendToShell({
        type: 'OVERRIDE_REVERTED',
        payload: {
          id: entry.id,
          kind: entry.kind,
          selector: entry.selector,
          reason: reason ?? 'Edit failed',
        },
      })
    }
    this.entries.delete(id)
  }

  /** Release everything without reverting — route change / page teardown
   *  (the elements are gone; source is whatever it is). */
  releaseAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) clearInterval(entry.timer)
    }
    this.entries.clear()
  }

  /** Introspection for tests + diagnostics. */
  get(id: string): { state: OverrideState } | undefined {
    const entry = this.entries.get(id)
    return entry ? { state: entry.state } : undefined
  }

  size(): number {
    return this.entries.size
  }

  private tick(entry: Entry): void {
    const age = Date.now() - entry.registeredAt

    if (age >= this.giveUpAfterMs) {
      // Stop fighting; leave the DOM as-is. The entry stays queryable as
      // 'unverified' until resolved or released.
      if (entry.timer) clearInterval(entry.timer)
      entry.timer = null
      entry.state = 'unverified'
      return
    }

    if (!entry.unverifiedEmitted && age >= this.unverifiedAfterMs) {
      entry.unverifiedEmitted = true
      entry.state = 'unverified'
      this.sendToShell({
        type: 'OVERRIDE_UNVERIFIED',
        payload: { id: entry.id, kind: entry.kind, selector: entry.selector },
      })
    }

    // Re-assert: an unrelated re-render (parent passing the original prop
    // back down, HMR from stale source) clobbered the preview — put it back.
    try {
      if (!entry.isApplied()) entry.apply()
    } catch {
      // Element temporarily unresolvable mid-render; next tick retries.
    }
  }
}

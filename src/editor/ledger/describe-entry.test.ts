import { describe, expect, it } from 'vitest'
import { describeLedgerEntry, LEDGER_KINDS } from './describe-entry'
import type { LedgerEditEntry } from './entry'

function entry(
  kind: string,
  fields: Record<string, unknown> = {},
  files: string[] = ['src/components/PricingCard.vue'],
): LedgerEditEntry {
  return {
    type: 'edit',
    id: 'e1',
    at: '2026-08-18T10:00:00.000Z',
    kind,
    lane: 'direct',
    files,
    afterHashes: {},
    fields,
  }
}

describe('describeLedgerEntry', () => {
  it('renders a prop edit as name = value', () => {
    expect(describeLedgerEntry(entry('prop', { propName: 'title', value: 'Pricing' })))
      .toBe('title = "Pricing"')
  })

  it('renders a token edit as name = value', () => {
    expect(
      describeLedgerEntry(entry('token-value', { tokenName: '--brand', newValue: '#0f6e56' })),
    ).toBe('--brand = "#0f6e56"')
  })

  it('renders a swap as from to', () => {
    expect(
      describeLedgerEntry(
        entry('swap', { fromComponentName: 'KButton', toComponentName: 'KSelect' }),
      ),
    ).toBe('KButton → KSelect')
  })

  it('renders a rename with both basenames', () => {
    expect(
      describeLedgerEntry(entry('rename_file', { from: 'src/a/TopBar.vue', to: 'src/a/Header.vue' })),
    ).toBe('TopBar.vue → Header.vue')
  })

  it('names the file for a whole-file rewrite', () => {
    expect(describeLedgerEntry(entry('overwrite'))).toBe('Rewrote PricingCard.vue')
  })

  // P1-2 (round-3 whole-branch review finding, 2026-08-19), corrected by
  // F2 (round-10, a regression IN round 3's own fix): an entry written by
  // an EDITOR PROCESS RUNNING ON WINDOWS can carry a backslash-separated
  // path forever — the log is append-only, so it can never be corrected
  // in place — and `base()`'s own `/`-based split finds no separator in a
  // purely-backslash path, so on that SAME Windows host it would fall
  // back to the whole path rather than just the filename.
  // `normalize-path.test.ts` proves that half deterministically, by
  // injecting `path.sep` as an explicit argument (the only call site that
  // can — `describeLedgerEntry` has no separator parameter of its own to
  // inject through).
  //
  // What THIS suite's real host can prove directly: `normalizeLedgerPath`
  // is now platform-SCOPED (round-10 fix) — on THIS host's actual
  // separator (POSIX, `/`), a literal `\` is data, not structure, so it is
  // never folded, and `base()`'s no-`/`-found fallback correctly returns
  // the WHOLE literal string. That is the same string round 3's bug
  // produced, but for the opposite reason: round 3 was a bug on any
  // platform; this is the deliberately-correct POSIX behavior for a path
  // this host cannot have authored a `\` for. See `normalize-path.ts`'s
  // doc comment for why the two now look identical here.
  it('shows the whole literal path for a backslash-separated entry on this (POSIX) host, since a backslash here is not a separator', () => {
    expect(describeLedgerEntry(entry('overwrite', {}, ['src\\components\\PricingCard.vue'])))
      .toBe('Rewrote src\\components\\PricingCard.vue')
  })

  it('counts the mutations in an llm-patch bundle', () => {
    expect(describeLedgerEntry(entry('llm-patch', { mutationCount: 3 }))).toBe('3 changes')
  })

  it('singularises a one-mutation bundle', () => {
    expect(describeLedgerEntry(entry('llm-patch', { mutationCount: 1 }))).toBe('1 change')
  })

  it('names the file for a built-in Write', () => {
    expect(describeLedgerEntry(entry('write'))).toBe('Wrote PricingCard.vue')
  })

  it('names the file for a built-in Edit', () => {
    expect(describeLedgerEntry(entry('edit'))).toBe('Edited PricingCard.vue')
  })

  it('names the step an undo reverted', () => {
    expect(describeLedgerEntry(entry('undo', { step: 'prop: src/App.vue' })))
      .toBe('Undid: prop: src/App.vue')
  })

  it('says so plainly when no lane claimed the write', () => {
    expect(describeLedgerEntry(entry('unknown'))).toBe('Changed outside the editor')
  })

  it('falls back to a humanised kind for an unrecognised one', () => {
    expect(describeLedgerEntry(entry('some_future_kind'))).toBe('Some future kind')
  })

  // The guard that matters: a kind listed as known must have a real case,
  // not the humanised fallback. Adding a kind to LEDGER_KINDS without a
  // case fails here.
  it('gives every known kind a specific description', () => {
    const fixtures: Record<string, Record<string, unknown>> = {
      prop: { propName: 'a', value: 'b' },
      'token-value': { tokenName: '--a', newValue: 'b' },
      'text-branch': { newValue: 'b' },
      swap: { fromComponentName: 'A', toComponentName: 'B' },
      detach: { componentName: 'A' },
      move: {},
      delete: {},
      insert: {},
      unwrap: {},
      'flatten-conditional': { branchToKeep: 0 },
      overwrite: {},
      'scoped-css-override': { declarations: { color: 'red' } },
      'jsx-style': { mode: 'classname', addClasses: ['p-2'] },
      'llm-patch': { mutationCount: 2 },
      delete_file: {},
      rename_file: { from: 'a/x.ts', to: 'a/y.ts' },
      insert_component: { componentName: 'KCard' },
      insert_element: {},
      scaffold_route: { routePath: '/pricing' },
      manage_package: { action: 'add', packageName: 'zod' },
      download_asset: {},
      write: {},
      edit: {},
      undo: { step: 'prop: src/App.vue' },
      redo: { step: 'prop: src/App.vue' },
      unknown: {},
    }
    for (const kind of LEDGER_KINDS) {
      const fields = fixtures[kind]
      expect(fields, `no fixture for known kind "${kind}"`).toBeDefined()
      const text = describeLedgerEntry(entry(kind, fields))
      expect(text.length, `empty description for "${kind}"`).toBeGreaterThan(0)
      expect(text, `"${kind}" fell through to the humanised fallback`).not.toBe(
        kind.replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      )
    }
  })
})

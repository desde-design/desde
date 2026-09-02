/**
 * Ledger entry -> the one-line description the Activity panel shows.
 *
 * Lives apart from the entry types because it is DISPLAY, and the ledger
 * deliberately stores fields rather than prose so this wording can change
 * without rewriting history. Pure — no I/O, no framework, no design system.
 */

import type { LedgerEditEntry } from './entry'
import { normalizeLedgerPath } from './normalize-path'

/**
 * Kinds this module renders specifically. The colocated test asserts every
 * one of them produces something other than the humanised fallback, so
 * adding a kind here without adding a case is a test failure, not a
 * silently vague row.
 */
export const LEDGER_KINDS: readonly string[] = [
  // Deterministic edit kinds (validate-edit-request.ts).
  'prop',
  'token-value',
  'text-branch',
  'swap',
  'detach',
  'move',
  'delete',
  'insert',
  'unwrap',
  'flatten-conditional',
  'overwrite',
  'scoped-css-override',
  'jsx-style',
  'llm-patch',
  // SDK structural tools (fs-structural-tools.ts).
  'delete_file',
  'rename_file',
  'insert_component',
  'insert_element',
  'scaffold_route',
  'manage_package',
  'download_asset',
  // The SDK's own built-in Write/Edit tools — the one write lane that
  // can't route through `brokeredWrite` (the SDK owns that write
  // syscall), so they're recorded from `sdk-write-guard.ts`'s own
  // post-write hook instead (P1-1, whole-branch review finding,
  // 2026-08-18).
  'write',
  'edit',
  // Undo/redo restores, which go through the same broker.
  'undo',
  'redo',
  // A write whose caller supplied no description.
  'unknown',
]

/**
 * The filename tail of a ledger path. Normalizes first (P1-2, round-3
 * whole-branch review finding, 2026-08-19) — an entry written before the
 * producer-side fix can carry `\`-separated segments forever (the log is
 * append-only), and this function's own `/`-based split would otherwise
 * find no separator at all in a purely-backslash path and return the
 * WHOLE path as the "filename" (e.g. `Rewrote src\components\App.vue`
 * instead of `Rewrote App.vue`).
 */
function base(path: string): string {
  const normalized = normalizeLedgerPath(path)
  const i = normalized.lastIndexOf('/')
  return i === -1 ? normalized : normalized.slice(i + 1)
}

/** Field as a plain string. Never "undefined" or "[object Object]". */
function s(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** Field as an authored literal, matching how the Checks list renders values. */
function q(value: unknown): string {
  return JSON.stringify(value ?? null)
}

/** `some_future_kind` -> `Some future kind`. */
function humanise(kind: string): string {
  const words = kind.replace(/[-_]/g, ' ')
  return words.replace(/^./, (c) => c.toUpperCase())
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).map(s) : []
}

/**
 * Renders a declarations/classes change — shared by `jsx-style` and
 * `scoped-css-override`, two edit kinds that are mechanically distinct
 * (React inline/className vs. a Vue `<style scoped>` or CSS rule) but
 * describe the same thing to a reader: some CSS properties and/or some
 * classes changed.
 *
 * Returns null when there is nothing worth saying, so each caller keeps
 * its own kind-specific fallback ('Style override' / 'Style change').
 *
 * Precedence: declarations set > added classes (`addClasses` for
 * jsx-style, `applyClasses` for scoped-css-override) > removed classes >
 * removed declarations. The two existing callers only ever populate one
 * tier at a time, so this ordering is a display choice, not a conflict
 * resolution.
 */
function describeStyleChange(f: Record<string, unknown>): string | null {
  const decls = f.declarations
  if (decls && typeof decls === 'object') {
    const pairs = Object.entries(decls as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${s(v)}`)
    if (pairs.length > 0) return pairs.join(', ')
  }

  const added = stringArray(f.addClasses).length > 0
    ? stringArray(f.addClasses)
    : stringArray(f.applyClasses)
  if (added.length > 0) return `Added ${added.join(' ')}`

  const removed = stringArray(f.removeClasses)
  if (removed.length > 0) return `Removed ${removed.join(' ')}`

  const removedDecls = stringArray(f.removeDeclarations)
  if (removedDecls.length > 0) return `Removed ${removedDecls.join(' ')}`

  return null
}

export function describeLedgerEntry(entry: LedgerEditEntry): string {
  const f = entry.fields ?? {}
  const file = base(entry.files[0] ?? '')

  switch (entry.kind) {
    case 'prop':
      return `${s(f.propName)} = ${q(f.value)}`
    case 'token-value':
      return `${s(f.tokenName)} = ${q(f.newValue)}`
    case 'text-branch':
      return `Text = ${q(f.newValue)}`
    case 'swap':
      return `${s(f.fromComponentName)} → ${s(f.toComponentName)}`
    case 'detach':
      return `Detached ${s(f.componentName)}`
    case 'move':
      return 'Moved element'
    case 'delete':
      return 'Deleted element'
    case 'insert':
      return 'Inserted element'
    case 'unwrap':
      return 'Unwrapped element'
    case 'flatten-conditional':
      return `Kept branch ${s(f.branchToKeep)}`
    case 'overwrite':
      return `Rewrote ${file}`
    case 'scoped-css-override':
      return describeStyleChange(f) ?? 'Style override'
    case 'jsx-style':
      return describeStyleChange(f) ?? 'Style change'
    case 'llm-patch': {
      const n = typeof f.mutationCount === 'number' ? f.mutationCount : 0
      return `${n} ${n === 1 ? 'change' : 'changes'}`
    }
    case 'delete_file':
      return `Deleted ${file}`
    case 'rename_file':
      return `${base(s(f.from))} → ${base(s(f.to))}`
    case 'insert_component':
      return `Inserted ${s(f.componentName)}`
    case 'insert_element':
      return 'Inserted element'
    case 'scaffold_route':
      return `New route ${s(f.routePath)}`
    case 'manage_package':
      return `${s(f.action)} ${s(f.packageName)}`.trim()
    case 'download_asset':
      return `Added ${file}`
    case 'write':
      return `Wrote ${file}`
    case 'edit':
      return `Edited ${file}`
    case 'undo':
      return `Undid: ${s(f.step)}`
    case 'redo':
      return `Redid: ${s(f.step)}`
    case 'unknown':
      // Not a failure state. A write with no description is a real event
      // worth a row; claiming to describe it would be the lie the current
      // panel's silence already tells.
      return 'Changed outside the editor'
    default:
      return humanise(entry.kind)
  }
}

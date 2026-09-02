/**
 * The free-identifier analyser underneath the detach scope guard. These
 * tests pin the two properties the guard depends on: template-bound names
 * (v-for aliases, slot props, including destructured ones) must NOT appear,
 * and instance-supplied names MUST appear — because a missing entry is a
 * silent break waved through, not a refusal.
 */

import { describe, expect, it } from 'vitest'
import {
  collectFreeIdentifiers,
  isAppGlobalIdentifier,
  isInstanceScopedIdentifier,
} from './template-free-identifiers'

function ids(template: string, typescript = false): string[] {
  const result = collectFreeIdentifiers(template, { typescript })
  if (!result.ok) throw new Error(`expected analysis to succeed: ${result.reason}`)
  return [...result.identifiers].sort()
}

describe('collectFreeIdentifiers — what counts as free', () => {
  it('reports identifiers supplied by the component instance', () => {
    expect(ids('<span>{{ label }}</span>')).toEqual(['label'])
    expect(ids('<b :class="tone" @click="go">x</b>')).toEqual(['go', 'tone'])
    expect(ids('<input v-model="form.name" />')).toEqual(['form'])
  })

  it('reports identifiers used only inside a ternary or call', () => {
    expect(ids(`<i :icon="isDark ? 'moon' : 'sun'" @click="toggle()" />`)).toEqual([
      'isDark',
      'toggle',
    ])
  })

  it('does NOT report v-for aliases, including destructured ones', () => {
    expect(ids('<ul><li v-for="(item, i) in rows" :key="i">{{ item.x }}</li></ul>')).toEqual([
      'rows',
    ])
    expect(ids('<ul><li v-for="({ id, name }) in rows" :key="id">{{ name }}</li></ul>')).toEqual([
      'rows',
    ])
  })

  it('does NOT report slot props', () => {
    expect(ids('<Foo><template #row="{ rec }">{{ rec.x }}{{ outer }}</template></Foo>')).toEqual([
      'outer',
    ])
  })

  it('does NOT report JS globals', () => {
    expect(ids('<p>{{ Math.max(1, 2) }}{{ Date.now() }}{{ JSON.stringify(payload) }}</p>')).toEqual(
      ['payload'],
    )
  })

  it('does NOT report component tags or directive names', () => {
    // Components resolve through `_resolveComponent`, directives through
    // `_resolveDirective` — neither becomes a `_ctx` member.
    expect(ids('<div><MyWidget v-styleclass="{ selector: \'@next\' }" /></div>')).toEqual([])
  })

  it('returns an empty set for a fully static template', () => {
    expect(ids('<button class="b" type="submit">Save</button>')).toEqual([])
  })

  it('parses TypeScript expressions when asked', () => {
    expect(ids('<p>{{ (raw as string).length }}</p>', true)).toEqual(['raw'])
  })
})

describe('collectFreeIdentifiers — failure is reported, not swallowed', () => {
  it('fails rather than returning a partial set for an unparseable expression', () => {
    const result = collectFreeIdentifiers('<p>{{ a b c( }}</p>')
    expect(result.ok).toBe(false)
  })

  it('fails on a compiler-level template error (v-else with no v-if)', () => {
    const result = collectFreeIdentifiers('<div><span v-else>{{ x }}</span></div>')
    expect(result.ok).toBe(false)
  })
})

describe('identifier classification', () => {
  it('treats instance-bound $-names as instance-scoped', () => {
    for (const name of ['$props', '$attrs', '$slots', '$emit', '$el']) {
      expect(isInstanceScopedIdentifier(name)).toBe(true)
      expect(isAppGlobalIdentifier(name)).toBe(false)
    }
  })

  it('treats other $-names as app-level global properties', () => {
    for (const name of ['$route', '$router', '$t', '$store']) {
      expect(isAppGlobalIdentifier(name)).toBe(true)
      expect(isInstanceScopedIdentifier(name)).toBe(false)
    }
  })

  it('does not classify ordinary identifiers as app globals', () => {
    expect(isAppGlobalIdentifier('route')).toBe(false)
  })
})

/**
 * Regression: the `$`-classifier must be a MEMBERSHIP test, not an absence
 * test.
 *
 * It was originally "instance-bound if listed, app-global otherwise", which
 * fails OPEN for every `$name` nobody enumerated. `$refs` is the concrete
 * case — it resolves against whichever component the template ends up in, so
 * an inlined `@click="$refs.child.open()"` silently retargets the consumer's
 * refs — but the shape of the bug is the point: an unknown `$name` must not
 * be assumed safe, because assuming safety is precisely the silent-breakage
 * class this module exists to close.
 */
describe('$-identifier classification fails closed', () => {
  it('treats every Vue built-in instance property as instance-scoped', () => {
    for (const name of ['$refs', '$watch', '$nextTick', '$forceUpdate']) {
      expect(isInstanceScopedIdentifier(name)).toBe(true)
      expect(isAppGlobalIdentifier(name)).toBe(false)
    }
  })

  it('does NOT treat an unknown $name as an app global', () => {
    for (const name of ['$anythingNobodyListed', '$quasar', '$vuetify']) {
      expect(isAppGlobalIdentifier(name)).toBe(false)
    }
  })

  it('still recognises the known app globals', () => {
    for (const name of ['$route', '$router', '$store', '$t', '$i18n']) {
      expect(isAppGlobalIdentifier(name)).toBe(true)
      expect(isInstanceScopedIdentifier(name)).toBe(false)
    }
  })

  it('surfaces $refs as a free identifier so the guard can refuse on it', () => {
    expect(ids('<b @click="$refs.child.open()">x</b>')).toContain('$refs')
  })
})

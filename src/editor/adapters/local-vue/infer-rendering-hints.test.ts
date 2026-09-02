/**
 * Tests for `inferRenderingHints` — SFC template → `dom` rendering hints
 * for first-party components. Covers the EntityFormBlock title/step/
 * description shape (the Phase 1h target) plus the bounding cases the
 * inference must REFUSE (so it never emits an unsafe hint).
 */
import { describe, expect, it } from 'vitest'
import { inferRenderingHints } from './infer-rendering-hints'
import type { RenderingHint } from '../../core'

/** Find the dom hint targeting `selector`, or undefined. */
function domHintFor(
  hints: RenderingHint[] | undefined,
  selector: string,
): Extract<RenderingHint, { kind: 'dom' }> | undefined {
  return hints?.find(
    (h): h is Extract<RenderingHint, { kind: 'dom' }> =>
      h.kind === 'dom' && h.domTarget.selector === selector,
  )
}

describe('inferRenderingHints', () => {
  it('infers title/step/description hints from the EntityFormBlock shape', () => {
    // The real EntityFormBlock template (trimmed of the extra/default slots
    // and the dynamic :class, which the inference ignores).
    const templateSource = `
      <div class="acme-ui-entity-form-block" :class="{ 'stepped': step !== undefined }">
        <header class="header">
          <div v-if="step !== undefined || slots.step" class="step">
            <slot name="step">
              {{ step }}
            </slot>
          </div>
          <div class="header-content">
            <h2 class="header-title">
              <slot name="title">
                {{ title }}
              </slot>
            </h2>
            <div v-if="description || slots.description" class="header-description">
              <slot name="description">
                {{ description }}
              </slot>
            </div>
          </div>
        </header>
        <div class="content">
          <slot />
        </div>
      </div>
    `
    const hints = inferRenderingHints({
      templateSource,
      propNames: ['step', 'title', 'description'],
    })

    const title = domHintFor(hints, 'h2.header-title')
    expect(title).toEqual({
      kind: 'dom',
      source: { kind: 'prop', name: 'title' },
      domTarget: { selector: 'h2.header-title', field: 'textContent' },
      editability: 'literal',
    })

    const step = domHintFor(hints, 'div.step')
    expect(step?.source).toEqual({ kind: 'prop', name: 'step' })

    const desc = domHintFor(hints, 'div.header-description')
    expect(desc?.source).toEqual({ kind: 'prop', name: 'description' })

    // No hint for the slot-only `.content` (no prop interpolation).
    expect(domHintFor(hints, 'div.content')).toBeUndefined()
  })

  it('infers from a bare interpolation (no slot wrapper)', () => {
    // Wrapped in a root so the rendering element is non-root and we exercise
    // the class-selector path (a lone root would yield `:root`).
    const hints = inferRenderingHints({
      templateSource: `<div><span class="step-label">{{ step }}</span></div>`,
      propNames: ['step'],
    })
    expect(domHintFor(hints, 'span.step-label')).toEqual({
      kind: 'dom',
      source: { kind: 'prop', name: 'step' },
      domTarget: { selector: 'span.step-label', field: 'textContent' },
      editability: 'literal',
    })
  })

  it('emits :root when the prop renders into the single template-root element', () => {
    const hints = inferRenderingHints({
      templateSource: `<h1 class="title">{{ title }}</h1>`,
      propNames: ['title'],
    })
    expect(domHintFor(hints, ':root')).toEqual({
      kind: 'dom',
      source: { kind: 'prop', name: 'title' },
      domTarget: { selector: ':root', field: 'textContent' },
      editability: 'literal',
    })
  })

  it('sorts class tokens to match the runtime canonical selector', () => {
    const hints = inferRenderingHints({
      templateSource: `<div class="zeta header-title alpha">{{ title }}</div>`,
      propNames: ['title'],
    })
    // Not :root because there's a single root but we still want the class
    // selector for a non-root… here it IS the root, so it's :root. Use a
    // wrapper to force a non-root element.
    expect(hints?.some((h) => h.kind === 'dom' && h.domTarget.selector === ':root')).toBe(true)

    const wrapped = inferRenderingHints({
      templateSource: `<section><div class="zeta header-title alpha">{{ title }}</div></section>`,
      propNames: ['title'],
    })
    expect(domHintFor(wrapped, 'div.alpha.header-title.zeta')).toBeDefined()
  })

  it('skips interpolations that are not declared props', () => {
    const hints = inferRenderingHints({
      templateSource: `<div class="x">{{ localRef }}</div>`,
      propNames: ['title'],
    })
    expect(hints).toBeUndefined()
  })

  it('skips member-access and computed expressions', () => {
    const hints = inferRenderingHints({
      templateSource: `
        <div>
          <div class="a">{{ user.name }}</div>
          <div class="b">{{ format(title) }}</div>
          <div class="c">{{ title || 'fallback' }}</div>
        </div>
      `,
      propNames: ['title', 'user'],
    })
    expect(hints).toBeUndefined()
  })

  it('skips elements that mix the prop interpolation with other content', () => {
    const hints = inferRenderingHints({
      templateSource: `
        <div>
          <div class="mixed-text">Label: {{ title }}</div>
          <div class="mixed-el">{{ title }}<span>x</span></div>
        </div>
      `,
      propNames: ['title'],
    })
    expect(hints).toBeUndefined()
  })

  it('skips class-less non-root elements (bare-tag selector is ambiguous)', () => {
    const hints = inferRenderingHints({
      templateSource: `<section><h2>{{ title }}</h2></section>`,
      propNames: ['title'],
    })
    expect(hints).toBeUndefined()
  })

  it('drops hints when two props collide on the same selector', () => {
    const hints = inferRenderingHints({
      templateSource: `
        <div>
          <div class="dup">{{ title }}</div>
          <div class="dup">{{ step }}</div>
        </div>
      `,
      propNames: ['title', 'step'],
    })
    expect(domHintFor(hints, 'div.dup')).toBeUndefined()
  })

  it('never emits a hint targeting a <slot> element itself (codex P2)', () => {
    // A `<slot>` produces no DOM node — its fallback renders into the
    // PARENT's position. A class on the slot tag, or a root slot, must NOT
    // yield a `slot.foo` / `:root` hint, because that selector can never
    // match the runtime `selectorWithinMountRoot`.
    const withClass = inferRenderingHints({
      templateSource: `<div><slot name="title" class="foo">{{ title }}</slot></div>`,
      propNames: ['title'],
    })
    expect(domHintFor(withClass, 'slot.foo')).toBeUndefined()
    expect(
      withClass?.some((h) => h.kind === 'dom' && h.domTarget.selector.startsWith('slot')),
    ).toBeFalsy()

    const rootSlot = inferRenderingHints({
      templateSource: `<slot name="title">{{ title }}</slot>`,
      propNames: ['title'],
    })
    // A bare root slot has no rendered host element to attribute to → no hint.
    expect(rootSlot).toBeUndefined()
  })

  it('never emits a hint targeting a <template> wrapper (codex P1)', () => {
    // `<template>` is a compile-time grouping, not a DOM element. A
    // `<template>` carrying a prop interpolation must not yield a hint.
    const hints = inferRenderingHints({
      templateSource: `<div><template v-if="title">{{ title }}</template></div>`,
      propNames: ['title'],
    })
    expect(
      hints?.some((h) => h.kind === 'dom' && h.domTarget.selector.startsWith('template')),
    ).toBeFalsy()
  })

  it('never emits a hint targeting a child component tag (codex P1)', () => {
    // A child COMPONENT (`<MyCard class="x">{{ title }}</MyCard>`) renders
    // its OWN DOM, not a `mycard.x` element — a prop reaching a child's text
    // is a `forward` hint, out of scope. No `dom` hint may target it.
    const hints = inferRenderingHints({
      templateSource: `<div><MyCard class="card">{{ title }}</MyCard></div>`,
      propNames: ['title'],
    })
    expect(domHintFor(hints, 'mycard.card')).toBeUndefined()
    expect(hints).toBeUndefined()
  })

  it('does not assign :root to a non-rendered single root node (codex P2)', () => {
    // A lone root `<template>` is not the mounted DOM root, so no `:root`
    // hint may be emitted for it.
    const hints = inferRenderingHints({
      templateSource: `<template><div class="inner">{{ title }}</div></template>`,
      propNames: ['title'],
    })
    expect(domHintFor(hints, ':root')).toBeUndefined()
    // The inner native div still gets a class-based hint.
    expect(domHintFor(hints, 'div.inner')?.source).toEqual({ kind: 'prop', name: 'title' })
  })

  it('attributes a slot-fallback prop to the parent rendered element', () => {
    // `<h2 class="header-title"><slot name="title">{{ title }}</slot></h2>`
    // wrapped so the h2 is non-root: the hint targets the PARENT h2, never
    // the slot.
    const hints = inferRenderingHints({
      templateSource: `<div><h2 class="header-title"><slot name="title">{{ title }}</slot></h2></div>`,
      propNames: ['title'],
    })
    expect(domHintFor(hints, 'h2.header-title')?.source).toEqual({
      kind: 'prop',
      name: 'title',
    })
    expect(
      hints?.some((h) => h.kind === 'dom' && h.domTarget.selector.startsWith('slot')),
    ).toBeFalsy()
  })

  it('returns undefined when there are no props', () => {
    expect(
      inferRenderingHints({ templateSource: `<div class="x">{{ title }}</div>`, propNames: [] }),
    ).toBeUndefined()
  })

  it('returns undefined when the template renders no declared prop as text', () => {
    expect(
      inferRenderingHints({
        templateSource: `<div class="x"><slot /></div>`,
        propNames: ['title'],
      }),
    ).toBeUndefined()
  })

  it('accepts a Set of prop names', () => {
    const hints = inferRenderingHints({
      templateSource: `<section><div class="t">{{ title }}</div></section>`,
      propNames: new Set(['title']),
    })
    expect(domHintFor(hints, 'div.t')).toBeDefined()
  })
})

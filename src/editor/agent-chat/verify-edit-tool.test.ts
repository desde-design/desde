/**
 * Unit tests for the `verify_edit` handler in `editor-tool-handlers.ts`.
 *
 * `verify_edit` exposes the deterministic L1+L2 render oracle
 * (src/editor/verification) to the agent. The oracle internals are covered
 * by `verification/verification.test.ts`; these tests verify the SDK adapter:
 *   - accessor derivation from `field` (text / attribute / style) + validation
 *   - the bridge round-trip shape (`chat:read_rendered_value`)
 *   - pass vs fail mapping and the cause→hint translation
 *   - source-line classification (bound-binding) using a real temp worktree
 *   - graceful degradation when no worktreeRoot is configured
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BridgeClient } from '../agent-tools/types'
import type { VerifyEditContext, VerifyEditInput } from './editor-tool-handlers'
import { verifyEdit } from './editor-tool-handlers'

/**
 * `verifyEdit` with a virtual clock injected (`VerifyEditContext.verifyTiming`):
 * `sleep` advances `now` without waiting, so verifyRender's 3s fail-poll and
 * 600ms confirm-stable windows complete instantly. With real timers every
 * fail-path test blocked ≥3s of wall clock and the whole file flaked under
 * machine load (setTimeout overshoot past the vitest timeout).
 */
function run(ctx: VerifyEditContext, input: VerifyEditInput) {
  let t = 0
  return verifyEdit(
    {
      ...ctx,
      verifyTiming: {
        now: () => t,
        sleep: async (ms: number) => {
          t += ms
        },
      },
    },
    input,
  )
}

/** A bridge whose `chat:read_rendered_value` always replies with `value`. */
function bridgeReturning(value: string | null): {
  bridge: BridgeClient
  send: ReturnType<typeof vi.fn>
} {
  const send = vi.fn(async (messageType: string) => {
    if (messageType === 'chat:read_rendered_value') return { value }
    return null
  })
  return { bridge: { send }, send }
}

function parse(result: { content: Array<{ type: 'text'; text: string }> }) {
  return JSON.parse(result.content[0].text) as {
    pass: boolean
    observed: string | null
    expected: string
    cause?: string
    hint?: string
    detail: string
  }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pt-verify-edit-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('verify_edit — input validation', () => {
  it("rejects field 'attribute' without an attribute name", async () => {
    const { bridge, send } = bridgeReturning('x')
    const result = await run(
      { bridge },
      { file: 'A.vue', line: 1, selector: '.x', expectedValue: 'v', field: 'attribute' },
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/requires `attribute`/)
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects an empty selector', async () => {
    const { bridge } = bridgeReturning('x')
    const result = await run(
      { bridge },
      { file: 'A.vue', line: 1, selector: '', expectedValue: 'v', field: 'textContent' },
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/selector is required/)
  })
})

describe('verify_edit — accessor mapping', () => {
  it("maps field 'textContent' to a text accessor", async () => {
    const { bridge, send } = bridgeReturning('Save')
    await run(
      { bridge },
      { file: 'A.vue', line: 1, selector: 'button', expectedValue: 'Save', field: 'textContent' },
    )
    expect(send).toHaveBeenCalledWith(
      'chat:read_rendered_value',
      { selector: 'button', accessor: { kind: 'text' } },
      expect.anything(),
    )
  })

  it("maps field 'attribute' to an attr accessor carrying the attribute name", async () => {
    const { bridge, send } = bridgeReturning('Type here')
    await run(
      { bridge },
      {
        file: 'A.vue',
        line: 1,
        selector: 'input',
        expectedValue: 'Type here',
        field: 'attribute',
        attribute: 'placeholder',
      },
    )
    expect(send).toHaveBeenCalledWith(
      'chat:read_rendered_value',
      { selector: 'input', accessor: { kind: 'attr', name: 'placeholder' } },
      expect.anything(),
    )
  })

})

describe('verify_edit — pass', () => {
  it('returns pass:true with the observed value when the DOM matches', async () => {
    const { bridge } = bridgeReturning('Save')
    const result = await run(
      { bridge },
      { file: 'A.vue', line: 1, selector: 'button', expectedValue: 'Save', field: 'textContent' },
    )
    const body = parse(result)
    expect(result.isError).toBeUndefined()
    expect(body.pass).toBe(true)
    expect(body.observed).toBe('Save')
    expect(body.expected).toBe('Save')
    expect(body.cause).toBeUndefined()
    expect(body.hint).toBeUndefined()
  })
})

describe('verify_edit — fail classification', () => {
  it('classifies an interpolated text mismatch ({{ }}) as bound-binding with a fix hint', async () => {
    // `{{ label }}` provably binds the text from the line — the literal the
    // agent tried to write can't stick. DOM still shows the old value.
    await writeFile(
      join(root, 'Interp.vue'),
      ['<template>', '  <button class="save-btn">{{ label }}</button>', '</template>'].join('\n'),
      'utf8',
    )
    const { bridge } = bridgeReturning('Old')
    const result = await run(
      { bridge, worktreeRoot: root },
      {
        file: 'Interp.vue',
        line: 2,
        selector: '.save-btn',
        expectedValue: 'Save',
        field: 'textContent',
      },
    )
    const body = parse(result)
    expect(body.pass).toBe(false)
    expect(body.observed).toBe('Old')
    expect(body.cause).toBe('bound-binding')
    expect(body.hint).toMatch(/bound expression/i)
    // `detail` must agree with the refined cause, not verifyRender's stale
    // DOM-only detail (no "HMR"/"selector" wording alongside bound-binding).
    expect(body.detail).toMatch(/bound/i)
    expect(body.detail).not.toMatch(/HMR|selector/i)
  })

  it('classifies an attribute mismatch on a bound attr as bound-binding (the specific :attr)', async () => {
    await writeFile(
      join(root, 'Input.vue'),
      ['<template>', '  <input :placeholder="ph" class="field" />', '</template>'].join('\n'),
      'utf8',
    )
    const { bridge } = bridgeReturning('old ph')
    const result = await run(
      { bridge, worktreeRoot: root },
      {
        file: 'Input.vue',
        line: 2,
        selector: '.field',
        expectedValue: 'new ph',
        field: 'attribute',
        attribute: 'placeholder',
      },
    )
    const body = parse(result)
    expect(body.pass).toBe(false)
    expect(body.cause).toBe('bound-binding')
  })

  it('does NOT misclassify a native-element text mismatch as bound-binding from an unrelated :class', async () => {
    // Codex finding: `:class` doesn't feed slot text on a native element, so a
    // failed text edit here must NOT be reported as bound-binding (which would
    // send the agent to mutate unrelated state). Expect a DOM-state cause.
    await writeFile(
      join(root, 'Native.vue'),
      ['<template>', '  <button :class="kind" class="save-btn">Old</button>', '</template>'].join('\n'),
      'utf8',
    )
    const { bridge } = bridgeReturning('Old')
    const result = await run(
      { bridge, worktreeRoot: root },
      {
        file: 'Native.vue',
        line: 2,
        selector: '.save-btn',
        expectedValue: 'Save',
        field: 'textContent',
      },
    )
    const body = parse(result)
    expect(body.pass).toBe(false)
    expect(body.cause).toBe('hmr-stale')
    expect(body.cause).not.toBe('bound-binding')
  })

  it('flags a component text mismatch as bound-binding when the tag carries a bound prop', async () => {
    // The headline case: a component routinely renders a prop (label/title/…)
    // as its text, so a failed literal text edit on a component with a bound
    // prop is treated as bound — the hint sends the agent to get_component to
    // find which prop. (We can't identify the exact prop from a source line
    // without the manifest; precise prop→surface mapping is a deferred Phase 4
    // item. A NATIVE element is NOT flagged this way — see the test above.)
    await writeFile(
      join(root, 'Comp.vue'),
      ['<template>', '  <KButton :label="label" class="save-btn" />', '</template>'].join('\n'),
      'utf8',
    )
    const { bridge } = bridgeReturning('Old')
    const result = await run(
      { bridge, worktreeRoot: root },
      {
        file: 'Comp.vue',
        line: 2,
        selector: '.save-btn',
        expectedValue: 'Save',
        field: 'textContent',
      },
    )
    const body = parse(result)
    expect(body.pass).toBe(false)
    expect(body.cause).toBe('bound-binding')
    expect(body.hint).toMatch(/get_component|bound expression/i)
  })

  it('classifies a MULTI-LINE component tag as bound-binding (binding on an adjacent line)', async () => {
    // The agent reports the tag's start line (`<KButton`), but `:label` is on a
    // following line. The classifier must scan the start-tag window, not just
    // input.line, or this mislabels as hmr-stale. (Codex finding.)
    await writeFile(
      join(root, 'Multi.vue'),
      [
        '<template>',
        '  <KButton',
        '    :label="title"',
        '    class="save-btn"',
        '  />',
        '</template>',
      ].join('\n'),
      'utf8',
    )
    const { bridge } = bridgeReturning('Old')
    const result = await run(
      { bridge, worktreeRoot: root },
      { file: 'Multi.vue', line: 2, selector: '.save-btn', expectedValue: 'Save', field: 'textContent' },
    )
    const body = parse(result)
    expect(body.pass).toBe(false)
    expect(body.cause).toBe('bound-binding')
  })

  it('finds the binding when the agent edits a LATER line of a multi-line tag (backward scan)', async () => {
    // The agent reports the attribute line it edited (line 3 = label="Save"),
    // not the <KButton opener (line 2). The window must scan backward to the
    // tag open AND forward to the bound :label, or it misclassifies. (Codex.)
    await writeFile(
      join(root, 'Later.vue'),
      [
        '<template>',
        '  <KButton',
        '    label="Save"',
        '    :label="title"',
        '  />',
        '</template>',
      ].join('\n'),
      'utf8',
    )
    const { bridge } = bridgeReturning('Old')
    const result = await run(
      { bridge, worktreeRoot: root },
      { file: 'Later.vue', line: 3, selector: '.save-btn', expectedValue: 'Save', field: 'textContent' },
    )
    const body = parse(result)
    expect(body.pass).toBe(false)
    expect(body.cause).toBe('bound-binding')
  })

  it('classifies a null ATTRIBUTE read with the element present as hmr-stale, not selector-missing', async () => {
    // The bridge returns null both for "selector matched nothing" and "element
    // exists but attribute absent". A present element with a missing attribute
    // must not tell the agent to debug the selector/route. (Codex finding.)
    await writeFile(
      join(root, 'Inp.vue'),
      ['<template>', '  <input class="field" />', '</template>'].join('\n'),
      'utf8',
    )
    // attr read → null (placeholder absent); text read → '' (element present).
    const send = vi.fn(async (messageType: string, payload?: unknown) => {
      if (messageType !== 'chat:read_rendered_value') return null
      const acc = (payload as { accessor?: { kind?: string } } | undefined)?.accessor
      return acc?.kind === 'attr' ? { value: null } : { value: '' }
    })
    const bridge: BridgeClient = { send }
    const result = await run(
      { bridge, worktreeRoot: root },
      { file: 'Inp.vue', line: 2, selector: '.field', expectedValue: 'Type here', field: 'attribute', attribute: 'placeholder' },
    )
    const body = parse(result)
    expect(body.pass).toBe(false)
    expect(body.observed).toBeNull()
    expect(body.cause).toBe('hmr-stale')
    expect(body.cause).not.toBe('selector-missing')
  })

  it('does not let a quoted > in a bound expr truncate the tag window before a later binding', async () => {
    // `:disabled="count > 0"` contains a `>` that is NOT the tag close; the
    // window must scan past it to the real `:label` binding below. (Codex.)
    await writeFile(
      join(root, 'Gt.vue'),
      [
        '<template>',
        '  <KButton',
        '    :disabled="count > 0"',
        '    :label="title"',
        '    class="save-btn"',
        '  />',
        '</template>',
      ].join('\n'),
      'utf8',
    )
    const { bridge } = bridgeReturning('Old')
    const result = await run(
      { bridge, worktreeRoot: root },
      { file: 'Gt.vue', line: 2, selector: '.save-btn', expectedValue: 'Save', field: 'textContent' },
    )
    const body = parse(result)
    expect(body.pass).toBe(false)
    expect(body.cause).toBe('bound-binding')
  })

  it('does NOT call v-model the cause for a placeholder edit on a v-model input (surface-scoped)', async () => {
    // A plain v-model drives value/checked, not placeholder — so a failed
    // placeholder edit must not be blamed on v-model. (Codex finding.)
    await writeFile(
      join(root, 'Vm.vue'),
      ['<template>', '  <input v-model="name" class="field" />', '</template>'].join('\n'),
      'utf8',
    )
    const { bridge } = bridgeReturning('old ph') // placeholder read differs → fail, element present
    const result = await run(
      { bridge, worktreeRoot: root },
      { file: 'Vm.vue', line: 2, selector: '.field', expectedValue: 'new ph', field: 'attribute', attribute: 'placeholder' },
    )
    const body = parse(result)
    expect(body.pass).toBe(false)
    expect(body.cause).not.toBe('v-model')
    expect(body.cause).toBe('hmr-stale')
  })

  it('DOES call v-model the cause for a value edit on a v-model input (surface-scoped)', async () => {
    // Plain v-model DOES drive value — so a failed value edit is correctly v-model.
    await writeFile(
      join(root, 'Vm2.vue'),
      ['<template>', '  <input v-model="name" class="field" />', '</template>'].join('\n'),
      'utf8',
    )
    const { bridge } = bridgeReturning('old')
    const result = await run(
      { bridge, worktreeRoot: root },
      { file: 'Vm2.vue', line: 2, selector: '.field', expectedValue: 'new', field: 'attribute', attribute: 'value' },
    )
    const body = parse(result)
    expect(body.pass).toBe(false)
    expect(body.cause).toBe('v-model')
  })

  it('does NOT report bound-binding for a component whose element is ABSENT (selector-missing)', async () => {
    // The component has a bound prop, but the element isn't in the DOM (stale
    // selector / not rendered). A binding can't explain a missing element — this
    // must be selector-missing, not bound-binding. (Codex finding.)
    await writeFile(
      join(root, 'Absent.vue'),
      ['<template>', '  <KButton :label="title" class="save-btn" />', '</template>'].join('\n'),
      'utf8',
    )
    const { bridge } = bridgeReturning(null) // every read null → element absent
    const result = await run(
      { bridge, worktreeRoot: root },
      { file: 'Absent.vue', line: 2, selector: '.save-btn', expectedValue: 'Save', field: 'textContent' },
    )
    const body = parse(result)
    expect(body.pass).toBe(false)
    expect(body.observed).toBeNull()
    expect(body.cause).toBe('selector-missing')
    expect(body.cause).not.toBe('bound-binding')
  })

  it('classifies a present-literal whose element is absent as selector-missing', async () => {
    // Literal IS in source (L1 passes) but the element isn't in the DOM.
    await writeFile(
      join(root, 'Card.vue'),
      ['<template>', '  <div class="title">New</div>', '</template>'].join('\n'),
      'utf8',
    )
    const { bridge } = bridgeReturning(null)
    const result = await run(
      { bridge, worktreeRoot: root },
      {
        file: 'Card.vue',
        line: 2,
        selector: '.title',
        expectedValue: 'New',
        field: 'textContent',
      },
    )
    const body = parse(result)
    expect(body.pass).toBe(false)
    expect(body.observed).toBeNull()
    expect(body.cause).toBe('selector-missing')
    expect(body.hint).toMatch(/not found/i)
  })

  it('degrades to a DOM-state cause (hmr-stale) when no worktreeRoot is configured', async () => {
    // No source reader → classification falls back on DOM state: element
    // present, value differs, no binding info → hmr-stale.
    const { bridge } = bridgeReturning('Old')
    const result = await run(
      { bridge },
      { file: 'A.vue', line: 1, selector: 'button', expectedValue: 'Save', field: 'textContent' },
    )
    const body = parse(result)
    expect(body.pass).toBe(false)
    expect(body.observed).toBe('Old')
    expect(body.cause).toBe('hmr-stale')
  })
})

describe('verify_edit — unsupported bridge', () => {
  it('returns skipped (not fail) when the shell reports supported:false', async () => {
    // Old bridge: the shell handler gates and replies supported:false.
    const send = vi.fn(async () => ({ value: null, supported: false }))
    const bridge: BridgeClient = { send }
    const result = await run(
      { bridge },
      { file: 'A.vue', line: 1, selector: 'button', expectedValue: 'Save', field: 'textContent' },
    )
    const body = JSON.parse(result.content[0].text) as {
      skipped?: boolean
      pass?: boolean
      reason?: string
    }
    expect(result.isError).toBeUndefined()
    expect(body.skipped).toBe(true)
    expect(body.pass).toBeUndefined()
    expect(body.reason).toMatch(/too old|capture_screenshot/i)
    // It must NOT poll after learning the bridge is unsupported (one probe read).
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('verify_edit — bridge errors', () => {
  it('surfaces a bridge rejection as isError text', async () => {
    const bridge: BridgeClient = {
      send: vi.fn(async () => {
        throw new Error('bridge_request timed out')
      }),
    }
    const result = await run(
      { bridge },
      { file: 'A.vue', line: 1, selector: 'button', expectedValue: 'Save', field: 'textContent' },
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/verify_edit failed/)
    expect(result.content[0].text).toMatch(/timed out/)
  })
})

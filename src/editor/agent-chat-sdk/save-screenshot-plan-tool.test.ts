/**
 * Unit tests for `saveScreenshotPlanHandler` — validates + writes a
 * ScreenshotPlan to `.desde/screenshot-plans/<id>.json` in the worktree,
 * in the same on-disk format the ScreenshotPlanStore reads.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { saveScreenshotPlanHandler } from './save-screenshot-plan-tool'
import type { ScreenshotPlanStep } from '../core'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'save-plan-test-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const steps: ScreenshotPlanStep[] = [
  { intent: 'open list', kind: 'navigate', route: '/ai-gateway' },
  {
    intent: 'open create',
    kind: 'interact',
    action: 'click',
    target: { description: 'the Create model button', role: 'button', name: 'Create', resolvedSelector: 'button.create' },
  },
  { intent: 'snapshot', kind: 'capture', capture: { scope: 'viewport', label: 'create form' } },
]

async function readPlans(): Promise<unknown[]> {
  const dir = path.join(root, '.desde', 'screenshot-plans')
  const entries = await fs.readdir(dir).catch(() => [])
  const out: unknown[] = []
  for (const e of entries) {
    if (e.endsWith('.json')) out.push(JSON.parse(await fs.readFile(path.join(dir, e), 'utf8')))
  }
  return out
}

describe('saveScreenshotPlanHandler', () => {
  it('writes a valid plan to .desde/screenshot-plans/<id>.json', async () => {
    const res = await saveScreenshotPlanHandler({
      worktreeRoot: root,
      input: { name: 'Create a model', baseUrl: 'http://localhost:5173', prompt: 'go create a model', steps },
    })
    expect(res.isError).toBeFalsy()
    const payload = JSON.parse(res.content[0].text) as { ok: boolean; planId: string; steps: number }
    expect(payload.ok).toBe(true)
    expect(payload.steps).toBe(3)

    const plans = (await readPlans()) as Array<{
      id: string
      name: string
      source: string
      steps: unknown[]
      createdAt: string
      prompt?: string
    }>
    expect(plans).toHaveLength(1)
    expect(plans[0].id).toBe(payload.planId)
    expect(plans[0].name).toBe('Create a model')
    expect(plans[0].source).toBe('prompt')
    expect(plans[0].prompt).toBe('go create a model')
    expect(plans[0].steps).toHaveLength(3)
    expect(plans[0].createdAt).toBeTruthy()
  })

  it('refuses a malformed plan and writes nothing', async () => {
    const res = await saveScreenshotPlanHandler({
      worktreeRoot: root,
      input: {
        name: 'bad',
        baseUrl: 'http://localhost:5173',
        // navigate step missing its route → validateScreenshotPlan rejects
        steps: [{ intent: 'go', kind: 'navigate' }] as ScreenshotPlanStep[],
      },
    })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/malformed|route/i)
    expect(await readPlans()).toEqual([])
  })

  it('refuses without a worktree root', async () => {
    const res = await saveScreenshotPlanHandler({
      worktreeRoot: undefined,
      input: { name: 'x', baseUrl: 'u', steps },
    })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/worktree/i)
  })

  it('omits prompt when not provided', async () => {
    await saveScreenshotPlanHandler({
      worktreeRoot: root,
      input: { name: 'no prompt', baseUrl: 'http://localhost:5173', steps },
    })
    const plans = (await readPlans()) as Array<Record<string, unknown>>
    expect('prompt' in plans[0]).toBe(false)
  })
})

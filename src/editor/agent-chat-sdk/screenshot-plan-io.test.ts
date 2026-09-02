/**
 * Unit tests for the shared plan read/write IO — focused on the containment
 * guard: `writePlanFile` must refuse a write whose `.desde` ancestor is a
 * symlink pointing outside the worktree (codex P2), so a pre-staged symlink
 * can't make `save_screenshot_plan` / `heal_plan_step` escape the worktree.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { writePlanFile, readPlanFile } from './screenshot-plan-io'
import type { ScreenshotPlan } from '../core'

let root: string
let outside: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-io-test-'))
  outside = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-io-outside-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

const plan = (id: string): ScreenshotPlan => ({
  id,
  name: 'Test plan',
  baseUrl: 'http://localhost:5173',
  source: 'prompt',
  createdAt: '2026-06-20T00:00:00.000Z',
  steps: [{ intent: 'open', kind: 'navigate', route: '/x' }],
})

describe('writePlanFile', () => {
  it('writes a new plan and reads it back', async () => {
    const res = await writePlanFile(root, plan('abc'))
    expect(res.ok).toBe(true)
    const back = await readPlanFile(root, 'abc')
    expect(back?.id).toBe('abc')
  })

  it('overwrites an existing plan (heal re-save path)', async () => {
    await writePlanFile(root, plan('abc'))
    const res = await writePlanFile(root, { ...plan('abc'), name: 'Renamed' })
    expect(res.ok).toBe(true)
    const back = await readPlanFile(root, 'abc')
    expect(back?.name).toBe('Renamed')
  })

  it('refuses a write when .desde is a symlink outside the worktree', async () => {
    // Pre-stage `.desde` -> an external dir, the attack the symlink-aware
    // ancestor walk defends against.
    await fs.symlink(outside, path.join(root, '.desde'), 'dir')
    const res = await writePlanFile(root, plan('escape'))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/symlink/i)
    // Nothing was written into the external dir.
    const leaked = await fs
      .readdir(path.join(outside, 'screenshot-plans'))
      .catch(() => null)
    expect(leaked).toBeNull()
  })

  it('refuses a write when the screenshot-plans dir is a symlink outside the worktree', async () => {
    await fs.mkdir(path.join(root, '.desde'), { recursive: true })
    await fs.symlink(outside, path.join(root, '.desde', 'screenshot-plans'), 'dir')
    const res = await writePlanFile(root, plan('escape2'))
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/symlink/i)
    const leaked = await fs.readdir(outside)
    expect(leaked.some((e) => e.endsWith('.json'))).toBe(false)
  })

  it('rejects an unsafe plan id', async () => {
    const res = await writePlanFile(root, plan('../escape'))
    expect(res.ok).toBe(false)
  })
})

/**
 * Task CX8 — the descriptor table's invariants, pinned as a test.
 *
 * Phase 6 was reduced (Mo, 2026-09-04): Kimi and Qwen are deferred, and the
 * `openai-compatible` factory that would have served them was never built.
 * What phase 6 keeps is this file. It pins every property a new descriptor
 * must satisfy, so registering one later is "make this test pass," and it
 * fails loudly the moment either of the two shipped descriptors drifts.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROVIDER_PRECEDENCE, listDescriptors } from './provider-registry'
import { getRateCard, UNKNOWN_MODEL_RATE } from './rate-cards'
import { EFFORT_LEVELS } from '../core/model-catalog'

const CAPABILITY_KEYS = [
  'midTurnSteering',
  'vendorReportedCostUsd',
  'inTurnBudgetStop',
  'reasoningVisibility',
  'vendorRateLimitEvents',
  'imagesInPrompt',
  'webTools',
] as const

describe('the descriptor table', () => {
  it('registers at least the two shipped providers, with unique ids', () => {
    const ids = listDescriptors().map((d) => d.id)
    expect(ids).toEqual(expect.arrayContaining(['anthropic', 'openai']))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('names every precedence entry', () => {
    const ids = new Set(listDescriptors().map((d) => d.id))
    for (const id of DEFAULT_PROVIDER_PRECEDENCE) expect(ids.has(id)).toBe(true)
  })

  for (const d of listDescriptors()) {
    describe(d.id, () => {
      it('has a label, a chat runtime and a full capabilities record', () => {
        expect(d.label.trim().length).toBeGreaterThan(0)
        expect(['claude-agent-sdk', 'neutral']).toContain(d.chatRuntime)
        for (const k of CAPABILITY_KEYS) expect(d.capabilities).toHaveProperty(k)
        expect(['vendor', 'step-boundary']).toContain(d.capabilities.inTurnBudgetStop)
      })

      it('has a usable credential spec', () => {
        expect(d.credentials.apiKeyEnvVar).toMatch(/^[A-Z][A-Z0-9_]+$/)
        expect(d.credentials.maskPrefix.length).toBeGreaterThan(0)
        expect(d.credentials.consoleUrl).toMatch(/^https:\/\//)
        if (d.credentials.baseUrlEnvVar) expect(d.credentials.baseUrlEnvVar).toMatch(/^[A-Z][A-Z0-9_]+$/)
      })

      it('serves a static catalog with exactly one default and a rate card per model', () => {
        expect(d.staticCatalog.providerId).toBe(d.id)
        expect(d.staticCatalog.models.length).toBeGreaterThan(0)
        expect(d.staticCatalog.models.filter((m) => m.isDefault)).toHaveLength(1)
        for (const m of d.staticCatalog.models) {
          expect(getRateCard(m.id), `${d.id}/${m.id} has no rate card`).not.toBe(UNKNOWN_MODEL_RATE)
          if (m.effortLevels) for (const level of m.effortLevels) expect(EFFORT_LEVELS).toContain(level)
        }
      })

      it('maps effort to a request shape without throwing', () => {
        expect(() => d.effort.toRequest(undefined)).not.toThrow()
        for (const level of d.effort.levels ?? []) expect(typeof d.effort.toRequest(level)).toBe('object')
      })

      it('builds a provider from explicit credentials without reading the environment', () => {
        const saved = process.env[d.credentials.apiKeyEnvVar]
        delete process.env[d.credentials.apiKeyEnvVar]
        try {
          const p = d.buildProvider({ apiKey: 'sk-test-only', model: d.staticCatalog.models[0]!.id })
          expect(p.name).toBe(d.id)
          expect(typeof p.streamConversation).toBe('function')
        } finally {
          if (saved !== undefined) process.env[d.credentials.apiKeyEnvVar] = saved
        }
      })
    })
  }
})

import { describe, expect, it } from 'vitest'
import { maskKey, probeCredential } from './credential-probe'
import { ANTHROPIC_DESCRIPTOR } from './descriptors/anthropic'
import { OPENAI_DESCRIPTOR } from './descriptors/openai'

const empty = { providers: {}, devMode: false }

describe('maskKey', () => {
  it('uses the prefix it is given, not a global constant', () => {
    expect(maskKey('sk-ant-api03-abcdefgh4f2a', 'sk-ant-')).toBe('sk-ant-…4f2a')
    expect(maskKey('sk-proj-abcdefgh9999', 'sk-')).toBe('sk-…9999')
  })

  it('masks a short key entirely rather than leaking most of it', () => {
    expect(maskKey('abc', 'sk-ant-')).toBe('sk-ant-…')
  })
})

describe('probeCredential: rungs 0 and 3 are unreachable without a subscription runtime', () => {
  it('dev mode credentials anthropic and says nothing about openai', () => {
    const stored = { providers: {}, devMode: true }
    expect(
      probeCredential({
        descriptor: ANTHROPIC_DESCRIPTOR,
        stored,
        claudeRuntimeResolvable: false,
        subscriptionOptIn: true,
      }),
    ).toEqual({ credentialed: true, source: 'subscription' })
    expect(
      probeCredential({
        descriptor: OPENAI_DESCRIPTOR,
        stored,
        claudeRuntimeResolvable: false,
        subscriptionOptIn: true,
      }),
    ).toEqual({ credentialed: false, source: 'none' })
  })

  it('a resolvable claude runtime never credentials openai', () => {
    expect(
      probeCredential({
        descriptor: OPENAI_DESCRIPTOR,
        stored: empty,
        claudeRuntimeResolvable: true,
        subscriptionOptIn: true,
      }),
    ).toEqual({ credentialed: false, source: 'none' })
  })
})

describe('probeCredential: the env and stored rungs are per provider', () => {
  it('reads the stored slot for the descriptor it was asked about', () => {
    const stored = {
      providers: { anthropic: { apiKey: 'sk-ant-stored5678' } },
      devMode: false,
    }
    expect(
      probeCredential({
        descriptor: ANTHROPIC_DESCRIPTOR,
        stored,
        claudeRuntimeResolvable: false,
      }),
    ).toEqual({
      credentialed: true,
      source: 'stored',
      maskedHint: 'sk-ant-…5678',
    })
    expect(
      probeCredential({
        descriptor: OPENAI_DESCRIPTOR,
        stored,
        claudeRuntimeResolvable: false,
      }),
    ).toEqual({ credentialed: false, source: 'none' })
  })

  it('prefers an inherited env key over a stored one, and masks with the right prefix', () => {
    expect(
      probeCredential({
        descriptor: OPENAI_DESCRIPTOR,
        inheritedApiKey: 'sk-proj-env1234',
        stored: { providers: { openai: { apiKey: 'sk-stored' } }, devMode: false },
        claudeRuntimeResolvable: false,
      }),
    ).toEqual({ credentialed: true, source: 'env', maskedHint: 'sk-…1234' })
  })

  it('treats a whitespace-only stored key as absent', () => {
    expect(
      probeCredential({
        descriptor: OPENAI_DESCRIPTOR,
        stored: { providers: { openai: { apiKey: '   ' } }, devMode: false },
        claudeRuntimeResolvable: false,
      }),
    ).toEqual({ credentialed: false, source: 'none' })
  })
})

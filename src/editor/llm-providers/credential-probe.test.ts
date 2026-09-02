import { describe, expect, it } from 'vitest'
import { maskKey, probeCredential } from './credential-probe'

const noStore = { devMode: false }

describe('maskKey', () => {
  it('shows a fixed prefix and the last four characters', () => {
    expect(maskKey('sk-ant-api03-abcdefgh4f2a')).toBe('sk-ant-…4f2a')
  })

  it('masks a short key entirely rather than leaking most of it', () => {
    expect(maskKey('abc')).toBe('sk-ant-…')
  })
})

describe('probeCredential', () => {
  it('reports dev mode before anything else, even with an env key present', () => {
    const result = probeCredential({
      inheritedApiKey: 'sk-ant-envkey1234',
      stored: { apiKey: 'sk-ant-storedkey5678', devMode: true },
      claudeRuntimeResolvable: false,
    })
    expect(result).toEqual({ credentialed: true, source: 'subscription' })
  })

  it('prefers an env key over a stored key', () => {
    const result = probeCredential({
      inheritedApiKey: 'sk-ant-envkey1234',
      stored: { apiKey: 'sk-ant-storedkey5678', devMode: false },
      claudeRuntimeResolvable: true,
    })
    expect(result).toEqual({
      credentialed: true,
      source: 'env',
      maskedHint: 'sk-ant-…1234',
    })
  })

  it('falls back to the stored key when env is empty', () => {
    const result = probeCredential({
      stored: { apiKey: 'sk-ant-storedkey5678', devMode: false },
      claudeRuntimeResolvable: true,
    })
    expect(result).toEqual({
      credentialed: true,
      source: 'stored',
      maskedHint: 'sk-ant-…5678',
    })
  })

  // The BYO-key cutover. This rung used to fire on `claudeRuntimeResolvable`
  // alone, so anyone whose `claude` binary happened to be signed in got a
  // working product and was never asked for anything. Anthropic's Agent SDK
  // terms do not allow a distributed product to offer claude.ai login that
  // way, so the subscription now needs an explicit opt-in.
  it('does NOT presume the subscription when only the runtime resolves', () => {
    const result = probeCredential({
      stored: noStore,
      claudeRuntimeResolvable: true,
    })
    // Reporting `none` is what makes the first-run dialog ask for a key
    // instead of the product quietly running on someone's subscription.
    expect(result).toEqual({ credentialed: false, source: 'none' })
  })

  it('uses the subscription once it has been opted into', () => {
    const result = probeCredential({
      stored: noStore,
      claudeRuntimeResolvable: true,
      subscriptionOptIn: true,
    })
    expect(result).toEqual({ credentialed: true, source: 'subscription' })
  })

  it('still reports none when opted in but the runtime is absent', () => {
    // The opt-in is permission, not a credential. With no runtime to route
    // through there is nothing to use.
    const result = probeCredential({
      stored: noStore,
      claudeRuntimeResolvable: false,
      subscriptionOptIn: true,
    })
    expect(result).toEqual({ credentialed: false, source: 'none' })
  })

  it('prefers a real key over the subscription even when both are available', () => {
    // Ordering control. If this ever inverted, an opted-in dev would stop
    // exercising the API path that every distributed user is on.
    const result = probeCredential({
      inheritedApiKey: 'sk-ant-envkey1234',
      stored: noStore,
      claudeRuntimeResolvable: true,
      subscriptionOptIn: true,
    })
    expect(result).toEqual({
      credentialed: true,
      source: 'env',
      maskedHint: 'sk-ant-…1234',
    })
  })

  it('reports uncredentialed when nothing is available', () => {
    const result = probeCredential({
      stored: noStore,
      claudeRuntimeResolvable: false,
    })
    expect(result).toEqual({ credentialed: false, source: 'none' })
  })

  it('treats a whitespace-only inherited key as absent', () => {
    const result = probeCredential({
      inheritedApiKey: '   ',
      stored: noStore,
      claudeRuntimeResolvable: false,
    })
    expect(result).toEqual({ credentialed: false, source: 'none' })
  })

  it('treats a whitespace-only stored key as absent', () => {
    const result = probeCredential({
      stored: { apiKey: '  ', devMode: false },
      claudeRuntimeResolvable: false,
    })
    expect(result).toEqual({ credentialed: false, source: 'none' })
  })
})

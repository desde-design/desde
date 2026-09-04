/**
 * Pins the ONE convention `OPENAI_BASE_URL` (and the credential dialog's
 * base-URL field) must follow: the value INCLUDES `/v1`.
 *
 * Before this test existed, three call sites disagreed (final-review-report.md
 * finding I2, CONFIRMED):
 *   - `OPENAI_DESCRIPTOR.validateKey` built `${base}/v1/models` and defaulted
 *     `base` to `https://api.openai.com` — so `base` must NOT include `/v1`.
 *   - `listOpenAiLiveModels` built `${base}/models` and defaulted to
 *     `https://api.openai.com/v1` — so `base` MUST include `/v1`.
 *   - `@ai-sdk/openai`'s `createOpenAI({ baseURL })` also defaults to
 *     `https://api.openai.com/v1` (pinned separately in
 *     `ai-sdk-openai.test.ts`, which is the one file the import fence lets
 *     touch `@ai-sdk/openai` directly — see `eslint.config.mjs`).
 *
 * No single value a user could type worked for both saving the key and
 * running chat. This test drives `validateKey` and `listOpenAiLiveModels`
 * with the SAME default and the SAME explicit gateway URL and checks they
 * build the same request path, so a future edit that reintroduces the
 * mismatch fails here first.
 */
import { describe, expect, it, vi } from 'vitest'
import { OPENAI_DESCRIPTOR } from './openai'
import { listOpenAiLiveModels } from '../openai-live-models'

/** The convention: /v1 INCLUDED. Matches `@ai-sdk/openai`'s own default. */
const AGREED_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

async function fetchUrl(run: (fetchImpl: typeof fetch) => Promise<unknown>): Promise<string> {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
  await run(fetchImpl as unknown as typeof fetch)
  const [url] = fetchImpl.mock.calls[0] as unknown as [string]
  return url
}

describe('OpenAI base URL convention: /v1 is INCLUDED everywhere (I2)', () => {
  it('validateKey and listOpenAiLiveModels hit the SAME URL with no base URL given', async () => {
    const validateUrl = await fetchUrl((fetchImpl) =>
      OPENAI_DESCRIPTOR.validateKey({ apiKey: 'sk-good', fetchImpl }),
    )
    const liveModelsUrl = await fetchUrl((fetchImpl) =>
      listOpenAiLiveModels({ apiKey: 'sk-good', fetchImpl }),
    )
    expect(validateUrl).toBe(`${AGREED_DEFAULT_BASE_URL}/models`)
    expect(liveModelsUrl).toBe(`${AGREED_DEFAULT_BASE_URL}/models`)
    expect(validateUrl).toBe(liveModelsUrl)
  })

  it('validateKey and listOpenAiLiveModels hit the SAME URL for a /v1-included gateway', async () => {
    const gateway = 'https://gw.example.com/v1'
    const validateUrl = await fetchUrl((fetchImpl) =>
      OPENAI_DESCRIPTOR.validateKey({ apiKey: 'sk-good', baseUrl: gateway, fetchImpl }),
    )
    const liveModelsUrl = await fetchUrl((fetchImpl) =>
      listOpenAiLiveModels({ apiKey: 'sk-good', baseUrl: gateway, fetchImpl }),
    )
    expect(validateUrl).toBe(`${gateway}/models`)
    expect(liveModelsUrl).toBe(`${gateway}/models`)
    expect(validateUrl).toBe(liveModelsUrl)
  })

  it('a trailing slash on the gateway URL does not change either result', async () => {
    const validateUrl = await fetchUrl((fetchImpl) =>
      OPENAI_DESCRIPTOR.validateKey({
        apiKey: 'sk-good',
        baseUrl: 'https://gw.example.com/v1/',
        fetchImpl,
      }),
    )
    const liveModelsUrl = await fetchUrl((fetchImpl) =>
      listOpenAiLiveModels({
        apiKey: 'sk-good',
        baseUrl: 'https://gw.example.com/v1/',
        fetchImpl,
      }),
    )
    expect(validateUrl).toBe('https://gw.example.com/v1/models')
    expect(liveModelsUrl).toBe('https://gw.example.com/v1/models')
  })
})

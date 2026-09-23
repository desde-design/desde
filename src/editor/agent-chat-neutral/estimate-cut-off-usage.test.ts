import { describe, expect, it } from 'vitest'

import { estimateCutOffStepUsage } from './estimate-cut-off-usage'

describe('estimateCutOffStepUsage', () => {
  it('copies the previous completed step when there is one', () => {
    expect(
      estimateCutOffStepUsage({
        request: { system: 'x'.repeat(4000), messages: [], tools: [] },
        previousStepInput: 900,
        producedChars: 9,
      }),
    ).toEqual({ inputTokens: 900, outputTokens: 3, estimated: true })
  })

  it("sizes the request by its characters when there is no earlier step, not by an image's base64", () => {
    const withImage = estimateCutOffStepUsage({
      request: {
        system: 'sys',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', mediaType: 'image/png', data: 'A'.repeat(400_000) },
            ],
          },
        ],
        tools: [],
      },
      previousStepInput: undefined,
      producedChars: 0,
    })
    // 400k base64 characters would be 100k tokens. The image is charged a
    // flat 1,600 instead, plus the few characters of the rest.
    expect(withImage.inputTokens).toBeGreaterThan(1_600)
    expect(withImage.inputTokens).toBeLessThan(1_700)
    expect(withImage.outputTokens).toBe(0)
  })
})

import { describe, expect, it } from 'vitest'
import { getDescriptor, isCredentialedFromEnv, listDescriptors } from './provider-registry'
import {
  ChatCredentialsMissingError,
  assertChatCredentials,
  chatCredentialsMessage,
  hasChatCredentials,
} from './assert-chat-credentials'

/**
 * The BYO-key cutover for the chat lane, now per provider (Task 14).
 *
 * Before this gate existed, chat ran on whatever the bundled `claude` binary
 * was signed in with. Someone with a Claude subscription got a fully working
 * product without being asked for anything, billed against their own
 * subscription by our software. That is what Anthropic's Agent SDK terms
 * forbid a distributed product from offering, and the old quickstart
 * advertised it in as many words: "Nothing extra to set."
 *
 * The gate used to check `ANTHROPIC_API_KEY` alone, which was correct back
 * when Anthropic was the only provider. Now that a session can pick OpenAI,
 * the gate has to check the credential the SESSION actually needs, not the
 * one that happened to be first.
 */
describe('hasChatCredentials', () => {
  it("checks the named provider's own key", () => {
    expect(hasChatCredentials({ OPENAI_API_KEY: 'sk-y' }, 'openai')).toBe(true)
    expect(hasChatCredentials({ OPENAI_API_KEY: 'sk-y' }, 'anthropic')).toBe(false)
  })

  it("does not let one provider's key admit another's session", () => {
    // The defect this closes in both directions: an OpenAI session admitted by
    // an unrelated Anthropic key, and an OpenAI-only user refused by a gate
    // that only ever looked at ANTHROPIC_API_KEY.
    expect(hasChatCredentials({ ANTHROPIC_API_KEY: 'sk-ant-x' }, 'openai')).toBe(false)
    expect(hasChatCredentials({ OPENAI_API_KEY: 'sk-y' }, 'anthropic')).toBe(false)
  })

  it('accepts a real Anthropic API key', () => {
    expect(hasChatCredentials({ ANTHROPIC_API_KEY: 'sk-ant-abc123' }, 'anthropic')).toBe(true)
  })

  it('refuses when nothing is configured', () => {
    // The case that matters: a distributed user whose `claude` binary happens
    // to be signed in. The runtime resolves, so the old code proceeded.
    expect(hasChatCredentials({}, 'anthropic')).toBe(false)
    expect(() => assertChatCredentials({}, 'anthropic')).toThrow(ChatCredentialsMissingError)
  })

  it('treats a blank or whitespace key as absent', () => {
    // A key set to "" is a common shape from a .env file with an empty value,
    // and reading it as present would restore the silent-subscription path
    // through the back door.
    expect(hasChatCredentials({ ANTHROPIC_API_KEY: '' }, 'anthropic')).toBe(false)
    expect(hasChatCredentials({ ANTHROPIC_API_KEY: '   ' }, 'anthropic')).toBe(false)
  })

  it('treats a whitespace-only key as absent', () => {
    expect(hasChatCredentials({ OPENAI_API_KEY: '   ' }, 'openai')).toBe(false)
  })

  it('counts the subscription opt-in only for a provider that has one', () => {
    expect(hasChatCredentials({ EDITOR_USE_CLAUDE_SUBSCRIPTION: '1' }, 'anthropic')).toBe(true)
    expect(hasChatCredentials({ EDITOR_USE_CLAUDE_SUBSCRIPTION: '1' }, 'openai')).toBe(false)
  })

  it('accepts other opt-in spellings, shared with the provider registry', () => {
    expect(hasChatCredentials({ EDITOR_USE_CLAUDE_SUBSCRIPTION: 'true' }, 'anthropic')).toBe(true)
    expect(hasChatCredentials({ EDITOR_USE_CLAUDE_SUBSCRIPTION: 'on' }, 'anthropic')).toBe(true)
  })

  it('does not accept a falsy-looking opt-in value', () => {
    expect(hasChatCredentials({ EDITOR_USE_CLAUDE_SUBSCRIPTION: '0' }, 'anthropic')).toBe(false)
    expect(hasChatCredentials({ EDITOR_USE_CLAUDE_SUBSCRIPTION: 'false' }, 'anthropic')).toBe(
      false,
    )
  })

  it('is false for a provider nobody registered', () => {
    expect(hasChatCredentials({ ANTHROPIC_API_KEY: 'sk-ant-x' }, 'moonshot')).toBe(false)
  })

  it('hasChatCredentials agrees with isCredentialedFromEnv for every descriptor and every env shape', () => {
    // The two used to be separate copies of "is this provider usable" (Task
    // 14 review). This is the regression pin: hasChatCredentials must always
    // delegate to the one predicate on the descriptor table, not restate it.
    const envs: NodeJS.ProcessEnv[] = [
      {},
      { ANTHROPIC_API_KEY: 'sk-ant-x' },
      { OPENAI_API_KEY: 'sk-x' },
      { EDITOR_USE_CLAUDE_SUBSCRIPTION: '1' },
      { ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-x' },
    ]
    for (const d of listDescriptors()) {
      for (const env of envs) {
        expect(hasChatCredentials(env, d.id)).toBe(isCredentialedFromEnv(d, env))
      }
    }
  })
})

describe('assertChatCredentials', () => {
  it('names the provider whose key is missing', () => {
    expect(() => assertChatCredentials({}, 'openai')).toThrow(/OpenAI/)
    expect(() => assertChatCredentials({}, 'openai')).toThrow(/OPENAI_API_KEY/)
  })

  it('offers the subscription escape hatch only for anthropic', () => {
    expect(() => assertChatCredentials({}, 'anthropic')).toThrow(/EDITOR_USE_CLAUDE_SUBSCRIPTION/)
    let message = ''
    try {
      assertChatCredentials({}, 'openai')
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).not.toContain('EDITOR_USE_CLAUDE_SUBSCRIPTION')
  })

  it('refuses an unknown provider by name rather than passing it through', () => {
    expect(() => assertChatCredentials({ ANTHROPIC_API_KEY: 'sk-ant-x' }, 'moonshot')).toThrow(
      /moonshot/,
    )
  })

  it('passes when the named provider is credentialed', () => {
    expect(() => assertChatCredentials({ OPENAI_API_KEY: 'sk-y' }, 'openai')).not.toThrow()
  })
})

describe('the refusal message', () => {
  const anthropicDescriptor = getDescriptor('anthropic')!
  const openaiDescriptor = getDescriptor('openai')!
  const message = chatCredentialsMessage(anthropicDescriptor)

  it('leads with the settings gear, which is the only route in the desktop app', () => {
    // A macOS app launched from Finder inherits launchd's environment, not a
    // shell's, so telling a desktop user to export a variable is advice they
    // cannot act on.
    expect(message).toMatch(/settings gear/i)
    expect(message.indexOf('settings gear')).toBeLessThan(message.indexOf('ANTHROPIC_API_KEY'))
  })

  it('says what still works, so the refusal is not read as the product being broken', () => {
    expect(message).toMatch(/inspector/i)
    expect(message).toMatch(/Commit and Publish/)
  })

  it('names the subscription opt-in last, and scoped to running it for yourself', () => {
    expect(message).toContain('EDITOR_USE_CLAUDE_SUBSCRIPTION=1')
    expect(message).toMatch(/only for yourself/i)
    expect(message.indexOf('EDITOR_USE_CLAUDE_SUBSCRIPTION')).toBeGreaterThan(
      message.indexOf('settings gear'),
    )
  })

  it('has no em dashes, which are banned in product copy', () => {
    expect(message).not.toContain('—')
  })

  it('never mentions the subscription opt-in for a provider without one', () => {
    const openaiMessage = chatCredentialsMessage(openaiDescriptor)
    expect(openaiMessage).not.toContain('EDITOR_USE_CLAUDE_SUBSCRIPTION')
    expect(openaiMessage).toMatch(/OpenAI API key/)
    expect(openaiMessage).toMatch(/OPENAI_API_KEY/)
  })
})

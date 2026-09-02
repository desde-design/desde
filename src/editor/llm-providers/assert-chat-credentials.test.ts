import { describe, expect, it } from 'vitest'
import {
  ChatCredentialsMissingError,
  assertChatCredentials,
  chatCredentialsMessage,
  hasChatCredentials,
} from './assert-chat-credentials'

/**
 * The BYO-key cutover for the chat lane.
 *
 * Before this gate existed, chat ran on whatever the bundled `claude` binary
 * was signed in with. Someone with a Claude subscription got a fully working
 * product without being asked for anything, billed against their own
 * subscription by our software. That is what Anthropic's Agent SDK terms
 * forbid a distributed product from offering, and the old quickstart
 * advertised it in as many words: "Nothing extra to set."
 *
 * The non-chat provider registry already required an explicit choice. These
 * tests hold chat to the same rule.
 */
describe('chat credentials', () => {
  it('accepts a real API key', () => {
    expect(hasChatCredentials({ ANTHROPIC_API_KEY: 'sk-ant-abc123' })).toBe(true)
  })

  it('refuses when nothing is configured', () => {
    // The case that matters: a distributed user whose `claude` binary happens
    // to be signed in. The runtime resolves, so the old code proceeded.
    expect(hasChatCredentials({})).toBe(false)
    expect(() => assertChatCredentials({})).toThrow(ChatCredentialsMissingError)
  })

  it('treats a blank or whitespace key as absent', () => {
    // A key set to "" is a common shape from a .env file with an empty value,
    // and reading it as present would restore the silent-subscription path
    // through the back door.
    expect(hasChatCredentials({ ANTHROPIC_API_KEY: '' })).toBe(false)
    expect(hasChatCredentials({ ANTHROPIC_API_KEY: '   ' })).toBe(false)
  })

  it('accepts the subscription once it is explicitly opted into', () => {
    expect(hasChatCredentials({ EDITOR_USE_CLAUDE_SUBSCRIPTION: '1' })).toBe(true)
    expect(hasChatCredentials({ EDITOR_USE_CLAUDE_SUBSCRIPTION: 'true' })).toBe(true)
    expect(hasChatCredentials({ EDITOR_USE_CLAUDE_SUBSCRIPTION: 'on' })).toBe(true)
  })

  it('does not accept a falsy-looking opt-in value', () => {
    // Shares one definition with the provider registry, so the two lanes
    // cannot drift on what counts as opting in.
    expect(hasChatCredentials({ EDITOR_USE_CLAUDE_SUBSCRIPTION: '0' })).toBe(false)
    expect(hasChatCredentials({ EDITOR_USE_CLAUDE_SUBSCRIPTION: 'false' })).toBe(false)
  })

  describe('the refusal message', () => {
    const message = chatCredentialsMessage()

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
  })
})

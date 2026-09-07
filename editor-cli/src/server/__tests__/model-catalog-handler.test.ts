import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildModelCatalogResponse,
  handleModelCatalogRequest,
} from '../model-catalog-handler'
import { ANTHROPIC_MODEL_CATALOG } from '../../../../src/editor/llm-providers/anthropic-model-catalog'
import { OPENAI_MODEL_CATALOG } from '../../../../src/editor/llm-providers/openai-model-catalog'

const twoCatalogs = {
  catalogs: [ANTHROPIC_MODEL_CATALOG, OPENAI_MODEL_CATALOG],
  source: 'static' as const,
}

describe('buildModelCatalogResponse: the default is a decision, not an index', () => {
  it('names the default provider and defaults to its model', () => {
    const body = buildModelCatalogResponse(null, twoCatalogs, {
      env: { OPENAI_API_KEY: 'sk-y' },
    })
    expect(body.defaultProviderId).toBe('openai')
    expect(body.default.provider).toBe('openai')
    expect(body.default.model).toBe('gpt-5.6')
  })

  it('prefers anthropic when both are credentialed', () => {
    const body = buildModelCatalogResponse(null, twoCatalogs, {
      env: { ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-y' },
    })
    expect(body.defaultProviderId).toBe('anthropic')
  })

  it('honours a configured default that is credentialed', () => {
    const body = buildModelCatalogResponse(null, twoCatalogs, {
      env: { ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-y' },
      configuredDefaultProvider: 'openai',
    })
    expect(body.defaultProviderId).toBe('openai')
  })

  it('falls back to a served catalog when the default provider serves none', () => {
    // Nothing credentialed resolves to 'anthropic'; if only OpenAI's catalog
    // were served, the response must still default to a model the client can
    // actually pick rather than throwing.
    const body = buildModelCatalogResponse(
      null,
      { catalogs: [OPENAI_MODEL_CATALOG], source: 'static' },
      { env: {} },
    )
    expect(body.defaultProviderId).toBe('openai')
    expect(body.default.provider).toBe('openai')
  })

  it("carries each catalog's capabilities so the client can gate", () => {
    const body = buildModelCatalogResponse(null, twoCatalogs, { env: {} })
    const anthropic = body.catalogs.find((c) => c.providerId === 'anthropic')
    const openai = body.catalogs.find((c) => c.providerId === 'openai')
    expect(anthropic?.capabilities.midTurnSteering).toBe(true)
    expect(openai?.capabilities.midTurnSteering).toBe(false)
    expect(openai?.capabilities.vendorRateLimitEvents).toBe(false)
  })

  it('still carries the models and the source untouched', () => {
    const body = buildModelCatalogResponse(null, twoCatalogs, { env: {} })
    expect(body.catalogs[0]?.models).toEqual(ANTHROPIC_MODEL_CATALOG.models)
    expect(body.source).toBe('static')
  })
})

describe('buildModelCatalogResponse', () => {
  it('returns the anthropic catalog and its default', () => {
    const body = buildModelCatalogResponse()
    expect(body.catalogs).toHaveLength(1)
    expect(body.catalogs[0].providerId).toBe('anthropic')
    expect(body.default.provider).toBe('anthropic')
    const defaultModel = body.catalogs[0].models.find((m) => m.isDefault)
    expect(body.default.model).toBe(defaultModel?.id)
  })

  it('defaults lastChosenModel to null and the source to static', () => {
    expect(buildModelCatalogResponse().lastChosenModel).toBeNull()
    expect(buildModelCatalogResponse().source).toBe('static')
  })
})

/**
 * The chip cannot know what a NEW chat will run without this. A minted
 * session has no persisted choice, so the endpoint answers the only
 * question that has one: what did the user last choose in this project?
 *
 * These write real session files through the real session store into a
 * temp repo, then call the real handler. Nothing hands the answer in;
 * the value has to be derived from what was persisted.
 */
describe('handleModelCatalogRequest — lastChosenModel', () => {
  let repoRoot: string

  function makeRes() {
    const state = { statusCode: 0, body: '' }
    const res = {
      statusCode: 0,
      setHeader: () => {},
      end: (chunk?: string) => {
        state.body = chunk ?? ''
        state.statusCode = (res as unknown as { statusCode: number }).statusCode
      },
    } as unknown as ServerResponse
    return { res, state }
  }

  /**
   * Persist a session the way a finished chat turn leaves one: an id,
   * an `updatedAt`, and the model that turn ran on.
   *
   * `saveSession` stamps `updatedAt` itself, so ordering is written
   * directly to disk afterwards — the listing sorts on that string and
   * "most recent" is the whole point of these cases.
   */
  async function seedSession(
    sessionId: string,
    modelConfig: unknown,
    updatedAt: string,
  ): Promise<void> {
    const { projectIdForRepoRoot, sessionFilePath, saveSession } = await import(
      '../../../../src/editor/agent-chat/session-store.js'
    )
    const { makeEmptySession } = await import(
      '../../../../src/editor/agent-chat/types.js'
    )
    const projectId = projectIdForRepoRoot(repoRoot)
    const session = makeEmptySession(projectId, sessionId)
    if (modelConfig !== undefined) {
      ;(session as unknown as Record<string, unknown>).modelConfig = modelConfig
    }
    await saveSession(repoRoot, session)
    const path = sessionFilePath(repoRoot, sessionId)
    const { readFile } = await import('node:fs/promises')
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    raw.updatedAt = updatedAt
    await writeFile(path, JSON.stringify(raw), 'utf8')
  }

  async function readLastChosen(): Promise<unknown> {
    const { res, state } = makeRes()
    await handleModelCatalogRequest({} as IncomingMessage, res, repoRoot)
    expect(state.statusCode).toBe(200)
    return JSON.parse(state.body).lastChosenModel
  }

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'desde-model-catalog-'))
  })
  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true })
  })

  it('is null when the project has never been chatted in', async () => {
    expect(await readLastChosen()).toBeNull()
  })

  it('is null when no session ever carried a choice', async () => {
    await seedSession('s1', undefined, '2026-08-10T00:00:00.000Z')
    expect(await readLastChosen()).toBeNull()
  })

  it('returns the choice from the most recently updated session', async () => {
    // The regression this pins: reading the PROJECT-DEFAULT session
    // instead. That session stopped receiving turns when opening a
    // project started minting a fresh one, so its choice froze. Here it
    // is the older record, and the newer chat is what the user last
    // used.
    const { projectIdForRepoRoot } = await import(
      '../../../../src/editor/agent-chat/session-store.js'
    )
    await seedSession(
      projectIdForRepoRoot(repoRoot),
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      '2026-07-01T00:00:00.000Z',
    )
    await seedSession(
      'minted-yesterday',
      { provider: 'anthropic', model: 'claude-opus-4-8' },
      '2026-08-13T00:00:00.000Z',
    )
    expect(await readLastChosen()).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
    })
  })

  it('ignores newer sessions that carry no choice', async () => {
    await seedSession(
      'chose-a-model',
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      '2026-08-12T00:00:00.000Z',
    )
    await seedSession('never-picked', undefined, '2026-08-13T00:00:00.000Z')
    expect(await readLastChosen()).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    })
  })

  it('falls through a retired model to the next-newest real choice', async () => {
    // A model that has left the catalog reconciles to null, which the
    // client cannot tell apart from "never chose one". Falling through
    // keeps a real preference alive rather than dropping the user back
    // to the runtime default over one stale record.
    await seedSession(
      'older',
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
      '2026-08-12T00:00:00.000Z',
    )
    await seedSession(
      'newer',
      { provider: 'anthropic', model: 'claude-retired-1' },
      '2026-08-13T00:00:00.000Z',
    )
    expect(await readLastChosen()).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    })
  })

  it('is null when every saved choice has left the catalog', async () => {
    await seedSession(
      'only',
      { provider: 'anthropic', model: 'claude-retired-1' },
      '2026-08-13T00:00:00.000Z',
    )
    expect(await readLastChosen()).toBeNull()
  })

  it('strips an effort the saved model does not support', async () => {
    await seedSession(
      'only',
      { provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' },
      '2026-08-13T00:00:00.000Z',
    )
    expect(await readLastChosen()).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    })
  })

  it('still answers 200 when a session file is unreadable garbage', async () => {
    const dir = join(repoRoot, '.desde', 'chat-sessions')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'broken.json'), 'not json', 'utf8')
    const { res, state } = makeRes()
    await handleModelCatalogRequest({} as IncomingMessage, res, repoRoot)
    expect(state.statusCode).toBe(200)
    const body = JSON.parse(state.body)
    expect(body.lastChosenModel).toBeNull()
    // No credentials in this test's env, so only the precedence default
    // (Anthropic) is served, static (codex fix: an uncredentialed provider
    // is not served at all, even when its chat runtime is servable).
    expect(body.catalogs).toHaveLength(1)
  })
})

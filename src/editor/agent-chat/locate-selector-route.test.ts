import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  extractSelectorToken,
  fillRouteParams,
  locateSelectorRoute,
} from './locate-selector-route'

describe('extractSelectorToken', () => {
  it('returns the class name for a simple class selector', () => {
    expect(extractSelectorToken('.mode-selector-wrapper')).toBe('mode-selector-wrapper')
  })
  it('prefers an id over a class', () => {
    expect(extractSelectorToken('#main .card')).toBe('main')
  })
  it('returns the LAST (most specific) class in a descendant selector', () => {
    expect(extractSelectorToken('.a .b .c')).toBe('c')
  })
  it('returns null when there is no class or id', () => {
    expect(extractSelectorToken('div > span')).toBeNull()
  })
})

describe('fillRouteParams', () => {
  it('borrows a param positionally from the current path', () => {
    expect(
      fillRouteParams('/ai-gateway/:id/mcp-servers/create', '/ai-gateway/abc/mcp-servers'),
    ).toBe('/ai-gateway/abc/mcp-servers/create')
  })
  it('returns null when a param has no value to borrow', () => {
    expect(
      fillRouteParams(
        '/ai-gateway/:gatewayId/mcp-servers/:mcpServerId/edit',
        '/ai-gateway/abc/mcp-servers',
      ),
    ).toBeNull()
  })
  it('returns null when a static segment mismatches (different subtree)', () => {
    expect(fillRouteParams('/users/:id/edit', '/posts/5')).toBeNull()
  })
  it('passes a param-free route through unchanged', () => {
    expect(fillRouteParams('/static/page', '/anything/else')).toBe('/static/page')
  })
  it('refuses catch-all routes', () => {
    expect(fillRouteParams('/:pathMatch(.*)*', '/whatever')).toBeNull()
  })
})

// ── locateSelectorRoute (filesystem) ─────────────────────────────────────────

const ROUTER = `import { createRouter, createWebHistory } from 'vue-router'

import AIGatewayMCPServerCreate from '../views/AIGatewayMCPServerCreate.vue'
import DirectView from '../views/DirectView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/ai-gateway/:id/mcp-servers/create',
      name: 'ai-gateway-mcp-server-create',
      component: AIGatewayMCPServerCreate
    },
    {
      path: '/ai-gateway/:gatewayId/mcp-servers/:mcpServerId/edit',
      name: 'ai-gateway-mcp-server-edit',
      component: AIGatewayMCPServerCreate
    },
    {
      path: '/direct',
      name: 'direct',
      component: DirectView
    }
  ]
})

export default router
`

const VIEW_CREATE = `<template>
  <AIGatewayPage>
    <MCPServerCreateStepWizard />
  </AIGatewayPage>
</template>

<script setup lang="ts">
import MCPServerCreateStepWizard from '../components/mcp-server-create/MCPServerCreateStepWizard.vue'
</script>
`

const WIZARD = `<template>
  <div class="mode-selector-wrapper">
    <KRadio v-for="o in modeOptions" :key="o.value" :label="o.label" />
  </div>
</template>
`

const VIEW_DIRECT = `<template>
  <div class="direct-thing">hello</div>
</template>
`

describe('locateSelectorRoute', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'locate-selector-'))
    await mkdir(join(root, 'src/router'), { recursive: true })
    await mkdir(join(root, 'src/views'), { recursive: true })
    await mkdir(join(root, 'src/components/mcp-server-create'), { recursive: true })
    await writeFile(join(root, 'src/router/index.ts'), ROUTER)
    await writeFile(join(root, 'src/views/AIGatewayMCPServerCreate.vue'), VIEW_CREATE)
    await writeFile(join(root, 'src/views/DirectView.vue'), VIEW_DIRECT)
    await writeFile(
      join(root, 'src/components/mcp-server-create/MCPServerCreateStepWizard.vue'),
      WIZARD,
    )
  })

  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('resolves a selector in a CHILD component up to the routed view (one-level import walk)', async () => {
    const r = await locateSelectorRoute({
      worktreeRoot: root,
      selector: '.mode-selector-wrapper',
      currentUrl: '/ai-gateway/abc/mcp-servers',
    })
    expect(r.ok).toBe(true)
    expect(r.sourceFiles).toContain(
      'src/components/mcp-server-create/MCPServerCreateStepWizard.vue',
    )
    const paths = r.routes.map((x) => x.path)
    expect(paths).toContain('/ai-gateway/:id/mcp-servers/create')
    expect(paths).toContain('/ai-gateway/:gatewayId/mcp-servers/:mcpServerId/edit')
    // The create route's :id is fillable from the current URL; the edit route's
    // :mcpServerId is not → only create is navigable.
    expect(r.navigableUrls).toContain('/ai-gateway/abc/mcp-servers/create')
    expect(r.navigableUrls).not.toContain(
      '/ai-gateway/abc/mcp-servers/abc/edit',
    )
  })

  it('returns routes but no navigable URLs when params cannot be filled', async () => {
    const r = await locateSelectorRoute({
      worktreeRoot: root,
      selector: '.mode-selector-wrapper',
      currentUrl: '/', // no :id available
    })
    expect(r.ok).toBe(true)
    expect(r.routes.length).toBeGreaterThan(0)
    expect(r.navigableUrls).toHaveLength(0)
  })

  it('directly matches a selector in a routed view (no nesting) and navigates a param-free route', async () => {
    const r = await locateSelectorRoute({
      worktreeRoot: root,
      selector: '.direct-thing',
      currentUrl: '/somewhere',
    })
    expect(r.ok).toBe(true)
    expect(r.sourceFiles).toContain('src/views/DirectView.vue')
    expect(r.navigableUrls).toContain('/direct')
  })

  it('fails cleanly when the selector token is not in any source', async () => {
    const r = await locateSelectorRoute({
      worktreeRoot: root,
      selector: '.totally-absent-class',
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not found/i)
  })
})

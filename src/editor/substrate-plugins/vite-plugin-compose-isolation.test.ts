/**
 * Tests for the editor isolation Vite plugin (Phase F3).
 *
 * Exercises the middleware's path-decoding, validation, and HTML
 * rendering against a faked req/res pair — no real Vite server needed.
 */

import { describe, expect, it, vi } from 'vitest'
import { composeIsolationPlugin } from './vite-plugin-compose-isolation'

interface FakeReq {
  url?: string
}

interface FakeRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  ended: boolean
  setHeader(name: string, value: string): void
  end(body?: string): void
}

function makeRes(): FakeRes {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    ended: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(body) {
      this.body = body ?? ''
      this.ended = true
    },
  }
}

function configurePlugin(
  transformIndexHtml?: (url: string, html: string) => string | Promise<string>,
  pluginOptions?: Parameters<typeof composeIsolationPlugin>[0],
) {
  const plugin = composeIsolationPlugin(pluginOptions)
  if (typeof plugin.configureServer !== 'function') {
    throw new Error('plugin missing configureServer')
  }
  type MwHandler = (
    req: FakeReq,
    res: FakeRes,
    next: () => void,
  ) => void | Promise<void>
  let middleware: MwHandler | null = null
  const transformSpy = vi.fn(transformIndexHtml ?? (async (_url: string, html: string) => html))
  const fakeServer = {
    middlewares: {
      use(handler: MwHandler) {
        middleware = handler
      },
    },
    transformIndexHtml: transformSpy,
  } as unknown as import('vite').ViteDevServer
  const result = (plugin.configureServer as (s: typeof fakeServer) => unknown)(fakeServer)
  void result
  if (!middleware) throw new Error('middleware not registered')
  return { middleware: middleware as MwHandler, transformSpy }
}

async function runMiddleware(
  url: string | undefined,
  transformIndexHtml?: (url: string, html: string) => string | Promise<string>,
  pluginOptions?: Parameters<typeof composeIsolationPlugin>[0],
): Promise<{
  res: FakeRes
  nextCalled: boolean
  transformSpy: ReturnType<typeof vi.fn>
}> {
  const { middleware, transformSpy } = configurePlugin(transformIndexHtml, pluginOptions)
  const req: FakeReq = { url }
  const res = makeRes()
  const next = vi.fn()
  await middleware(req, res, next)
  return { res, nextCalled: next.mock.calls.length > 0, transformSpy }
}

/** Build the second path segment: base64url-encoded JSON config. */
function encodeConfig(config: object): string {
  return Buffer.from(JSON.stringify(config))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Build a full route URL: spec + optional config. */
function makeUrl(spec: string, config?: object): string {
  const base = '/__compose/component/' + encodeURIComponent(spec)
  return config === undefined ? base : `${base}/${encodeConfig(config)}`
}

describe('composeIsolationPlugin', () => {
  it('calls next() for unrelated paths', async () => {
    const { nextCalled, res } = await runMiddleware('/src/App.vue')
    expect(nextCalled).toBe(true)
    expect(res.ended).toBe(false)
  })

  it('calls next() when req.url is missing', async () => {
    const { nextCalled } = await runMiddleware(undefined)
    expect(nextCalled).toBe(true)
  })

  it('returns 400 when no component spec is provided', async () => {
    const { res } = await runMiddleware('/__compose/component/')
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/missing component spec/)
  })

  it('returns 400 for non-.vue files (without config.name)', async () => {
    const { res } = await runMiddleware(makeUrl('src/lib.ts'))
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/file spec must end in \.vue/)
  })

  it('returns 400 for path traversal attempts', async () => {
    const { res } = await runMiddleware(makeUrl('../../etc/passwd.vue'))
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/path traversal/)
  })

  it('returns 400 for too many path segments', async () => {
    // Spec + config = 2 segments. Anything beyond that is wrong.
    const { res } = await runMiddleware(
      `/__compose/component/${encodeURIComponent('src/X.vue')}/${encodeConfig({})}/extra`,
    )
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/too many path segments/)
  })

  it('renders HTML that imports the component from a Vite-served URL', async () => {
    const { res } = await runMiddleware(makeUrl('src/components/MyButton.vue'))
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.body).toContain(`from "/src/components/MyButton.vue"`)
    expect(res.body).toContain('const fallbackProps = {}')
    expect(res.body).toContain('MyButton')
  })

  it('splices a JSON-validated config.props payload into the fallback mount', async () => {
    const props = { variant: 'danger', disabled: true }
    const { res } = await runMiddleware(
      makeUrl('src/components/MyButton.vue', { props }),
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toMatch(
      /const fallbackProps = \{"variant":"danger","disabled":true\}/,
    )
  })

  it('escapes HTML in the component name surfaced in <title> + toolbar', async () => {
    const { res } = await runMiddleware(
      makeUrl('src/components/<EvilName>.vue'),
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('&lt;EvilName&gt;')
    const toolbarMatch = res.body.match(
      /<span class="name">([^<]+)<\/span>/,
    )
    expect(toolbarMatch?.[1]).not.toMatch(/<|>/)
  })

  it('returns 400 for malformed percent-encoding (no unhandled URIError)', async () => {
    const { res } = await runMiddleware('/__compose/component/%E0%A4%A.vue')
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/malformed URI encoding/)
  })

  it('escapes </script> sequences inside config.props to prevent XSS', async () => {
    const { res } = await runMiddleware(
      makeUrl('src/components/X.vue', {
        props: { label: '</script><script>alert(1)</script>' },
      }),
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toMatch(/<\/script>\s*<script>alert\(1\)/)
    expect(res.body).toContain('<\\/script>')
  })

  it('escapes <!-- sequences inside config.props', async () => {
    const { res } = await runMiddleware(
      makeUrl('src/components/X.vue', {
        props: { note: '<!-- not a comment -->' },
      }),
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('<!-- not a comment')
    expect(res.body).toContain('<\\!--')
  })

  it('marks the toolbar with data-prototype-flow so the bridge ignores it for selection', async () => {
    const { res } = await runMiddleware(makeUrl('src/components/X.vue'))
    expect(res.body).toContain('data-prototype-flow')
  })

  it('renders a variant grid when config.variants is non-empty', async () => {
    const variants = [
      { label: 'appearance: primary', props: { appearance: 'primary' } },
      { label: 'appearance: danger', props: { appearance: 'danger' } },
    ]
    const { res } = await runMiddleware(
      makeUrl('src/components/MyButton.vue', { variants }),
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('variant-grid')
    expect(res.body).toMatch(/const variants = \[/)
    expect(res.body).toContain('appearance: primary')
    expect(res.body).toContain('appearance: danger')
  })

  it('renders the empty-state when config.variants is an empty array', async () => {
    const { res } = await runMiddleware(
      makeUrl('src/components/MyButton.vue', { variants: [] }),
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('No demo data available')
    expect(res.body).toContain('const variants = []')
  })

  it('returns 400 when config.variants is not an array', async () => {
    const { res } = await runMiddleware(
      makeUrl('src/components/X.vue', { variants: { not: 'array' } }),
    )
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/variants must be an array/)
  })

  it('escapes </script> and <!-- inside config.variants', async () => {
    const variants = [
      { label: '</script><script>alert(1)</script>', props: {} },
      { label: '<!-- evil -->', props: {} },
    ]
    const { res } = await runMiddleware(
      makeUrl('src/components/X.vue', { variants }),
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toMatch(/<\/script>\s*<script>alert\(1\)/)
    expect(res.body).toContain('<\\/script>')
    expect(res.body).toContain('<\\!--')
  })

  it('emits a named import when config.name is provided with a package spec', async () => {
    const { res } = await runMiddleware(
      makeUrl('@acme/design-system', { name: 'UiButton' }),
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(
      `import { UiButton as Component } from "@acme/design-system"`,
    )
    expect(res.body).not.toContain(`from "/@acme/design-system"`)
  })

  it('returns 400 when config.name references a malicious package spec', async () => {
    const { res } = await runMiddleware(
      makeUrl('https://evil.example/x.js', { name: 'Pwn' }),
    )
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/npm-style/)
  })

  it('returns 400 when config.name is not a valid JS identifier', async () => {
    const { res } = await runMiddleware(
      makeUrl('@acme/design-system', { name: 'alert(1);//' }),
    )
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/valid JS identifier/)
  })

  it('returns 400 when the config segment is not valid base64url', async () => {
    const { res } = await runMiddleware(
      `/__compose/component/${encodeURIComponent('src/X.vue')}/not%20valid`,
    )
    expect(res.statusCode).toBe(400)
    // After URL decoding, "not valid" contains a space → not base64url.
    expect(res.body).toMatch(/base64url|JSON/)
  })

  it('returns 400 when the config segment is not valid JSON', async () => {
    // base64url-encoded "not-json" — decodes to a string, which fails
    // both JSON.parse and the "must be object" check.
    const garbage = Buffer.from('not-json').toString('base64').replace(/=+$/, '')
    const { res } = await runMiddleware(
      `/__compose/component/${encodeURIComponent('src/X.vue')}/${garbage}`,
    )
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatch(/JSON|object/)
  })

  it('emits side-effect imports for cssImports option', async () => {
    const { res } = await runMiddleware(
      makeUrl('src/components/X.vue'),
      undefined,
      { cssImports: ['@acme/design-system/dist/style.css', './styles/main.css'] },
    )
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(`import "@acme/design-system/dist/style.css"`)
    expect(res.body).toContain(`import "./styles/main.css"`)
  })

  it('throws at plugin setup when cssImports contains a malicious entry', () => {
    expect(() =>
      composeIsolationPlugin({
        cssImports: ['" + alert(1) + "'],
      }),
    ).toThrow(/invalid cssImports/)
    expect(() =>
      composeIsolationPlugin({
        cssImports: ['../../etc/passwd'],
      }),
    ).toThrow(/invalid cssImports/)
  })

  it('passes the rendered HTML through server.transformIndexHtml so bare specifiers resolve', async () => {
    // Without this, `import { createApp } from 'vue'` would fail in
    // the browser as an unresolvable bare specifier and the canvas
    // would stay blank.
    const fakeTransform = vi.fn(async (_url: string, html: string) =>
      html.replace(`from 'vue'`, `from "/transformed/vue.js"`),
    )
    const { res, transformSpy } = await runMiddleware(
      makeUrl('src/components/X.vue'),
      fakeTransform,
    )
    expect(transformSpy).toHaveBeenCalledTimes(1)
    expect(res.body).toContain('/transformed/vue.js')
    expect(res.body).not.toContain(`from 'vue'`)
  })
})

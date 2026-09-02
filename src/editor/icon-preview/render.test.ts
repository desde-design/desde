import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { iconPreviewCandidateDirs, iconPreviewScriptPath, renderIconPreviews } from './render'

/**
 * The renderer's contract: spawn `node <scriptPath>` with cwd =
 * prototypeRoot, pass `{ packageName, iconExports }` on stdin, parse
 * `{ previews, failures }` from stdout. These tests use synthetic
 * scripts so they exercise the IPC + lifecycle without booting Vue.
 */
describe('renderIconPreviews', () => {
  let prototypeRoot: string

  beforeEach(async () => {
    prototypeRoot = await mkdtemp(join(tmpdir(), 'pt-icon-render-'))
  })

  afterEach(async () => {
    await rm(prototypeRoot, { recursive: true, force: true })
  })

  it('returns empty result for empty iconExports without spawning', async () => {
    const result = await renderIconPreviews({
      framework: 'vue3',
      packageName: '@anything/icons',
      iconExports: [],
      prototypeRoot,
      scriptPath: '/this/path/does/not/exist.mjs',
    })

    expect(result).toEqual({ previews: {}, failures: {} })
  })

  it('parses well-formed subprocess output', async () => {
    const script = join(prototypeRoot, 'fake-renderer.mjs')
    await writeFile(
      script,
      `
import { Buffer } from 'node:buffer'
const chunks = []
for await (const c of process.stdin) chunks.push(c)
const { iconExports } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const previews = Object.fromEntries(iconExports.map((n) => [n, '<svg id="' + n + '"/>']))
process.stdout.write(JSON.stringify({ previews, failures: {} }))
`,
    )

    const result = await renderIconPreviews({
      framework: 'vue3',
      packageName: '@anything/icons',
      iconExports: ['IconA', 'IconB'],
      prototypeRoot,
      scriptPath: script,
    })

    expect(result.previews).toEqual({
      IconA: '<svg id="IconA"/>',
      IconB: '<svg id="IconB"/>',
    })
    expect(result.failures).toEqual({})
  })

  it('forwards partial failures from the subprocess', async () => {
    const script = join(prototypeRoot, 'partial-fail.mjs')
    await writeFile(
      script,
      `process.stdout.write(JSON.stringify({ previews: { IconA: '<svg/>' }, failures: { IconB: 'nope' } }))`,
    )

    const result = await renderIconPreviews({
      framework: 'vue3',
      packageName: '@anything/icons',
      iconExports: ['IconA', 'IconB'],
      prototypeRoot,
      scriptPath: script,
    })

    expect(result.previews).toEqual({ IconA: '<svg/>' })
    expect(result.failures).toEqual({ IconB: 'nope' })
  })

  it('rejects when the subprocess exits with a non-zero code', async () => {
    const script = join(prototypeRoot, 'crash.mjs')
    await writeFile(
      script,
      `process.stderr.write('boom\\n'); process.exitCode = 7`,
    )

    await expect(
      renderIconPreviews({
        framework: 'vue3',
        packageName: '@anything/icons',
        iconExports: ['IconA'],
        prototypeRoot,
        scriptPath: script,
      }),
    ).rejects.toThrow(/exited with code 7/)
  })

  it('rejects when stdout is not valid JSON', async () => {
    const script = join(prototypeRoot, 'garbage.mjs')
    await writeFile(script, `process.stdout.write('not json')`)

    await expect(
      renderIconPreviews({
        framework: 'vue3',
        packageName: '@anything/icons',
        iconExports: ['IconA'],
        prototypeRoot,
        scriptPath: script,
      }),
    ).rejects.toThrow(/invalid JSON/)
  })

  it('SIGTERMs and rejects after the configured timeout', async () => {
    const script = join(prototypeRoot, 'hang.mjs')
    // setInterval keeps the event loop alive, so Node won't bail on
    // an unsettled top-level await. The orchestrator must SIGTERM.
    await writeFile(script, `setInterval(() => {}, 1000)`)

    await expect(
      renderIconPreviews({
        framework: 'vue3',
        packageName: '@anything/icons',
        iconExports: ['IconA'],
        prototypeRoot,
        scriptPath: script,
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/timed out/)
  })

  it('refuses unsupported frameworks', async () => {
    await expect(
      renderIconPreviews({
        framework: 'react',
        packageName: '@anything/icons',
        iconExports: ['IconA'],
        prototypeRoot,
      }),
    ).rejects.toThrow(/React is not implemented yet/)

    await expect(
      renderIconPreviews({
        framework: 'any',
        packageName: '@anything/icons',
        iconExports: ['IconA'],
        prototypeRoot,
      }),
    ).rejects.toThrow(/requires a concrete framework/)
  })
})

/**
 * `iconPreviewCandidateDirs` / `iconPreviewScriptPath` — the probe that
 * replaced a single computed `HERE`-relative path (fix-round-1 finding 1).
 * `render.ts` is transitively bundled (`core.ts` → `icon-sets/auto-detect.ts`
 * → `adapters/icon-sets/npm-named-exports/index.ts` → here), so its own
 * `import.meta.url` collapses to the BUNDLE's location once
 * `editor-cli/dist/cli.js` exists — a depth this file never runs from
 * unbundled. These tests are what proves the probe actually resolves the
 * script from that location instead of silently missing it.
 */
describe('icon-preview path resolution', () => {
  // This test file lives at src/editor/icon-preview/render.test.ts — four
  // segments below the repo root — so this derives REPO_ROOT rather than
  // hardcoding an absolute path.
  const REPO_ROOT = resolvePath(fileURLToPath(import.meta.url), '..', '..', '..', '..')
  const REAL_ICON_PREVIEW_DIR = resolvePath(REPO_ROOT, 'src', 'editor', 'icon-preview')
  // editor-cli/dist doesn't exist in this checkout (nothing has bundled the
  // CLI yet) — which is exactly what makes it a faithful stand-in for "this
  // file, bundled": a directory with no render-vue.mjs of its own.
  const SIMULATED_BUNDLE_DIR = resolvePath(REPO_ROOT, 'editor-cli', 'dist')

  let priorPayloadRoot: string | undefined

  beforeEach(() => {
    priorPayloadRoot = process.env.EDITOR_PAYLOAD_ROOT
    delete process.env.EDITOR_PAYLOAD_ROOT
  })

  afterEach(() => {
    if (priorPayloadRoot === undefined) delete process.env.EDITOR_PAYLOAD_ROOT
    else process.env.EDITOR_PAYLOAD_ROOT = priorPayloadRoot
  })

  describe('iconPreviewCandidateDirs', () => {
    it('has no payload candidate when EDITOR_PAYLOAD_ROOT is unset', () => {
      expect(iconPreviewCandidateDirs(REAL_ICON_PREVIEW_DIR)).toEqual([
        REAL_ICON_PREVIEW_DIR,
        resolvePath(REAL_ICON_PREVIEW_DIR, '..', '..', 'src', 'editor', 'icon-preview'),
      ])
    })

    it('treats an empty string the same as unset', () => {
      process.env.EDITOR_PAYLOAD_ROOT = ''
      expect(iconPreviewCandidateDirs(REAL_ICON_PREVIEW_DIR)).toHaveLength(2)
    })

    it('treats a whitespace-only value the same as unset', () => {
      process.env.EDITOR_PAYLOAD_ROOT = '   \t  '
      expect(iconPreviewCandidateDirs(REAL_ICON_PREVIEW_DIR)).toHaveLength(2)
    })

    it('puts <EDITOR_PAYLOAD_ROOT>/icon-preview first when set', () => {
      process.env.EDITOR_PAYLOAD_ROOT = '/tmp/payload'
      expect(iconPreviewCandidateDirs(REAL_ICON_PREVIEW_DIR)[0]).toBe(
        resolvePath('/tmp/payload', 'icon-preview'),
      )
    })

    it('throws on a relative EDITOR_PAYLOAD_ROOT, naming the variable and the value', () => {
      process.env.EDITOR_PAYLOAD_ROOT = 'relative/payload'
      expect(() => iconPreviewCandidateDirs(REAL_ICON_PREVIEW_DIR)).toThrow(
        /EDITOR_PAYLOAD_ROOT/,
      )
      expect(() => iconPreviewCandidateDirs(REAL_ICON_PREVIEW_DIR)).toThrow(
        /relative\/payload/,
      )
    })

    /**
     * Regression coverage for fix-round findings F1: this function used to
     * `.trim()` the value before validating/using it, diverging from
     * `payload-paths.ts`'s `payloadRoot()` (fixed in a1a96691 to stop
     * trimming) even though this module's doc comment promises identical
     * rules. A directory whose real name ends in a space is valid on macOS
     * and Linux — trimming silently rewrote it to a different, likely
     * nonexistent path, and the resulting failure (a missing
     * `render-vue.mjs`) pointed nowhere near the real cause. The candidate
     * must be built from the value byte-for-byte, trailing space included.
     */
    it('preserves a trailing space in EDITOR_PAYLOAD_ROOT rather than trimming it away', () => {
      const withTrailingSpace = '/tmp/payload '
      process.env.EDITOR_PAYLOAD_ROOT = withTrailingSpace
      expect(iconPreviewCandidateDirs(REAL_ICON_PREVIEW_DIR)[0]).toBe(
        resolvePath(withTrailingSpace, 'icon-preview'),
      )
    })

    /**
     * Same defect, the other end of the string — and the more dangerous
     * half. Before the fix, a leading space made `raw.trim()` produce a
     * DIFFERENT absolute path that `isAbsolute` accepted, so the value was
     * silently "corrected" here while `payloadRoot()` (never trimming)
     * already threw on the very same untrimmed value — one env var, two
     * behaviors, inside one process. After the fix both throw.
     */
    it('throws on a leading space in EDITOR_PAYLOAD_ROOT instead of silently correcting it', () => {
      process.env.EDITOR_PAYLOAD_ROOT = ' /tmp/payload'
      expect(() => iconPreviewCandidateDirs(REAL_ICON_PREVIEW_DIR)).toThrow(
        /EDITOR_PAYLOAD_ROOT/,
      )
      expect(() => iconPreviewCandidateDirs(REAL_ICON_PREVIEW_DIR)).toThrow(
        / \/tmp\/payload/,
      )
    })

    it('the bundled-in-checkout candidate lands on the real icon-preview dir', () => {
      // This is the fix: from a simulated editor-cli/dist location, the third
      // candidate must resolve back to where render-vue.mjs actually lives.
      const dirs = iconPreviewCandidateDirs(SIMULATED_BUNDLE_DIR)
      expect(dirs).toContain(REAL_ICON_PREVIEW_DIR)
    })
  })

  describe('iconPreviewScriptPath', () => {
    it('resolves render-vue.mjs when run unbundled (the default `here`)', async () => {
      const path = await iconPreviewScriptPath('render-vue.mjs')
      expect(path).toBe(resolvePath(REAL_ICON_PREVIEW_DIR, 'render-vue.mjs'))
    })

    it(
      'the failure the probe prevents: the naive bundled-location candidate has no script',
      async () => {
        // If iconPreviewScriptPath used ONLY `here` (candidate 2) — which is
        // what the pre-fix implementation effectively did — a bundled run
        // would resolve to this path, and it does not exist.
        await expect(
          iconPreviewScriptPath('render-vue.mjs', SIMULATED_BUNDLE_DIR),
        ).resolves.not.toBe(resolvePath(SIMULATED_BUNDLE_DIR, 'render-vue.mjs'))
      },
    )

    it('resolves render-vue.mjs from a simulated bundled-in-checkout location', async () => {
      // The actual regression proof: driven with a `here` that mimics
      // editor-cli/dist/cli.js's directory, the probe still finds the real
      // script via the third candidate instead of throwing.
      const path = await iconPreviewScriptPath('render-vue.mjs', SIMULATED_BUNDLE_DIR)
      expect(path).toBe(resolvePath(REAL_ICON_PREVIEW_DIR, 'render-vue.mjs'))
    })

    it('prefers a payload candidate that actually has the file', async () => {
      const payloadRoot = await mkdtemp(join(tmpdir(), 'pt-icon-payload-'))
      try {
        const payloadIconPreviewDir = join(payloadRoot, 'icon-preview')
        await mkdir(payloadIconPreviewDir, { recursive: true })
        await writeFile(join(payloadIconPreviewDir, 'render-vue.mjs'), '// staged renderer')
        process.env.EDITOR_PAYLOAD_ROOT = payloadRoot

        const path = await iconPreviewScriptPath('render-vue.mjs')
        expect(path).toBe(join(payloadIconPreviewDir, 'render-vue.mjs'))
      } finally {
        await rm(payloadRoot, { recursive: true, force: true })
      }
    })

    it('throws listing every candidate tried when nothing has the file', async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), 'pt-icon-empty-'))
      try {
        await expect(iconPreviewScriptPath('render-vue.mjs', emptyDir)).rejects.toThrow(
          /render-vue\.mjs.*was not found in any candidate location/,
        )
        await expect(iconPreviewScriptPath('render-vue.mjs', emptyDir)).rejects.toThrow(
          new RegExp(emptyDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        )
      } finally {
        await rm(emptyDir, { recursive: true, force: true })
      }
    })
  })
})

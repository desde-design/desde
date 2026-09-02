/**
 * End-to-end tests for the Node/npm VerificationAdapter against a real
 * temp repo. Each test seeds a tiny `package.json` (and optionally
 * `tsconfig.json`) and runs the adapter; checks exit codes + outputs
 * rather than relying on a fake exec layer.
 *
 * `pm: 'npm'` is passed explicitly to skip lockfile detection (which
 * is exercised in detectNodePackageManager tests below).
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createNodePackageVerificationAdapter,
  detectNodePackageManager,
} from './verification-adapter'

describe('node-npm verification-adapter', () => {
  let repo: string

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'pt-vt-'))
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  /**
   * Put an executable `node_modules/.bin/<name>` in the fixture repo.
   *
   * Enough for the adapter's `hasLocalBin` gate and for `npm exec` to resolve
   * locally instead of reaching the registry, which is the entire point: the
   * command label is what these tests assert, and running a two-line shell
   * script to learn it costs nothing and works offline.
   */
  async function installStubBin(name: string, exitCode = 0): Promise<void> {
    const bin = join(repo, 'node_modules', '.bin')
    await mkdir(bin, { recursive: true })
    const file = join(bin, name)
    await writeFile(file, `#!/bin/sh\nexit ${exitCode}\n`, 'utf8')
    await chmod(file, 0o755)
  }

  describe('detectNodePackageManager', () => {
    it('returns "pnpm" when pnpm-lock.yaml is present', async () => {
      await writeFile(join(repo, 'pnpm-lock.yaml'), '', 'utf8')
      expect(detectNodePackageManager(repo)).toBe('pnpm')
    })

    it('returns "yarn" when yarn.lock is present', async () => {
      await writeFile(join(repo, 'yarn.lock'), '', 'utf8')
      expect(detectNodePackageManager(repo)).toBe('yarn')
    })

    it('defaults to "npm" when no lockfile is present', () => {
      expect(detectNodePackageManager(repo)).toBe('npm')
    })

    it('pnpm wins over yarn when both lockfiles are present', async () => {
      await writeFile(join(repo, 'pnpm-lock.yaml'), '', 'utf8')
      await writeFile(join(repo, 'yarn.lock'), '', 'utf8')
      expect(detectNodePackageManager(repo)).toBe('pnpm')
    })
  })

  describe('run()', () => {
    it('returns noScript with availableScripts when typecheck is missing and no tsconfig exists', async () => {
      await writeFile(
        join(repo, 'package.json'),
        JSON.stringify({ scripts: { build: 'true' } }),
        'utf8',
      )
      const adapter = createNodePackageVerificationAdapter({ repoRoot: repo, packageManager: 'npm' })
      const r = await adapter.run('typecheck')
      expect(r.ok).toBe(false)
      expect(r.noScript).toBe(true)
      expect(r.availableScripts).toEqual(['build'])
      expect(r.exitCode).toBe(-1)
      expect(r.stderr).toMatch(/No script defined/)
    })

    it('runs a passing script and returns ok=true with the right command', async () => {
      await writeFile(
        join(repo, 'package.json'),
        JSON.stringify({ scripts: { lint: 'node -e "console.log(\\"lint-ok\\")"' } }),
        'utf8',
      )
      const adapter = createNodePackageVerificationAdapter({ repoRoot: repo, packageManager: 'npm' })
      const r = await adapter.run('lint')
      expect(r.ok).toBe(true)
      expect(r.exitCode).toBe(0)
      expect(r.command).toBe('npm run lint')
      expect(r.stdout).toContain('lint-ok')
      expect(r.noScript).toBeUndefined()
    })

    it('reports ok=false with captured output when the script exits non-zero', async () => {
      await writeFile(
        join(repo, 'package.json'),
        JSON.stringify({
          scripts: {
            // process.exit(7) — guaranteed-failing script.
            lint: 'node -e "console.error(\\"boom\\"); process.exit(7)"',
          },
        }),
        'utf8',
      )
      const adapter = createNodePackageVerificationAdapter({ repoRoot: repo, packageManager: 'npm' })
      const r = await adapter.run('lint')
      expect(r.ok).toBe(false)
      expect(r.exitCode).not.toBe(0)
      expect(r.stderr).toContain('boom')
    })

    it('falls back to `npm exec tsc -- --noEmit` for typecheck when the script is missing, tsconfig.json exists, and tsc is installed', async () => {
      await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: {} }), 'utf8')
      await writeFile(join(repo, 'tsconfig.json'), JSON.stringify({}), 'utf8')
      await installStubBin('tsc')
      const adapter = createNodePackageVerificationAdapter({ repoRoot: repo, packageManager: 'npm' })
      const r = await adapter.run('typecheck')
      // The fallback command is exactly this; whether tsc is installed
      // determines exit code. We assert on the resolved command label.
      expect(r.command).toBe('npm exec tsc -- --noEmit')
      // noScript should NOT be set — a fallback IS a script run.
      expect(r.noScript).toBeUndefined()
    })

    /**
     * The other half of the same gate, and the reason the test above has to
     * install a stub at all.
     *
     * `npm exec tsc` is not "run the local tsc". With nothing installed it
     * downloads and runs whatever package owns the name `tsc` on the public
     * registry, which is an unrelated `2.0.4` that exits non-zero without
     * typechecking anything. Reporting THAT as the user's typecheck result was
     * the bug; reporting `noScript` is the honest answer, because a repo with
     * no TypeScript installed has nothing to typecheck with.
     *
     * This test is also what keeps the suite off the network: the fixture
     * above used to be exactly this one, so every `npm test` fetched and
     * executed that package, costing seconds for a string comparison. Both
     * tests are now offline — 691ms and 29ms on an idle machine.
     */
    it('reports noScript for typecheck when tsconfig.json exists but tsc is not installed', async () => {
      await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: {} }), 'utf8')
      await writeFile(join(repo, 'tsconfig.json'), JSON.stringify({}), 'utf8')
      const adapter = createNodePackageVerificationAdapter({ repoRoot: repo, packageManager: 'npm' })
      const r = await adapter.run('typecheck')
      expect(r.noScript).toBe(true)
      expect(r.ok).toBe(false)
      expect(r.command).not.toBe('npm exec tsc -- --noEmit')
    })

    it('matches the `test:types` alias for typecheck when that script is defined instead', async () => {
      await writeFile(
        join(repo, 'package.json'),
        JSON.stringify({ scripts: { 'test:types': 'true' } }),
        'utf8',
      )
      const adapter = createNodePackageVerificationAdapter({ repoRoot: repo, packageManager: 'npm' })
      const r = await adapter.run('typecheck')
      expect(r.command).toBe('npm run test:types')
      expect(r.ok).toBe(true)
    })

    it('truncates oversized stdout from the head (tail-preserving)', async () => {
      // Generate >32KB of stdout via printing a 40k-byte string.
      await writeFile(
        join(repo, 'package.json'),
        JSON.stringify({
          scripts: {
            lint: `node -e "process.stdout.write('x'.repeat(40000)); console.log('FINAL_MARKER')"`,
          },
        }),
        'utf8',
      )
      const adapter = createNodePackageVerificationAdapter({ repoRoot: repo, packageManager: 'npm' })
      const r = await adapter.run('lint')
      expect(r.ok).toBe(true)
      // Tail preserved: the FINAL_MARKER printed last must survive.
      expect(r.stdout).toContain('FINAL_MARKER')
      // And the truncation marker is present.
      expect(r.stdout).toMatch(/^…\[truncated \d+ leading bytes\]/)
      // Total payload size capped at 32KB + the truncation prefix.
      expect(r.stdout.length).toBeLessThan(33 * 1024)
    })

    it('respects an external abort signal', async () => {
      await writeFile(
        join(repo, 'package.json'),
        JSON.stringify({
          // A 60-second sleep — longer than the abort window.
          scripts: { lint: 'node -e "setTimeout(() => {}, 60000)"' },
        }),
        'utf8',
      )
      const adapter = createNodePackageVerificationAdapter({ repoRoot: repo, packageManager: 'npm' })
      const ac = new AbortController()
      setTimeout(() => ac.abort(), 50)
      const r = await adapter.run('lint', { signal: ac.signal })
      expect(r.ok).toBe(false)
      expect(r.aborted).toBe(true)
    })
  })
})

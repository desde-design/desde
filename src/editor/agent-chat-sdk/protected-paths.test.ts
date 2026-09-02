import { describe, expect, it } from 'vitest'

import { isProtectedAgentPath, normalizeRepoRelative, protectedPathDenial } from './protected-paths'

describe('isProtectedAgentPath', () => {
  describe('B6 — the SDK settings sink', () => {
    // The finding that made this module exist. `settingSources: ['project']`
    // loaded this file and executed its `hooks` as shell commands; the old
    // four-entry list did not contain it.
    it('protects .claude/settings.json', () => {
      expect(isProtectedAgentPath('.claude/settings.json')).toBe(true)
    })

    it('protects everything else under .claude/, not just settings.json', () => {
      expect(isProtectedAgentPath('.claude/settings.local.json')).toBe(true)
      expect(isProtectedAgentPath('.claude/hooks/pre-tool-use.js')).toBe(true)
      expect(isProtectedAgentPath('.claude/agents/helper.md')).toBe(true)
    })

    it('does not treat a same-prefix sibling directory as protected', () => {
      // `.claudette/` is not `.claude/`. The prefix check must respect the
      // path separator — this is the same class of bug as a bare `startsWith`
      // containment check on a filesystem root.
      expect(isProtectedAgentPath('.claudette/notes.md')).toBe(false)
      expect(isProtectedAgentPath('src/dot-claude/settings.json')).toBe(false)
    })
  })

  describe('execution sinks', () => {
    it('protects git hooks and config', () => {
      // Inside the repo root, so the root-containment guard never fires.
      expect(isProtectedAgentPath('.git/hooks/pre-commit')).toBe(true)
      expect(isProtectedAgentPath('.git/config')).toBe(true)
    })

    it('protects node_modules, including .bin shims', () => {
      expect(isProtectedAgentPath('node_modules/.bin/vite')).toBe(true)
      expect(isProtectedAgentPath('node_modules/left-pad/index.js')).toBe(true)
    })

    it('protects root build configs across every loader extension', () => {
      for (const p of [
        'vite.config.ts',
        'vite.config.js',
        'vite.config.mjs',
        'next.config.ts',
        'vitest.config.mts',
        'eslint.config.mjs',
        'tailwind.config.js',
        'postcss.config.cjs',
      ]) {
        expect(isProtectedAgentPath(p), p).toBe(true)
      }
    })

    it('does not protect a NESTED file that merely shares a config name', () => {
      // The policy is about root-level configs the toolchain actually loads.
      // A fixture named vite.config.ts inside a test directory is ordinary
      // source and must stay editable.
      expect(isProtectedAgentPath('src/fixtures/vite.config.ts')).toBe(false)
    })
  })

  describe('extension + instruction config', () => {
    it('protects the original four', () => {
      expect(isProtectedAgentPath('.mcp.json')).toBe(true)
      expect(isProtectedAgentPath('desde.config.json')).toBe(true)
      expect(isProtectedAgentPath('desde-composer.config.json')).toBe(true)
      expect(isProtectedAgentPath('.desde/config.json')).toBe(true)
    })

    it('protects rule files, which are loaded as instructions (S12)', () => {
      expect(isProtectedAgentPath('CLAUDE.md')).toBe(true)
      expect(isProtectedAgentPath('AGENTS.md')).toBe(true)
      expect(isProtectedAgentPath('.cursorrules')).toBe(true)
      expect(isProtectedAgentPath('.cursor/rules/style.mdc')).toBe(true)
      expect(isProtectedAgentPath('.github/copilot-instructions.md')).toBe(true)
    })

    it('protects the editor state directory, which holds the undo journal', () => {
      expect(isProtectedAgentPath('.desde/backups/abc/App.vue')).toBe(true)
    })
  })

  describe('ordinary source stays editable', () => {
    it('allows the files the agent exists to edit', () => {
      for (const p of [
        'src/App.vue',
        'src/components/Button.tsx',
        'package.json',
        'README.md',
        'docs/design.md',
        'src/styles/tokens.css',
      ]) {
        expect(isProtectedAgentPath(p), p).toBe(false)
      }
    })

    it('leaves package.json editable on purpose', () => {
      // `manage_package` legitimately rewrites the dependency blocks, so a
      // blanket block here would break the tool. The script-execution half of
      // B8 is closed at the execution end instead: `--ignore-scripts` on the
      // agent's install, and run_verification refusing a changed script block.
      expect(isProtectedAgentPath('package.json')).toBe(false)
    })
  })

  describe('normalization', () => {
    it('treats Windows separators as POSIX', () => {
      expect(isProtectedAgentPath('.claude\\settings.json')).toBe(true)
      expect(isProtectedAgentPath('.git\\hooks\\pre-commit')).toBe(true)
    })

    it('strips a leading ./', () => {
      expect(isProtectedAgentPath('./.mcp.json')).toBe(true)
      expect(normalizeRepoRelative('./src/App.vue')).toBe('src/App.vue')
    })
  })
})

describe('protectedPathDenial', () => {
  it('names the path and forbids routing around the block', () => {
    const msg = protectedPathDenial('.claude/settings.json')
    expect(msg).toContain('.claude/settings.json')
    // The message is read by the model. It must not merely refuse — it must
    // pre-empt the "rename it into place" workaround (that WAS the B7 bypass)
    // and the "but the user asked" rationalization.
    expect(msg).toMatch(/renaming|copying/i)
    expect(msg).toMatch(/prompt-injected/i)
  })
})

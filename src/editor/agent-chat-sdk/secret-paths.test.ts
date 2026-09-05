import { describe, expect, it } from 'vitest'

import {
  globPatternTargetsSecret,
  isSecretAgentPath,
  secretPathDenial,
  secretPathOmissionNote,
} from './protected-paths'

describe('isSecretAgentPath', () => {
  describe('.env and its variants', () => {
    it('refuses .env itself', () => {
      expect(isSecretAgentPath('.env')).toBe(true)
    })

    it('refuses the ordinary per-environment variants', () => {
      for (const p of [
        '.env.local',
        '.env.production',
        '.env.production.local',
        '.env.development',
        '.env.staging',
        '.env.test.local',
      ]) {
        expect(isSecretAgentPath(p), p).toBe(true)
      }
    })

    it('refuses an .env anywhere in the tree, not just at the root', () => {
      expect(isSecretAgentPath('packages/api/.env')).toBe(true)
      expect(isSecretAgentPath('apps/web/.env.local')).toBe(true)
    })

    it('refuses the reversed spelling a Compose or .NET project uses', () => {
      expect(isSecretAgentPath('prod.env')).toBe(true)
      expect(isSecretAgentPath('deploy/staging.env')).toBe(true)
    })
  })

  /**
   * FX17 item 2. `.envrc` is direnv's per-directory shell file and its
   * documented use is `export AWS_SECRET_ACCESS_KEY=…`. It is not
   * `.env`-shaped — it does not end in `.env`, is not `.env`, and does not
   * start with `.env.` — so it classified as non-secret and a plain
   * `Read('.envrc')` returned its contents on BOTH lanes.
   */
  describe('.envrc — direnv (FX17 item 2)', () => {
    it('refuses .envrc and its suffixed forms, at any depth', () => {
      for (const p of ['.envrc', '.envrc.local', '.envrc.production', 'app/.envrc']) {
        expect(isSecretAgentPath(p), p).toBe(true)
      }
    })

    it('goes through the same normalisation as every other entry', () => {
      // Case folded: `.ENVRC` is the same file on macOS and Windows.
      expect(isSecretAgentPath('.ENVRC')).toBe(true)
      expect(isSecretAgentPath('.EnvRc.Local')).toBe(true)
      expect(isSecretAgentPath('APP/.EnvRc')).toBe(true)
      // Trailing dot stripped, the Win32 hole the write list already closes.
      expect(isSecretAgentPath('.envrc.')).toBe(true)
      expect(isSecretAgentPath('.ENVRC. ')).toBe(true)
    })

    it('keeps the documentation spelling readable, as .env.example is', () => {
      expect(isSecretAgentPath('.envrc.example')).toBe(false)
      expect(isSecretAgentPath('.envrc.sample')).toBe(false)
    })
  })

  describe('documentation stays readable — the point of the list', () => {
    it('reads .env.example and .env.sample', () => {
      expect(isSecretAgentPath('.env.example')).toBe(false)
      expect(isSecretAgentPath('.env.sample')).toBe(false)
    })

    it('reads the other documentation spellings', () => {
      for (const p of ['.env.template', '.env.dist', '.env.defaults']) {
        expect(isSecretAgentPath(p), p).toBe(false)
      }
    })

    it('reads a documentation marker in either position', () => {
      expect(isSecretAgentPath('.env.local.example')).toBe(false)
      expect(isSecretAgentPath('.env.example.local')).toBe(false)
    })

    it('reads example.env, the reversed documentation spelling', () => {
      expect(isSecretAgentPath('example.env')).toBe(false)
      expect(isSecretAgentPath('docs/sample.env')).toBe(false)
    })
  })

  describe('case folding — the same normalisation the write list uses', () => {
    // The write list was hardened on 2026-09-04 to fold case, because macOS
    // and Windows resolve paths case-insensitively and the model's own
    // spelling survives into the predicate. A read list that compared raw
    // strings would refuse `.env` and serve `.ENV`, which is the same file.
    it('refuses .ENV, .Env and .eNv', () => {
      expect(isSecretAgentPath('.ENV')).toBe(true)
      expect(isSecretAgentPath('.Env')).toBe(true)
      expect(isSecretAgentPath('.eNv')).toBe(true)
      expect(isSecretAgentPath('.ENV.PRODUCTION')).toBe(true)
    })

    it('folds case on every other entry too', () => {
      expect(isSecretAgentPath('.NPMRC')).toBe(true)
      expect(isSecretAgentPath('.SSH/ID_RSA')).toBe(true)
      expect(isSecretAgentPath('certs/Server.PEM')).toBe(true)
    })

    it('still reads .ENV.EXAMPLE', () => {
      expect(isSecretAgentPath('.ENV.EXAMPLE')).toBe(false)
    })
  })

  describe('trailing dots and spaces — the Win32 stripping the write list handles', () => {
    it('refuses .env. and ".env "', () => {
      expect(isSecretAgentPath('.env.')).toBe(true)
      expect(isSecretAgentPath('.env ')).toBe(true)
      expect(isSecretAgentPath('.ENV.')).toBe(true)
    })
  })

  describe('private keys', () => {
    it('refuses key material by extension', () => {
      for (const p of [
        'certs/server.pem',
        'certs/server.key',
        'android/release.jks',
        'android/release.keystore',
        'ios/dist.p12',
        'ios/dist.pfx',
        'deploy/key.ppk',
        'secrets.gpg',
      ]) {
        expect(isSecretAgentPath(p), p).toBe(true)
      }
    })

    it('refuses ssh keys by their conventional names', () => {
      for (const p of ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'fixtures/.ssh/id_rsa']) {
        expect(isSecretAgentPath(p), p).toBe(true)
      }
    })

    it('reads the public half of a key pair', () => {
      expect(isSecretAgentPath('id_rsa.pub')).toBe(false)
      expect(isSecretAgentPath('certs/server.pem.pub')).toBe(false)
    })

    it('refuses everything under an .ssh or .gnupg directory at any depth', () => {
      expect(isSecretAgentPath('.ssh/config')).toBe(true)
      expect(isSecretAgentPath('.gnupg/pubring.kbx')).toBe(true)
      expect(isSecretAgentPath('test/fixtures/.gnupg/trustdb.gpg')).toBe(true)
    })
  })

  describe('registry and cloud credentials', () => {
    it('refuses .npmrc, .yarnrc.yml and .netrc wherever they sit', () => {
      expect(isSecretAgentPath('.npmrc')).toBe(true)
      expect(isSecretAgentPath('packages/ui/.npmrc')).toBe(true)
      expect(isSecretAgentPath('.yarnrc.yml')).toBe(true)
      expect(isSecretAgentPath('.netrc')).toBe(true)
      expect(isSecretAgentPath('_netrc')).toBe(true)
    })

    it('refuses the other credential stores a repo can carry', () => {
      for (const p of [
        '.pgpass',
        '.htpasswd',
        '.pypirc',
        '.dockercfg',
        '.git-credentials',
        '.aws/credentials',
        '.aws/config',
        '.docker/config.json',
        '.azure/accessTokens.json',
        '.config/gcloud/application_default_credentials.json',
        'infra/service-account.json',
        'terraform.tfvars',
        'terraform.tfvars.json',
      ]) {
        expect(isSecretAgentPath(p), p).toBe(true)
      }
    })

    it("refuses Editor's own credential store, in the shape it would take in a repo", () => {
      expect(isSecretAgentPath('.desde/credentials.json')).toBe(true)
      expect(isSecretAgentPath('.desde/llm-credentials.json')).toBe(true)
    })
  })

  describe('ordinary source stays readable', () => {
    it('reads the files the agent exists to edit', () => {
      for (const p of [
        'src/App.vue',
        'src/views/Home.tsx',
        'package.json',
        'vite.config.ts',
        'README.md',
        'src/styles/globals.css',
        'public/logo.svg',
        '.gitignore',
        '.eslintrc.json',
      ]) {
        expect(isSecretAgentPath(p), p).toBe(false)
      }
    })

    it('does not treat a same-prefix sibling directory as secret', () => {
      expect(isSecretAgentPath('.sshconfig/notes.md')).toBe(false)
      expect(isSecretAgentPath('src/dot-ssh/id_rsa.md')).toBe(false)
    })

    it('is false for an empty path', () => {
      expect(isSecretAgentPath('')).toBe(false)
    })
  })
})

describe('globPatternTargetsSecret', () => {
  it('is true when the pattern names a secret file directly', () => {
    for (const p of ['.env', '**/.env', 'packages/*/.env', '.env*', '**/.env*', '.env.*']) {
      expect(globPatternTargetsSecret(p), p).toBe(true)
    }
  })

  it('is true when the pattern names a class of key files', () => {
    expect(globPatternTargetsSecret('**/*.pem')).toBe(true)
    expect(globPatternTargetsSecret('certs/*.key')).toBe(true)
    expect(globPatternTargetsSecret('**/id_rsa')).toBe(true)
  })

  it('is false for an ordinary repository search', () => {
    for (const p of ['**/*', '**/.*', 'src/**/*.vue', '*', 'src/*', '**/Button*']) {
      expect(globPatternTargetsSecret(p), p).toBe(false)
    }
  })

  it('is false for a documentation pattern', () => {
    expect(globPatternTargetsSecret('.env.example')).toBe(false)
    expect(globPatternTargetsSecret('**/*.vue')).toBe(false)
  })

  it('is false for an empty pattern', () => {
    expect(globPatternTargetsSecret('')).toBe(false)
  })

  /**
   * FX17 item 3a. Every spelling below returned FALSE before the fix while
   * matching the very file `**\/.env` was refused for, because the check
   * stripped leading and trailing `*` and then gave up on any stem that
   * still held a metacharacter. On the SDK lane, where results cannot be
   * filtered after the fact, that turned a `Grep` in `output_mode:
   * "content"` into a way to read `.env` verbatim.
   */
  describe('a metacharacter in the stem fails CLOSED (FX17 item 3a)', () => {
    it.each([
      '**/.en?',
      '**/.en[v]',
      '**/.env{,.local}',
      '**/[.]env',
      '**/.npmr?',
      '**/id_rs?',
      '**/.envr?',
      '**/{.env,README.md}',
      '**/?.pem',
      '**/terraform.tfvar?',
      '**/.ENV{,.local}',
    ])('refuses %s', (pattern) => {
      expect(globPatternTargetsSecret(pattern)).toBe(true)
    })

    it('still allows the ordinary metacharacter patterns real searches use', () => {
      for (const p of [
        'src/**/*.{ts,tsx}',
        '**/*.test.?s',
        'packages/*/src/**/*.ts',
        '**/[A-Z]*.vue',
        '**/index.{js,ts}',
      ]) {
        expect(globPatternTargetsSecret(p), p).toBe(false)
      }
    })

    it('treats an unterminated bracket as a literal, the way glob engines do', () => {
      expect(globPatternTargetsSecret('**/[unterminated')).toBe(false)
      expect(globPatternTargetsSecret('**/[.env')).toBe(false)
    })

    it('refuses a segment too long or too wildcarded to answer for', () => {
      // Fail-closed on the inputs the compiler declines rather than
      // guessing. A refusal costs the model a round trip; the other error
      // serves a credential.
      expect(globPatternTargetsSecret(`**/${'a'.repeat(250)}?`)).toBe(true)
      expect(globPatternTargetsSecret(`**/${'?'.repeat(25)}x`)).toBe(true)
    })
  })
})

describe('secretPathDenial', () => {
  it('names the path, the reason, and the per-project setting', () => {
    const msg = secretPathDenial('.env')
    expect(msg).toContain("'.env'")
    expect(msg).toContain('credentials')
    expect(msg).toContain('secretReads')
  })

  it('never suggests the user paste the contents', () => {
    // The failure mode this wording exists to avoid: a refusal that ends
    // "ask the user for the values" is an exfiltration prompt with an extra
    // step, and it is followed most eagerly in the injected-content case.
    const msg = secretPathDenial('.env').toLowerCase()
    expect(msg).toContain('do not ask the user to paste')
    expect(msg).not.toMatch(/ask the user (for|to provide|to share) the (value|content|secret)/)
  })

  it('tells the model not to route around the block', () => {
    const msg = secretPathDenial('.env')
    expect(msg).toContain('prompt-injected')
    expect(msg).toMatch(/rename|copy/i)
  })

  it('points at the readable substitute rather than at the user', () => {
    expect(secretPathDenial('.env')).toContain('.env.example')
  })

  it('echoes the normalised spelling of the path it refused', () => {
    expect(secretPathDenial('./.env')).toContain("'.env'")
  })

  it('says "searched" for a search refusal', () => {
    expect(secretPathDenial('.env', 'search')).toContain('cannot be searched')
  })
})

describe('secretPathOmissionNote', () => {
  it('is empty when nothing was omitted', () => {
    expect(secretPathOmissionNote(0)).toBe('')
  })

  it('says how many were left out, so a short list is not read as absence', () => {
    expect(secretPathOmissionNote(1)).toContain('1 file was left out')
    expect(secretPathOmissionNote(3)).toContain('3 files were left out')
  })

  it('does not suggest a workaround', () => {
    expect(secretPathOmissionNote(2)).toContain('Do not try to reach them another way')
  })
})

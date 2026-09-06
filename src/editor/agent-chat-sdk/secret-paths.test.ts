import { describe, expect, it } from 'vitest'

import {
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

/**
 * **FX20 item 1 — `globPatternTargetsSecret` is gone, and this is what its
 * tests became.**
 *
 * The deleted function read a Glob or pathspec PATTERN and judged whether it
 * aimed at a credential name. It was removed for being unsound rather than
 * unused: glob syntax has unbounded spellings for identical reach, five
 * review rounds each found one more, and the last measured seven of eight
 * brace and character-class spellings of a secret directory passing where
 * the literal spelling was refused.
 *
 * The probe tables it was tested against are still worth keeping, so they
 * are kept — pointed at the predicate that replaced it. Every CONCRETE path
 * those patterns reached must be refused by `isSecretAgentPath`, because
 * that is now the only question anyone asks: the callers enumerate first
 * (`matchingPaths`, `withholdSecretPaths`) and ask about resolved paths.
 *
 * If a future reader is tempted to reintroduce a pattern analysis, the list
 * below is the evidence that it does not converge. What converges is asking
 * about the file.
 */
describe('the concrete paths the retired pattern analysis was tested on (FX20 item 1)', () => {
  it.each([
    // FX19 item 3's probe table, reduced to the file each pattern reached.
    '.ssh/id_rsa',
    '.ssh/config',
    '.ssh/notes.txt',
    '.aws/credentials',
    '.gnupg/secring.gpg',
    '.config/gcloud/credentials.db',
    '.docker/config.json',
    '.env.production.local',
    '.env.staging',
    '.envrc.production',
    'prod.env',
    'abc.pem',
    'server.pem',
    'ca.key',
    'terraform.tfvars.json',
    // FX17 item 3a's, likewise.
    '.env',
    '.env.local',
    '.npmrc',
    'id_rsa',
    '[.env',
  ])('refuses %s by name', (concrete) => {
    expect(isSecretAgentPath(concrete)).toBe(true)
  })

  it('still serves the ordinary files a repository search reaches', () => {
    for (const p of [
      'src/components/Button.vue',
      'src/index.ts',
      'packages/ui/src/index.ts',
      '.env.example',
      'README.md',
    ]) {
      expect(isSecretAgentPath(p), p).toBe(false)
    }
  })
})

describe('secretPathDenial', () => {
  it('names the path, the reason, and the per-project setting', () => {
    const msg = secretPathDenial('.env')
    expect(msg).toContain("'.env'")
    expect(msg).toContain('credentials')
    expect(msg).toContain('blockSecretReads')
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

import { generateKeyPairSync } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { loadConfig } from "../config"
import { loadRuntimeConfig, updateRuntimeConfig } from "../runtime-config"
import { tmpViewerDataDir } from "./test-config"

describe("loadConfig", () => {
  it("defaults to the selfhost profile", () => {
    const dataDir = tmpViewerDataDir()
    const config = loadConfig({ VIEWER_DATA_DIR: dataDir })
    expect(config.profile).toBe("selfhost")
    expect(config.port).toBe(3100)
    expect(config.dataDir).toBe(dataDir)
    expect(config.publicUrl).toBe("http://localhost:3100")
    expect(config.adminToken).toBeNull()
    expect(config.serveDomain).toBeNull()
    expect(config.devBundler).toBe("turbopack")
    expect(config.email).toBeNull()
    expect(config.unsubscribeSecret).toBeNull()
    // ALWAYS present — generated into `<dataDir>/config.json` on first read.
    expect(config.sessionSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(config.githubAuth).toBeNull()
    expect(config.githubApp).toBeNull()
    expect(config.prototypeCsp).toBeNull()
    expect(config.prototypeOrigin).toBeNull()
    expect(config.seedDemoProject).toBe(true)
    expect(config.loopbackListeners).toBe("auto")
  })

  // The one call in this file that does NOT redirect `VIEWER_DATA_DIR` to a
  // tmp directory — this test exists specifically to prove that default, so
  // it has to exercise the real one. `loadConfig` is effectful (it creates
  // `<dataDir>/config.json` on first read, via `runtime-config.ts`), so this
  // touches the real, gitignored `.desde-viewer/` next to this repo.
  // That's fine: the assertion below doesn't depend on anything else that
  // file holds, so a concurrent writer touching it changes nothing this test
  // checks.
  it("defaults dataDir to .desde-viewer when VIEWER_DATA_DIR is unset", () => {
    expect(loadConfig({}).dataDir).toBe(".desde-viewer")
  })

  it("reads overrides from the environment", () => {
    const dataDir = tmpViewerDataDir()
    const config = loadConfig({
      VIEWER_PROFILE: "selfhost",
      PORT: "8080",
      VIEWER_DATA_DIR: dataDir,
      VIEWER_PUBLIC_URL: "https://viewer.example.com",
      VIEWER_ADMIN_TOKEN: "secret",
      VIEWER_SERVE_DOMAIN: "protos.example.com",
      VIEWER_DEV_BUNDLER: "webpack",
      VIEWER_SMTP_HOST: "smtp.example.com",
      VIEWER_SMTP_PORT: "465",
      VIEWER_SMTP_USER: "smtp-user",
      VIEWER_SMTP_PASS: "smtp-pass",
      VIEWER_SMTP_FROM: "noreply@example.com",
      VIEWER_UNSUBSCRIBE_SECRET: "unsub-secret",
      VIEWER_GITHUB_CLIENT_ID: "client-id",
      VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
      VIEWER_SESSION_SECRET: "session-secret",
      VIEWER_PROTOTYPE_CSP: "default-src 'none'",
      // "off" here (rather than "auto") is what keeps this assertion
      // independent of whatever filesystem the test happens to run on.
      VIEWER_LOOPBACK_LISTENERS: "off",
    })
    expect(config).toEqual({
      profile: "selfhost",
      port: 8080,
      dataDir,
      publicUrl: "https://viewer.example.com",
      adminToken: "secret",
      serveDomain: "protos.example.com",
      devBundler: "webpack",
      emailSource: "env",
      email: {
        host: "smtp.example.com",
        port: 465,
        user: "smtp-user",
        pass: "smtp-pass",
        from: "noreply@example.com",
      },
      unsubscribeSecret: "unsub-secret",
      sessionSecret: "session-secret",
      githubAuth: {
        clientId: "client-id",
        clientSecret: "client-secret",
      },
      githubApp: null,
      prototypeCsp: "default-src 'none'",
      prototypeOrigin: null,
      allowedEmailDomains: null,
      seedDemoProject: true,
      trustProxy: false,
      loopbackListeners: "off",
      loopbackAvailable: false,
      loopbackPortRange: null,
      loopbackBindAllInterfaces: false,
      loopbackBindNetworkUnrecognized: false,
      loopbackBind: "auto",
      loopbackInContainer: false,
    })
  })

  describe("email config", () => {
    it("is null when VIEWER_SMTP_HOST is unset", () => {
      expect(loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }).email).toBeNull()
    })

    it("populates email with a parsed numeric port when the full set is present", () => {
      const config = loadConfig({
        VIEWER_DATA_DIR: tmpViewerDataDir(),
        VIEWER_SMTP_HOST: "smtp.example.com",
        VIEWER_SMTP_PORT: "587",
        VIEWER_SMTP_USER: "smtp-user",
        VIEWER_SMTP_PASS: "smtp-pass",
        VIEWER_SMTP_FROM: "noreply@example.com",
      })
      expect(config.email).toEqual({
        host: "smtp.example.com",
        port: 587,
        user: "smtp-user",
        pass: "smtp-pass",
        from: "noreply@example.com",
      })
    })

    it("defaults VIEWER_SMTP_PORT to 587 when unset", () => {
      const config = loadConfig({
        VIEWER_DATA_DIR: tmpViewerDataDir(),
        VIEWER_SMTP_HOST: "smtp.example.com",
        VIEWER_SMTP_USER: "smtp-user",
        VIEWER_SMTP_PASS: "smtp-pass",
        VIEWER_SMTP_FROM: "noreply@example.com",
      })
      expect(config.email?.port).toBe(587)
    })

    it("rejects a non-integer VIEWER_SMTP_PORT", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_SMTP_HOST: "smtp.example.com",
          VIEWER_SMTP_PORT: "abc",
          VIEWER_SMTP_USER: "smtp-user",
          VIEWER_SMTP_PASS: "smtp-pass",
          VIEWER_SMTP_FROM: "noreply@example.com",
        }),
      ).toThrow(/VIEWER_SMTP_PORT/)
    })

    it("throws naming the missing var when VIEWER_SMTP_USER is absent", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_SMTP_HOST: "smtp.example.com",
          VIEWER_SMTP_PASS: "smtp-pass",
          VIEWER_SMTP_FROM: "noreply@example.com",
        }),
      ).toThrow(/VIEWER_SMTP_USER/)
    })

    it("throws naming the missing var when VIEWER_SMTP_PASS is absent", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_SMTP_HOST: "smtp.example.com",
          VIEWER_SMTP_USER: "smtp-user",
          VIEWER_SMTP_FROM: "noreply@example.com",
        }),
      ).toThrow(/VIEWER_SMTP_PASS/)
    })

    it("throws naming the missing var when VIEWER_SMTP_FROM is absent", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_SMTP_HOST: "smtp.example.com",
          VIEWER_SMTP_USER: "smtp-user",
          VIEWER_SMTP_PASS: "smtp-pass",
        }),
      ).toThrow(/VIEWER_SMTP_FROM/)
    })
  })

  describe("sessionSecret — ALWAYS present now (the split this task made)", () => {
    it("is generated and stable across repeated loadConfig calls against the same VIEWER_DATA_DIR", () => {
      const dataDir = tmpViewerDataDir()
      const first = loadConfig({ VIEWER_DATA_DIR: dataDir })
      const second = loadConfig({ VIEWER_DATA_DIR: dataDir })
      expect(first.sessionSecret).toMatch(/^[0-9a-f]{64}$/)
      expect(second.sessionSecret).toBe(first.sessionSecret)
    })

    it("two different VIEWER_DATA_DIRs get two different generated secrets", () => {
      const a = loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() })
      const b = loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() })
      expect(a.sessionSecret).not.toBe(b.sessionSecret)
    })

    it("VIEWER_SESSION_SECRET overrides the generated one", () => {
      const config = loadConfig({
        VIEWER_DATA_DIR: tmpViewerDataDir(),
        VIEWER_SESSION_SECRET: "operator-chosen-secret",
      })
      expect(config.sessionSecret).toBe("operator-chosen-secret")
    })

    it("is present with no GitHub sign-in and no GitHub App configured at all — the whole point of the split", () => {
      const config = loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() })
      expect(config.githubAuth).toBeNull()
      expect(config.githubApp).toBeNull()
      expect(config.sessionSecret).toMatch(/^[0-9a-f]{64}$/)
    })

    // The environment always wins over the runtime file, and is NEVER
    // written back to it — see `runtime-config.ts`'s header. Two disagreeing
    // sources for the same secret would be exactly the "looks configured,
    // behaves oddly" failure mode the file's own doc comment warns about.
    it("VIEWER_SESSION_SECRET is never persisted to the runtime file", () => {
      const dataDir = tmpViewerDataDir()
      // Force the file to exist first, with its own generated secret.
      const generated = loadRuntimeConfig(dataDir).sessionSecret
      const config = loadConfig({ VIEWER_DATA_DIR: dataDir, VIEWER_SESSION_SECRET: "env-secret" })
      expect(config.sessionSecret).toBe("env-secret")
      const onDisk = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as {
        sessionSecret: string
      }
      expect(onDisk.sessionSecret).toBe(generated)
      expect(onDisk.sessionSecret).not.toBe("env-secret")
    })
  })

  describe("githubAuth config (GitHub OAuth sign-in — split from sessionSecret)", () => {
    it("is null when neither GitHub OAuth var is set", () => {
      expect(loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }).githubAuth).toBeNull()
    })

    it("populates githubAuth when both vars are present", () => {
      const config = loadConfig({
        VIEWER_DATA_DIR: tmpViewerDataDir(),
        VIEWER_GITHUB_CLIENT_ID: "client-id",
        VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
      })
      expect(config.githubAuth).toEqual({
        clientId: "client-id",
        clientSecret: "client-secret",
      })
    })

    it("does NOT require VIEWER_SESSION_SECRET any more — that was the defect this task fixed", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_GITHUB_CLIENT_ID: "client-id",
          VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
        }),
      ).not.toThrow()
    })

    it("throws naming the missing var when VIEWER_GITHUB_CLIENT_ID is absent", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
        }),
      ).toThrow(/VIEWER_GITHUB_CLIENT_ID/)
    })

    it("throws naming the missing var when VIEWER_GITHUB_CLIENT_SECRET is absent", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_GITHUB_CLIENT_ID: "client-id",
        }),
      ).toThrow(/VIEWER_GITHUB_CLIENT_SECRET/)
    })
  })

  describe("GitHub endpoint overrides (GHES support)", () => {
    const requiredAuthEnv = {
      VIEWER_GITHUB_CLIENT_ID: "client-id",
      VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
    }

    it("populates all three overrides on config.githubAuth when all three are set", () => {
      const config = loadConfig({
        VIEWER_DATA_DIR: tmpViewerDataDir(),
        ...requiredAuthEnv,
        VIEWER_GITHUB_AUTHORIZE_URL: "https://github.company.com/login/oauth/authorize",
        VIEWER_GITHUB_TOKEN_URL: "https://github.company.com/login/oauth/access_token",
        VIEWER_GITHUB_API_BASE_URL: "https://github.company.com/api/v3",
      })
      expect(config.githubAuth).toEqual({
        clientId: "client-id",
        clientSecret: "client-secret",
        authorizeUrl: "https://github.company.com/login/oauth/authorize",
        tokenUrl: "https://github.company.com/login/oauth/access_token",
        apiBaseUrl: "https://github.company.com/api/v3",
      })
    })

    it("leaves the overrides undefined when unset, even with githubAuth configured", () => {
      const config = loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), ...requiredAuthEnv })
      expect(config.githubAuth?.authorizeUrl).toBeUndefined()
      expect(config.githubAuth?.tokenUrl).toBeUndefined()
      expect(config.githubAuth?.apiBaseUrl).toBeUndefined()
    })

    it("each override is independent — setting only one doesn't require the others", () => {
      const config = loadConfig({
        VIEWER_DATA_DIR: tmpViewerDataDir(),
        ...requiredAuthEnv,
        VIEWER_GITHUB_API_BASE_URL: "https://github.company.com/api/v3",
      })
      expect(config.githubAuth?.apiBaseUrl).toBe("https://github.company.com/api/v3")
      expect(config.githubAuth?.authorizeUrl).toBeUndefined()
      expect(config.githubAuth?.tokenUrl).toBeUndefined()
    })

    it("rejects a malformed VIEWER_GITHUB_AUTHORIZE_URL", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          ...requiredAuthEnv,
          VIEWER_GITHUB_AUTHORIZE_URL: "not-a-url",
        }),
      ).toThrow(/VIEWER_GITHUB_AUTHORIZE_URL/)
    })

    it("rejects a non-http(s) scheme for VIEWER_GITHUB_TOKEN_URL", () => {
      expect(() =>
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), ...requiredAuthEnv, VIEWER_GITHUB_TOKEN_URL: "ftp://x" }),
      ).toThrow(/VIEWER_GITHUB_TOKEN_URL/)
    })

    it("rejects a malformed VIEWER_GITHUB_API_BASE_URL", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          ...requiredAuthEnv,
          VIEWER_GITHUB_API_BASE_URL: "not-a-url",
        }),
      ).toThrow(/VIEWER_GITHUB_API_BASE_URL/)
    })

    it("rejects a non-http(s) scheme for VIEWER_GITHUB_API_BASE_URL", () => {
      expect(() =>
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), ...requiredAuthEnv, VIEWER_GITHUB_API_BASE_URL: "ftp://x" }),
      ).toThrow(/VIEWER_GITHUB_API_BASE_URL/)
    })

    it("is inert (config.githubAuth stays null, no throw) when the required pair is absent", () => {
      const config = loadConfig({
        VIEWER_DATA_DIR: tmpViewerDataDir(),
        VIEWER_GITHUB_AUTHORIZE_URL: "https://github.company.com/login/oauth/authorize",
        VIEWER_GITHUB_TOKEN_URL: "https://github.company.com/login/oauth/access_token",
        VIEWER_GITHUB_API_BASE_URL: "https://github.company.com/api/v3",
      })
      expect(config.githubAuth).toBeNull()
    })

    it("stays inert even when an override value is malformed, absent the required pair", () => {
      expect(() =>
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_GITHUB_AUTHORIZE_URL: "not-a-url" }),
      ).not.toThrow()
      expect(
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_GITHUB_AUTHORIZE_URL: "not-a-url" }).githubAuth,
      ).toBeNull()
    })
  })

  describe("githubApp config", () => {
    const { privateKey: testPrivateKeyPem } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    })
    // `generateKeyPairSync`'s PEM output has a trailing newline;
    // `normalizeGithubAppPrivateKey` trims surrounding whitespace as part of
    // normalization (a pasted/`.env`-sourced value commonly carries one), so
    // the round-tripped value is the trimmed form.
    const testPrivateKeyPemTrimmed = testPrivateKeyPem.trim()

    it("is null when none of the three GitHub App vars are set", () => {
      expect(loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }).githubApp).toBeNull()
    })

    it("populates githubApp when all three vars are present (literal PEM)", () => {
      const config = loadConfig({
        VIEWER_DATA_DIR: tmpViewerDataDir(),
        VIEWER_GITHUB_APP_ID: "12345",
        VIEWER_GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
        VIEWER_GITHUB_APP_SLUG: "my-app",
      })
      expect(config.githubApp).toEqual({
        appId: "12345",
        privateKeyPem: testPrivateKeyPemTrimmed,
        slug: "my-app",
      })
    })

    it("accepts a base64-encoded private key and decodes it to the same PEM", () => {
      const encoded = Buffer.from(testPrivateKeyPem, "utf8").toString("base64")
      const config = loadConfig({
        VIEWER_DATA_DIR: tmpViewerDataDir(),
        VIEWER_GITHUB_APP_ID: "12345",
        VIEWER_GITHUB_APP_PRIVATE_KEY: encoded,
        VIEWER_GITHUB_APP_SLUG: "my-app",
      })
      expect(config.githubApp?.privateKeyPem).toBe(testPrivateKeyPem)
    })

    it("throws naming the missing var when VIEWER_GITHUB_APP_ID is absent", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
          VIEWER_GITHUB_APP_SLUG: "my-app",
        }),
      ).toThrow(/VIEWER_GITHUB_APP_ID/)
    })

    it("throws naming the missing var when VIEWER_GITHUB_APP_PRIVATE_KEY is absent", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_GITHUB_APP_ID: "12345",
          VIEWER_GITHUB_APP_SLUG: "my-app",
        }),
      ).toThrow(/VIEWER_GITHUB_APP_PRIVATE_KEY/)
    })

    it("throws naming the missing var when VIEWER_GITHUB_APP_SLUG is absent", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_GITHUB_APP_ID: "12345",
          VIEWER_GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
        }),
      ).toThrow(/VIEWER_GITHUB_APP_SLUG/)
    })

    it("throws naming the missing var when only one of the three is set", () => {
      expect(() =>
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_GITHUB_APP_ID: "12345" }),
      ).toThrow(/VIEWER_GITHUB_APP_PRIVATE_KEY/)
    })

    it("rejects a private key that isn't PEM and isn't base64-of-PEM at boot", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_GITHUB_APP_ID: "12345",
          VIEWER_GITHUB_APP_PRIVATE_KEY: "not a key at all",
          VIEWER_GITHUB_APP_SLUG: "my-app",
        }),
      ).toThrow(/Invalid VIEWER_GITHUB_APP_PRIVATE_KEY/)
    })

    it("rejects a literal-PEM-looking key with a corrupt body at boot", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_GITHUB_APP_ID: "12345",
          VIEWER_GITHUB_APP_PRIVATE_KEY:
            "-----BEGIN RSA PRIVATE KEY-----\nnotvalidbase64body\n-----END RSA PRIVATE KEY-----",
          VIEWER_GITHUB_APP_SLUG: "my-app",
        }),
      ).toThrow(/Invalid VIEWER_GITHUB_APP_PRIVATE_KEY/)
    })

    it("rejects a valid PUBLIC key (wrong key type) at boot", () => {
      const { publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "pkcs1", format: "pem" },
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
      })
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_GITHUB_APP_ID: "12345",
          VIEWER_GITHUB_APP_PRIVATE_KEY: publicKey,
          VIEWER_GITHUB_APP_SLUG: "my-app",
        }),
      ).toThrow(/Invalid VIEWER_GITHUB_APP_PRIVATE_KEY/)
    })

    it("populates apiBaseUrl from VIEWER_GITHUB_API_BASE_URL, independent of the trio", () => {
      const config = loadConfig({
        VIEWER_DATA_DIR: tmpViewerDataDir(),
        VIEWER_GITHUB_APP_ID: "12345",
        VIEWER_GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
        VIEWER_GITHUB_APP_SLUG: "my-app",
        VIEWER_GITHUB_API_BASE_URL: "https://github.company.com/api/v3",
      })
      expect(config.githubApp?.apiBaseUrl).toBe("https://github.company.com/api/v3")
    })

    it("leaves apiBaseUrl undefined when unset, even with githubApp configured", () => {
      const config = loadConfig({
        VIEWER_DATA_DIR: tmpViewerDataDir(),
        VIEWER_GITHUB_APP_ID: "12345",
        VIEWER_GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
        VIEWER_GITHUB_APP_SLUG: "my-app",
      })
      expect(config.githubApp?.apiBaseUrl).toBeUndefined()
    })

    it("rejects a malformed VIEWER_GITHUB_API_BASE_URL when githubApp is configured", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_GITHUB_APP_ID: "12345",
          VIEWER_GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
          VIEWER_GITHUB_APP_SLUG: "my-app",
          VIEWER_GITHUB_API_BASE_URL: "not-a-url",
        }),
      ).toThrow(/VIEWER_GITHUB_API_BASE_URL/)
    })

    it("is inert (config.githubApp stays null, no throw) when the required trio is absent, even with a malformed override", () => {
      expect(() =>
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_GITHUB_API_BASE_URL: "not-a-url" }),
      ).not.toThrow()
      expect(
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_GITHUB_API_BASE_URL: "not-a-url" }).githubApp,
      ).toBeNull()
    })

    it("shares VIEWER_GITHUB_API_BASE_URL between githubAuth and githubApp when both are configured", () => {
      const config = loadConfig({
        VIEWER_DATA_DIR: tmpViewerDataDir(),
        VIEWER_GITHUB_CLIENT_ID: "client-id",
        VIEWER_GITHUB_CLIENT_SECRET: "client-secret",
        VIEWER_GITHUB_APP_ID: "12345",
        VIEWER_GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
        VIEWER_GITHUB_APP_SLUG: "my-app",
        VIEWER_GITHUB_API_BASE_URL: "https://github.company.com/api/v3",
      })
      expect(config.githubAuth?.apiBaseUrl).toBe("https://github.company.com/api/v3")
      expect(config.githubApp?.apiBaseUrl).toBe("https://github.company.com/api/v3")
    })
  })

  // New in this task: a GitHub App created through the manifest flow
  // (Task 10, not yet built) persists to the runtime file — `runtime-config.ts`'s
  // `githubApp` record. `loadConfig` must fall back to it for BOTH
  // `githubApp` and `githubAuth` when the corresponding env vars are absent,
  // and the environment must win wholesale over it when present.
  describe("runtime githubApp fallback (manifest-flow persistence)", () => {
    const { privateKey: testPrivateKeyPem } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "pkcs1", format: "pem" },
    })

    function seedRuntimeGithubApp(dataDir: string) {
      return updateRuntimeConfig(dataDir, {
        githubApp: {
          appId: "runtime-app-id",
          slug: "runtime-app-slug",
          privateKeyPem: testPrivateKeyPem,
          clientId: "runtime-client-id",
          clientSecret: "runtime-client-secret",
          webhookSecret: "runtime-webhook-secret",
        },
      })
    }

    it("supplies githubApp from the runtime record when no env trio is set", () => {
      const dataDir = tmpViewerDataDir()
      seedRuntimeGithubApp(dataDir)
      const config = loadConfig({ VIEWER_DATA_DIR: dataDir })
      expect(config.githubApp).toEqual({
        appId: "runtime-app-id",
        slug: "runtime-app-slug",
        privateKeyPem: testPrivateKeyPem,
        webhookSecret: "runtime-webhook-secret",
      })
    })

    it("supplies githubAuth's clientId/clientSecret from the same runtime record when no env pair is set", () => {
      const dataDir = tmpViewerDataDir()
      seedRuntimeGithubApp(dataDir)
      const config = loadConfig({ VIEWER_DATA_DIR: dataDir })
      expect(config.githubAuth).toEqual({
        clientId: "runtime-client-id",
        clientSecret: "runtime-client-secret",
      })
    })

    it("the env githubApp trio wins wholesale over the runtime record", () => {
      const dataDir = tmpViewerDataDir()
      seedRuntimeGithubApp(dataDir)
      const config = loadConfig({
        VIEWER_DATA_DIR: dataDir,
        VIEWER_GITHUB_APP_ID: "env-app-id",
        VIEWER_GITHUB_APP_PRIVATE_KEY: testPrivateKeyPem,
        VIEWER_GITHUB_APP_SLUG: "env-app-slug",
      })
      expect(config.githubApp).toEqual({
        appId: "env-app-id",
        privateKeyPem: testPrivateKeyPem.trim(),
        slug: "env-app-slug",
      })
    })

    it("the env githubAuth pair wins wholesale over the runtime record", () => {
      const dataDir = tmpViewerDataDir()
      seedRuntimeGithubApp(dataDir)
      const config = loadConfig({
        VIEWER_DATA_DIR: dataDir,
        VIEWER_GITHUB_CLIENT_ID: "env-client-id",
        VIEWER_GITHUB_CLIENT_SECRET: "env-client-secret",
      })
      expect(config.githubAuth).toEqual({
        clientId: "env-client-id",
        clientSecret: "env-client-secret",
      })
    })

    it("omits webhookSecret from githubApp when the runtime record doesn't have one", () => {
      const dataDir = tmpViewerDataDir()
      updateRuntimeConfig(dataDir, {
        githubApp: {
          appId: "runtime-app-id",
          slug: "runtime-app-slug",
          privateKeyPem: testPrivateKeyPem,
          clientId: "runtime-client-id",
          clientSecret: "runtime-client-secret",
        },
      })
      const config = loadConfig({ VIEWER_DATA_DIR: dataDir })
      expect(config.githubApp?.webhookSecret).toBeUndefined()
    })

    // Code-review fix: the runtime-record fallback arms originally dropped
    // VIEWER_GITHUB_AUTHORIZE_URL/TOKEN_URL/API_BASE_URL and
    // VIEWER_GITHUB_APP_WEBHOOK_SECRET entirely — an operator provisioning
    // the App via the manifest flow (runtime record, no webhookSecret), then
    // later setting VIEWER_GITHUB_APP_WEBHOOK_SECRET to turn on push
    // auto-deploy, would have had that env var silently ignored. These three
    // pin the fix.

    it("(a) applies env VIEWER_GITHUB_API_BASE_URL to BOTH githubApp and githubAuth when clientId/appId come from the runtime record", () => {
      const dataDir = tmpViewerDataDir()
      seedRuntimeGithubApp(dataDir)
      const config = loadConfig({
        VIEWER_DATA_DIR: dataDir,
        VIEWER_GITHUB_API_BASE_URL: "https://github.company.com/api/v3",
      })
      expect(config.githubApp?.apiBaseUrl).toBe("https://github.company.com/api/v3")
      expect(config.githubAuth?.apiBaseUrl).toBe("https://github.company.com/api/v3")
    })

    it("(b) env VIEWER_GITHUB_APP_WEBHOOK_SECRET wins over a webhookSecret already stored in the runtime record", () => {
      const dataDir = tmpViewerDataDir()
      seedRuntimeGithubApp(dataDir) // stores webhookSecret: "runtime-webhook-secret"
      const config = loadConfig({
        VIEWER_DATA_DIR: dataDir,
        VIEWER_GITHUB_APP_WEBHOOK_SECRET: "env-webhook-secret",
      })
      expect(config.githubApp?.webhookSecret).toBe("env-webhook-secret")
    })

    it("(c) with a runtime githubApp record and no relevant env vars, the optional fields stay absent", () => {
      const dataDir = tmpViewerDataDir()
      seedRuntimeGithubApp(dataDir)
      const config = loadConfig({ VIEWER_DATA_DIR: dataDir })
      expect(config.githubApp?.apiBaseUrl).toBeUndefined()
      expect(config.githubAuth?.authorizeUrl).toBeUndefined()
      expect(config.githubAuth?.tokenUrl).toBeUndefined()
      expect(config.githubAuth?.apiBaseUrl).toBeUndefined()
    })

    it("applies env VIEWER_GITHUB_AUTHORIZE_URL/TOKEN_URL to githubAuth even when its clientId/clientSecret come from the runtime record", () => {
      const dataDir = tmpViewerDataDir()
      seedRuntimeGithubApp(dataDir)
      const config = loadConfig({
        VIEWER_DATA_DIR: dataDir,
        VIEWER_GITHUB_AUTHORIZE_URL: "https://github.company.com/login/oauth/authorize",
        VIEWER_GITHUB_TOKEN_URL: "https://github.company.com/login/oauth/access_token",
      })
      expect(config.githubAuth).toEqual({
        clientId: "runtime-client-id",
        clientSecret: "runtime-client-secret",
        authorizeUrl: "https://github.company.com/login/oauth/authorize",
        tokenUrl: "https://github.company.com/login/oauth/access_token",
      })
    })
  })

  describe("unsubscribeSecret", () => {
    it("is null when VIEWER_UNSUBSCRIBE_SECRET is unset", () => {
      expect(loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }).unsubscribeSecret).toBeNull()
    })

    it("reads VIEWER_UNSUBSCRIBE_SECRET", () => {
      expect(
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_UNSUBSCRIBE_SECRET: "shh" }).unsubscribeSecret,
      ).toBe("shh")
    })
  })

  describe("prototypeCsp", () => {
    it("is null when VIEWER_PROTOTYPE_CSP is unset (computed default used)", () => {
      expect(loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }).prototypeCsp).toBeNull()
    })

    it("reads the literal 'off' escape hatch", () => {
      expect(
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_PROTOTYPE_CSP: "off" }).prototypeCsp,
      ).toBe("off")
    })

    it("reads a custom policy string verbatim", () => {
      expect(
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_PROTOTYPE_CSP: "default-src 'none'" })
          .prototypeCsp,
      ).toBe("default-src 'none'")
    })

    // VIEWER_PROTOTYPE_CSP="" is a common .env misconfiguration (an unset
    // var left as an empty assignment). Treating it as "configured" would
    // emit an empty `Content-Security-Policy:` header, which browsers
    // ignore outright — protection silently off while the var LOOKS set.
    it("treats an empty string as unset (computed default used, not an empty header)", () => {
      expect(loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_PROTOTYPE_CSP: "" }).prototypeCsp).toBeNull()
    })

    it("treats a whitespace-only string as unset", () => {
      expect(
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_PROTOTYPE_CSP: "   " }).prototypeCsp,
      ).toBeNull()
    })
  })

  describe("prototypeOrigin (VIEWER_PROTOTYPE_ORIGIN)", () => {
    it("is null when unset", () => {
      expect(loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }).prototypeOrigin).toBeNull()
    })

    it("normalizes a set value to its bare origin (scheme://host, default port dropped, path stripped)", () => {
      expect(
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_PROTOTYPE_ORIGIN: "https://proto.example.net:443/whatever/",
        }).prototypeOrigin,
      ).toBe("https://proto.example.net")
    })

    it("keeps an explicit non-default port", () => {
      expect(
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_PROTOTYPE_ORIGIN: "http://proto.example.net:3100",
        }).prototypeOrigin,
      ).toBe("http://proto.example.net:3100")
    })

    it("rejects a malformed VIEWER_PROTOTYPE_ORIGIN", () => {
      expect(() =>
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_PROTOTYPE_ORIGIN: "not-a-url" }),
      ).toThrow(/Invalid VIEWER_PROTOTYPE_ORIGIN/)
    })

    it("rejects a non-http(s) scheme", () => {
      expect(() =>
        loadConfig({
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_PROTOTYPE_ORIGIN: "ftp://proto.example.net",
        }),
      ).toThrow(/Invalid VIEWER_PROTOTYPE_ORIGIN/)
    })
  })

  it("rejects an unknown profile", () => {
    expect(() => loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_PROFILE: "azure" })).toThrow(
      /Unknown VIEWER_PROFILE/,
    )
  })

  it("rejects a non-numeric port", () => {
    expect(() => loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), PORT: "abc" })).toThrow(/PORT/)
  })

  it("strips a trailing slash from the public url", () => {
    expect(
      loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_PUBLIC_URL: "https://v.example.com/" }).publicUrl,
    ).toBe("https://v.example.com")
  })

  it("rejects a malformed VIEWER_PUBLIC_URL", () => {
    expect(() =>
      loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_PUBLIC_URL: "not-a-url" }),
    ).toThrow(/Invalid VIEWER_PUBLIC_URL/)
  })

  it("rejects a VIEWER_PUBLIC_URL missing a scheme", () => {
    expect(() =>
      loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_PUBLIC_URL: "localhost:3100" }),
    ).toThrow(/Invalid VIEWER_PUBLIC_URL/)
  })

  it("rejects a non-http(s) VIEWER_PUBLIC_URL scheme", () => {
    expect(() =>
      loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_PUBLIC_URL: "ftp://v.example.com" }),
    ).toThrow(/Invalid VIEWER_PUBLIC_URL/)
  })

  it("accepts a VIEWER_PUBLIC_URL on plain http", () => {
    expect(
      loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_PUBLIC_URL: "http://v.example.com" }).publicUrl,
    ).toBe("http://v.example.com")
  })

  it("defaults devBundler to turbopack", () => {
    expect(loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }).devBundler).toBe("turbopack")
  })

  it("accepts VIEWER_DEV_BUNDLER=webpack", () => {
    expect(
      loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_DEV_BUNDLER: "webpack" }).devBundler,
    ).toBe("webpack")
  })

  it("rejects an unknown dev bundler", () => {
    expect(() =>
      loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_DEV_BUNDLER: "rspack" }),
    ).toThrow(/Unknown VIEWER_DEV_BUNDLER/)
  })

  it("defaults seedDemoProject to true", () => {
    expect(loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }).seedDemoProject).toBe(true)
  })

  it("disables the demo seed when VIEWER_DEMO_PROJECT=off", () => {
    expect(
      loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_DEMO_PROJECT: "off" }).seedDemoProject,
    ).toBe(false)
  })

  it("treats any other VIEWER_DEMO_PROJECT value as enabled", () => {
    expect(
      loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_DEMO_PROJECT: "true" }).seedDemoProject,
    ).toBe(true)
  })

  /**
   * `VIEWER_LOOPBACK_LISTENERS` (task: Docker/remote loopback auto-fallback).
   * `loopbackListeners` is the raw mode; `loopbackAvailable` is what
   * `resolveOrigins` actually reads. "on"/"off" are forced and never touch
   * the container heuristic; "auto" (the default) asks it, via an injectable
   * override so these tests never depend on the real filesystem.
   */
  describe("loopbackListeners / loopbackAvailable", () => {
    it("defaults to auto", () => {
      expect(loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }).loopbackListeners).toBe("auto")
    })

    it("rejects an unknown VIEWER_LOOPBACK_LISTENERS value", () => {
      expect(() =>
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_LISTENERS: "sometimes" }),
      ).toThrow(/Unknown VIEWER_LOOPBACK_LISTENERS/)
    })

    it('"on" forces loopbackAvailable true, even when the container check says yes', () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_LISTENERS: "on" },
        { isLikelyContainerized: () => true },
      )
      expect(config.loopbackListeners).toBe("on")
      expect(config.loopbackAvailable).toBe(true)
    })

    it('"off" forces loopbackAvailable false, even when the container check says no', () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_LISTENERS: "off" },
        { isLikelyContainerized: () => false },
      )
      expect(config.loopbackListeners).toBe("off")
      expect(config.loopbackAvailable).toBe(false)
    })

    // Since task 4 (VIEWER_LOOPBACK_PORT_RANGE), a container gets a default
    // port range, so loopbackAvailable is true here too. See the
    // "VIEWER_LOOPBACK_PORT_RANGE" describe block below for the range itself.
    it('"auto" follows the container check: containerized -> loopbackAvailable true (a default range now applies)', () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_LISTENERS: "auto" },
        { isLikelyContainerized: () => true },
      )
      expect(config.loopbackAvailable).toBe(true)
    })

    it('"auto" follows the container check: not containerized -> loopbackAvailable true', () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_LISTENERS: "auto" },
        { isLikelyContainerized: () => false },
      )
      expect(config.loopbackAvailable).toBe(true)
    })

    it("the default mode (no env var set) also follows the container check, and is now available there too", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir() },
        { isLikelyContainerized: () => true },
      )
      expect(config.loopbackListeners).toBe("auto")
      expect(config.loopbackAvailable).toBe(true)
    })
  })

  /**
   * `loopbackBindAllInterfaces` (codex round 2, item 1). `loopbackAvailable`
   * says whether a listener may open at all; this says whether it binds
   * every interface (`0.0.0.0`) instead of loopback alone. They used to be
   * the SAME question, answered by "is a port range configured" — but an
   * operator can set `VIEWER_LOOPBACK_PORT_RANGE` on a laptop, and that laptop
   * is not a container, so binding `0.0.0.0` there would make a private
   * prototype reachable from the LAN on a predictable port. This is only
   * true when the process is ACTUALLY in a container, regardless of which
   * `VIEWER_LOOPBACK_LISTENERS` mode asked for listeners to open.
   */
  describe("loopbackBindAllInterfaces", () => {
    it("is false for a container detected under auto: auto never widens, the image sets all (codex round 18)", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir() },
        // A recognised bridged layout: pinned explicitly rather than left to
        // the real `/proc/net/dev` on whatever machine runs this suite
        // (VIEWER_LOOPBACK_BIND task, codex round 6, Fix 1 / round 10, Fix 2).
        { isLikelyContainerized: () => true, isLikelyBridgedNamespace: () => true },
      )
      expect(config.loopbackListeners).toBe("auto")
      expect(config.loopbackBindAllInterfaces).toBe(false)
    })

    it("is false on a laptop (not a container) with an explicit port range set by hand", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_PORT_RANGE: "4000-4005" },
        { isLikelyContainerized: () => false },
      )
      expect(config.loopbackPortRange).toEqual({ from: 4000, to: 4005 })
      expect(config.loopbackBindAllInterfaces).toBe(false)
    })

    it("is false when VIEWER_LOOPBACK_LISTENERS=off, even inside a container", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_LISTENERS: "off" },
        { isLikelyContainerized: () => true },
      )
      expect(config.loopbackBindAllInterfaces).toBe(false)
    })

    it("is false for VIEWER_LOOPBACK_LISTENERS=on inside an actually-detected container: only VIEWER_LOOPBACK_BIND=all widens (codex round 18)", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_LISTENERS: "on" },
        { isLikelyContainerized: () => true, isLikelyBridgedNamespace: () => true },
      )
      expect(config.loopbackBindAllInterfaces).toBe(false)
    })

    it("is false for VIEWER_LOOPBACK_LISTENERS=on forced on a laptop that is not a container", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_LISTENERS: "on" },
        { isLikelyContainerized: () => false },
      )
      expect(config.loopbackAvailable).toBe(true)
      expect(config.loopbackBindAllInterfaces).toBe(false)
    })

    it("is false on a plain laptop default (auto, not a container)", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir() },
        { isLikelyContainerized: () => false },
      )
      expect(config.loopbackBindAllInterfaces).toBe(false)
    })
  })

  /**
   * `VIEWER_LOOPBACK_BIND` (codex round 6, Fix 1; the `auto` default
   * strengthened again in codex round 10, Fix 2). `docker run --network
   * host` still makes container detection succeed, but host networking
   * means the container's loopback IS the host's loopback, so `auto`'s
   * container-implies-wildcard-bind rule is wrong there — the fix is an
   * explicit control, plus a safer `auto` default that widens only on
   * POSITIVE evidence of Docker's ordinary bridged layout
   * (`isLikelyBridgedNamespace`, `container-detect.ts`). Round 10 tightened
   * this further: a round-6 negative check ("not one of Docker's own
   * host-side names") read an unrecognised runtime — Podman's own bridge
   * names included — as safe to widen; the positive check reads the same
   * runtime as "stay narrow" instead.
   */
  describe("VIEWER_LOOPBACK_BIND", () => {
    it("rejects an unknown VIEWER_LOOPBACK_BIND value", () => {
      expect(() =>
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_BIND: "sometimes" }),
      ).toThrow(/Unknown VIEWER_LOOPBACK_BIND/)
    })

    it("auto: even a container with a recognised bridged layout stays on loopback (codex round 18)", () => {
      // `lo` + `eth0` is also what a host-network container on a host whose
      // NIC is named `eth0` looks like, and the wrong guess puts the port
      // range on the LAN. Only an explicit `all` widens; the image sets it.
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_BIND: "auto" },
        { isLikelyContainerized: () => true, isLikelyBridgedNamespace: () => true },
      )
      expect(config.loopbackBindAllInterfaces).toBe(false)
      expect(config.loopbackBindNetworkUnrecognized).toBe(false)
      expect(config.loopbackInContainer).toBe(true)
    })

    it("auto: a container whose network layout is not recognised as bridged stays on loopback", () => {
      // Covers BOTH host networking (--network host) and a runtime this
      // heuristic simply does not recognise (Podman) — isLikelyBridgedNamespace
      // returns false for either, and auto treats them the same: narrow.
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_BIND: "auto" },
        { isLikelyContainerized: () => true, isLikelyBridgedNamespace: () => false },
      )
      expect(config.loopbackBindAllInterfaces).toBe(false)
      expect(config.loopbackBindNetworkUnrecognized).toBe(true)
    })

    it("auto: never probes the bridged-namespace check outside a container", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_BIND: "auto" },
        {
          isLikelyContainerized: () => false,
          isLikelyBridgedNamespace: () => {
            throw new Error("must not be called when no container was detected")
          },
        },
      )
      expect(config.loopbackBindAllInterfaces).toBe(false)
      expect(config.loopbackBindNetworkUnrecognized).toBe(false)
    })

    it("loopback: stays on loopback even inside a container, when the layout IS recognised", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_BIND: "loopback" },
        { isLikelyContainerized: () => true, isLikelyBridgedNamespace: () => true },
      )
      expect(config.loopbackBindAllInterfaces).toBe(false)
      // A recognised layout means the check has nothing to flag, whichever
      // bind mode the operator chose.
      expect(config.loopbackBindNetworkUnrecognized).toBe(false)
    })

    it("loopback: still flags an unrecognised layout even though the operator's own choice already keeps the bind narrow (Task 5 widening)", () => {
      // `loopbackBindNetworkUnrecognized` used to be true only under `auto`.
      // The server-prototypes rework (Task 5) widened it to fire on ANY bind
      // mode whenever a container was detected and the layout was not
      // confirmed as bridged, so the same fact is available to the banner
      // regardless of how the operator set VIEWER_LOOPBACK_BIND.
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_BIND: "loopback" },
        { isLikelyContainerized: () => true, isLikelyBridgedNamespace: () => false },
      )
      expect(config.loopbackBindAllInterfaces).toBe(false)
      expect(config.loopbackBindNetworkUnrecognized).toBe(true)
    })

    it("all: binds every interface on a plain laptop (not a container)", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_BIND: "all" },
        { isLikelyContainerized: () => false },
      )
      expect(config.loopbackBindAllInterfaces).toBe(true)
      // Never a container, so nothing to flag either.
      expect(config.loopbackBindNetworkUnrecognized).toBe(false)
    })

    it("all: stays false under VIEWER_LOOPBACK_LISTENERS=off, since no listener opens", () => {
      const config = loadConfig(
        {
          VIEWER_DATA_DIR: tmpViewerDataDir(),
          VIEWER_LOOPBACK_BIND: "all",
          VIEWER_LOOPBACK_LISTENERS: "off",
        },
        { isLikelyContainerized: () => true },
      )
      expect(config.loopbackBindAllInterfaces).toBe(false)
    })

    it("all: a recognised bridged container widens the bind and flags nothing (the shipped image's normal case)", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_BIND: "all" },
        { isLikelyContainerized: () => true, isLikelyBridgedNamespace: () => true },
      )
      expect(config.loopbackBindAllInterfaces).toBe(true)
      expect(config.loopbackBindNetworkUnrecognized).toBe(false)
    })

    it("all: a container whose layout is NOT recognised as bridged still widens the bind (the operator forced it), but flags the mismatch (Task 5 widening)", () => {
      // This is the shipped image on `--network host` (or on a runtime the
      // heuristic does not recognise) without the operator overriding back to
      // `loopback`: the image's `ENV VIEWER_LOOPBACK_BIND=all` still forces
      // the wide bind, but the check now has something to say about it.
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_BIND: "all" },
        { isLikelyContainerized: () => true, isLikelyBridgedNamespace: () => false },
      )
      expect(config.loopbackBindAllInterfaces).toBe(true)
      expect(config.loopbackBindNetworkUnrecognized).toBe(true)
    })
  })

  /**
   * `VIEWER_LOOPBACK_PORT_RANGE` (task 4 of the server-prototypes spec). A
   * random ephemeral port can't be published with Docker's `-p`, so a
   * container gets a fixed range instead, defaulted from `PORT`. This makes
   * loopback mode available again inside a container: see the
   * `loopbackAvailable` assertions below.
   */
  describe("VIEWER_LOOPBACK_PORT_RANGE", () => {
    it("is null outside a container when unset: ephemeral ports as before", () => {
      const config = loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir() }, { isLikelyContainerized: () => false })
      expect(config.loopbackPortRange).toBeNull()
      expect(config.loopbackAvailable).toBe(true)
    })
    it("defaults to the twenty ports above PORT inside a container, and makes loopback available there", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), PORT: "3100" },
        { isLikelyContainerized: () => true },
      )
      expect(config.loopbackPortRange).toEqual({ from: 3101, to: 3120 })
      expect(config.loopbackAvailable).toBe(true)
    })
    it("parses an explicit range", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_PORT_RANGE: "4000-4005" },
        { isLikelyContainerized: () => false },
      )
      expect(config.loopbackPortRange).toEqual({ from: 4000, to: 4005 })
    })
    it("refuses a malformed, inverted, privileged, or PORT-overlapping range", () => {
      for (const bad of ["x", "4000", "4005-4000", "80-90", "3090-3110"]) {
        expect(() =>
          loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), PORT: "3100", VIEWER_LOOPBACK_PORT_RANGE: bad }),
        ).toThrow(/VIEWER_LOOPBACK_PORT_RANGE/)
      }
    })
    it("still honours VIEWER_LOOPBACK_LISTENERS=off inside a container", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), VIEWER_LOOPBACK_LISTENERS: "off" },
        { isLikelyContainerized: () => true },
      )
      expect(config.loopbackAvailable).toBe(false)
    })

    /**
     * The default range is `PORT+1` to `PORT+20`. A `PORT` near the top of
     * the valid port space (65535 is itself a legal port) can push that
     * past 65535, which no listener could ever bind — the derivation needs
     * the same ceiling an explicit `VIEWER_LOOPBACK_PORT_RANGE` is already
     * held to.
     */
    it("derives a default range right up against 65535 when there's exactly enough room", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), PORT: "65515" },
        { isLikelyContainerized: () => true },
      )
      expect(config.loopbackPortRange).toEqual({ from: 65516, to: 65535 })
    })
    it("refuses to derive a default range that would exceed 65535, naming PORT and VIEWER_LOOPBACK_PORT_RANGE", () => {
      expect(() =>
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), PORT: "65520" }, { isLikelyContainerized: () => true }),
      ).toThrow(/PORT/)
      expect(() =>
        loadConfig({ VIEWER_DATA_DIR: tmpViewerDataDir(), PORT: "65520" }, { isLikelyContainerized: () => true }),
      ).toThrow(/VIEWER_LOOPBACK_PORT_RANGE/)
    })
    it("a PORT that would overflow the default range is fine outside a container, since no default range is derived there", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), PORT: "65535" },
        { isLikelyContainerized: () => false },
      )
      expect(config.loopbackPortRange).toBeNull()
    })

    /**
     * Codex round 5, Fix 3. `VIEWER_LOOPBACK_LISTENERS=on` used to force
     * `inContainer` to `false` outright, so with no explicit
     * `VIEWER_LOOPBACK_PORT_RANGE` the default range was `null` — while
     * `loopbackBindAllInterfaces` (a separate probe) still correctly bound
     * every interface, because Docker forwards a published port to the
     * container's external interface only. The result: every loopback
     * listener bound `0.0.0.0` on a random ephemeral port Docker could never
     * publish, so no prototype origin was reachable from the host. Both
     * fields now come from ONE `actuallyInContainer` check that runs for
     * "on" as well as "auto" — never for "off", where no listener opens.
     */
    it("defaults the range (but keeps the loopback bind) for VIEWER_LOOPBACK_LISTENERS=on inside an actually-detected container", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), PORT: "3100", VIEWER_LOOPBACK_LISTENERS: "on" },
        // A recognised bridged layout: pinned explicitly (codex round 10, Fix
        // 2) rather than left to the real `/proc/net/dev` on whatever machine
        // runs this suite — an unpinned default now reads as "unrecognised"
        // on a non-Linux runner, the opposite of what this test needs.
        { isLikelyContainerized: () => true, isLikelyBridgedNamespace: () => true },
      )
      expect(config.loopbackPortRange).toEqual({ from: 3101, to: 3120 })
      expect(config.loopbackBindAllInterfaces).toBe(false)
    })

    it("leaves the range null (and does not bind every interface) for VIEWER_LOOPBACK_LISTENERS=on when the container check says no", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), PORT: "3100", VIEWER_LOOPBACK_LISTENERS: "on" },
        { isLikelyContainerized: () => false },
      )
      expect(config.loopbackPortRange).toBeNull()
      expect(config.loopbackBindAllInterfaces).toBe(false)
    })

    it("never probes the container check at all for VIEWER_LOOPBACK_LISTENERS=off", () => {
      let probed = false
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), PORT: "3100", VIEWER_LOOPBACK_LISTENERS: "off" },
        {
          isLikelyContainerized: () => {
            probed = true
            return true
          },
        },
      )
      expect(probed).toBe(false)
      expect(config.loopbackPortRange).toBeNull()
      expect(config.loopbackBindAllInterfaces).toBe(false)
    })

    // "auto" is unchanged by this fix — both fields already read the real
    // container check under "auto" before it, and still do.
    it("auto: still defaults the range (but keeps the loopback bind) inside a container", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), PORT: "3100", VIEWER_LOOPBACK_LISTENERS: "auto" },
        { isLikelyContainerized: () => true, isLikelyBridgedNamespace: () => true },
      )
      expect(config.loopbackPortRange).toEqual({ from: 3101, to: 3120 })
      expect(config.loopbackBindAllInterfaces).toBe(false)
    })

    it("auto: still leaves the range null (and does not bind every interface) outside a container", () => {
      const config = loadConfig(
        { VIEWER_DATA_DIR: tmpViewerDataDir(), PORT: "3100", VIEWER_LOOPBACK_LISTENERS: "auto" },
        { isLikelyContainerized: () => false },
      )
      expect(config.loopbackPortRange).toBeNull()
      expect(config.loopbackBindAllInterfaces).toBe(false)
    })
  })
})

describe("VIEWER_TRUST_PROXY", () => {
  const env = (raw?: string): Record<string, string> => ({
    VIEWER_DATA_DIR: tmpViewerDataDir(),
    ...(raw === undefined ? {} : { VIEWER_TRUST_PROXY: raw }),
  })

  it("defaults to false when unset, so no header is trusted", () => {
    expect(loadConfig(env()).trustProxy).toBe(false)
  })

  it("treats empty, 0, false and off as unset", () => {
    for (const raw of ["", "   ", "0", "false", "FALSE", "off"]) {
      expect(loadConfig(env(raw)).trustProxy).toBe(false)
    }
  })

  it("accepts a hop count", () => {
    expect(loadConfig(env("1")).trustProxy).toBe(1)
    expect(loadConfig(env("2")).trustProxy).toBe(2)
  })

  it("accepts an address or CIDR list verbatim, for Express to validate", () => {
    expect(loadConfig(env("10.0.0.0/8, 127.0.0.1")).trustProxy).toBe("10.0.0.0/8, 127.0.0.1")
  })

  it("REFUSES true, which would trust a client-supplied header", () => {
    // The whole point of the setting is per-client rate limiting. `true` makes
    // the client's own X-Forwarded-For decide the key, so an attacker rotates
    // it and defeats the limiter entirely: strictly worse than the shared
    // bucket this setting exists to fix.
    expect(() => loadConfig(env("true"))).toThrow(/refused/i)
    expect(() => loadConfig(env("TRUE"))).toThrow(/refused/i)
  })
})

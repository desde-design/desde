import express from "express"
import request from "supertest"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AssetStore } from "../../assets/types"
import { WRITE_SCOPE_REQUIRED } from "../../auth/authorize"
import { ensureLocalOperatorUser } from "../../auth/local-operator"
import { generateMachineToken } from "../../auth/machine-token"
import { generateOneTimeToken, parseOneTimeToken } from "../../auth/one-time-token"
import { signSessionId } from "../../auth/session-cookie"
import { loadConfig } from "../../config"
import { createApp, type AppDeps } from "../../__tests__/test-app"
import type { ReloadableEmailProvider } from "../../notify/reloadable-email-provider"
import { InMemoryStorage } from "../../storage/in-memory-storage"
import type { InstanceRole } from "../../storage/types"
import { createSwappableApp } from "../../__tests__/swappable-app"
import { tmpViewerDataDir } from "../../__tests__/test-config"
import { testGithubRuntime } from "../../__tests__/test-github-runtime"
import { upsertTestUser } from "../../__tests__/user-fixtures"

/**
 * Magic-link sign-in, self-serve domain join, admin-issued sign-in links and
 * invite emails — viewer-membership Task 14.
 *
 * Its own file rather than an appendix to `auth-routes.test.ts` /
 * `instance-routes.test.ts` because every test here needs the same two things
 * neither of those suites has: an `EmailProvider` on `AppDeps`, and a config
 * with SMTP set. Those two suites are deliberately built the other way round
 * (no provider, no SMTP), and the routes under test span BOTH routers anyway —
 * a magic link is minted by one and redeemed by the other, so splitting them
 * across two files would put the two halves of one flow out of each other's
 * sight.
 */

const nullAssets: AssetStore = {
  async put() {},
  async get() {
    return null
  },
  async deleteDeployment() {},
}

const SMTP_ENV = {
  VIEWER_SMTP_HOST: "smtp.test",
  VIEWER_SMTP_USER: "u",
  VIEWER_SMTP_PASS: "p",
  VIEWER_SMTP_FROM: "viewer@test",
}

/** Pulls one cookie's bare value out of a `Set-Cookie` header list. */
function extractCookie(setCookie: string[], name: string): string | null {
  for (const raw of setCookie) {
    const pair = raw.split(";")[0]
    const eq = pair.indexOf("=")
    if (eq === -1) continue
    if (pair.slice(0, eq) !== name) continue
    return decodeURIComponent(pair.slice(eq + 1))
  }
  return null
}

/** Node can send several `Set-Cookie` headers; superagent's types say otherwise. */
function setCookies(res: { headers: Record<string, string> }): string[] {
  const raw = res.headers["set-cookie"] as unknown as string | string[] | undefined
  if (!raw) return []
  return Array.isArray(raw) ? raw : [raw]
}

describe("magic links, domain join, admin sign-in links (Task 14)", () => {
  let storage: InMemoryStorage
  let sent: { to: string; subject: string; html: string }[]

  // ONE stable app object for the file; `stableAlt` for the two tests that
  // genuinely need a SECOND live app (the byte-identity comparison across an
  // SMTP-configured and an SMTP-less deployment).
  const stable = createSwappableApp()
  const stableAlt = createSwappableApp()

  const adminAuth = { Authorization: "Bearer secret" }

  function recordingProvider(mode: "ok" | "fail" | "throw"): ReloadableEmailProvider {
    return {
      // Configured by construction: a test that supplies a provider is
      // testing the path where mail is on.
      isConfigured: () => true,
      reconfigure: () => {},
      async send(to, subject, html) {
        sent.push({ to, subject, html })
        if (mode === "throw") throw new Error("simulated transport explosion")
        return mode === "ok"
      },
    }
  }

  /**
   * `AppDeps` with SMTP configured and a recording provider unless
   * `smtp: false` — the "email sign-in isn't set up on this viewer" state,
   * which is exactly the state the admin-issued link route has to keep
   * working in.
   */
  function depsWith(opts: { smtp?: boolean; mode?: "ok" | "fail" | "throw" } = {}): AppDeps {
    const smtp = opts.smtp !== false
    const config = loadConfig({
      VIEWER_ADMIN_TOKEN: "secret",
      VIEWER_SESSION_SECRET: "sesh-secret",
      VIEWER_PUBLIC_URL: "http://localhost:3100",
      VIEWER_DATA_DIR: tmpViewerDataDir(),
      ...(smtp ? SMTP_ENV : {}),
    })
    return {
      storage,
      assets: nullAssets,
      config,
      bridgeScript: "// bridge",
      github: testGithubRuntime({ config }),
      ...(smtp ? { email: recordingProvider(opts.mode ?? "ok") } : {}),
    }
  }

  function useApp(opts: Parameters<typeof depsWith>[0] = {}): express.Express {
    stable.use(createApp(depsWith(opts)))
    return stable.app
  }

  beforeEach(() => {
    storage = new InMemoryStorage()
    sent = []
  })

  /** Every `createSignInToken` input this test recorded, in order. */
  function trackMints() {
    return vi.spyOn(storage, "createSignInToken")
  }

  /**
   * An unrelated account, so `countUsers()` is nonzero.
   *
   * Load-bearing in every refusal test: on an EMPTY instance the gate's
   * first-user bootstrap rung admits anybody, so a "the domain rule was
   * removed, so this is refused" test against fresh storage would go green
   * while measuring the wrong rung.
   */
  async function seedExistingAccount() {
    return upsertTestUser(storage, {
      provider: "github",
      providerUserId: "already-here",
      email: "already@example.test",
      displayName: "Already Here",
      avatarUrl: "",
      role: "admin",
    })
  }

  async function seedMember(local: string, role: InstanceRole = "editor") {
    return upsertTestUser(storage, {
      provider: "github",
      providerUserId: local,
      email: `${local}@example.test`,
      displayName: local,
      avatarUrl: "",
      role,
    })
  }

  /** The `<a href>` a sign-in email carries. */
  function signInHref(html: string): string {
    const match = /href="([^"]*\/auth\/signin\/[^"]+)"/.exec(html)
    if (!match) throw new Error(`no sign-in link in email html: ${html}`)
    return match[1]
  }

  /**
   * The route answers WITHOUT waiting for the send — the response must not
   * take as long as the mail server does, or the timing alone answers the
   * membership question the identical body exists to hide (see the route's
   * doc comment). So drain the microtask/immediate queue after the response
   * before asserting on `sent`.
   *
   * The recording provider happens to push synchronously today, so every
   * assertion here would pass without this. That is exactly the kind of
   * accident that turns into a flake the first time somebody puts an `await`
   * ahead of the push.
   */
  async function magicLink(app: express.Express, email: unknown) {
    const res = await request(app).post("/api/v1/auth/magic-link").send({ email })
    await new Promise((resolve) => setImmediate(resolve))
    return res
  }

  /** Requests a magic link for `email` and returns the emailed link's PATH. */
  async function linkPathFor(app: express.Express, email: string): Promise<string> {
    const before = sent.length
    await magicLink(app, email)
    expect(sent.length).toBe(before + 1)
    return new URL(signInHref(sent[sent.length - 1].html)).pathname
  }

  /**
   * Redeem a one-time link the way a person does — fix wave 6.
   *
   * A link is two steps now: the GET renders an inert confirmation page and
   * touches no storage, and that page's form POSTs back to the SAME path to
   * redeem. Every test that used to drive the GET drives both, so the page
   * stays on the path a real click takes and its form's `action` cannot drift
   * away from the route that answers it.
   *
   * Returns the POST's response — the redemption — so the status, `Location`
   * and `Set-Cookie` assertions these tests already made read the same.
   *
   * `Sec-Fetch-Site: same-origin` on the POST — fix wave 7, item 3 — is what
   * a real browser sends submitting the confirmation page's own form: same
   * origin as the page it came from. Without it `requireDocumentNavigation`
   * now refuses the redemption before it ever reaches the token logic.
   */
  async function redeem(app: express.Express, path: string) {
    const page = await request(app).get(path).set("Sec-Fetch-Dest", "document")
    expect(page.status, `GET ${path}`).toBe(200)
    expect(page.text, `GET ${path}`).toContain(`<form method="post" action="${path}">`)
    return request(app)
      .post(path)
      .set("Sec-Fetch-Dest", "document")
      .set("Sec-Fetch-Site", "same-origin")
  }

  // -------------------------------------------------------------------------
  // POST /auth/magic-link
  // -------------------------------------------------------------------------

  describe("POST /auth/magic-link", () => {
    it("sends a sign-in link to an ACTIVE member and answers 202", async () => {
      const member = await seedMember("member")
      const mints = trackMints()
      const app = useApp()

      const res = await magicLink(app, "member@example.test")
      expect(res.status).toBe(202)
      expect(res.body).toEqual({ ok: true })
      expect(sent).toHaveLength(1)
      expect(sent[0].to).toBe("member@example.test")
      expect(sent[0].subject).toBe("Your sign-in link")

      // The USER variant — never the email one, since an account exists.
      expect(mints).toHaveBeenCalledTimes(1)
      expect(mints.mock.calls[0][0]).toMatchObject({ userId: member.id, email: null })
    })

    it("mints a 15-minute token, not the admin-issued 24 hours", async () => {
      await seedMember("ttl")
      const mints = trackMints()
      const before = Date.now()

      await magicLink(useApp(), "ttl@example.test")

      const ttlMs = new Date(mints.mock.calls[0][0].expiresAt).getTime() - before
      expect(ttlMs).toBeGreaterThan(14 * 60_000)
      expect(ttlMs).toBeLessThanOrEqual(15 * 60_000 + 5_000)
    })

    it("sends to an address with NO account when a domain rule matches it", async () => {
      await seedExistingAccount()
      await storage.setDomainRule({ domain: "join.test", role: "viewer", createdByUserId: null })
      const mints = trackMints()

      const res = await magicLink(useApp(), "newbie@join.test")
      expect(res.status).toBe(202)
      expect(sent).toHaveLength(1)

      // The EMAIL variant — there is no account to point a `userId` at yet.
      expect(mints.mock.calls[0][0]).toMatchObject({ userId: null, email: "newbie@join.test" })
    })

    it("sends nothing for an unknown address with no matching rule", async () => {
      await seedExistingAccount()
      const mints = trackMints()

      const res = await magicLink(useApp(), "stranger@nowhere.test")
      expect(res.status).toBe(202)
      expect(sent).toEqual([])
      expect(mints).not.toHaveBeenCalled()
    })

    it("matches the WHOLE domain, never a suffix — evil-join.test is not join.test", async () => {
      await seedExistingAccount()
      await storage.setDomainRule({ domain: "join.test", role: "viewer", createdByUserId: null })
      const mints = trackMints()

      const res = await magicLink(useApp(), "attacker@evil-join.test")
      expect(res.status).toBe(202)
      expect(sent).toEqual([])
      expect(mints).not.toHaveBeenCalled()
    })

    it("sends nothing to a REMOVED account, even when its domain has a rule", async () => {
      await seedExistingAccount()
      await storage.setDomainRule({ domain: "join.test", role: "viewer", createdByUserId: null })
      const gone = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "gone",
        email: "gone@join.test",
        displayName: "Gone",
        avatarUrl: "",
        role: "editor",
      })
      await storage.setUserStatus(gone.id, "removed")
      const mints = trackMints()

      const res = await magicLink(useApp(), "gone@join.test")
      expect(res.status).toBe(202)
      expect(sent).toEqual([])
      expect(mints).not.toHaveBeenCalled()
    })

    /**
     * THE oracle test. A member, a domain-rule address and a total stranger
     * must be indistinguishable to an anonymous caller, or this route answers
     * "does this address have an account here?" for anything a prober submits.
     * Compares the RAW body bytes, not a parsed object, so a difference in
     * serialization would fail too.
     */
    it("answers byte-identically for a member, a domain-rule address and a stranger", async () => {
      await seedMember("member")
      await storage.setDomainRule({ domain: "join.test", role: "viewer", createdByUserId: null })
      const app = useApp()

      const member = await magicLink(app, "member@example.test")
      const ruled = await magicLink(app, "newbie@join.test")
      const stranger = await magicLink(app, "stranger@nowhere.test")

      for (const res of [ruled, stranger]) {
        expect(res.status).toBe(member.status)
        expect(res.text).toBe(member.text)
        expect(res.headers["content-type"]).toBe(member.headers["content-type"])
        expect(res.headers["set-cookie"]).toBeUndefined()
      }
      // …and the difference that DOES exist is invisible from outside.
      expect(sent.map((s) => s.to)).toEqual(["member@example.test", "newbie@join.test"])
    })

    it("a REMOVED member is byte-identical to a live one too", async () => {
      const gone = await seedMember("gone")
      await storage.setUserStatus(gone.id, "removed")
      await seedMember("live")
      const app = useApp()

      const removed = await magicLink(app, "gone@example.test")
      const live = await magicLink(app, "live@example.test")
      expect(removed.status).toBe(live.status)
      expect(removed.text).toBe(live.text)
      expect(sent.map((s) => s.to)).toEqual(["live@example.test"])
    })

    /**
     * The local operator is reachable through exactly one door by design — a
     * token printed to the server's own stdout — and `/auth/local` turns
     * itself off the moment a real provider appears so that stays true. A
     * magic link addressed to `operator@localhost` would be a second door,
     * into an ADMIN account, on a host that may well run its own MTA.
     */
    it("sends nothing for the local-operator account", async () => {
      const operator = await ensureLocalOperatorUser(storage)
      expect(operator.role).toBe("admin")
      const mints = trackMints()

      const res = await magicLink(useApp(), operator.email)
      expect(res.status).toBe(202)
      expect(sent).toEqual([])
      expect(mints).not.toHaveBeenCalled()
    })

    it("never puts the plaintext token in its own response", async () => {
      await seedMember("quiet")
      const res = await magicLink(useApp(), "quiet@example.test")
      expect(res.text).toBe(JSON.stringify({ ok: true }))
      expect(res.text).not.toContain("dss_")
    })

    it("stores only the hash — the plaintext lives in the email and nowhere else", async () => {
      await seedMember("hashonly")
      const mints = trackMints()
      await magicLink(useApp(), "hashonly@example.test")

      const plaintext = /\/auth\/signin\/(dss_[0-9a-f]{16}_[A-Za-z0-9_-]{43})/.exec(sent[0].html)![1]
      const stored = mints.mock.calls[0][0]
      expect(stored.tokenHash).not.toBe(plaintext)
      expect(stored.tokenHash).not.toContain(plaintext)
      expect(JSON.stringify(await storage.getSignInToken(stored.id))).not.toContain(plaintext)
    })

    it("normalizes case and surrounding whitespace before looking the account up", async () => {
      await seedMember("mixed")
      const res = await magicLink(useApp(), "  MiXeD@Example.TEST  ")
      expect(res.status).toBe(202)
      expect(sent).toHaveLength(1)
      expect(sent[0].to).toBe("mixed@example.test")
    })

    it("still answers 202 when the provider reports a failed send", async () => {
      await seedMember("failsend")
      const res = await magicLink(useApp({ mode: "fail" }), "failsend@example.test")
      expect(res.status).toBe(202)
      expect(res.body).toEqual({ ok: true })
    })

    it("still answers 202 when the provider THROWS — no oracle via an error shape", async () => {
      await seedMember("throwsend")
      const res = await magicLink(useApp({ mode: "throw" }), "throwsend@example.test")
      expect(res.status).toBe(202)
      expect(res.body).toEqual({ ok: true })
    })

    it("409s every input identically when SMTP is unconfigured", async () => {
      await seedMember("member")
      await storage.setDomainRule({ domain: "join.test", role: "viewer", createdByUserId: null })
      const mints = trackMints()
      const app = useApp({ smtp: false })

      const member = await magicLink(app, "member@example.test")
      expect(member.status).toBe(409)
      expect(member.body).toEqual({ error: "Email sign-in isn't set up on this viewer" })

      for (const input of [
        "newbie@join.test",
        "stranger@nowhere.test",
        "not-an-email",
        42,
        undefined,
      ]) {
        const res = await magicLink(app, input)
        expect(res.status, JSON.stringify(input)).toBe(member.status)
        expect(res.text, JSON.stringify(input)).toBe(member.text)
      }
      expect(mints).not.toHaveBeenCalled()
      expect(sent).toEqual([])
    })

    it("400s a malformed address — a fact about the INPUT, not about who has an account", async () => {
      const app = useApp()
      for (const input of ["not-an-email", "", 42, null, undefined]) {
        const res = await magicLink(app, input)
        expect(res.status, JSON.stringify(input) ?? "undefined").toBe(400)
        expect(res.body).toEqual({ error: "email is invalid" })
      }
      expect(sent).toEqual([])
    })

    it("is not reachable as a document navigation", async () => {
      const res = await request(useApp())
        .post("/api/v1/auth/magic-link")
        .set("Sec-Fetch-Dest", "document")
        .send({ email: "x@example.test" })
      expect(res.status).toBe(403)
    })

    /**
     * THE bootstrap hole (adversarial review, Important 1).
     *
     * The route decides to send because a DOMAIN RULE matched, but redemption
     * re-runs the whole gate ladder — where first-user bootstrap (rung 4)
     * sits ABOVE the domain rule (rung 5), deliberately, so an empty instance
     * always ends up with an admin. Put those two together on an instance
     * that is configured with a GitHub App (so no local-operator row exists)
     * and has domain rules seeded from `VIEWER_ALLOWED_EMAIL_DOMAINS`, and
     * the FIRST person at `corp.com` to type their address into a sign-in box
     * becomes instance admin — having proved only that they can read their
     * own mail.
     *
     * An empty instance's first account must arrive through an explicit
     * bootstrap path: GitHub sign-in, the local-operator URL, or an
     * adminToken-minted invite. So the email variant is not minted at all
     * while `countUsers() === 0`.
     */
    it("does not mint the email variant on an EMPTY instance, even with a matching domain rule", async () => {
      await storage.setDomainRule({ domain: "corp.test", role: "viewer", createdByUserId: null })
      expect(await storage.countUsers()).toBe(0)
      const mints = trackMints()

      const res = await magicLink(useApp(), "first@corp.test")
      expect(res.status).toBe(202)
      expect(res.body).toEqual({ ok: true })
      expect(sent).toEqual([])
      expect(mints).not.toHaveBeenCalled()
    })

    it("the empty-instance refusal is byte-identical to an ordinary no-send", async () => {
      await storage.setDomainRule({ domain: "corp.test", role: "viewer", createdByUserId: null })
      const app = useApp()

      const ruled = await magicLink(app, "first@corp.test")
      const stranger = await magicLink(app, "nobody@elsewhere.test")
      expect(ruled.status).toBe(stranger.status)
      expect(ruled.text).toBe(stranger.text)
    })

    it("mints the email variant again as soon as the instance has ANY account", async () => {
      await storage.setDomainRule({ domain: "corp.test", role: "viewer", createdByUserId: null })
      // One account — including a REMOVED one — is enough to close the
      // bootstrap rung, which is exactly what `countUsers` counts.
      const seeded = await seedExistingAccount()
      await storage.setUserStatus(seeded.id, "removed")
      const mints = trackMints()

      const res = await magicLink(useApp(), "second@corp.test")
      expect(res.status).toBe(202)
      expect(sent).toHaveLength(1)
      expect(mints.mock.calls[0][0]).toMatchObject({ userId: null, email: "second@corp.test" })
    })

    /**
     * Per-subject mint throttle (adversarial review, Important 2b). Without
     * it, the `auth` rate-limit lane's 60 requests/minute is 3,600 real
     * emails an hour to arbitrary mailboxes at a ruled domain — a mail-bomb
     * relay and a sender-reputation problem, on an unauthenticated route.
     */
    it("does not mint or send a second link for the same member within the throttle window", async () => {
      await seedMember("throttled")
      const mints = trackMints()
      const app = useApp()

      const first = await magicLink(app, "throttled@example.test")
      const second = await magicLink(app, "throttled@example.test")

      expect(mints).toHaveBeenCalledTimes(1)
      expect(sent).toHaveLength(1)
      // …and the second request is indistinguishable from the first.
      expect(second.status).toBe(first.status)
      expect(second.text).toBe(first.text)
    })

    it("throttles the domain-rule (email) subject too", async () => {
      await seedExistingAccount()
      await storage.setDomainRule({ domain: "join.test", role: "viewer", createdByUserId: null })
      const mints = trackMints()
      const app = useApp()

      await magicLink(app, "newbie@join.test")
      await magicLink(app, "newbie@join.test")

      expect(mints).toHaveBeenCalledTimes(1)
      expect(sent).toHaveLength(1)
    })

    it("throttles per subject, not globally — a different member still gets their link", async () => {
      await seedMember("alice")
      await seedMember("bob")
      const app = useApp()

      await magicLink(app, "alice@example.test")
      await magicLink(app, "alice@example.test")
      await magicLink(app, "bob@example.test")

      expect(sent.map((s) => s.to)).toEqual(["alice@example.test", "bob@example.test"])
    })

    it("mints again once the throttle window has elapsed", async () => {
      await seedMember("later")
      const mints = trackMints()
      const app = useApp()

      // Fake `Date` ONLY — timers stay real, so supertest's socket I/O is
      // untouched. The first request is made ten minutes in the past, which
      // stamps its token's `createdAt` there; the second runs at the real
      // clock, by which point the throttle window is long gone.
      //
      // Ten minutes rather than an hour on purpose: the token's `expiresAt`
      // is (then + 15 min), so it is STILL unexpired at the second request.
      // That makes the throttle the only thing that could have blocked the
      // second mint — an expired token would have let it through for the
      // wrong reason.
      const realNow = Date.now()
      vi.useFakeTimers({ toFake: ["Date"] })
      try {
        vi.setSystemTime(realNow - 10 * 60_000)
        await magicLink(app, "later@example.test")
        expect(mints).toHaveBeenCalledTimes(1)

        vi.setSystemTime(realNow)
        await magicLink(app, "later@example.test")
      } finally {
        vi.useRealTimers()
      }

      expect(mints).toHaveBeenCalledTimes(2)
      expect(sent).toHaveLength(2)
    })

    it("does not throttle on an already-CLAIMED token — a spent link must be replaceable", async () => {
      await seedMember("spent")
      const mints = trackMints()
      const app = useApp()

      const path = await linkPathFor(app, "spent@example.test")
      expect((await redeem(app, path)).status).toBe(302)

      await magicLink(app, "spent@example.test")
      expect(mints).toHaveBeenCalledTimes(2)
      expect(sent).toHaveLength(2)
    })

    /**
     * Control characters and whitespace inside the address (adversarial
     * review, Minor 8). `isValidEmail` is a loose shape check, and a bare
     * `\r\n` in a value that reaches a mail transport is the classic header
     * injection primitive. Treated as invalid input, exactly like any other
     * malformed address — a fact about the string, not about who has an
     * account.
     */
    it.each([
      "a b@example.test",
      "a\tb@example.test",
      "victim@example.test\r\nBcc: attacker@evil.test",
      "victim@example.test\nX-Injected: 1",
      `vic${String.fromCharCode(0)}tim@example.test`,
      `victim@example.test${String.fromCharCode(127)}`,
    ])("rejects %j — no row, no send", async (input) => {
      await seedExistingAccount()
      const mints = trackMints()
      const res = await magicLink(useApp(), input)
      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: "email is invalid" })
      expect(mints).not.toHaveBeenCalled()
      expect(sent).toEqual([])
    })

    it("still accepts an address wrapped in ordinary surrounding whitespace", async () => {
      // The trim happens first, so leading/trailing space is a typo to
      // forgive — it is INTERNAL whitespace and control bytes that are junk.
      await seedMember("padded")
      const res = await magicLink(useApp(), "\t padded@example.test \n")
      expect(res.status).toBe(202)
      expect(sent).toHaveLength(1)
      expect(sent[0].to).toBe("padded@example.test")
    })
  })

  // -------------------------------------------------------------------------
  // GET /auth/signin/:token
  // -------------------------------------------------------------------------

  describe("GET /auth/signin/:token", () => {
    it("signs an existing member in and 302s home", async () => {
      const member = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "clicker",
        email: "clicker@example.test",
        displayName: "Clicker",
        avatarUrl: "https://avatars.example.test/c.png",
        role: "editor",
      })
      const app = useApp()
      const path = await linkPathFor(app, "clicker@example.test")

      const res = await redeem(app, path)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")
      const session = extractCookie(setCookies(res), "viewer_session")
      expect(session).toBeTruthy()

      const me = await request(app).get("/api/v1/me").set("Cookie", `viewer_session=${session}`)
      expect(me.body.user.id).toBe(member.id)
      // The synthetic email profile must NOT overwrite a GitHub identity's
      // real name/avatar — see `gate.ts` rung 1.
      expect(me.body.user.displayName).toBe("Clicker")
      expect(me.body.user.avatarUrl).toBe("https://avatars.example.test/c.png")
      expect(me.body.user.provider).toBe("github")
      expect(me.body.user.role).toBe("editor")
    })

    it("self-serve domain join: creates the account at the RULE's role on first click", async () => {
      await seedExistingAccount()
      await storage.setDomainRule({ domain: "join.test", role: "viewer", createdByUserId: null })
      const app = useApp()
      const path = await linkPathFor(app, "newbie@join.test")

      const res = await redeem(app, path)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")

      const created = await storage.getUserByEmail("newbie@join.test")
      expect(created?.role).toBe("viewer")
      expect(created?.provider).toBe("email")
      expect(created?.status).toBe("active")
    })

    /**
     * C3: the gate looks up a pending invite by email on every door,
     * including this one — the self-serve domain-join link never carries an
     * invite token, so without the lookup an admin's invite would be
     * silently outranked by a domain rule the moment the recipient used the
     * "email me a link" box instead of the emailed invite itself.
     */
    it("a pending invite outranks a domain rule on the self-serve join door too", async () => {
      await seedExistingAccount()
      await storage.setDomainRule({ domain: "join.test", role: "viewer", createdByUserId: null })
      const inviteGen = generateOneTimeToken("dsi")
      const invite = await storage.createInstanceInvite({
        id: inviteGen.id,
        email: "newbie@join.test",
        role: "editor",
        tokenHash: inviteGen.tokenHash,
        createdByUserId: null,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      })
      const app = useApp()
      const path = await linkPathFor(app, "newbie@join.test")

      const res = await redeem(app, path)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")

      const created = await storage.getUserByEmail("newbie@join.test")
      expect(created?.role).toBe("editor")
      expect((await storage.getInstanceInvite(invite.id))?.usedAt).not.toBeNull()
    })

    it("is single-use: the second click is refused and mints no second session", async () => {
      await seedMember("once")
      const app = useApp()
      const path = await linkPathFor(app, "once@example.test")

      const first = await redeem(app, path)
      expect(first.status).toBe(302)
      expect(first.headers.location).toBe("/")

      const second = await redeem(app, path)
      expect(second.status).toBe(302)
      expect(second.headers.location).toBe("/denied?reason=link-invalid")
      expect(setCookies(second)).toEqual([])
    })

    it("refuses an EXPIRED token with no cookie", async () => {
      const member = await seedMember("stale")
      const minted = generateOneTimeToken("dss")
      await storage.createSignInToken({
        id: minted.id,
        userId: member.id,
        email: null,
        tokenHash: minted.tokenHash,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })

      const res = await redeem(useApp(), `/api/v1/auth/signin/${minted.token}`)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied?reason=link-invalid")
      expect(setCookies(res)).toEqual([])
    })

    it("refuses a garbage token rather than 404ing or 500ing", async () => {
      const res = await request(useApp())
        .post("/api/v1/auth/signin/garbage-token")
        .set("Sec-Fetch-Dest", "document")
        .set("Sec-Fetch-Site", "same-origin")
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied?reason=link-invalid")
    })

    /**
     * The GET's answer to a token that is not even well-formed: a 404 page,
     * never the confirmation form. Not an oracle — the format check is a pure
     * function of the string the caller already holds — but it must not offer
     * a button that could only ever fail.
     */
    it("the confirmation page 404s a malformed token instead of offering a button", async () => {
      const res = await request(useApp())
        .get("/api/v1/auth/signin/garbage-token")
        .set("Sec-Fetch-Dest", "document")
      expect(res.status).toBe(404)
      expect(res.text).not.toContain("<form")
    })

    it("refuses a token whose secret does not match the stored hash", async () => {
      const member = await seedMember("forged")
      const real = generateOneTimeToken("dss")
      await storage.createSignInToken({
        id: real.id,
        userId: member.id,
        email: null,
        tokenHash: real.tokenHash,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      // Same id, a different secret — the exact shape a constant-time hash
      // comparison exists to refuse.
      const forged = generateOneTimeToken("dss", real.id)

      const res = await redeem(useApp(), `/api/v1/auth/signin/${forged.token}`)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied?reason=link-invalid")
      expect(setCookies(res)).toEqual([])
      // The real token is untouched — a failed guess must not burn it.
      expect((await storage.getSignInToken(real.id))?.usedAt).toBeNull()
    })

    /**
     * Prefix isolation, in both directions. `dsi` and `dss` are separate
     * credential families over separate tables; a token from one must never
     * resolve at the other's route even though the id space is shared.
     */
    it("refuses an INVITE token presented at the sign-in route", async () => {
      const minted = generateOneTimeToken("dsi")
      await storage.createInstanceInvite({
        id: minted.id,
        email: "crossed@example.test",
        role: "editor",
        tokenHash: minted.tokenHash,
        createdByUserId: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })

      const app = useApp()
      // The GET refuses it on FORMAT alone — an invite token cannot even be
      // the right shape for this route — so there is no page to press a
      // button on, and the POST refuses it too.
      const page = await request(app)
        .get(`/api/v1/auth/signin/${minted.token}`)
        .set("Sec-Fetch-Dest", "document")
      expect(page.status).toBe(404)

      const res = await request(app)
        .post(`/api/v1/auth/signin/${minted.token}`)
        .set("Sec-Fetch-Dest", "document")
        .set("Sec-Fetch-Site", "same-origin")
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied?reason=link-invalid")
      expect(setCookies(res)).toEqual([])
    })

    it("refuses a SIGN-IN token presented at the invite route", async () => {
      const member = await seedMember("crossed")
      const minted = generateOneTimeToken("dss")
      await storage.createSignInToken({
        id: minted.id,
        userId: member.id,
        email: null,
        tokenHash: minted.tokenHash,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })

      const app = useApp()
      const page = await request(app)
        .get(`/api/v1/auth/invite/${minted.token}`)
        .set("Sec-Fetch-Dest", "document")
      expect(page.status).toBe(404)

      const res = await request(app)
        .post(`/api/v1/auth/invite/${minted.token}`)
        .set("Sec-Fetch-Dest", "document")
        .set("Sec-Fetch-Site", "same-origin")
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied?reason=invite-invalid")
      expect(setCookies(res)).toEqual([])
    })

    /**
     * THE self-serve-join revocation case. The link was legitimately minted
     * against a live domain rule; the admin deleted the rule before it was
     * clicked. The GATE — not this route — is what refuses, and it must: a
     * minted link is not a standing grant.
     */
    it("refuses when the domain rule was removed between mint and click", async () => {
      await seedExistingAccount()
      await storage.setDomainRule({ domain: "join.test", role: "viewer", createdByUserId: null })
      const app = useApp()
      const path = await linkPathFor(app, "revoked@join.test")

      await storage.removeDomainRule("join.test")

      const res = await redeem(app, path)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied?reason=link-invalid")
      expect(setCookies(res)).toEqual([])
      expect(await storage.getUserByEmail("revoked@join.test")).toBeNull()
    })

    it("refuses a REMOVED account's outstanding link and revokes its live credentials", async () => {
      const member = await seedMember("revokeme")
      const app = useApp()
      const path = await linkPathFor(app, "revokeme@example.test")

      const liveSession = await storage.createSession({
        userId: member.id,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      await storage.createMachineToken({
        id: "fedcba9876543210",
        userId: member.id,
        name: "ci",
        scopes: ["read"],
        tokenHash: "hash",
        expiresAt: null,
      })
      await storage.setUserStatus(member.id, "removed")

      const res = await redeem(app, path)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied?reason=link-invalid")
      expect(setCookies(res)).toEqual([])
      expect(await storage.getSession(liveSession.id)).toBeNull()
      expect(await storage.listMachineTokensForUser(member.id)).toHaveLength(0)
      // The row itself survives — `removed` is a soft delete.
      expect((await storage.getUser(member.id))?.status).toBe("removed")
    })

    /**
     * Fix wave 9, item 3. `deleteSignInTokensForUser` (fix wave 8, item 2,
     * proven just above) cannot reach an EMAIL-linked token — that row names
     * no account, only an address — so a self-serve-join link for the SAME
     * address the refused account holds used to survive this exact refusal
     * untouched.
     */
    it("also revokes an outstanding EMAIL-linked sign-in link for the refused account's own address", async () => {
      const member = await seedMember("revokeemail")
      const app = useApp()
      // Minted separately from the one about to be redeemed below — a second
      // "email me a link" request for the same address, or one left over
      // from before the account existed.
      const emailMinted = generateOneTimeToken("dss")
      await storage.createSignInToken({
        id: emailMinted.id,
        userId: null,
        email: "revokeemail@example.test",
        tokenHash: emailMinted.tokenHash,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      const path = await linkPathFor(app, "revokeemail@example.test")
      await storage.setUserStatus(member.id, "removed")

      const res = await redeem(app, path)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied?reason=link-invalid")

      expect(await storage.getSignInToken(emailMinted.id)).toBeNull()
    })

    it("refuses a link whose user row disappeared between mint and click", async () => {
      const member = await seedMember("vanished")
      const minted = generateOneTimeToken("dss")
      await storage.createSignInToken({
        id: minted.id,
        userId: `${member.id}-nope`,
        email: null,
        tokenHash: minted.tokenHash,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })

      const res = await redeem(useApp(), `/api/v1/auth/signin/${minted.token}`)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied?reason=link-invalid")
      expect(setCookies(res)).toEqual([])
    })

    /**
     * The `/auth/invite/<token>` guard finding, applied to the second
     * path-segment-token route: possession of the token alone mints a session
     * on a bare GET, so a same-origin prototype could `<iframe src=…>` it and
     * silently swap the visitor's session. Exempt for `document` ONLY.
     */
    it.each(["iframe", "frame", "object", "embed"])(
      "refuses a sign-in link framed as %s — no cookie, token left unclaimed",
      async (dest) => {
        await seedMember(`framed${dest}`)
        const mints = trackMints()
        const app = useApp()
        const path = await linkPathFor(app, `framed${dest}@example.test`)

        // Both halves. The GET is inert now, so the request that would
        // actually spend the link is the POST — a framed page can submit a
        // form as easily as it can set a `src`, and the guard refuses both.
        for (const verb of ["get", "post"] as const) {
          const res = await request(app)[verb](path).set("Sec-Fetch-Dest", dest)
          expect(res.status, verb).toBe(403)
          expect(res.headers["set-cookie"], verb).toBeUndefined()
        }
        expect((await storage.getSignInToken(mints.mock.calls[0][0].id))?.usedAt).toBeNull()
      },
    )

    it("the SAME link still works as a top-level navigation after being refused as an iframe", async () => {
      await seedMember("afterframe")
      const app = useApp()
      const path = await linkPathFor(app, "afterframe@example.test")

      expect((await request(app).post(path).set("Sec-Fetch-Dest", "iframe")).status).toBe(403)
      const clicked = await redeem(app, path)
      expect(clicked.status).toBe(302)
      expect(clicked.headers.location).toBe("/")
    })

    it("does not extend the document exemption to a path nested one level under it", async () => {
      const app = useApp()
      for (const verb of ["get", "post"] as const) {
        const res = await request(app)
          [verb]("/api/v1/auth/signin/some-token/extra")
          .set("Sec-Fetch-Dest", "document")
        expect(res.status, verb).toBe(403)
      }
    })

    /**
     * Fix wave 6 — the reason the GET/POST split exists.
     *
     * A sign-in URL sitting in a mailbox is fetched by things that are not the
     * recipient: link unfurlers, mail security scanners, gateway prefetchers.
     * Each is a GET, and while the GET redeemed, each of them burned the
     * link — the person then clicked something already spent, and every
     * failure looks identical by design, so they could not tell why.
     */
    it("a bare GET does not claim the link — the real click still works", async () => {
      await seedMember("unfurled")
      const mints = trackMints()
      const app = useApp()
      const path = await linkPathFor(app, "unfurled@example.test")
      const tokenId = mints.mock.calls[0][0].id

      for (let i = 0; i < 3; i += 1) {
        expect((await request(app).get(path).set("Sec-Fetch-Dest", "document")).status).toBe(200)
      }
      expect((await storage.getSignInToken(tokenId))?.usedAt).toBeNull()

      const clicked = await redeem(app, path)
      expect(clicked.status).toBe(302)
      expect(clicked.headers.location).toBe("/")
    })

    /**
     * The page must not become the oracle the uniform `/denied` redirect is
     * careful not to be. A live link and a random well-formed token differ
     * ONLY in the token itself, because nothing about either is looked up.
     */
    it("renders the same page for a live link and a random well-formed token", async () => {
      await seedMember("sameshape")
      const app = useApp()
      const path = await linkPathFor(app, "sameshape@example.test")
      const real = path.split("/auth/signin/")[1]
      const bogus = generateOneTimeToken("dss").token

      const realPage = await request(app).get(path).set("Sec-Fetch-Dest", "document")
      const bogusPage = await request(app)
        .get(`/api/v1/auth/signin/${bogus}`)
        .set("Sec-Fetch-Dest", "document")

      expect(realPage.status).toBe(bogusPage.status)
      expect(realPage.text.replaceAll(real, "TOKEN")).toBe(
        bogusPage.text.replaceAll(bogus, "TOKEN"),
      )
    })

    it("serves the confirmation page with no-store — the URL is a credential", async () => {
      await seedMember("nostore")
      const app = useApp()
      const path = await linkPathFor(app, "nostore@example.test")

      const page = await request(app).get(path).set("Sec-Fetch-Dest", "document")
      expect(page.headers["cache-control"]).toBe("no-store")
      expect(page.text).toContain(`<meta name="robots" content="noindex">`)
    })

    /**
     * The document-destination guard fails OPEN on an absent `Sec-Fetch-Dest`
     * — right for a read, wrong for the one request that spends a credential,
     * because "no Sec-Fetch headers at all" is exactly what a scripted or
     * scanner-issued POST looks like. So the redemption route requires the
     * header itself, and refuses BEFORE claiming.
     */
    it("refuses a POST that carries no Sec-Fetch-Dest, and claims nothing", async () => {
      await seedMember("scripted")
      const mints = trackMints()
      const app = useApp()
      const path = await linkPathFor(app, "scripted@example.test")
      const tokenId = mints.mock.calls[0][0].id

      const res = await request(app).post(path)
      expect(res.status).toBe(403)
      expect(setCookies(res)).toEqual([])
      expect((await storage.getSignInToken(tokenId))?.usedAt).toBeNull()

      expect((await redeem(app, path)).status).toBe(302)
    })

    /**
     * Fix wave 7, item 3. `Sec-Fetch-Dest: document` alone says the request
     * is a top-level navigation — it does not say WHERE FROM. A cross-site
     * page can carry a real `<a href>` or an auto-submitting form to this
     * exact path and produce `document` too; `Sec-Fetch-Site` is the header
     * that tells the two apart, and only the confirmation page's own form
     * submit is same-origin. Absent is refused the same as cross-site — same
     * reasoning as the dest check just above: no `Sec-Fetch-*` at all is
     * exactly what a scripted or scanner-issued POST looks like.
     */
    it("refuses a cross-site POST even with Sec-Fetch-Dest: document, and claims nothing", async () => {
      await seedMember("crosssite")
      const mints = trackMints()
      const app = useApp()
      const path = await linkPathFor(app, "crosssite@example.test")
      const tokenId = mints.mock.calls[0][0].id

      const res = await request(app)
        .post(path)
        .set("Sec-Fetch-Dest", "document")
        .set("Sec-Fetch-Site", "cross-site")
      expect(res.status).toBe(403)
      expect(setCookies(res)).toEqual([])
      expect((await storage.getSignInToken(tokenId))?.usedAt).toBeNull()

      // Still redeemable by the person it was for.
      expect((await redeem(app, path)).status).toBe(302)
    })

    it("refuses a POST with Sec-Fetch-Dest: document but no Sec-Fetch-Site, and claims nothing", async () => {
      await seedMember("nositeheader")
      const mints = trackMints()
      const app = useApp()
      const path = await linkPathFor(app, "nositeheader@example.test")
      const tokenId = mints.mock.calls[0][0].id

      const res = await request(app).post(path).set("Sec-Fetch-Dest", "document")
      expect(res.status).toBe(403)
      expect(setCookies(res)).toEqual([])
      expect((await storage.getSignInToken(tokenId))?.usedAt).toBeNull()
    })

    /**
     * Fix wave 7, item 4. A browser old enough to send no Fetch Metadata
     * headers at all (pre-16.4 Safari) hits this same refusal on a routine
     * click, not an attack — so it gets a readable page instead of a bare
     * JSON body, and the page names no token.
     */
    it("renders an HTML page, not JSON, when the navigation check refuses — no token echoed", async () => {
      await seedMember("oldbrowser")
      const app = useApp()
      const path = await linkPathFor(app, "oldbrowser@example.test")
      const token = path.split("/auth/signin/")[1]

      const res = await request(app).post(path)
      expect(res.status).toBe(403)
      expect(res.headers["content-type"]).toContain("text/html")
      expect(res.text).toContain(
        "This browser didn't send the information needed to sign you in safely. Open the link in an up-to-date browser and try again.",
      )
      expect(res.text).not.toContain(token)
      // Fix wave 8, item 3: parity with the GET confirmation page
      // (`sendSignInConfirmation`) — this response is reached by a URL that
      // carries a credential too, so a shared cache or the back-forward
      // cache must not hold a copy of it either.
      expect(res.headers["cache-control"]).toBe("no-store")
    })

    it("redeems exactly once — the second POST is refused", async () => {
      await seedMember("exactlyonce")
      const app = useApp()
      const path = await linkPathFor(app, "exactlyonce@example.test")

      const first = await request(app)
        .post(path)
        .set("Sec-Fetch-Dest", "document")
        .set("Sec-Fetch-Site", "same-origin")
      expect(first.headers.location).toBe("/")
      const second = await request(app)
        .post(path)
        .set("Sec-Fetch-Dest", "document")
        .set("Sec-Fetch-Site", "same-origin")
      expect(second.headers.location).toBe("/denied?reason=link-invalid")
      expect(setCookies(second)).toEqual([])
    })

    /**
     * Drift-proofing, the same shape `instance-routes.test.ts` uses for the
     * invite URL: take the link the EMAIL carries, keep only its path, and ask
     * this app to resolve it. A URL built against the wrong mount looks
     * plausible and 404s for a real recipient, and no test that extracts the
     * token by hand can ever see that.
     */
    it("the emailed link's own path resolves on this app", async () => {
      await seedMember("drift")
      const app = useApp()
      await magicLink(app, "drift@example.test")

      const href = signInHref(sent[0].html)
      expect(href).toMatch(
        /^http:\/\/localhost:3100\/api\/v1\/auth\/signin\/dss_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/,
      )
      // The emailed url is the CONFIRMATION PAGE's path; `redeem` drives its
      // GET and then the form's POST, so a url built against the wrong mount
      // still fails here — now on the GET.
      const res = await redeem(app, new URL(href).pathname)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")
    })

    it("works on a viewer with no GitHub sign-in configured at all", async () => {
      // The whole point of the email lane: an instance that never sets up a
      // GitHub App still has a way in.
      await seedMember("nogithub")
      const deps = depsWith()
      expect(deps.config.githubAuth).toBeNull()
      stableAlt.use(createApp(deps))

      const path = await linkPathFor(stableAlt.app, "nogithub@example.test")
      const res = await redeem(stableAlt.app, path)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")
    })
  })

  // -------------------------------------------------------------------------
  // DELETE /instance/members/:userId also revokes an outstanding
  // EMAIL-linked sign-in link (fix wave 9, item 3)
  // -------------------------------------------------------------------------

  describe("DELETE /instance/members/:userId revokes an outstanding email-linked sign-in link", () => {
    /**
     * The exact scenario fix wave 9, item 3 closes: a self-serve-join link is
     * minted for an address BEFORE any account exists at it, the account then
     * shows up through a completely different door (here, an admin invite —
     * never by clicking the link), and only later is it removed. Before this
     * fix, `deleteSignInTokensForUser` (fix wave 8, item 2) could not reach
     * the email-linked row at all — it names no account, only the address —
     * so the old link outlived the removal and even a restore.
     */
    it("mints an email-linked link, the account is created another way, is removed, restored, and the old link is dead — row gone", async () => {
      await seedExistingAccount()
      await storage.setDomainRule({ domain: "join.test", role: "viewer", createdByUserId: null })
      const app = useApp()

      const mints = trackMints()
      const path = await linkPathFor(app, "later@join.test")
      const mintedTokenId = mints.mock.calls[0][0].id
      expect(mints.mock.calls[0][0]).toMatchObject({ userId: null, email: "later@join.test" })

      // The account shows up through a DIFFERENT door — never by redeeming
      // the link above.
      const created = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: "later-door",
        email: "later@join.test",
        displayName: "Later",
        avatarUrl: "",
        role: "editor",
      })

      await request(app)
        .delete(`/api/v1/instance/members/${created.id}`)
        .set(adminAuth)
        .expect(204)
      await request(app)
        .post(`/api/v1/instance/members/${created.id}/restore`)
        .set(adminAuth)
        .expect(200)

      // The row itself is gone, not merely refused — a restore does not
      // bring it back.
      expect(await storage.getSignInToken(mintedTokenId)).toBeNull()

      const res = await redeem(app, path)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/denied?reason=link-invalid")
      expect(setCookies(res)).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // POST /instance/members/:userId/signin-link
  // -------------------------------------------------------------------------

  describe("POST /instance/members/:userId/signin-link", () => {
    /** Seeds a user at `role` + a live session; returns its `Cookie` header value. */
    async function signInAs(email: string, role: InstanceRole, deps: AppDeps) {
      const user = await upsertTestUser(storage, {
        provider: "github",
        providerUserId: email,
        email,
        displayName: email,
        avatarUrl: "",
        role,
      })
      const session = await storage.createSession({
        userId: user.id,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      return {
        user,
        cookie: `viewer_session=${signSessionId(deps.config.sessionSecret, session.id)}`,
      }
    }

    it("refuses an anonymous caller with 403", async () => {
      const member = await seedMember("target")
      await request(useApp())
        .post(`/api/v1/instance/members/${member.id}/signin-link`)
        .expect(403)
    })

    it("refuses a signed-in EDITOR with 403", async () => {
      const deps = depsWith()
      stable.use(createApp(deps))
      const member = await seedMember("target")
      const { cookie } = await signInAs("editor@x.test", "editor", deps)
      await request(stable.app)
        .post(`/api/v1/instance/members/${member.id}/signin-link`)
        .set("Cookie", cookie)
        .expect(403)
    })

    it("admits a signed-in ADMIN session", async () => {
      const deps = depsWith()
      stable.use(createApp(deps))
      const member = await seedMember("target")
      const { cookie } = await signInAs("admin@x.test", "admin", deps)
      await request(stable.app)
        .post(`/api/v1/instance/members/${member.id}/signin-link`)
        .set("Cookie", cookie)
        .expect(201)
    })

    it("404s an unknown user", async () => {
      await request(useApp())
        .post("/api/v1/instance/members/nope/signin-link")
        .set(adminAuth)
        .expect(404)
    })

    /**
     * A read-scoped PAT belonging to an ADMIN is the case worth pinning:
     * the role is sufficient and the scope is not, so this must fail on the
     * scope alone. Minting a sign-in link is the most privilege-dense write
     * on the instance — it hands over a credential for another account — so
     * a token its owner deliberately created read-only must not reach it.
     */
    it("refuses a READ-scoped admin PAT with 403 WRITE_SCOPE_REQUIRED", async () => {
      const target = await seedMember("target")
      const admin = await seedMember("scoped-admin", "admin")
      const pat = generateMachineToken()
      await storage.createMachineToken({
        id: pat.id,
        userId: admin.id,
        name: "read-only",
        scopes: ["read"],
        tokenHash: pat.tokenHash,
        expiresAt: null,
      })

      const res = await request(useApp())
        .post(`/api/v1/instance/members/${target.id}/signin-link`)
        .set("Authorization", `Bearer ${pat.token}`)
      expect(res.status).toBe(403)
      expect(res.body).toEqual({ error: WRITE_SCOPE_REQUIRED })
    })

    it("admits the SAME admin's PAT once it carries the write scope", async () => {
      const target = await seedMember("target")
      const admin = await seedMember("writing-admin", "admin")
      const pat = generateMachineToken()
      await storage.createMachineToken({
        id: pat.id,
        userId: admin.id,
        name: "read-write",
        scopes: ["read", "write"],
        tokenHash: pat.tokenHash,
        expiresAt: null,
      })

      await request(useApp())
        .post(`/api/v1/instance/members/${target.id}/signin-link`)
        .set("Authorization", `Bearer ${pat.token}`)
        .expect(201)
    })

    /**
     * The zero-SMTP re-auth path, and the reason this route exists at all: an
     * admin can hand someone a way back in on a deployment that can send no
     * mail whatsoever.
     */
    it("works with SMTP unconfigured, and the link signs the member in", async () => {
      const member = await seedMember("offline")
      const app = useApp({ smtp: false })

      const res = await request(app)
        .post(`/api/v1/instance/members/${member.id}/signin-link`)
        .set(adminAuth)
      expect(res.status).toBe(201)
      expect(res.body.url).toMatch(
        /^http:\/\/localhost:3100\/api\/v1\/auth\/signin\/dss_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/,
      )
      // Nothing was mailed — there is no provider to mail with.
      expect(sent).toEqual([])

      const clicked = await redeem(app, new URL(res.body.url).pathname)
      expect(clicked.status).toBe(302)
      expect(clicked.headers.location).toBe("/")
      const session = extractCookie(setCookies(clicked), "viewer_session")
      const me = await request(app).get("/api/v1/me").set("Cookie", `viewer_session=${session}`)
      expect(me.body.user.id).toBe(member.id)
    })

    it("mints a 24-HOUR token — the recipient may be offline when it is issued", async () => {
      const member = await seedMember("longlived")
      const mints = trackMints()
      const before = Date.now()

      const res = await request(useApp())
        .post(`/api/v1/instance/members/${member.id}/signin-link`)
        .set(adminAuth)
        .expect(201)

      const ttlMs = new Date(mints.mock.calls[0][0].expiresAt).getTime() - before
      expect(ttlMs).toBeGreaterThan(23 * 60 * 60_000)
      expect(ttlMs).toBeLessThanOrEqual(24 * 60 * 60_000 + 5_000)
      expect(res.body.expiresAt).toBe(mints.mock.calls[0][0].expiresAt)
    })

    it("mints the userId variant and stores only the hash", async () => {
      const member = await seedMember("hashed")
      const mints = trackMints()

      const res = await request(useApp())
        .post(`/api/v1/instance/members/${member.id}/signin-link`)
        .set(adminAuth)
        .expect(201)

      const stored = mints.mock.calls[0][0]
      expect(stored).toMatchObject({ userId: member.id, email: null })
      const plaintext = res.body.url.split("/auth/signin/")[1]
      expect(stored.tokenHash).not.toBe(plaintext)
      expect(JSON.stringify(await storage.getSignInToken(stored.id))).not.toContain(plaintext)
    })

    it("is single-use like every other sign-in link", async () => {
      const member = await seedMember("onceadmin")
      const app = useApp()
      const res = await request(app)
        .post(`/api/v1/instance/members/${member.id}/signin-link`)
        .set(adminAuth)
        .expect(201)
      const path = new URL(res.body.url).pathname

      expect((await redeem(app, path)).headers.location).toBe("/")
      const second = await redeem(app, path)
      expect(second.headers.location).toBe("/denied?reason=link-invalid")
    })

    it("409s for a REMOVED member rather than minting a link the gate will refuse", async () => {
      const member = await seedMember("removed")
      await storage.setUserStatus(member.id, "removed")
      const mints = trackMints()

      const res = await request(useApp())
        .post(`/api/v1/instance/members/${member.id}/signin-link`)
        .set(adminAuth)
      expect(res.status).toBe(409)
      expect(res.body).toEqual({
        error: "That member has been removed. Restore them before issuing a sign-in link.",
      })
      expect(mints).not.toHaveBeenCalled()
    })

    it("is not reachable as a document navigation", async () => {
      const member = await seedMember("target")
      const res = await request(useApp())
        .post(`/api/v1/instance/members/${member.id}/signin-link`)
        .set(adminAuth)
        .set("Sec-Fetch-Dest", "document")
      expect(res.status).toBe(403)
    })

    /**
     * Fix wave 8, item 2: removing a member used to kill only their SESSIONS
     * and MACHINE TOKENS (`deleteSessionsForUser` / `deleteMachineTokensForUser`
     * in `DELETE /instance/members/:userId`), leaving an outstanding
     * admin-issued sign-in link fully live — a 24-hour credential (see this
     * route's own doc comment on why it's that long) that a removal is
     * supposed to kill along with everything else. Worse, RESTORING the
     * member did nothing to close it either: the stale link still worked,
     * because `admitSignIn`'s `removed` refusal only applies to a token
     * redeemed while the account is actually removed — restore it first and
     * the same old link signs back in. Removal must revoke the token row
     * itself, not just wait for the account status to make it un-redeemable.
     */
    it("removing a member revokes an outstanding admin-issued sign-in link, even after restoring the account", async () => {
      const member = await seedMember("linked")
      const app = useApp()

      const minted = await request(app)
        .post(`/api/v1/instance/members/${member.id}/signin-link`)
        .set(adminAuth)
        .expect(201)
      const path = new URL(minted.body.url).pathname
      const tokenId = parseOneTimeToken(path.split("/auth/signin/")[1])!.id

      await request(app).delete(`/api/v1/instance/members/${member.id}`).set(adminAuth).expect(204)
      // The row is gone immediately on removal — not merely un-redeemable
      // while the account happens to be `removed`.
      expect(await storage.getSignInToken(tokenId)).toBeNull()

      await request(app)
        .post(`/api/v1/instance/members/${member.id}/restore`)
        .set(adminAuth)
        .expect(200)

      const clicked = await redeem(app, path)
      expect(clicked.headers.location).toBe("/denied?reason=link-invalid")
    })
  })

  // -------------------------------------------------------------------------
  // Invite emails (the Task 6 routes gain a best-effort side effect)
  // -------------------------------------------------------------------------

  describe("invite emails", () => {
    it("POST /instance/invites emails the invite and reports emailed: true", async () => {
      const res = await request(useApp())
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "invitee@x.test", role: "editor" })
        .expect(201)

      expect(res.body.emailed).toBe(true)
      expect(sent).toHaveLength(1)
      expect(sent[0].to).toBe("invitee@x.test")
      expect(sent[0].subject).toBe("You're invited to a Desde viewer")
      // The emailed link is the SAME one the response reveals.
      expect(sent[0].html).toContain(res.body.url)
    })

    it("the emailed invite link actually resolves to a sign-in", async () => {
      const app = useApp()
      await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "resolvable@x.test", role: "viewer" })
        .expect(201)

      const href = /href="([^"]*\/auth\/invite\/[^"]+)"/.exec(sent[0].html)![1]
      const res = await redeem(app, new URL(href).pathname)
      expect(res.status).toBe(302)
      expect(res.headers.location).toBe("/")
      expect((await storage.getUserByEmail("resolvable@x.test"))?.role).toBe("viewer")
    })

    it("reports emailed: false and still succeeds when SMTP is unconfigured", async () => {
      const res = await request(useApp({ smtp: false }))
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "nomail@x.test", role: "editor" })
        .expect(201)

      expect(res.body.emailed).toBe(false)
      expect(res.body.url).toContain("/api/v1/auth/invite/")
      expect(sent).toEqual([])
      // The invite itself was created — the email is a side effect, not the point.
      expect(await storage.listInstanceInvites()).toHaveLength(1)
    })

    it("reports emailed: false and still 201s when the send FAILS", async () => {
      const res = await request(useApp({ mode: "fail" }))
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "failed@x.test", role: "editor" })
        .expect(201)

      expect(res.body.emailed).toBe(false)
      expect(await storage.listInstanceInvites()).toHaveLength(1)
    })

    it("reports emailed: false and still 201s when the send THROWS", async () => {
      const res = await request(useApp({ mode: "throw" }))
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "threw@x.test", role: "editor" })
        .expect(201)

      expect(res.body.emailed).toBe(false)
      expect(await storage.listInstanceInvites()).toHaveLength(1)
    })

    it("regenerate emails the FRESH link and reports emailed", async () => {
      const app = useApp()
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "again@x.test", role: "admin" })
        .expect(201)
      expect(sent).toHaveLength(1)

      const regenerated = await request(app)
        .post(`/api/v1/instance/invites/${created.body.invite.id}/regenerate`)
        .set(adminAuth)
        .expect(200)

      expect(regenerated.body.emailed).toBe(true)
      expect(sent).toHaveLength(2)
      expect(sent[1].to).toBe("again@x.test")
      expect(sent[1].html).toContain(regenerated.body.url)
      // The superseded link is NOT what was mailed the second time.
      expect(sent[1].html).not.toContain(created.body.url)
      // The role phrase comes from the stored invite, not from a request body.
      expect(sent[1].html).toContain("an admin")
    })

    it("regenerate reports emailed: false with SMTP unconfigured", async () => {
      const app = useApp({ smtp: false })
      const created = await request(app)
        .post("/api/v1/instance/invites")
        .set(adminAuth)
        .send({ email: "quiet@x.test", role: "viewer" })
        .expect(201)

      const regenerated = await request(app)
        .post(`/api/v1/instance/invites/${created.body.invite.id}/regenerate`)
        .set(adminAuth)
        .expect(200)
      expect(regenerated.body.emailed).toBe(false)
      expect(sent).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // GET /me — emailSignInEnabled (Task 15)
  // -------------------------------------------------------------------------

  /**
   * The sign-in page (viewer-membership Task 15) decides whether to show the
   * email form off this one field. It reads `deps.config.email !== null` —
   * boot-time SMTP config, the same predicate `/setup`'s "Mention emails" row
   * uses — rather than `deps.email` (the live provider `POST
   * /auth/magic-link` gates on): unlike `signInUrl`, which has to track the
   * GitHub App Manifest flow appearing mid-process, SMTP has no such live
   * reconfiguration story, so there is nothing for a runtime read to buy
   * here. This file (not `auth-routes.test.ts`) is where the `true` case
   * belongs — it is the one suite already built to toggle SMTP via `useApp`.
   */
  describe("GET /me — emailSignInEnabled", () => {
    it("is true when SMTP is configured", async () => {
      const res = await request(useApp()).get("/api/v1/me")
      expect(res.body.emailSignInEnabled).toBe(true)
    })

    it("is false when SMTP is not configured", async () => {
      const res = await request(useApp({ smtp: false })).get("/api/v1/me")
      expect(res.body.emailSignInEnabled).toBe(false)
    })
  })
})

/**
 * Viewer runtime configuration.
 *
 * The `profile` selects which infrastructure impls the process wires up
 * (see server/index.ts): `selfhost` = SQLite + local disk. It is the only
 * Firestore + GCS (Phase 4). Everything else in the server reads its
 * dependencies through interfaces, so this is the only place a profile
 * is named.
 */

import { createPrivateKey } from "node:crypto"
import { loadRuntimeConfig } from "./runtime-config"
import { isLikelyContainerized } from "./serve/container-detect"

/**
 * Only `selfhost` ships. The type stays a union of one so the profile
 * remains an explicit, validated concept rather than dead config — a second
 * backend plugs in here and at the single selection site in `index.ts`.
 * A Firestore/GCS profile existed briefly and was removed: its justification
 * was a deployment that is now maintained separately, and a second impl whose
 * conformance tests skip by default rots silently while the suite stays green.
 */
export type ViewerProfile = "selfhost"

/**
 * Which bundler the Next.js dev server uses in `server/index.ts`. Defaults
 * to `turbopack` (Next 16's default). `webpack` is an escape hatch: Next's
 * programmatic dev server crashes under Turbopack when the project's
 * `node_modules` resolves through a symlink pointing outside the directory
 * Turbopack treats as the filesystem root (e.g. a git worktree sharing a
 * sibling checkout's `node_modules`) — see `server/index.ts` for the exact
 * error. A normal `git clone && npm install` never produces that layout, so
 * `turbopack` stays the default for everyone else.
 */
export type ViewerDevBundler = "turbopack" | "webpack"

/**
 * Whether loopback prototype listeners are allowed to open, from
 * `VIEWER_LOOPBACK_LISTENERS`. Default `"auto"`.
 *
 * - `"on"` — always open them. Use this for a host-network container, where
 *   the browser genuinely shares the host's loopback interface.
 * - `"off"` — never open them. Prototypes fall back to same-host path mode.
 * - `"auto"` — open them unless `isLikelyContainerized()` says this process
 *   is probably in a container. See `ViewerConfig.loopbackAvailable`, which
 *   is the boolean this resolves to and the one the rest of the server
 *   actually reads.
 */
export type ViewerLoopbackListenersMode = "auto" | "on" | "off"

/**
 * Whether a loopback listener binds every interface (`0.0.0.0`) instead of
 * loopback alone, from `VIEWER_LOOPBACK_BIND`. Default `"auto"`.
 *
 * This exists because container detection alone is not enough. `docker run
 * --network host` still makes `isLikelyContainerized()` return true, but
 * host networking means the container's loopback IS the host's loopback —
 * so widening the bind there is both unnecessary and a real exposure: the
 * ports would face the LAN directly, since `--network host` ignores `-p`.
 *
 * - `"loopback"` — always bind loopback alone. Use this on `--network host`.
 * - `"all"` — always bind every interface. The Docker image sets this: a
 *   published `-p` range only reaches the host through a wide bind.
 * - `"auto"` — never widens (codex round 18). No reading of the container's
 *   interfaces can tell a bridged container from a `--network host` one on
 *   a host whose NIC is named `eth0` (codex round 31 retired the last such
 *   heuristic), and the wrong guess puts a credential-free port range on
 *   the LAN. A container under `auto` keeps its own loopback and the banner
 *   names `all` for published ports. See `ViewerConfig.loopbackBindAllInterfaces`.
 *
 * `"off"` for `VIEWER_LOOPBACK_LISTENERS` always wins over this: no listener
 * opens at all, so there is nothing to bind either way.
 */
export type ViewerLoopbackBindMode = "auto" | "loopback" | "all"

export interface ViewerConfig {
  profile: ViewerProfile
  port: number

  /**
   * Email domains (or exact addresses) permitted to sign in. Null = anyone
   * who completes the OAuth flow gets an account.
   *
   * Null is the DEFAULT and is correct for a viewer behind a network
   * boundary, but it is a real exposure on a public URL: sign-in is what
   * grants a GitHub App installation view and the ability to own a project.
   */
  allowedEmailDomains: string[] | null

  /** Root for SQLite db + disk assets (selfhost profile). */
  dataDir: string
  /** Absolute origin the viewer is reachable at; used as the bridge's shell origin. */
  publicUrl: string
  /** Static bearer token guarding write endpoints until real auth lands (Phase 3). */
  adminToken: string | null
  /** Optional `{slug}.{domain}` host routing. Null = path-based only. */
  serveDomain: string | null
  /** Dev-only Next.js bundler choice. See `ViewerDevBundler`. */
  devBundler: ViewerDevBundler
  /**
   * SMTP config for mention-email delivery. Null when `VIEWER_SMTP_HOST` is
   * unset — notifications hold (no send) rather than erroring; commenting
   * itself is unaffected either way. When `VIEWER_SMTP_HOST` IS set, the
   * rest of the SMTP vars are required and validated strictly (a partially
   * configured SMTP setup fails loudly at boot, not silently at send time).
   */
  email: { host: string; port: number; user: string; pass: string; from: string } | null
  /**
   * WHERE `email` came from, so the settings page can say whether it is
   * editable there.
   *
   * `"env"` means `VIEWER_SMTP_HOST` is set and wins; the stored settings are
   * ignored and the form must not pretend otherwise. `"stored"` means it came
   * from the settings page. `null` means mention mail is off.
   */
  emailSource: "env" | "stored" | null
  /** HMAC secret for signing unsubscribe links. Null = unsubscribe links unavailable. */
  unsubscribeSecret: string | null
  /**
   * HMAC key for the session cookie. ALWAYS present — generated into
   * `$VIEWER_DATA_DIR/config.json` on first boot when `VIEWER_SESSION_SECRET`
   * is unset (see `runtime-config.ts`).
   *
   * It is deliberately NOT part of the GitHub group any more. Sessions are a
   * capability of the viewer itself; GitHub is one way to START one, and the
   * local-operator flow (`auth/local-operator.ts`) is another. Before this
   * split, `getCurrentUser` returned null whenever GitHub was unconfigured,
   * which meant a viewer with no GitHub App could hold no sessions, and
   * therefore could not service a single write from its own UI.
   *
   * Setting `VIEWER_SESSION_SECRET` in the environment overrides the
   * generated one and invalidates every existing session. That is the
   * documented way to force a global sign-out.
   */
  sessionSecret: string
  /**
   * GitHub OAuth sign-in. Null when neither `VIEWER_GITHUB_CLIENT_ID` nor
   * `VIEWER_GITHUB_CLIENT_SECRET` is set; setting either requires both.
   * Null means the GitHub sign-in ROUTES do not register — it no longer
   * means sessions are impossible.
   *
   * `authorizeUrl` / `tokenUrl` / `apiBaseUrl` are independent optional
   * overrides for the GitHub endpoints — set them to point at a GitHub
   * Enterprise Server instance (or, for tests, a local OAuth stub) instead
   * of github.com. Each is validated individually when present, but none
   * of the three participates in the all-or-nothing rule above: they are
   * inert (and never validated) when the required pair is absent, since
   * there is no provider to configure endpoints for.
   *
   * When neither `VIEWER_GITHUB_CLIENT_ID` nor `VIEWER_GITHUB_CLIENT_SECRET`
   * is set, a `githubApp` record persisted by the GitHub App Manifest flow
   * (Task 10) supplies `clientId`/`clientSecret` instead — an App created
   * that way carries its own OAuth client credentials, so it can provide
   * sign-in with no separate OAuth App config. The env pair still wins
   * wholesale over that fallback.
   */
  githubAuth: {
    clientId: string
    clientSecret: string
    authorizeUrl?: string
    tokenUrl?: string
    apiBaseUrl?: string
  } | null
  /**
   * GitHub App config (Phase 3c-1) — repo listing / connect-a-repo /
   * eventually clone-for-build. The App's installation token is minted on
   * demand (never stored) to read/clone the repos it is installed on.
   *
   * **Same registration as `githubAuth` above, since Phase 3c-1b.**
   * `githubAuth`'s `clientId`/`clientSecret` are now this App's OWN client
   * credentials (a GitHub App has a client id/secret for user-OAuth on its
   * settings page), not a standalone OAuth App's. The two config blocks stay
   * SEPARATE because they are independently optional and carry different
   * fields — sign-in works with no App keys configured, and vice versa —
   * but an operator now copies both from one App. See
   * `docs/superpowers/plans/2026-08-07-oss-viewer-phase-3c1b-auth-unification.md`
   * for why unifying was necessary: per-user installation filtering requires
   * a GitHub App user token, which a standalone OAuth App cannot produce.
   *
   * Null when none of the three required vars are set — same all-or-nothing
   * discipline as `githubAuth`: any one of `VIEWER_GITHUB_APP_ID` /
   * `VIEWER_GITHUB_APP_PRIVATE_KEY` / `VIEWER_GITHUB_APP_SLUG` set requires
   * all three, validated strictly at boot.
   *
   * `apiBaseUrl` is the same independent-optional-override shape as
   * `githubAuth.apiBaseUrl` (GitHub Enterprise Server support), reusing the
   * SAME `VIEWER_GITHUB_API_BASE_URL` env var — both `githubAuth` and
   * `githubApp` point at the same GitHub host, so there is one override,
   * not two.
   *
   * `VIEWER_GITHUB_APP_WEBHOOK_SECRET` is deliberately NOT read here — it is
   * unused until Phase 3c-3 (push webhooks) consumes it; adding it now would
   * be dead config.
   */
  githubApp: {
    appId: string
    /** Optional. Absent => push-webhook auto-deploy is off. */
    webhookSecret?: string
    /**
     * Always a normalized literal PEM by the time it lands here — see
     * `normalizeGithubAppPrivateKey`. The raw env var may be a literal PEM
     * or a base64-encoded PEM (multiline env vars are miserable in most
     * process managers); `loadConfig` detects and decodes.
     */
    privateKeyPem: string
    slug: string
    apiBaseUrl?: string
  } | null
  /**
   * Content-Security-Policy sent on served prototype HTML, from
   * `VIEWER_PROTOTYPE_CSP`. Same "absent is a legitimate state" shape as
   * `adminToken` — not the all-or-nothing SMTP/auth trio — because there is
   * no combination of other vars this one needs to agree with:
   *
   * - `null` (unset): the serve layer computes a default policy scoped to
   *   the prototype's own path prefix.
   * - the literal string `"off"`: no CSP header is sent at all (documented
   *   escape hatch for prototypes that break under any policy).
   * - any other string: sent verbatim as the header value.
   *
   * DANGER, `"off"`: prototypes are served SAME-ORIGIN with the viewer, so
   * with no CSP a hosted prototype's JS can call
   * `fetch('/api/v1/tokens', { method: 'POST', credentials: 'include',
   * referrerPolicy: 'no-referrer' })` and mint a personal access token as
   * whoever is currently signed in and viewing it — a credential that
   * survives that reviewer's logout and shows up nowhere they would look.
   * No header check can stop it (the request is legitimately same-origin,
   * and the referer guard is bypassable by the page that controls it); the
   * structural fix is per-prototype subdomains (Phase 3d). Never use `off`
   * on a deployment where the people who can publish a prototype are a
   * wider set than the people you would hand an API token to. Prefer a
   * custom policy that allow-lists what a prototype actually needs in
   * `connect-src`. See the README's "Prototype isolation" section.
   */
  prototypeCsp: string | null
  /**
   * `VIEWER_PROTOTYPE_ORIGIN` — a SINGLE alternate origin that serves ALL
   * prototypes, cross-origin from the shell but path-namespaced under
   * `/p/{slug}/`. Null when unset. Normalized to its bare origin
   * (`scheme://host`, default port dropped) at load, so every downstream
   * reader gets a clean origin string.
   *
   * For an operator who can add ONE DNS name and one cert SAN but not a
   * wildcard. It is weaker than subdomain mode (`VIEWER_SERVE_DOMAIN`):
   * every prototype shares this one origin, so they share a cookie jar,
   * `localStorage` and IndexedDB and can script each other. Subdomain mode
   * gives each prototype its own registrable host and is strictly stronger;
   * prefer it when wildcard DNS is available.
   *
   * Boot refuses three unsafe shapes (`assertPrototypeOriginConfig` in
   * `serve/prototype-origin-resolve.ts`): an origin equal to `publicUrl`
   * (sandbox escape), a different scheme (mixed content), and a same-site
   * sibling of `publicUrl` (a Domain cookie the shell would receive).
   */
  prototypeOrigin: string | null
  /** Seed a demo project on an empty first boot. `VIEWER_DEMO_PROJECT=off` disables it. */
  seedDemoProject: boolean
  /**
   * Express's `trust proxy`. `false` (the default) when nothing is in front of
   * this server. See {@link parseTrustProxy} for why `true` is refused.
   */
  trustProxy: number | string | false
  /** Raw `VIEWER_LOOPBACK_LISTENERS` mode. See `ViewerLoopbackListenersMode`. */
  loopbackListeners: ViewerLoopbackListenersMode
  /**
   * Computed from `loopbackListeners`: `"on"` → `true`, `"off"` → `false`,
   * `"auto"` → not a container, OR a container that has a
   * {@link ViewerConfig.loopbackPortRange} (which is every container, since
   * the range has a container default). This is the value `resolveOrigins`
   * (`server/serve/prototype-origin-resolve.ts`) actually reads — it stays
   * import-free and pure, so the container check has to run here, at boot,
   * and get threaded in as a plain boolean.
   *
   * When `false`, a shell that would otherwise get loopback mode (a
   * loopback `VIEWER_PUBLIC_URL`) falls back to same-host path mode
   * instead: no per-deployment listener is opened.
   *
   * The container case needs TWO things to be reachable, and the range is
   * only one of them: a published port forwards to the container's external
   * interface and never to the container's own loopback, so the listener
   * also binds `0.0.0.0` whenever a range is configured. See
   * `serve/loopback-listeners.ts`. Before that bind widened, a container
   * with a published range served nothing at all (MEASURED, 2026-09-11).
   */
  loopbackAvailable: boolean
  /**
   * Loopback listeners bind ports from this range instead of ephemeral ones.
   * `VIEWER_LOOPBACK_PORT_RANGE="3101-3120"`. Defaults to the twenty ports
   * above `PORT` inside a container and to `null` (ephemeral) elsewhere. It
   * exists so a container can publish the range with one `-p` flag; see the
   * server-prototypes spec, "Loopback port range".
   */
  loopbackPortRange: { from: number; to: number } | null
  /**
   * Whether a loopback listener binds every interface (`0.0.0.0`) instead of
   * a loopback address alone.
   *
   * This is a NARROWER question than `loopbackPortRange` being set. Before
   * this field existed, `loopback-listeners.ts` widened the bind whenever
   * `deps.portRange` was non-null — but an operator can set
   * `VIEWER_LOOPBACK_PORT_RANGE` on a laptop for reasons that have nothing to
   * do with being in a container, and that laptop is not behind Docker's
   * port-forwarding NAT. Binding `0.0.0.0` there makes a private prototype
   * reachable from anyone else on the LAN, on a predictable port, with
   * `Host: localhost:<port>` — the loopback boundary the whole listener
   * design rests on would be gone.
   *
   * True ONLY when the process is ACTUALLY detected as a container (never
   * merely told to behave like one): `"auto"` mode's own container check, or
   * `"on"` mode's container check run for this purpose alone (see
   * `loadConfig`). `"off"` is always false, since no listener opens at all.
   * `"on"` forced by an operator on a real laptop is also false: forcing
   * listeners open is not the same statement as forcing the wildcard bind,
   * and only the second one is safe to infer from the first.
   *
   * Directly controllable with `VIEWER_LOOPBACK_BIND` (codex round 6, Fix 1):
   * `"loopback"` forces this false and `"all"` forces it true (except under
   * `VIEWER_LOOPBACK_LISTENERS=off`, where it stays false because no
   * listener opens). The default, `"auto"`, never widens: only the
   * operator's explicit `"all"` does (codex round 18). See
   * `ViewerLoopbackBindMode` for why no interface listing gets a say.
   */
  loopbackBindAllInterfaces: boolean
  /**
   * The operator's `VIEWER_LOOPBACK_BIND` as given (`auto` when unset), so
   * the banner can tell a deliberate `loopback` from the default's own
   * choice: only the default deserves "set it to all if you meant to".
   */
  loopbackBind: ViewerLoopbackBindMode
  /**
   * A container was detected and listeners are not off. The banner's cue to
   * name `VIEWER_LOOPBACK_BIND=all` under `auto`, and, under `all`, to say
   * what `--network host` needs instead: the wide bind is the image's
   * default and nothing here can tell the two network layouts apart, so
   * every container under `all` hears it (codex round 31).
   */
  loopbackInContainer: boolean
}

const PROFILES: ViewerProfile[] = ["selfhost"]
const DEV_BUNDLERS: ViewerDevBundler[] = ["turbopack", "webpack"]
const LOOPBACK_LISTENERS_MODES: ViewerLoopbackListenersMode[] = ["auto", "on", "off"]
const LOOPBACK_BIND_MODES: ViewerLoopbackBindMode[] = ["auto", "loopback", "all"]

/**
 * Parses the allowlist. An entry containing `@` is an exact address; anything
 * else is a domain. Returns null for unset/blank so "not configured" stays
 * distinct from "configured with nothing", which would lock every user out of
 * their own deployment.
 *
 * The env var is now an ADMISSION SEED, not a live check: `seedDomainRulesFromEnv`
 * (`auth/gate.ts`) converts these entries into stored instance domain rules
 * once, on a boot that has none, and every later decision reads the stored
 * rules. The companion `isEmailAllowed` predicate was deleted along with the
 * two per-request re-checks that were its only callers — see `current-user.ts`
 * for why a live session must not be gated on this. Exact-address entries have
 * no domain-rule equivalent and are skipped with a warning by the seeder.
 */
export function parseAllowedEmailDomains(raw: string | undefined): string[] | null {
  if (raw === undefined) return null
  const entries = raw
    .split(",")
    .map((e) => e.trim().toLowerCase().replace(/^@/, ""))
    .filter((e) => e.length > 0)
  return entries.length > 0 ? entries : null
}

function requireEnv(v: string | undefined, name: string, becauseOf = "VIEWER_SMTP_HOST is set"): string {
  if (!v) {
    throw new Error(`Missing ${name}. Required when ${becauseOf}`)
  }
  return v
}

function requireAuthEnv(v: string | undefined, name: string): string {
  if (!v) {
    throw new Error(
      `Missing ${name}. Required when either of VIEWER_GITHUB_CLIENT_ID, ` +
        `VIEWER_GITHUB_CLIENT_SECRET is set`,
    )
  }
  return v
}

function requireGithubAppEnv(v: string | undefined, name: string): string {
  if (!v) {
    throw new Error(
      `Missing ${name}. Required when any of VIEWER_GITHUB_APP_ID, ` +
        `VIEWER_GITHUB_APP_PRIVATE_KEY, VIEWER_GITHUB_APP_SLUG is set`,
    )
  }
  return v
}

/**
 * Normalizes `VIEWER_GITHUB_APP_PRIVATE_KEY` into a literal PEM string,
 * accepting either form:
 *
 * - a literal PEM (starts with `-----BEGIN`, after trimming) — used as-is.
 * - a base64-encoded PEM — decoded. No second env var declares which form
 *   was used; the leading `-----BEGIN` marker after trim is the detector,
 *   since a base64 alphabet can never produce that literal prefix.
 *
 * Either way, the result is validated by actually parsing it as a private
 * key (`createPrivateKey`) before `loadConfig` returns — a malformed key
 * (garbage, a public key, a truncated paste) fails LOUDLY at boot, not on
 * the first GitHub API call this config eventually backs.
 */
function normalizeGithubAppPrivateKey(raw: string): string {
  const trimmed = raw.trim()
  const pem = trimmed.startsWith("-----BEGIN") ? trimmed : Buffer.from(trimmed, "base64").toString("utf8")
  try {
    createPrivateKey(pem)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Invalid VIEWER_GITHUB_APP_PRIVATE_KEY. Expected a PEM-encoded private key, ` +
        `either literal or base64-encoded (${reason})`,
    )
  }
  return pem
}

/**
 * Validates that `raw` is an absolute http(s) URL, throwing a message that
 * names `varName` when it isn't. Shared by `VIEWER_PUBLIC_URL` and the
 * optional GitHub endpoint overrides below — all three are "a URL a bridge
 * or an OAuth redirect gets pointed at," so a typo should fail loudly at
 * boot rather than surface later as a silent misroute.
 */
function validateAbsoluteHttpUrl(raw: string, varName: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`Invalid ${varName} "${raw}". Expected an absolute http(s) URL`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid ${varName} "${raw}". Expected an absolute http(s) URL`)
  }
  return raw
}

/**
 * Parses `VIEWER_PROTOTYPE_ORIGIN` into a normalized bare origin
 * (`scheme://host`), or `null` when unset/blank.
 *
 * Validated as an absolute http(s) URL (same `validateAbsoluteHttpUrl` as
 * `VIEWER_PUBLIC_URL`) and then reduced to its origin: `URL.host` drops a
 * scheme-default port and any path/query, so `https://proto.example.net:443/x`
 * and `https://proto.example.net` normalize to the same string. A clean origin
 * here is what lets `resolveOrigins` echo it verbatim and the client build
 * `{prototypeOrigin}/p/{slug}/…` without re-normalizing.
 *
 * Blank (`""`/whitespace) normalizes to `null` for the same reason
 * `normalizePrototypeCsp` does: an empty assignment in a `.env` file is an
 * unset variable, not a configured-empty one.
 */
function parsePrototypeOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null
  const validated = validateAbsoluteHttpUrl(raw.trim(), "VIEWER_PROTOTYPE_ORIGIN")
  const url = new URL(validated)
  return `${url.protocol}//${url.host}`
}

/**
 * `VIEWER_PROTOTYPE_CSP=""` (or whitespace-only) is a common `.env`
 * misconfiguration — an unset variable left as an empty assignment rather
 * than omitted entirely. Treating that as "configured" would emit a
 * literal empty `Content-Security-Policy:` header, which browsers ignore
 * outright, silently disabling protection while the variable *looks* set.
 * Normalize it to `null` (unset) so the computed default applies instead.
 */
function normalizePrototypeCsp(raw: string | undefined): string | null {
  if (raw === undefined) return null
  return raw.trim() === "" ? null : raw
}

/**
 * `VIEWER_TRUST_PROXY` — how many reverse-proxy hops sit in front of us, or
 * which proxy addresses to trust.
 *
 * This exists because `rate-limit.ts` keys every bucket on `req.ip`, and
 * `req.ip` only reflects the real client when Express is told about the proxy.
 * Behind a TLS terminator with this unset, every request keys to the PROXY's
 * address, so the per-IP limits become one global bucket: one abusive visitor
 * takes the whole budget and 429s everybody else. The limiter's own doc
 * comment has said an operator "MUST set it (see .env.example / README)" for
 * some time, and until now neither document mentioned it and no setting
 * existed to set.
 *
 * **Default OFF, and `true` is REFUSED.** Express's `true` trusts the leftmost
 * `X-Forwarded-For` entry, which is supplied by the client, so an attacker
 * rotates that header and mints unlimited buckets. That is strictly worse than
 * the shared bucket this setting exists to fix: a shared limit is degraded, a
 * spoofable one is absent. Off is also the right default, because trusting a
 * hop that is not there has the same effect as `true`.
 *
 * Accepted: a positive integer (hop count, the common case is `1`), or a
 * comma-separated list of proxy IPs/CIDRs, or an explicit off value.
 */
function parseTrustProxy(raw: string | undefined): number | string | false {
  if (raw === undefined) return false
  const value = raw.trim()
  if (value === "" || value === "0" || value.toLowerCase() === "false" || value.toLowerCase() === "off") {
    return false
  }
  if (value.toLowerCase() === "true") {
    throw new Error(
      'VIEWER_TRUST_PROXY=true is refused: Express trusts the client-supplied ' +
        "X-Forwarded-For header, so anyone can spoof their address and defeat rate " +
        "limiting entirely. Set the number of proxy hops in front of this server " +
        '(usually "1"), or a comma-separated list of proxy IPs/CIDRs.',
    )
  }
  if (/^\d+$/.test(value)) {
    const hops = Number.parseInt(value, 10)
    if (hops < 1) return false
    return hops
  }
  // An address or CIDR list. Express validates these itself and throws on a
  // malformed entry at `app.set` time, which is the right moment: a typo here
  // should stop the boot, not silently degrade to trusting nobody.
  return value
}

function parseSmtpPort(raw: string | undefined): number {
  if (raw === undefined) return 587
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid VIEWER_SMTP_PORT "${raw}". Expected a positive integer`)
  }
  return port
}

/**
 * Parses `VIEWER_LOOPBACK_PORT_RANGE`, e.g. `"3101-3120"`. `port` is the
 * Viewer's own port (`PORT`), so the range can be checked for overlap with
 * it: a loopback listener sharing the Viewer's own port would collide with
 * it, so that overlap is refused rather than silently allowed.
 */
function parseLoopbackPortRange(raw: string, port: number): { from: number; to: number } {
  const m = /^(\d{1,5})-(\d{1,5})$/.exec(raw.trim())
  if (!m) throw new Error(`VIEWER_LOOPBACK_PORT_RANGE "${raw}" must look like "3101-3120"`)
  const from = Number(m[1])
  const to = Number(m[2])
  if (from < 1024 || to > 65535 || from > to) {
    throw new Error(`VIEWER_LOOPBACK_PORT_RANGE "${raw}" must be within 1024-65535 and ascending`)
  }
  if (port >= from && port <= to) {
    throw new Error(`VIEWER_LOOPBACK_PORT_RANGE "${raw}" must not include the Viewer's own port ${port}`)
  }
  return { from, to }
}

/**
 * The container default range: the twenty ports above `PORT`.
 *
 * Held to the same 65535 ceiling an explicit `VIEWER_LOOPBACK_PORT_RANGE`
 * already is (`parseLoopbackPortRange`). Without this, a `PORT` near the
 * top of the valid port space — 65535 is itself a legal port — silently
 * derives a range like `65536-65555`, ports that do not exist and that no
 * listener could ever bind.
 */
function defaultLoopbackPortRange(port: number): { from: number; to: number } {
  if (port + 20 > 65535) {
    throw new Error(
      `PORT ${port} leaves no room for the twenty loopback prototype ports above it. ` +
        `Set VIEWER_LOOPBACK_PORT_RANGE or a lower PORT.`,
    )
  }
  return { from: port + 1, to: port + 20 }
}

/**
 * `overrides.isLikelyContainerized` exists ONLY for tests: the real default
 * is the real `isLikelyContainerized` (`server/serve/container-detect.ts`),
 * which touches the actual filesystem.
 * Injecting a stub here is what lets the "auto" mode's tests assert a
 * deterministic `loopbackAvailable` / `loopbackBindAllInterfaces` without
 * depending on whether the machine running the suite happens to be a
 * container. Same shape as `buildHostAllowlist`'s options-bag second
 * parameter (`serve/host-allowlist.ts`) — an options bag rather than
 * threading a new positional parameter through every other caller.
 */
export function loadConfig(
  env: Partial<NodeJS.ProcessEnv> = process.env,
  overrides: { isLikelyContainerized?: () => boolean } = {},
): ViewerConfig {
  const profile = (env.VIEWER_PROFILE ?? "selfhost") as ViewerProfile
  if (!PROFILES.includes(profile)) {
    throw new Error(
      `Unknown VIEWER_PROFILE "${profile}". Expected one of ${PROFILES.join(", ")}`,
    )
  }

  const rawPort = env.PORT ?? "3100"
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT "${rawPort}". Expected a positive integer`)
  }

  const publicUrl = (env.VIEWER_PUBLIC_URL ?? `http://localhost:${port}`).replace(
    /\/+$/,
    "",
  )
  // `publicUrl` is used verbatim as the bridge's `shellOrigin` — the origin
  // every served prototype's injected bridge posts messages to. A malformed
  // value would silently produce a bridge whose postMessage target is
  // wrong, so validate it's an absolute http(s) URL up front rather than
  // letting a typo surface later as "comments/inspector mysteriously don't
  // work."
  validateAbsoluteHttpUrl(publicUrl, "VIEWER_PUBLIC_URL")

  const devBundler = (env.VIEWER_DEV_BUNDLER ?? "turbopack") as ViewerDevBundler
  if (!DEV_BUNDLERS.includes(devBundler)) {
    throw new Error(
      `Unknown VIEWER_DEV_BUNDLER "${devBundler}". Expected one of ${DEV_BUNDLERS.join(", ")}`,
    )
  }

  const loopbackListeners = (env.VIEWER_LOOPBACK_LISTENERS ?? "auto") as ViewerLoopbackListenersMode
  if (!LOOPBACK_LISTENERS_MODES.includes(loopbackListeners)) {
    throw new Error(
      `Unknown VIEWER_LOOPBACK_LISTENERS "${loopbackListeners}". Expected one of ` +
        `${LOOPBACK_LISTENERS_MODES.join(", ")}`,
    )
  }
  // `inContainer` (below) is a forced answer for "on"/"off" and never touches
  // the container check for them — not even to skip calling it, but
  // semantically: an operator who says "on" or "off" is stating the
  // AVAILABILITY answer, not asking us to detect it. Only "auto" (the
  // default) asks `isLikelyContainerized` for that decision.
  //
  // `actuallyInContainer` is a different question, asked regardless of the
  // requested mode: is the process REALLY in a container. The port-range
  // default and the wildcard bind both depend on the real answer, not the
  // operator's requested mode — `VIEWER_LOOPBACK_LISTENERS=on` inside a
  // container still needs the default range and the wide bind, because
  // Docker only forwards a published port to the container's external
  // interface, never to its loopback (codex round 5, Fix 3: MEASURED, `on`
  // forced `inContainer` to `false`, so a container with no explicit range
  // got `null` and bound loopback-only — every prototype origin was
  // unreachable from the host). Never probed for "off": no listener opens
  // either way, so the answer would never be used.
  const detectContainer = overrides.isLikelyContainerized ?? isLikelyContainerized
  const actuallyInContainer = loopbackListeners === "off" ? false : detectContainer()
  const inContainer = loopbackListeners === "auto" ? actuallyInContainer : false
  // The default range only where loopback mode can actually be selected
  // (codex round 63): under `VIEWER_SERVE_DOMAIN` or `VIEWER_PROTOTYPE_ORIGIN`
  // those modes win and no listener ever opens, and deriving the range
  // anyway refused a `PORT` near 65535 for twenty ports nothing would use.
  const loopbackModePossible = !env.VIEWER_SERVE_DOMAIN?.trim() && !env.VIEWER_PROTOTYPE_ORIGIN?.trim()
  const loopbackPortRange = env.VIEWER_LOOPBACK_PORT_RANGE
    ? parseLoopbackPortRange(env.VIEWER_LOOPBACK_PORT_RANGE, port)
    : actuallyInContainer && loopbackModePossible
      ? defaultLoopbackPortRange(port)
      : null
  // A container now gets loopback mode too, on a range it can publish. Reads
  // `inContainer` — the AUTO-only answer — deliberately, not
  // `actuallyInContainer`: an operator who forced "on" has already stated
  // loopback mode is available, so this decision must not be re-derived from
  // whether a container was actually detected. See `ViewerConfig.loopbackAvailable`.
  const loopbackAvailable =
    loopbackListeners === "on" ? true : loopbackListeners === "off" ? false : !inContainer || loopbackPortRange !== null

  const loopbackBind = (env.VIEWER_LOOPBACK_BIND ?? "auto") as ViewerLoopbackBindMode
  if (!LOOPBACK_BIND_MODES.includes(loopbackBind)) {
    throw new Error(
      `Unknown VIEWER_LOOPBACK_BIND "${loopbackBind}". Expected one of ` +
        `${LOOPBACK_BIND_MODES.join(", ")}`,
    )
  }
  // Whether to widen the bind to every interface.
  //
  // `"off"` wins over everything: no listener opens at all, so there is
  // nothing to bind — `"all"` forced by hand must not widen a bind that
  // never happens. `"loopback"` and `"all"` are then the operator's own
  // statement, taken as given. See `ViewerConfig.loopbackBindAllInterfaces`
  // for why the container question must not simply be "is a port range
  // configured".
  const loopbackBindAllInterfaces =
    loopbackListeners === "off"
      ? false
      : loopbackBind === "loopback"
        ? false
        : loopbackBind === "all"
          ? true
          : // `auto` never widens (codex round 18). The interface list cannot
            // tell a bridged container from a host-network container on a
            // host whose NIC is named `eth0`, and the wrong guess puts a
            // credential-free port range on the LAN. The image, which IS
            // the container case, says `all` itself; anyone else says so
            // on the run line, and the banner tells them.
            false

  // A container, whatever its bind: under `auto` the banner tells the
  // operator that `-p` published ports need `VIEWER_LOOPBACK_BIND=all`;
  // under `all` it tells them what `--network host` needs instead.
  const loopbackInContainer = loopbackListeners !== "off" && actuallyInContainer

  const dataDir = env.VIEWER_DATA_DIR ?? ".desde-viewer"
  // Fallback source for `sessionSecret` and, when neither GitHub sign-in nor
  // GitHub App env vars are set, for `githubAuth`/`githubApp` too. Never an
  // override — see the "environment always wins" rule in `runtime-config.ts`.
  const runtime = loadRuntimeConfig(dataDir)

  // GitHub Enterprise Server / test-stub endpoint overrides for GitHub OAuth
  // sign-in. Independent of WHICH branch supplies clientId/clientSecret
  // (env pair or the runtime githubApp fallback below) — an operator who
  // set an endpoint override in the environment expects it honored either
  // way, so this is a shared helper spread into both `githubAuth` branches
  // rather than only the env one.
  //
  // Deliberately a FUNCTION, not a top-level computed value: it must stay
  // lazy so it is only invoked (and can only throw on a malformed override)
  // from inside a branch that actually produces a non-null `githubAuth`.
  // Hoisting the validation to run unconditionally regressed the "malformed
  // override is inert when GitHub sign-in isn't configured at all" case —
  // caught by the config.test.ts suite.
  function githubAuthEndpointOverrides() {
    return {
      ...(env.VIEWER_GITHUB_AUTHORIZE_URL !== undefined
        ? {
            authorizeUrl: validateAbsoluteHttpUrl(
              env.VIEWER_GITHUB_AUTHORIZE_URL,
              "VIEWER_GITHUB_AUTHORIZE_URL",
            ),
          }
        : {}),
      ...(env.VIEWER_GITHUB_TOKEN_URL !== undefined
        ? {
            tokenUrl: validateAbsoluteHttpUrl(env.VIEWER_GITHUB_TOKEN_URL, "VIEWER_GITHUB_TOKEN_URL"),
          }
        : {}),
      ...(env.VIEWER_GITHUB_API_BASE_URL !== undefined
        ? {
            apiBaseUrl: validateAbsoluteHttpUrl(
              env.VIEWER_GITHUB_API_BASE_URL,
              "VIEWER_GITHUB_API_BASE_URL",
            ),
          }
        : {}),
    }
  }

  // Same idea for `githubApp`: these two env overrides must apply whether
  // the trio comes from env or from the runtime fallback below, and
  // `VIEWER_GITHUB_APP_WEBHOOK_SECRET` must beat a webhookSecret already
  // stored in the runtime record (an operator provisioning the App via the
  // manifest flow, then later setting the env var to turn on push
  // auto-deploy, must not have that env var silently ignored). Also a
  // function for the same lazy-evaluation reason as above.
  function githubAppEnvOverrides() {
    return {
      ...(env.VIEWER_GITHUB_APP_WEBHOOK_SECRET
        ? { webhookSecret: env.VIEWER_GITHUB_APP_WEBHOOK_SECRET }
        : {}),
      ...(env.VIEWER_GITHUB_API_BASE_URL !== undefined
        ? {
            apiBaseUrl: validateAbsoluteHttpUrl(
              env.VIEWER_GITHUB_API_BASE_URL,
              "VIEWER_GITHUB_API_BASE_URL",
            ),
          }
        : {}),
    }
  }

  return {
    profile,
    port,
    dataDir,
    publicUrl,
    adminToken: env.VIEWER_ADMIN_TOKEN ?? null,
    serveDomain: env.VIEWER_SERVE_DOMAIN ?? null,
    // Comma-separated. Entries are lowercased and stripped of a leading `@`
    // so `@example.com`, `example.com` and `EXAMPLE.COM` all behave the
    // same — an operator should not have to guess the punctuation.
    allowedEmailDomains: parseAllowedEmailDomains(env.VIEWER_ALLOWED_EMAIL_DOMAINS),
    devBundler,
    prototypeCsp: normalizePrototypeCsp(env.VIEWER_PROTOTYPE_CSP),
    prototypeOrigin: parsePrototypeOrigin(env.VIEWER_PROTOTYPE_ORIGIN),
    seedDemoProject: env.VIEWER_DEMO_PROJECT !== "off",
    trustProxy: parseTrustProxy(env.VIEWER_TRUST_PROXY),
    loopbackListeners,
    loopbackAvailable,
    loopbackPortRange,
    loopbackBindAllInterfaces,
    loopbackBind,
    loopbackInContainer,
    /*
      Env first, stored settings as the fallback — `runtime-config.ts`'s rule,
      not a new one. An operator who has set `VIEWER_SMTP_HOST` in their
      deployment must not have it silently replaced by something typed into a
      form, and the settings page reads `emailSource` to say so rather than
      offering an edit that would not take.
    */
    email: env.VIEWER_SMTP_HOST
      ? {
          host: env.VIEWER_SMTP_HOST,
          port: parseSmtpPort(env.VIEWER_SMTP_PORT),
          user: requireEnv(env.VIEWER_SMTP_USER, "VIEWER_SMTP_USER"),
          pass: requireEnv(env.VIEWER_SMTP_PASS, "VIEWER_SMTP_PASS"),
          from: requireEnv(env.VIEWER_SMTP_FROM, "VIEWER_SMTP_FROM"),
        }
      : (runtime.email ?? null),
    emailSource: env.VIEWER_SMTP_HOST ? "env" : runtime.email ? "stored" : null,
    unsubscribeSecret: env.VIEWER_UNSUBSCRIBE_SECRET ?? null,
    sessionSecret: env.VIEWER_SESSION_SECRET || runtime.sessionSecret,
    githubAuth:
      env.VIEWER_GITHUB_CLIENT_ID || env.VIEWER_GITHUB_CLIENT_SECRET
        ? {
            clientId: requireAuthEnv(env.VIEWER_GITHUB_CLIENT_ID, "VIEWER_GITHUB_CLIENT_ID"),
            clientSecret: requireAuthEnv(
              env.VIEWER_GITHUB_CLIENT_SECRET,
              "VIEWER_GITHUB_CLIENT_SECRET",
            ),
            // Optional GitHub Enterprise Server / test-stub endpoint
            // overrides — each independent, validated only when present.
            // Not part of the all-or-nothing pair above: they default to
            // github.com's endpoints inside the auth provider when unset.
            ...githubAuthEndpointOverrides(),
          }
        : runtime.githubApp
          ? {
              // An App created through the manifest flow carries its own
              // OAuth client id/secret — it can provide sign-in with no
              // separate OAuth App config. Env still wins wholesale, above.
              clientId: runtime.githubApp.clientId,
              clientSecret: runtime.githubApp.clientSecret,
              // Same endpoint overrides as the env-pair branch above — an
              // operator's VIEWER_GITHUB_AUTHORIZE_URL/TOKEN_URL/API_BASE_URL
              // must apply here too, not just when the client id/secret
              // themselves came from the environment.
              ...githubAuthEndpointOverrides(),
            }
          : null,
    githubApp:
      env.VIEWER_GITHUB_APP_ID || env.VIEWER_GITHUB_APP_PRIVATE_KEY || env.VIEWER_GITHUB_APP_SLUG
        ? {
            appId: requireGithubAppEnv(env.VIEWER_GITHUB_APP_ID, "VIEWER_GITHUB_APP_ID"),
            privateKeyPem: normalizeGithubAppPrivateKey(
              requireGithubAppEnv(
                env.VIEWER_GITHUB_APP_PRIVATE_KEY,
                "VIEWER_GITHUB_APP_PRIVATE_KEY",
              ),
            ),
            slug: requireGithubAppEnv(env.VIEWER_GITHUB_APP_SLUG, "VIEWER_GITHUB_APP_SLUG"),
            // OPTIONAL, deliberately outside the required trio: an operator
            // who only wants manual builds should not be forced to configure
            // a webhook. Unset => the webhook route 503s rather than
            // accepting unverified payloads. Same override, same validator
            // as `githubAuth.apiBaseUrl` above — independent of the
            // required trio, validated only when present.
            ...githubAppEnvOverrides(),
          }
        : runtime.githubApp
          ? {
              appId: runtime.githubApp.appId,
              privateKeyPem: runtime.githubApp.privateKeyPem,
              slug: runtime.githubApp.slug,
              ...(runtime.githubApp.webhookSecret !== undefined
                ? { webhookSecret: runtime.githubApp.webhookSecret }
                : {}),
              // `githubAppEnvOverrides` spread LAST: env's
              // VIEWER_GITHUB_APP_WEBHOOK_SECRET must beat a webhookSecret
              // already stored in the runtime record (an operator
              // provisioning the App via the manifest flow, then later
              // setting the env var to turn on push auto-deploy, must not
              // have that env var silently ignored). `apiBaseUrl` is
              // env-only either way — the runtime record never carries one.
              ...githubAppEnvOverrides(),
            }
          : null,
  }
}

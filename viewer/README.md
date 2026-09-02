# Desde Viewer

Self-hostable prototype hosting, viewing and commenting. One Node process:
a Next.js dashboard, a JSON API, and a prototype serve layer that injects
the Desde bridge at request time.

**Status:** projects + bundle upload + serving, comments + mentions (with
email delivery once SMTP is configured), a GitHub build pipeline (manual
and push-triggered), and real GitHub sign-in are all live today. The viewer
also boots with zero configuration: it seeds a demo project on first run and
prints a one-time sign-in link, so there is something to click before you
set anything up. See the sections below for each.

## License

AGPL-3.0-or-later. See [LICENSE](../LICENSE). The Viewer is exactly the case AGPL's network
clause is about: you run it, and other people use it over a network without ever getting a
copy of it themselves. If you modify the Viewer and run that modified version for your team,
AGPL requires you to make the modified source available to them. Running it unmodified
doesn't trigger this. This isn't legal advice; read the license for the authoritative text.

## Requirements

- Node 24+ (uses the built-in `node:sqlite`)
- The bridge bundle built once from the repo root: `npm run build:bridge`

## Run it

```bash
npm install                 # repo root first: next and react resolve from here
npm install --prefix viewer
npm run build:bridge
cd viewer
npm run dev
```

The server prints a line like this:

```
[viewer] No GitHub sign-in configured. Open this URL to sign in:
[viewer]   http://localhost:3100/api/v1/auth/local?token=...
```

Open that URL. It signs you in and lands you on the dashboard, where there
is already one project: a small demo prototype, seeded automatically on
first boot. Open it, click the comment tool, then click something in the
demo to try it.

The link is printed again on every restart, but once you've used it, your
session survives a restart. Set `VIEWER_DEMO_PROJECT=off` to skip seeding
the demo. Rebuild the demo fixture itself with `npm run build:demo`.

For production:

```bash
cd viewer
npm run build
npm start
```

Nothing is compiled ahead of time into a standalone binary. `npm start`
runs the same `tsx server/index.ts` as `npm run dev`, just with
`NODE_ENV=production`.

Setting `VIEWER_ADMIN_TOKEN` is optional. Every write endpoint works without
it. Any signed-in user can mint their own personal access token at
`/settings` (minting itself needs no particular role; using the token to
create or manage a project needs Editor or Admin, same as a browser session
would). You just don't get one shared bearer credential for scripts and CI.
See "Who can sign in, and who gets an account" below.

## Connect a repository

Open **Settings › GitHub** (or start connecting a repo from any project:
the same setup card appears right in the dialog), pick whether the App lives
on your personal account or an organization, and click **Create GitHub App**.
Confirm the App on GitHub's own page, then install it on the repositories you
want to deploy. Sign-in and repo connection are both live the moment you
finish, no restart needed, because it's the same GitHub App that does both
jobs.

Without a connected repo you can still get a prototype hosted: open any
project and drag a `.tar.gz` of your build output onto it.

<details>
<summary>Registering the App by hand</summary>

Use this path instead of the one-click flow above for GitHub Enterprise
Server, a locked-down org that blocks App creation from a manifest, or a
deployment where GitHub sign-in is configured through environment variables
rather than through the setup card (env-configured sign-in has no local operator
to click the button as; see "Who can sign in, and who gets an account"
below).

#### 1. Register the App

[github.com/settings/apps](https://github.com/settings/apps) → **New GitHub App**:

- **Homepage URL**: `$VIEWER_PUBLIC_URL`
- **Callback URL**: `${VIEWER_PUBLIC_URL}/api/v1/auth/github/callback`
- **Request user authorization (OAuth) during installation**: optional, either way.
- **Webhook**: optional, for push-triggered auto-deploy. Leave it inactive
  for now if you're not setting that up yet. You can activate it later by
  following "Push-webhook auto-deploy" below, which needs the webhook
  secret and URL configured together with the App's webhook settings. Doing
  that now instead is fine too; just make sure both sides (this step's App
  settings and that section's `VIEWER_GITHUB_APP_WEBHOOK_SECRET`) are set
  together, since the App will send deliveries the moment it's active.
- **Account permissions** → **Email addresses: Read-only**. Required: sign-in falls back to `GET /user/emails` for accounts with no public email, and without this permission those users cannot sign in at all.
- **Repository permissions** → **Contents: Read-only** (enough to list and clone). **Metadata: Read-only** is granted implicitly.

Then generate a **private key** (bottom of the App's settings page) and note the **App ID**, the **App slug** (the last path segment of the App's public URL, `github.com/apps/<slug>`), and the App's own **Client ID** / **Client secret**. Those last two are on the same settings page, and they are what sign-in uses.

Finally, **Install** the App (from its settings page → Install App) on the account or organization whose repositories you want to deploy, choosing either all repositories or a specific set.

#### 2. Configure the viewer

Sign-in: both required together. Set neither and sign-in is off; set one and the server throws at boot naming the missing var. No partial state at runtime. (`VIEWER_SESSION_SECRET` used to be part of this group. It isn't any more. See "Configuration" below.)

| Variable | Default | Purpose |
|---|---|---|
| `VIEWER_GITHUB_CLIENT_ID` | unset | The **GitHub App's** client ID (App settings page). |
| `VIEWER_GITHUB_CLIENT_SECRET` | unset | The **GitHub App's** client secret (App settings page). |

Repositories: also all-or-nothing, and independent of the pair above (sign-in works with none of these set; you just cannot connect a repo).

| Variable | Default | Purpose |
|---|---|---|
| `VIEWER_GITHUB_APP_ID` | unset | The App ID (a number, App settings page). |
| `VIEWER_GITHUB_APP_PRIVATE_KEY` | unset | The generated private key: either the literal PEM or a base64 blob of it (multiline env vars are awkward in most process managers, so both are accepted and auto-detected). Validated at boot. |
| `VIEWER_GITHUB_APP_SLUG` | unset | The App slug, used to build install links in the UI. |
| `VIEWER_GITHUB_APP_WEBHOOK_SECRET` | unset | Optional, independent of the repositories trio above. Only needed for push-triggered auto-deploy. See "Push-webhook auto-deploy" below. Unset ⇒ `POST /api/v1/webhooks/github` answers 503. |

GitHub Enterprise Server overrides: each optional and independent, defaulting to github.com. `VIEWER_GITHUB_API_BASE_URL` is shared by sign-in and the App client, since both point at the same host.

| Variable | Default | Purpose |
|---|---|---|
| `VIEWER_GITHUB_AUTHORIZE_URL` | github.com | OAuth authorize endpoint, e.g. `https://github.company.com/login/oauth/authorize`. |
| `VIEWER_GITHUB_TOKEN_URL` | github.com | OAuth token endpoint, e.g. `https://github.company.com/login/oauth/access_token`. |
| `VIEWER_GITHUB_API_BASE_URL` | api.github.com | REST API base, e.g. `https://github.company.com/api/v3`. |

```bash
cd viewer
VIEWER_ADMIN_TOKEN=choose-a-secret \
VIEWER_GITHUB_CLIENT_ID=... \
VIEWER_GITHUB_CLIENT_SECRET=... \
VIEWER_GITHUB_APP_ID=123456 \
VIEWER_GITHUB_APP_PRIVATE_KEY="$(cat app-private-key.pem)" \
VIEWER_GITHUB_APP_SLUG=my-viewer-app \
npm run dev
```

</details>

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `VIEWER_PROFILE` | `selfhost` | Only `selfhost` (SQLite + disk) ships today. |
| `PORT` | `3100` | HTTP port |
| `VIEWER_DATA_DIR` | `.desde-viewer` | SQLite database + uploaded assets + the runtime config file (see below) |
| `VIEWER_DEMO_PROJECT` | unset (seeds a demo) | Seeds a demo project at `/p/demo/` on a genuinely empty first boot. Set to the literal `off` to skip it. Rebuild the fixture itself with `npm run build:demo`. Always created with `access: public-link`, so it's readable by anyone regardless of sign-in. When you boot with no GitHub App configured, the local operator is added to its access list (so they can upload a new build over it); on a deployment that already has GitHub sign-in configured, the demo's access list stays empty: it doesn't need one, since it's public. |
| `VIEWER_PUBLIC_URL` | `http://localhost:$PORT` | Public origin; also the bridge's shell origin |
| `VIEWER_SESSION_SECRET` | unset (generated for you) | HMAC key for signing the session cookie. Usually left unset. The viewer generates one on first boot and stores it in the runtime config file (see below). Set your own to force a rotation: every existing session becomes invalid the moment you do. |
| `VIEWER_ADMIN_TOKEN` | unset | Bearer token for write endpoints. **Unset does NOT disable writes.** A signed-in Editor or Admin can still mint a write-scoped personal access token at `/settings` and use it for every write endpoint they already have authority for. What's actually unavailable is the admin bearer itself: the unscoped, non-revocable escape hatch that reaches every project regardless of its access setting. |
| `VIEWER_ALLOWED_EMAIL_DOMAINS` | unset | Comma-separated list of domains, seeded once into stored domain rules at boot. See "Who can sign in, and who gets an account" below. The viewer is invite-only regardless of this variable. |
| `VIEWER_SERVE_DOMAIN` | unset | `{slug}.{domain}` host-based subdomain routing (shipped, optional). See "Subdomain serving" below. |
| `VIEWER_PROTOTYPE_ORIGIN` | unset | A single alternate origin (e.g. `https://prototypes.example.net`) that serves ALL prototypes, cross-origin from the shell but path-namespaced at `/p/{slug}/`. For a deployment that can add one DNS name and cert SAN but not a wildcard. Weaker than `VIEWER_SERVE_DOMAIN` (every prototype shares this one origin, so they share storage and can script each other). Prefer subdomain mode when wildcard DNS is available. See "How prototypes are isolated" below. |
| `VIEWER_LOOPBACK_LISTENERS` | `auto` | Whether loopback origin mode is allowed to open a listener. `auto` opens one unless the process looks like it's running in a container (`/.dockerenv` or `/run/.containerenv` present); `off` never opens one; `on` always does. See "How prototypes are isolated" below. |
| `VIEWER_DEV_BUNDLER` | `turbopack` | Dev-only Next.js bundler. Set to `webpack` if the dev server crashes with a Turbopack symlink error. The tell is your project's `node_modules` being a symlink that resolves outside the project root (e.g. a shared checkout). |
| `VIEWER_TRUST_PROXY` | unset (trust nothing) | Reverse-proxy hops in front of this server (`1` for a single nginx/Caddy/load balancer), or a comma-separated list of proxy IPs/CIDRs. **Set this whenever you terminate TLS at a proxy**: rate limiting keys on the client address, and without it every request keys to the proxy's, collapsing the per-IP limits into one global bucket that a single abusive visitor can exhaust for everyone. `true` is refused and fails the boot, because it trusts a client-supplied `X-Forwarded-For` and so defeats rate limiting outright. |
| `VIEWER_PROTOTYPE_CSP` | unset (computed default) | `Content-Security-Policy` sent on served prototype HTML. See "Prototype isolation" below. Set to the literal `off` to disable entirely, or to a full policy string to override the default verbatim. **`off` lets a hosted prototype mint API credentials as the signed-in reviewer. Read the warning below before using it.** |

### The runtime config file

The viewer writes one small file the first time it boots:
`$VIEWER_DATA_DIR/config.json`. It exists so a few things can survive a
restart without you having to set them by hand.

It holds:

- the session secret, generated once and reused on every later boot
- GitHub App credentials, but only if you created the App through the
  setup card in Settings › GitHub
  rather than registering it by hand
- a marker recording whether the demo project has already been seeded

The file is created with permissions `0600` (only the process's own user
can read it), and every write is atomic (write a temp file, then rename it
over the old one), so a crash mid-write leaves the previous, intact file in
place rather than a corrupt one.

**The environment always wins.** Set `VIEWER_SESSION_SECRET`,
`VIEWER_GITHUB_CLIENT_ID`, or anything else this file can also hold, and
your env var overrides what's on disk. The viewer never writes an
env-supplied value back into the file, so the two can never end up
disagreeing about which one is in charge.

**Deleting the file signs everyone out.** A fresh session secret is
generated on the very next boot, which invalidates every existing session
cookie at once. On its own, deleting the file does not re-seed the demo:
only its marker is gone, and the seed step also checks whether any project
already exists. If one does, the next boot just rewrites the marker and
moves on. Delete the file **and** delete every project, and the next boot
seeds a fresh demo.

Don't commit this file, and don't copy it between machines. The session
secret in it is what makes a session cookie minted by one deployment
worthless everywhere else. Copying the file defeats that.

## Upgrading

Take a backup before upgrading. Versioned migrations run at boot, tracked in
SQLite's `PRAGMA user_version` and applied at most once each; there is no
down-migration.

If your instance predates instance roles (Admin / Editor / Viewer), the
first boot on the new version backfills them: the oldest **human** account
becomes Admin (the local-operator row is never counted as "oldest" here,
even though it's usually the first row a zero-config instance ever wrote;
it's separately set to Admin on its own), and everyone else becomes Editor.
Both promotions are logged to stdout. **Review Settings → Members after
upgrading**, and consider setting `VIEWER_ADMIN_TOKEN` beforehand as a
recovery path independent of how the backfill landed.

## How prototypes are isolated

A prototype is untrusted code someone uploaded or built from a repo. The
viewer keeps it from reading the shell's session cookie, and from framing
its way into the reviewer's own browser realm. There are three ways it does
this, called origin modes. The viewer picks one automatically, from your
config, at boot.

| Mode | When it's used | Where the prototype is served | Credential for a private prototype |
|---|---|---|---|
| **Loopback** | The shell is reached on `localhost`, `127.0.0.1`, or `[::1]` (a laptop with no domain configured), and loopback listeners are available (`VIEWER_LOOPBACK_LISTENERS`, see below) | The *other* loopback name, on its own ephemeral port, at the origin root | None needed. Reaching that port at all is the credential. |
| **Subdomain** | `VIEWER_SERVE_DOMAIN` is set | `{slug}.{domain}`, at the origin root | A `public-link` project needs none. An `all-members` or `invited` project gets a capability appended to the document load (`?~c={token}`). The server then carries it forward as a host-only `dsv_cap` cookie on the prototype's own host, so every later same-site request from the iframe, assets included, is authorized without ever needing the shell's session cookie. |
| **Single alternate origin** | `VIEWER_PROTOTYPE_ORIGIN` is set (and no serve domain) | That one origin, at `/p/{slug}/~c/{token}/`, shared by every prototype | A capability token in the URL PATH (never a cookie: a cookie on the shared host would be sent to every prototype on it, leaking between them). |
| **Fallback** | None of the above (a server reached by a bare IP or a hostname with no wildcard DNS) | The same host as the shell, at `/p/{slug}/~c/{token}/`, sandboxed into an opaque origin | A capability token in the URL path |

Loopback and subdomain mode give the prototype a real origin of its own, so
things like `localStorage` and a service worker work inside it. Fallback
mode can't do that: the prototype shares the shell's origin, so it's boxed
in with an iframe sandbox instead.

**The sandbox token set.** The review iframe always carries
`sandbox="allow-scripts allow-forms"`. Loopback and subdomain mode add one
more token, `allow-same-origin`, because the prototype is already on a
different origin from the shell there, so restoring its own origin grants it
nothing toward the shell. Fallback mode never adds `allow-same-origin`: the
prototype there is still same-origin with the shell, and adding it back
would let the prototype's JS reach into the shell's DOM.

**The loopback boundary.** A loopback port is reachable by any process on
your machine, not only your browser. Any local program that can make an
HTTP request can reach a prototype's loopback listener while it's open.
Prototypes served on the same loopback host share cookies with each other
across ports, but nothing else: each port gets its own `localStorage`, its
own IndexedDB, its own DOM. This is an accepted cost on a single-user
laptop.

**Loopback listeners auto-fall-back in a container.** Loopback mode only
works when the browser is on the same machine as the viewer. Run the viewer
in a container published with `docker run -p 3100:3100` and a default
`VIEWER_PUBLIC_URL`, and a loopback listener binds an address *inside the
container*, which the host browser can't reach through the one published
port. `VIEWER_LOOPBACK_LISTENERS` (default `auto`) exists for this: `auto`
checks for `/.dockerenv` or `/run/.containerenv` at boot, and if either is
present, the viewer treats loopback listeners as unavailable and every
prototype that would have been loopback mode falls back to fallback mode
instead (same-host, sandboxed) rather than opening a listener nobody outside
the container can reach. Set `VIEWER_LOOPBACK_LISTENERS=off` to force that
behavior regardless of what the container check finds, or `=on` to force
listeners open anyway (correct for a container run with `--network host`,
where the browser genuinely does share the host's loopback interface). None
of this is a substitute for real isolation on a real deployment: set
`VIEWER_SERVE_DOMAIN` (subdomain mode) for that.

**The DNS you need for subdomain mode.** Subdomain mode needs one wildcard
DNS record (`*.yourdomain.com`) and a matching wildcard TLS certificate.
You set this up once, when you deploy the viewer itself, alongside the DNS
you're already configuring. It's never something you're asked for while
setting up an individual project.

**When a wildcard is not available: `VIEWER_PROTOTYPE_ORIGIN`.** Some
deployments can add one more DNS name and one more certificate SAN, but not
a wildcard. `VIEWER_PROTOTYPE_ORIGIN` is for that case: set it to a single
alternate origin (e.g. `https://prototypes.example.net`), and every
prototype is served from that one origin, cross-origin from the shell but
path-namespaced at `/p/{slug}/`. The tradeoff is real and worth stating
plainly: all prototypes share that one origin, so they share storage and a
cookie jar and can script each other. Subdomain mode does not have this
(each prototype gets its own registrable host), so it is stronger; use
`VIEWER_PROTOTYPE_ORIGIN` only when a wildcard is genuinely unavailable. The
origin must use the same scheme as `VIEWER_PUBLIC_URL` and be on a different
registrable domain than the shell (`app.example.com` shell with a
`prototypes.example.net` prototype origin is fine; `prototypes.example.com`
is not: a prototype there could set a cookie the shell would receive). The
viewer refuses an unsafe value at boot.

**`VIEWER_SERVE_DOMAIN` must be same-site with `VIEWER_PUBLIC_URL`.** The
`dsv_cap` cookie above only attaches to the iframe's own subresource requests
if the prototype's host shares a registrable domain (its eTLD+1, e.g.
`example.com` in `app.example.com`) with `VIEWER_PUBLIC_URL`'s host. Set the
shell at `app.example.com` and the serve domain at `proto.example.com` and
this holds. Split them across unrelated domains, like a shell at
`example.com` and a serve domain at `other.net`. Then the browser silently
withholds the cookie: the prototype's HTML loads, then every one of its
assets 404s inside the iframe.

**The Host allowlist (new).** The viewer now only answers requests whose
`Host` header names one of a small set of hosts built from its own config:
`VIEWER_PUBLIC_URL`'s host, its own loopback address on `PORT`, and
`{slug}.VIEWER_SERVE_DOMAIN` when a serve domain is set. Anything else,
including a LAN IP address or a proxy that rewrites `Host` to something
else, now gets a `400 Unexpected host` response instead of being served. If
you're hitting this, set `VIEWER_PUBLIC_URL` to the actual name people use
to reach the viewer.

Boot prints which mode is active. In loopback mode it also names the paired
loopback host prototypes will use. In fallback mode it prints a warning,
because a prototype built with a root-absolute asset base won't fully load
for a signed-in member there; the warning names the fix (set
`VIEWER_SERVE_DOMAIN`, or build the prototype with a relative base). When a
loopback shell was downgraded to fallback mode because loopback listeners
aren't available (the container case above), the boot log prints that same
fallback warning plus one more line naming `VIEWER_LOOPBACK_LISTENERS` as the
reason.

The rest of this section, and "Subdomain serving" further down, go into the
mechanics of fallback and subdomain mode in more detail. The resolver
deciding which mode applies lives in
`server/serve/prototype-origin-resolve.ts`; the per-deployment loopback
listeners live in `server/serve/loopback-listeners.ts`.

## Prototype isolation

Prototypes are served same-origin at `/p/{slug}/**`, alongside the API at
`/api/v1/**` and (once someone signs in) a `viewer_session` cookie at
`Path=/`. Without a restriction, JS running inside a hosted prototype could
call the viewer API credentialed as whoever is currently signed in:
`HttpOnly` doesn't stop the browser from attaching the cookie to a same-origin
fetch, `SameSite` doesn't apply to a same-origin request, and cookie
`Path`-scoping matches the *request* URL (`/api/v1/...`) rather than the
*page* URL the script runs on, so it can't help either.

Two layers, but only one of them is the real control:

- **CSP is the actual control, but it only restricts reading the viewer
  API, not general internet access.** Every response under `/p/{slug}/**`
  gets a `Content-Security-Policy`, not just HTML pages. Scoping it to HTML
  responses was itself a critical bug this fixes: an `.svg` (and other
  non-HTML-but-scriptable content types) served without a CSP would be a
  clean bypass. The header's `connect-src` is scoped to the prototype's own
  path prefix (`{publicUrl}/p/{slug}/`) rather than a bare `'self'`, plus
  `frame-src 'none'` / `object-src 'none'` / `form-action 'none'` to close
  the same-origin iframe/object/form exfiltration routes that `connect-src`
  alone doesn't cover. Those four directives are the entire security claim,
  and this is what actually stops a hostile prototype from reaching
  `/api/v1/**`. Everything else in the default policy is deliberately
  permissive: inline `<script>`/`<style>` (`'unsafe-inline'`) and `https:`
  fonts/images/stylesheets are all allowed, because normal prototypes need
  them. The bridge itself is served EXTERNALLY, as its own script file at
  `/p/{slug}/__desde/bridge-<version>.js` (referenced via a `<script
  src>` tag injected at serve time), not inlined, so it loads under the
  same `connect-src`-scoped policy as everything else on the page, no
  `script-src` carve-out needed. This does not weaken the read-protection
  property: a prototype can already exfiltrate arbitrary data via a
  top-level navigation, which no CSP directive here governs, so permitting
  `https:` resource loads doesn't open a new channel, only a redundant one.
  A prototype that legitimately needs to call a third-party *API* (or
  anything outside its own path prefix, via `fetch`/`XHR`/`sendBeacon`)
  still needs `VIEWER_PROTOTYPE_CSP` set to a custom policy that allow-lists
  it in `connect-src`; the default does not. **Running with
  `VIEWER_PROTOTYPE_CSP=off` means a hostile prototype is not contained.**
  Don't disable it on an untrusted deployment.
- **The `Referer`-based guard** on the API router catches *accidental*,
  non-adversarial same-origin API calls (a prototype's own code calling a
  relative URL that happens to resolve under `/api/v1/**`, a stale bookmark,
  etc.). Any such request is rejected with 403 before any route handler
  runs. It is not a security boundary against a deliberately malicious
  prototype: an attacker can trivially suppress its own referer (e.g.
  `<a rel="noreferrer">` / `fetch(..., { referrerPolicy: "no-referrer" })`)
  and pass straight through. Requests with no referer (the Editor CLI, CI, curl,
  and other headless clients) are intentionally allowed for exactly this
  reason: the guard cannot and does not attempt to distinguish "headless
  client" from "attacker who blanked the referer."

- **The review iframe is sandboxed under path serving, for essentially every
  prototype, private ones included.** A CSP binds the document it is
  delivered with; it says nothing about `window.parent`. So the two layers
  above, on their own, did not stop prototype JS from running in the
  *reviewer's* realm (which has no policy at all) and calling
  `parent.fetch('/api/v1/tokens', …)` to mint a durable write-scoped token as
  that reviewer (security audit 2026-08-09, finding B1). The review iframe
  therefore carries `sandbox="allow-scripts allow-forms"`. The absence of
  `allow-same-origin` IS the control: it puts the prototype in an opaque
  origin, so there is no shared realm to reach into. `allow-popups` and
  `allow-top-navigation` are omitted for the same reason. Two costs, one
  since closed:
  - **An opaque origin has no storage**, so a sandboxed prototype touching
    `localStorage`/`sessionStorage`/`document.cookie` throws. Still true,
    and unavoidable: this is what the opaque origin buys.
  - **An opaque origin does not carry the session cookie**, and
    `/p/{slug}/**` authorizes every request on it: an `invited` project
    with nobody signed in 404s an anonymous read, the bridge bundle
    included. Sandboxing such a prototype used to mean serving its HTML and
    then 404ing its JS, its CSS and the bridge, so the sandbox was applied
    only to anonymously-readable prototypes (`public-link`, while
    `allowPublicLinks` is on), leaving every private prototype same-origin
    and uncontained. **This is now closed.** `server/serve/
    prototype-capability.ts` mints a short-lived, HMAC-signed capability for
    a project the caller has already been admitted to, carried as a path
    segment (`/p/{slug}/~c/{token}/`) that every relative subresource
    inherits for free, and `app/prototype-origin.ts` stops gating the
    sandbox on anonymous readability once a capability is available. A
    private prototype's JS, CSS and bridge all resolve under the capability
    prefix with no cookie involved, so the iframe is sandboxed
    unconditionally in path mode. The one residue: when NO capability can be
    minted at all (`VIEWER_SESSION_SECRET` absent, i.e. sign-in itself is
    unconfigured) a prototype falls back to the old same-origin,
    unsandboxed behavior, a case that is close to vacuous, since no session
    secret means no sessions, hence no users, hence no private or invited
    project to protect in the first place.
  - **The opaque origin also can't read its own scripts without a CORS
    grant.** A Vite build's entry point is an ES module
    (`<script type="module" crossorigin>`), and a module fetch from an
    opaque origin sends `Origin: null`, which a same-origin-only response
    blocks, so the sandboxed prototype would render blank. Every response
    under `/p/{slug}/**` (HTML, the bridge bundle, static assets) therefore
    carries `Access-Control-Allow-Origin: *`. That's safe together with the
    point above: `*` and a credentialed (cookie-carrying) response are
    mutually exclusive under the fetch spec, so the header can't be used to
    read anything the opaque-origin request wasn't already allowed to see.
- **`/api/v1/**` refuses to be loaded as a document.** No CSP directive
  governs `window.open`: `connect-src` covers fetch, `frame-src`/
  `object-src` cover nested contexts, `form-action` covers form submission,
  and CSP3's `navigate-to` shipped in no browser. So a prototype opened as
  a top-level page could `window.open('/api/v1/projects')` and read the
  popup (finding B2). Any `/api/v1` request carrying a document-ish
  `Sec-Fetch-Dest` is now refused with a sandboxed 403, except the three
  paths that genuinely are navigations (`/auth/github`,
  `/auth/github/callback`, `/unsubscribe`). `Sec-Fetch-*` is browser-set and
  unspoofable by page JS; a client that omits it (curl, CI, the Editor CLI)
  passes through, which is why this is a lane-closer and not the boundary.

This is path-based isolation, not full origin isolation. The prototype
still shares the viewer's origin, and the sandbox plus the CSP are what's
doing the work. Full origin isolation (serving each prototype from its own
subdomain, so there's no shared origin to protect at all) is the stronger
option: set `VIEWER_SERVE_DOMAIN` (see "Subdomain serving" below) and the
dashboard's "Open" link and the review iframe both move to
`{slug}.{VIEWER_SERVE_DOMAIN}`. Path serving remains the default because it
needs no wildcard DNS/TLS setup.

> Two corrections to what earlier copies of this file promised, both from
> the 2026-08-09 security audit:
>
> - Setting `VIEWER_SERVE_DOMAIN` used to make the isolated origin
>   *reachable* while changing nothing the product itself loaded. Both
>   shell surfaces hardcoded `/p/{slug}/`, so a deployment with wildcard DNS
>   and TLS behaved identically to one without (finding S8). The shell now
>   follows the flag.
> - Origin isolation used to be **not** available to every project. The
>   session cookie is host-only, so by design it is never sent to
>   `{slug}.{serveDomain}` (that is what makes the mode a real boundary), so
>   at the time of this finding an `all-members` or `invited` project could
>   not be served there at all (every read 404ed). **This is fixed.** A
>   private project's document load now carries a short-lived capability of
>   its own (`?~c={token}`), which the server verifies and then sets as a
>   host-only `dsv_cap` cookie on the prototype's subdomain. That is the same
>   mechanism path serving already had, adapted to a mode with no
>   `/p/{slug}/` prefix to carry it in. See the table above.

> ### ⚠️ `VIEWER_PROTOTYPE_CSP=off` lets a prototype mint credentials
>
> With the CSP disabled, JS inside a hosted prototype can call
> `fetch('/api/v1/tokens', { method: 'POST', credentials: 'include',
> referrerPolicy: 'no-referrer' })` and **mint a personal access token as
> whoever is currently signed in and viewing it**, a credential that keeps
> working after that reviewer signs out and that appears nowhere the
> reviewer would think to look. Before machine tokens existed, this bypass
> could only read data the reviewer could already see during that session;
> now it produces a durable credential.
>
> This is not fixable with a header check. The request is genuinely
> same-origin and same-site, so `Origin`, `SameSite`, and `HttpOnly` all
> legitimately permit it, and the referer guard is explicitly bypassable by
> the attacker who controls the page. The iframe sandbox narrows it: a
> prototype loaded in the *review* page is in an opaque origin, so
> `fetch('/api/v1/…')` from there is cross-origin and CORS-blocked even with
> the CSP off. But the dashboard's "Open" link loads the same prototype as
> a TOP-LEVEL page, where no sandbox applies. The structural fix is serving
> each prototype from its own subdomain, which removes the shared origin
> entirely: set `VIEWER_SERVE_DOMAIN` (see "Subdomain serving" below), which
> as of 2026-08-09 actually moves both surfaces to that origin.
>
> **Do not set `VIEWER_PROTOTYPE_CSP=off` on any deployment where the set of
> people who can publish a prototype is wider than the set of people you
> would hand an API token to.** On a deployment where anyone can publish, it
> is a privilege-escalation path, not a compatibility knob. If a specific
> prototype needs wider network access, set a custom policy that allow-lists
> exactly what it needs in `connect-src` instead of turning the header off.

## Mention notifications

Mention-comment notifications are enqueued to an outbox when reviewers are mentioned; delivery is gated by SMTP configuration.

| Variable | Default | Purpose |
|---|---|---|
| `VIEWER_SMTP_HOST` | unset | SMTP server hostname. **Unset means notifications enqueue but are never sent.** When set, all other `VIEWER_SMTP_*` vars are required and validated strictly at boot. |
| `VIEWER_SMTP_PORT` | `587` | SMTP server port. |
| `VIEWER_SMTP_USER` | unset | SMTP authentication username. Required when `VIEWER_SMTP_HOST` is set. |
| `VIEWER_SMTP_PASS` | unset | SMTP authentication password. Required when `VIEWER_SMTP_HOST` is set. |
| `VIEWER_SMTP_FROM` | unset | Sender email address for outbound notifications. Required when `VIEWER_SMTP_HOST` is set. |
| `VIEWER_UNSUBSCRIBE_SECRET` | unset | Stable random string for signing unsubscribe links (e.g., `openssl rand -hex 32`). Rotate it to invalidate existing links; unset means unsubscribe links are unavailable. |

**Degradation when unconfigured:** When `VIEWER_SMTP_HOST` is unset, notifications enqueue into the outbox but do not send; commenting itself and in-app mention flags are unaffected. Partial SMTP configuration (e.g., some vars set, others missing) throws loudly at startup rather than silently failing at send time. Deploy only on trusted networks: comment and participant endpoints are public-write by design (self-declared identity, not gated on sign-in), even though GitHub sign-in exists. See "Notes and current limits" below.

**Session sweep.** Expired sessions (see "Sign-in" below) are opportunistically deleted the moment someone presents an expired cookie, but a session for a user who never comes back would otherwise sit in storage forever. The server also sweeps expired sessions once at boot and every 6 hours, unconditionally. This runs whether or not GitHub sign-in is configured, since session rows can outlive an auth config change.

**Unsubscribe scope is per-project, not global.** Participants are per-project rows (a distinct id per project for the same email), so clicking unsubscribe stops mention emails for the project you clicked from only. There's no "unsubscribe from everything" affordance yet, and the confirmation page never claims one. GitHub sign-in (see below) already gives a signed-in person one `User` identity across projects, but the participant directory is still a separate, self-declared, per-project table that isn't unified with it. A genuinely cross-project opt-out needs that unification, which hasn't landed yet.

## GitHub (sign-in and repositories)

**One GitHub App does both jobs.** It signs people in, and (once installed on the repositories you want to deploy) it is what the viewer connects a project to and (from Phase 3c-2) clones with. There is no separate OAuth App; earlier versions of this document told you to create one, and that instruction is obsolete. See "Upgrading from a separate OAuth App" below if you followed it. To create the App itself, see "Connect a repository" near the top of this file.

All of this is **optional**, but not in the way earlier versions of this
file meant. With none of it set, the viewer still has a sign-in affordance:
it prints a local-operator sign-in link at boot instead of a GitHub one
(see "Run it" near the top). Comments and participant invites (the
per-project notification directory, a different thing from an instance
invite, see below) still work as self-declared identity, and there is still
no repo-connect surface until you configure GitHub. Configuring GitHub gets
you verified identity for every reviewer (comments author as the signed-in
GitHub user, not just yours), and it turns on the repo-connect surface.

### Moving from local sign-in to GitHub sign-in

If you started in local mode, any project you created lists
`operator@localhost` (the local operator, not a real account) on its
access list.

Configuring GitHub sign-in makes you a different user. The local sign-in
link stops working the moment GitHub sign-in goes live (immediately, if you
used the one-click setup card; at the next restart, if you set the
GitHub env vars by hand).

**In the normal case this is handled for you.** Sign in with GitHub from the
same browser you were using as the local operator, and the admission gate
(below) admits you as **Admin** directly: the same rung that lets a
brand-new instance work with no local-operator step at all. It works because
holding a live local-operator session at that moment is proof of being the
operator: that token was printed to the server's own console. Someone else
signing in with GitHub carries no such session, so nothing of yours transfers
to them.

As Admin you can already read and manage every project, so nothing further
is strictly needed. The viewer also copies every access-list row the
operator held onto your new account, for history and in case you're ever
demoted from Admin later. It deliberately does not delete the operator's own
row. It stays as history.

If you cleared cookies, signed in from a different browser, or let the
operator session expire first, there is nothing to prove possession with and
the handoff does not run. Then use one of the manual paths: while still
signed in as the local operator, go to `/settings` → Members and change your
GitHub account's role to Admin; or, if you have already cut over, do the
same with the admin bearer: `PATCH /api/v1/instance/members/:userId`.

### Upgrading from a separate OAuth App

Earlier versions of this viewer used a standalone GitHub **OAuth App** for sign-in and a separate GitHub **App** for repositories. Sign-in has moved onto the App, and **the variable names did not change.** This means an upgrade that leaves the old values in place will *look* configured and behave strangely. To migrate:

1. Replace `VIEWER_GITHUB_CLIENT_ID` and `VIEWER_GITHUB_CLIENT_SECRET` with the **App's** client ID and secret (App settings page), not the old OAuth App's.
2. Grant the App the **Email addresses: Read-only** account permission if you haven't.
3. Delete the old OAuth App. Nothing uses it any more.
4. Everyone must **sign in again**. Which repositories a person can connect is read from GitHub at sign-in, so an existing session predating the upgrade shows no installations until they do. The UI says so explicitly ("Sign in again to refresh your GitHub access") rather than claiming you have no installations.

### Who can sign in, and who gets an account

**The viewer is invite-only.** Completing GitHub sign-in, or clicking an
invite link or a magic link, authenticates you, but does not by itself
create an account. One function, `admitSignIn` (`server/auth/gate.ts`), runs
after every successful authentication and decides, in this order:

1. An **existing active account** (found by GitHub identity, or by email)
   signs in. A `removed` account is refused here, and nowhere else.
2. A valid, unexpired, unused **invite** for this exact email creates the
   account at the invite's role.
3. The **local operator handing off to GitHub** (see above) creates the
   account as Admin.
4. A **brand-new instance with zero users** creates the account as Admin.
   This is what makes a fresh GitHub-configured instance work with no
   local-operator step at all: the first person to sign in becomes Admin.
5. A matching **domain rule** creates the account at the rule's role.
6. Otherwise, **refused**. Nothing is created.

Rungs 3 and 4, the two ways to become Admin, are checked before rung 5 on
purpose, so a brand-new instance always ends up with an admin even if
`VIEWER_ALLOWED_EMAIL_DOMAINS` was set from the very first boot. Someone
refused by the gate lands on `/denied`, a plain "this viewer is invite-only,
ask an admin to invite you" page with no hint about who else has access.

**`VIEWER_ALLOWED_EMAIL_DOMAINS` only feeds rung 5, and only once.** On the
first boot, if it's set and the stored domain-rule table is still empty,
each domain-only entry (no `@`) is copied in as a stored rule with role
`viewer`. An entry that's a full address can't become a domain rule and is
skipped, with a boot-log warning telling you to invite that address instead.
After that first boot the variable is ignored completely. An admin manages
the domain list from `/settings` from then on.

**Four ways to sign in, any combination on at once:** GitHub (above); an
invite link an admin mints for one email and one role from `/settings` →
Members (works with no SMTP: without SMTP the link itself is the
credential, expires in 7 days, and can be regenerated or revoked); a magic
link a returning member requests for themselves at `/signin` (needs SMTP,
15-minute expiry, also lets someone whose email domain matches a rule
self-serve join); and an admin-issued sign-in link for re-authenticating an
existing member with no SMTP at all (24-hour expiry, minted from the Members
page, refused if the member was removed).

**Opening an invite or sign-in link shows a confirmation page; the button on
it signs you in.** Nothing is spent by opening the link, so a chat unfurl, a
mail security scanner or a gateway prefetch can no longer burn a one-time link
before its recipient clicks it. Pressing the button requires the browser to
send `Sec-Fetch-Dest`/`Sec-Fetch-Site` headers proving a same-origin
navigation, so a very old browser (Safari before 16.4) cannot complete this
step. It gets a plain-language error page instead of a working sign-in.

**A signed-in user sees, and can connect, exactly the App installations that *their own* GitHub account can see**, captured from GitHub at sign-in, stored server-side, never accepted from the browser. So installing the App on an organization exposes that organization's repository inventory (including **private** repository names) to every user who can see that installation on GitHub, which is normally that org's members, and is not affected by whether they have an account here.

Practically: install the App only on accounts/orgs whose repository list you are willing to show to the people who can sign in.

Two further properties worth knowing:

- **The installation snapshot is refreshed on every sign-in and expires after 30 days.** There is deliberately no stored GitHub credential to re-query with, so signing in again *is* the refresh. Losing access to an org on GitHub therefore takes effect here at the next sign-in, or at the 30-day expiry, whichever comes first.
- **Installation access tokens are minted on demand and never stored.** Nothing in the database can read a GitHub repository; the App private key in the environment is the only credential that can, and it is bounded by where the App is installed.
- **`VIEWER_ADMIN_TOKEN` is deliberately NOT installation-scoped.** Connecting a repo with the admin bearer and no session bypasses the per-caller installation filter entirely. That is intended, not an oversight: whoever holds the admin token is the operator, who also holds the App private key and can therefore already mint an installation token for anything the App is installed on. Scoping them would be theatre. Treat the admin token as equivalent to the private key and don't hand it to reviewers.

The session cookie is `HttpOnly` (not readable from page JS) and only carries a signed session id: the session row in storage is the source of truth, so **logout revokes server-side**, not just by clearing the cookie.

**Every project has one of three access levels, and access control runs on it for every read path.** Project list/detail, deployment history, comments (including the SSE stream), participants, and every `/p/{slug}/**` prototype, plus the root-asset fallback, all check `access`. `all-members` (the default for a new project) is readable by every signed-in member of the instance, of any role. `invited` is readable only by admins and by the people on that project's access list. There is no zero-members trap any more: an `invited` project with an empty access list is readable by nobody but admins, never by the world. `public-link` is anonymous-usable as long as the instance-wide `allowPublicLinks` setting (an Admin toggle in Settings, default on) is on; turn it off and a `public-link` project behaves exactly like `all-members` (sign-in required, nothing about the project itself changes) until it's turned back on. A denied read 404s (never a 403), so a project's existence isn't leaked to someone who can't read it. Comment/participant WRITE endpoints are gated the same way.

**Creating and managing a project needs Editor or Admin authority. There is no per-project ownership.** `POST /projects` is gated by `requireWrite` (see "API" below), which now means instance-level authority: the admin bearer, a signed-in Editor or Admin's own session, or one of their `write`-scoped personal access tokens. A signed-in Viewer-role account, or a read-only token, gets `403`. Managing an existing project (rename, change access, connect a repo, trigger a build, edit its access list) needs the same authority, resolved per project: admin authority reaches every project regardless of access; an editor needs to already be able to read the project at `:id` first. Since a new project's default access is `all-members`, that's automatic for any editor: the one edge case is creating a project with `access: "invited"` as a non-admin editor, which would otherwise lock the creator out of the project they just made, so the server adds the creator to the access list automatically in that one case (`addCreatorIfLockedOut` in `projects-routes.ts`); an admin creator is never added, since admin authority doesn't depend on the list. `GET/POST/DELETE /projects/:id/members` manage the access list directly: invite is by EMAIL and resolves to an EXISTING, active `User`. There is no pending-member state (unlike the participant directory's invite-by-email, which creates a placeholder row for anyone). If nobody has an account with that email yet, the request 404s telling the operator to invite that address to the instance first, then retry. On an `access: "invited"` project, `DELETE` refuses (400) removing the last remaining access-list entry, unless the caller is an admin (who doesn't need the list to manage the project). See "Notes and current limits" below. `all-members` and `public-link` projects have no such guard, since their readability never depended on the list.

Deploy on a trusted network regardless: the build runner still executes repository code untrusted, and there's no rate limiting yet (see "Notes and current limits" below).

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/health` | — | Liveness + active profile |
| GET | `/api/v1/projects` | — | List projects (filtered by `access`) |
| POST | `/api/v1/projects` | editor or admin | Create `{ slug, name, repoUrl?, access? }`. `access` defaults to `"all-members"`. Works from a plain signed-in Editor/Admin session, the admin bearer, or one of their write-scoped PATs: no ownership precondition, since there's no per-project ownership any more. See "Who can sign in, and who gets an account" above. |
| GET | `/api/v1/projects/:id` | — | One project |
| PATCH | `/api/v1/projects/:id` | editor or admin, project readable | Update name / repoUrl / access |
| POST | `/api/v1/projects/resolve` | None (unauthenticated) | Editor-facing reconcile: given `{ embeddedId?, remoteUrl?, name? }`, answers adopt / mint-a-slug / conflict: never creates a project itself. Deliberately open. See `project-resolve.ts`. |
| GET | `/api/v1/projects/:id/deployments` | — | Deployment history, newest first |
| POST | `/api/v1/projects/:id/deployments` | editor or admin, project readable | Upload a `.tar.gz` of the build output; activates it |
| POST | `/api/v1/projects/:id/deployments/build` | editor or admin, project readable | Trigger a build of the connected repo (manual lane; push-triggered is the webhook below) |
| GET | `/api/v1/deployments/:id/log/stream` | — | SSE stream of a build's log, gated on the owning project's `access` |
| GET | `/api/v1/projects/:id/comments` | — | List comments |
| POST | `/api/v1/projects/:id/comments` | — | Create a comment: `{ position, body, author }`. Public-write for anyone who can READ the project: self-declared identity, no per-write credential required. |
| GET | `/api/v1/projects/:id/comments/stream` | — | SSE stream of comment change events (+ heartbeat) |
| PATCH | `/api/v1/projects/:id/comments/:commentId` | — | Edit / resolve a comment (same public-write rule as create) |
| POST | `/api/v1/projects/:id/comments/:commentId/replies` | — | Reply to a comment (same public-write rule) |
| DELETE | `/api/v1/projects/:id/comments/:commentId` | — | Delete a comment (same public-write rule) |
| GET | `/api/v1/projects/:id/participants` | — | List the participant directory |
| POST | `/api/v1/projects/:id/participants` | — | Upsert a participant (self-declared, same public-write rule as comments) |
| GET | `/api/v1/projects/:id/members` | — | List the project's access list (joined with user identity; `email` shown only to a manager or a listed caller) |
| POST | `/api/v1/projects/:id/members` | editor or admin, project readable | Add to the access list: `{ email }` (no `role` field, membership carries none any more); 404s if no active `User` exists for that email yet |
| DELETE | `/api/v1/projects/:id/members/:userId` | editor or admin, project readable | Remove from the access list; idempotent; 400s on `access: "invited"` if it would remove the last remaining entry, unless the caller is an admin. See "Notes and current limits" below |
| GET | `/api/v1/github/installations` | signed in | GitHub App installations **this caller** can see; `{ configured: false }` when the App isn't set up |
| GET | `/api/v1/github/installations/:id/repos` | signed in | Repositories in that installation; 404 if the caller can't see it (identical to a nonexistent one) |
| PUT | `/api/v1/projects/:id/repo` | editor or admin, project readable | Connect a repo: `{ installationId, owner, name, branch, installCommand, buildCommand, outputDir, autoDeploy }` |
| DELETE | `/api/v1/projects/:id/repo` | editor or admin, project readable | Disconnect; leaves deployments untouched |
| GET | `/api/v1/me` | — | Current signed-in user (carries their instance `role`), or `null`. Also carries `authEnabled` (whether GitHub sign-in is live on this deployment right now), `signInUrl`, `emailSignInEnabled` (whether `/signin` should offer the magic-link form), and `scopes` (the caller's PAT scopes, or `null` for a browser session). |
| GET | `/api/v1/auth/github` | — | Start the GitHub OAuth sign-in flow |
| GET | `/api/v1/auth/github/callback` | — | OAuth callback; runs the admission gate, sets the session cookie |
| GET | `/api/v1/auth/invite/:token` | — | The invite link's confirmation page. Verifies the token's format only: claims nothing, so a link preview or scanner cannot spend it |
| POST | `/api/v1/auth/invite/:token` | — | What the confirmation page's button posts to: accepts the invite, runs the admission gate at the invite's role, sets the session cookie. Requires `Sec-Fetch-Dest: document` and `Sec-Fetch-Site: same-origin` |
| POST | `/api/v1/auth/magic-link` | None (rate-limited) | Request a 15-minute self-serve sign-in link by email; always answers `202` regardless of whether the address has an account, so it can't be used as a membership oracle |
| GET | `/api/v1/auth/signin/:token` | — | The sign-in link's confirmation page. Format check only, claims nothing |
| POST | `/api/v1/auth/signin/:token` | — | Redeem a magic link or an admin-issued sign-in link. Requires `Sec-Fetch-Dest: document` and `Sec-Fetch-Site: same-origin` |
| POST | `/api/v1/auth/logout` | — | Revoke the current session server-side |
| GET | `/api/v1/setup/github/manifest` | operator | Start the one-click GitHub App flow (the setup card in Settings › GitHub, also embedded in the connect-repo dialog): mints a manifest and a CSRF `state` for the browser to post to github.com. 409 if this deployment already has a GitHub App configured. |
| GET | `/api/v1/setup/github/callback` | operator | GitHub's redirect back after the App is created; exchanges the code for credentials, saves them to the runtime config file, and redirects to the App's install page. 409 if this deployment already has a GitHub App configured: checked both before and after the exchange, so two setup tabs opened at once can't both win. |
| POST | `/api/v1/tokens` | signed in (session only: a PAT is refused here) | Mint a personal access token: `{ name, scopes, expiresInDays? }`; returns the plaintext once |
| GET | `/api/v1/tokens` | signed in (session only) | List the caller's own tokens (never the hash or plaintext) |
| DELETE | `/api/v1/tokens/:id` | signed in (session only) | Revoke a token; 404s (never 403) on another user's token |
| GET | `/api/v1/instance/members` | admin | List every account on the instance, including `removed` ones (the client labels those, this route doesn't filter them) |
| PATCH | `/api/v1/instance/members/:userId` | admin | Change a member's role; 409s if it would demote the last active admin |
| DELETE | `/api/v1/instance/members/:userId` | admin | Remove a member; revokes their sessions and machine tokens immediately; 409s if it would remove the last active admin |
| POST | `/api/v1/instance/members/:userId/restore` | admin | Reactivate a removed member |
| POST | `/api/v1/instance/members/:userId/signin-link` | admin | Mint a 24-hour one-time sign-in link for an existing, active member |
| POST | `/api/v1/instance/invites` | admin | Create an invite: `{ email, role }`; returns the plaintext URL, and emails it too if SMTP is configured |
| GET | `/api/v1/instance/invites` | admin | List invites, with a derived `state`: pending / used / revoked / expired |
| POST | `/api/v1/instance/invites/:id/regenerate` | admin | Mint a fresh link for the same invite row, killing the old one |
| DELETE | `/api/v1/instance/invites/:id` | admin | Revoke an invite |
| GET | `/api/v1/instance/domain-rules` | admin | List domain rules |
| PUT | `/api/v1/instance/domain-rules/:domain` | admin | Create or update a domain rule: `{ role }` |
| DELETE | `/api/v1/instance/domain-rules/:domain` | admin | Remove a domain rule |
| GET | `/api/v1/instance/settings` | admin | `{ allowPublicLinks }` |
| PATCH | `/api/v1/instance/settings` | admin | Update `{ allowPublicLinks }` |
| GET | `/api/v1/unsubscribe` | None (signed token in the query string) | Mention-email unsubscribe link target; renders a confirmation page |
| POST | `/api/v1/unsubscribe` | None (signed token) | RFC 8058 one-click unsubscribe (`List-Unsubscribe-Post`) |
| POST | `/api/v1/webhooks/github` | None (GitHub webhook signature) | Push-triggered auto-deploy; 503 if `VIEWER_GITHUB_APP_WEBHOOK_SECRET` is unset |

"Auth" above is who may WRITE (a `—` GET row is still gated on the project's
`access` where one applies: comments, participants, members, deployments,
and `/p/{slug}/**`; see "Notes and current limits" below for the exact
rule). "Editor or admin" means `requireWrite` (`api-router.ts`), which now
routes to instance-level authority: the admin bearer, an active `admin` or
`editor`-role account (session or PAT), and a PAT additionally needs the
`write` scope. `POST /projects` has no `:id` yet, so it only asks the
instance-level question. Every other row marked "project readable" asks it
again per project, through `requireProjectManage`: admin authority reaches
any project; an `editor` additionally needs to already be able to READ the
project at `:id`. See "Who can sign in, and who gets an account" above.
This replaced the old `requireProjectOwnerOrAdmin`, which asked a question
`ProjectMember` can no longer answer, since it dropped its `role` field.
Every route under `/api/v1/instance/**` is checked independently by
`requireInstanceAdmin`: the admin bearer, or an active `admin`-role account
(a PAT again needs `write` for anything that mutates). "Operator" (the two
setup routes) is stricter still: the admin bearer, or a session belonging
specifically to the local-operator user, never any other signed-in person,
even an Admin with a write-scoped PAT, because completing that flow creates
a real GitHub identity the whole deployment then builds through
(`requireOperator` in `setup-routes.ts`).

## Publish a prototype

```bash
tar czf bundle.tar.gz -C dist .
```

```bash
curl -X POST "http://localhost:3100/api/v1/projects/$PROJECT_ID/deployments?commitSha=$(git rev-parse HEAD)" -H "Authorization: Bearer $VIEWER_ADMIN_TOKEN" -H "Content-Type: application/gzip" --data-binary @bundle.tar.gz
```

The prototype is then served at `/p/{slug}/`.

## Notes and current limits

- Prototypes are served under a path prefix (`/p/{slug}/`). The serve layer
  compensates for root-relative URLs deterministically: HTML attributes are
  rewritten to the prefix, and root-absolute requests baked into JS (hashed
  asset filenames, e.g. Vite's `/assets/index-*.js`) are resolved by a
  root-level fallback (Referer-scoped, then a hashed-name scan of nested
  paths only). Residue that cannot be compensated: an explicit router base
  baked at build time (e.g. React Router `basename`) and exotic runtime URL
  construction. If your app uses client-side routing, set the router's base
  explicitly: React-Router-style explicit basenames should be set to
  `/p/{slug}/`, or build with `base: './'`; Vue Router with no explicit base
  adopts the injected `<base>` automatically. Subdomain serving (full origin
  isolation, zero compensation needed) is already available. See
  "Subdomain serving" below.
- **Every build or upload is scanned for root-absolute asset references**
  (`server/build/root-absolute-scan.ts`): a root-absolute `<script src>`/
  `<link href>`, a CSS `url(/...)`, or one of two narrow bundler-runtime
  signatures (Vite's absolute-base preload helper, webpack's
  `publicPath`). This is what most bundlers emit by default (Vite, Create
  React App, Next static export, Astro, Nuxt, Parcel), and it is exactly
  the class of reference the fallback above only partially compensates
  for: a HASHED filename resolves reliably through the fallback's scan
  lane, but a non-hashed one depends on the Referer header being present,
  which a lazily-loaded chunk or preloaded stylesheet does not always
  send. The scan's result is recorded on the deployment (`warnings`,
  `GET /projects/:id/deployments`) whether or not it currently matters, and
  the viewer shows a warning Callout in the Repo dialog's Build panel only
  when the project's CURRENT access and serve mode make the failure real:
  path mode, and not a genuinely public-link project. The one-line fix is
  the same one named just above: build with a relative base (Vite:
  `base: './'`; Create React App: `"homepage": "."`), or serve the
  prototype from its own subdomain (`VIEWER_SERVE_DOMAIN`, see "Subdomain
  serving" below), which needs no relative-base change at all.
- Prototypes share the viewer's origin under path-based serving (the
  default), so the review iframe is sandboxed into an opaque origin to
  compensate, which costs the prototype `localStorage`/`sessionStorage`/
  cookies. For hard isolation *with* storage, set `VIEWER_SERVE_DOMAIN`;
  both the review iframe and the dashboard's "Open" link follow it. See
  "Subdomain serving" below.
- The build runner executes repository code. Deploy only repos you
  trust; this is not a multi-tenant SaaS.
- **Access is enforced on every read path.** The project list (filters,
  doesn't 404), project detail, deployment history, comments (including the
  SSE stream: checked at connection time only; an in-flight stream is never
  re-checked, so removing a reviewer from an access list takes effect on
  their next reconnect, not mid-stream), participants, and every
  `/p/{slug}/**` prototype are gated on the project's `access`. The root
  asset fallback (above) runs the same check on BOTH its lanes (Referer and
  hashed-name scan). It lives outside `/p/` and would otherwise be a
  cross-project existence oracle. The rule, in order: `public-link` is
  readable by anyone as long as the instance-wide `allowPublicLinks` setting
  is on; the shared admin token (or an admin-role account) reaches
  everything; a signed-in instance member reads `all-members`; a signed-in
  member also reads `public-link` when `allowPublicLinks` is off (it then
  behaves exactly like `all-members`); a signed-in member on the access list
  reads `invited`. A denied read 404s, byte-identical to a genuine miss
  (never a 403, which would itself confirm the project exists). **There's no
  zero-members trap any more**: an `invited` project with an empty access
  list is readable by nobody but admins, never by the world. The old
  `visibility: "members"` migration rule that made a zero-member project
  world-readable was deleted along with `visibility` itself. None of this is
  rate-limited yet, and the build runner still executes repository code
  untrusted, so keep deploying only where trusted people can reach the port
  (e.g. behind a VPN or on a private network), not on the open internet.
- **Managing a project needs Editor or Admin instance authority. There is
  no per-project ownership.** `POST /projects` needs that authority at the
  instance level (`requireWrite` → `requireInstanceEditor`): the admin
  bearer, an active `admin`/`editor`-role account, or their write-scoped PAT.
  From there, `GET/POST/DELETE /projects/:id/members` manage the project's
  access list: the LIST route is gated the same as every other read
  (readable-project); the WRITE routes (`POST`, `DELETE`) go through
  `requireProjectManage`: admin authority, or an `editor` who can already
  read the project at `:id`. Invite is identity-first: it resolves an email
  to an EXISTING, active `User` row via `getUserByEmail`, and 404s with an
  actionable message ("invite them from Settings first") when no such
  account exists yet. There is deliberately **no pending-access-list state.**
  Unlike the participant directory (`POST /projects/:id/participants`),
  which happily creates a placeholder row for any email, the access list
  requires the person to have an account already. `DELETE` is idempotent
  (removing a non-member is a no-op 204). One refusal guard applies, scoped
  to `access === "invited"` projects only; a `public-link` or
  `all-members` project's readability never depended on its access list, so
  removal there is always unconditional:
  - **Last access-list entry.** Refuses (400) removing the target if they
    are the last remaining entry on an `invited` project's access list,
    UNLESS the caller is an admin. The guard exists to stop a non-admin
    editor from locking themselves (and everyone else on the list) out of a
    project whose readability depends entirely on that list. It doesn't
    apply to an admin caller, because admin authority reaches the project
    regardless of who's listed. There's no lockout to prevent, and the
    admin is often deliberately emptying the list.

  Every project response carries `access` directly. There's no derived
  "is this secretly public" flag any more, since `access` is a stored
  tri-state that already says what it means.
- Comment endpoints are public-write for anyone who CAN read the project
  (per the access rule above): reviewers self-declare a name unless signed
  in (no per-write auth requirement), so any instance member on an
  `all-members` project, a listed member of an `invited` project, or anyone
  at all on a `public-link` project can comment. Payloads are strictly
  validated and size-capped, and comment writes are rate-limited per IP (see
  below), but there is still no aggregate bound on comment or connection
  counts.
- The participant-invite endpoint (`POST /api/v1/projects/:id/participants`)
  follows the same rule: gated on project access, but not on a per-write
  auth requirement beyond that. It's self-declared identity, same as
  comments. Emails are shape-validated and rows are size-capped, and this
  endpoint is also rate-limited per IP (see below), but there is still no
  aggregate cap on participant or pending-invite count per project.
- **Some write lanes are rate-limited per client IP; most of the API, and
  every GET read, are not.** `POST /projects/resolve`, the participant-invite
  endpoint above, comment writes (`POST`/`PATCH`/`DELETE`), and every
  `/api/v1/auth/**` route (including `/auth/local` and the new invite/
  magic-link/sign-in-link routes, so none of them can be brute-forced past a
  fixed rate) are capped per client IP per time window. A caller over the
  limit gets `429` with a `Retry-After` header. SSE streams are deliberately
  excluded: a limiter in front of a long-lived connection would either count
  it once (useless) or refuse a normal reconnect after a proxy hiccup
  (harmful). Project creation, access-list management, repo connect, build
  triggers, every route under `/api/v1/instance/**`, and every other read
  still have no rate limit.

### Push-webhook auto-deploy (Phase 3c-3)

**If you created the App with the one-click setup card, and your
`VIEWER_PUBLIC_URL` is a real public address (not `localhost` or another
loopback host), this is already done.** GitHub cannot deliver a webhook to a
loopback address. It rejects the whole App manifest if you try. So for a
loopback `VIEWER_PUBLIC_URL` the one-click flow deliberately asks for no
webhook at all, and there is nothing here to activate later without
re-registering the App at a public URL (or setting up a tunnel; see "Local
development needs a tunnel" below). For a public `VIEWER_PUBLIC_URL`, the
manifest that flow submits to GitHub asks for the webhook active and pointed
at `{VIEWER_PUBLIC_URL}/api/v1/webhooks/github` from the start, and GitHub
hands back a webhook secret as part of App creation, which the viewer stores
for you. All that's left is turning `autoDeploy` on for a project (see
`PUT /api/v1/projects/:id/repo` in the API table above).

Registering the App by hand needs one more step: set
`VIEWER_GITHUB_APP_WEBHOOK_SECRET` to any long random string, then set the
**same** value as the App's webhook secret and point the App's webhook URL at
`{VIEWER_PUBLIC_URL}/api/v1/webhooks/github`. A push to a project's configured
branch builds it, if that project has `autoDeploy` on.

Unset ⇒ the route answers **503**. It never processes an unverified payload:
GitHub is not a user and carries no session, so the signature is the entire
security boundary.

**Local development needs a tunnel.** GitHub cannot reach `localhost`, so
either leave the webhook off and use the manual **Build now** button, or proxy
deliveries with GitHub's own [smee.io](https://smee.io) (no account required):

```bash
npx smee-client --url https://smee.io/<your-channel> \
  --target http://localhost:3100/api/v1/webhooks/github
```

Point the App's webhook URL at the smee channel rather than at localhost.

## Subdomain serving (optional, Phase 3d)

Set `VIEWER_SERVE_DOMAIN` (e.g. `proto.example.com`) and prototypes are also
served at `{slug}.{VIEWER_SERVE_DOMAIN}/`, at the **origin root**, not under
`/p/{slug}/`. Path serving keeps working; this is additive.

The shell follows the flag: with a serve domain configured, the review
page's iframe and the dashboard's "Open" link both point at
`{slug}.{VIEWER_SERVE_DOMAIN}/`, and the iframe drops its path-mode sandbox
because the origin is now the boundary (`app/prototype-origin.ts` is the one
place that decides this). Without one, both stay on `/p/{slug}/`.

**A project that needs sign-in is served here too, just not with the shell's
session cookie.** That cookie is host-only, so it is never sent to a
prototype subdomain, by design. A `public-link` project (while the
instance's `allowPublicLinks` setting is on) needs nothing more than that:
every read is already anonymous. An `all-members` or `invited` project gets
a short-lived capability instead: the document load carries it as `?~c=`,
the server verifies it and sets it as a host-only `dsv_cap` cookie on the
prototype's own subdomain, and every later same-site request from that
document, including its assets, is authorized by that cookie with no session
cookie involved. This only works when `VIEWER_SERVE_DOMAIN` is same-site
with `VIEWER_PUBLIC_URL` (see "How prototypes are isolated" above). Split
across unrelated domains, the cookie never attaches and a private
prototype's assets 404 in the iframe.

**Why you'd want it.** Path serving puts the prototype on the same origin as
the shell and its API, so every isolation property is bought with a CSP header,
and `VIEWER_PROTOTYPE_CSP=off` removes that wholesale. A separate origin
removes the premise instead:

- The session cookie is host-only (no `Domain` attribute), so it is **never
  sent** to a prototype origin.
- The API is **not routed** on a prototype origin at all: every path there
  resolves as a prototype asset. That boundary survives even with the CSP off.
- `connect-src` becomes `'self'`, which is both stronger and simpler: on its
  own origin, `'self'` is the prototype and nothing else.
- No `<base href>` and no URL rewriting are needed, because the prototype
  really is at the root, which removes the Phase 1.5 residue entirely, including
  for apps built with an explicitly configured base path.

**Why it isn't the default.** It needs wildcard DNS (`*.proto.example.com`) and
a matching wildcard TLS certificate. Only one label may precede the serve
domain: `a.b.{domain}` is refused, because a `*.{domain}` certificate does not
cover it.

**Local testing** needs hostnames that resolve. Add them to `/etc/hosts`
(`127.0.0.1 acme.proto.test`), or use a wildcard-resolving service such as
`acme.127.0.0.1.nip.io` with `VIEWER_SERVE_DOMAIN=127.0.0.1.nip.io`.


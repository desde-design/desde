/**
 * Downloading a binary asset (an image) into the prototype.
 *
 * The agent can author text today but has no way to bring in a picture, so
 * "use this image" has always meant the user saving a file by hand.
 *
 * ## Why this is a separate allowlist from ALLOWED_NEW_FILE_EXTENSIONS
 *
 * That set governs files the agent AUTHORS, and it is text-only on purpose —
 * it is what stops the agent writing a shell script or a `.env`. Downloads are
 * a different operation with a different risk shape (bytes come from the
 * network, not the model), so they get their own, narrower set: raster and
 * vector images only. Widening the authoring set to cover images would have
 * loosened an unrelated guard to solve this problem.
 *
 * ## Trust
 *
 * The URL must pass the SAME host allowlist that gates `WebFetch`. Downloads
 * therefore add no new trust surface: a host the user already decided the
 * agent may read is the only host it may download from. Private and loopback
 * addresses are refused outright even if allowlisted, so an allowlist entry
 * can never be turned into an SSRF probe of the user's network.
 */

import { lookup } from 'node:dns/promises'
import { isPrivateOrLoopbackHost } from '../edit-service/parse-storybook-urls'
import { isWebFetchAllowed, type WebPolicy } from './web-policy'

/**
 * Extensions a download may produce. Images only — they are inert data.
 * Nothing here can be executed by the dev server or imported as code.
 */
export const DOWNLOADABLE_ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.svg',
  '.ico',
])

/** Content types we accept, mapped to the extensions they may be written as. */
const CONTENT_TYPE_EXTENSIONS: Record<string, ReadonlySet<string>> = {
  'image/png': new Set(['.png']),
  'image/jpeg': new Set(['.jpg', '.jpeg']),
  'image/gif': new Set(['.gif']),
  'image/webp': new Set(['.webp']),
  'image/avif': new Set(['.avif']),
  'image/svg+xml': new Set(['.svg']),
  'image/x-icon': new Set(['.ico']),
  'image/vnd.microsoft.icon': new Set(['.ico']),
}

/** 10 MB. An image for a prototype is far smaller; this bounds a hostile server. */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024

export type DownloadFailure =
  | 'not-allowed-host'
  | 'private-address'
  | 'bad-extension'
  | 'fetch-failed'
  | 'too-large'
  | 'wrong-content-type'

export type DownloadResult =
  | { ok: true; bytes: Buffer; contentType: string }
  | { ok: false; code: DownloadFailure; reason: string }

export function assetExtensionOf(destPath: string): string {
  const base = destPath.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot).toLowerCase()
}

/**
 * Everything that can be decided WITHOUT touching the network.
 *
 * Split out so the policy is unit-testable on its own, and so the caller can
 * refuse before making a request at all — a denied download should not
 * generate traffic that tells a server the user exists.
 */
export function checkDownloadRequest(opts: {
  url: unknown
  destPath: string
  policy: WebPolicy | undefined
}): { ok: true; url: URL; extension: string } | { ok: false; code: DownloadFailure; reason: string } {
  const extension = assetExtensionOf(opts.destPath)
  if (!DOWNLOADABLE_ASSET_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      code: 'bad-extension',
      reason: `Downloads may only write image files (${[...DOWNLOADABLE_ASSET_EXTENSIONS].join(', ')}). '${opts.destPath}' is not one.`,
    }
  }

  if (!opts.policy) {
    return {
      ok: false,
      code: 'not-allowed-host',
      reason:
        'Downloads are disabled: no web policy configured. Add `"webFetch": {"allowedHosts": [...]}` to desde.config.json to allow a host.',
    }
  }

  // Same gate as WebFetch: downloads add no new trust surface.
  const allowed = isWebFetchAllowed(opts.policy, opts.url)
  if (!allowed.ok) {
    return { ok: false, code: 'not-allowed-host', reason: allowed.reason }
  }

  let parsed: URL
  try {
    parsed = new URL(String(opts.url))
  } catch {
    return { ok: false, code: 'not-allowed-host', reason: `Invalid URL ${JSON.stringify(opts.url)}` }
  }

  // Refused even when allowlisted: an allowlist entry must never become a
  // probe of the user's own network.
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return {
      ok: false,
      code: 'private-address',
      reason: `Refusing to download from a private or loopback address (${parsed.hostname}).`,
    }
  }

  return { ok: true, url: parsed, extension }
}

/**
 * Fetch the bytes, enforcing size and content type.
 *
 * `fetchImpl` is injectable so the policy and the streaming size cap are
 * testable without a network.
 */
export async function downloadAsset(opts: {
  url: unknown
  destPath: string
  policy: WebPolicy | undefined
  fetchImpl?: typeof fetch
  maxBytes?: number
  /** Injectable for tests. Defaults to a real DNS lookup. */
  resolveHost?: (hostname: string) => Promise<string[]>
  /** Injectable for tests; production builds one pinned to the vetted IPs. */
  dispatcher?: unknown
}): Promise<DownloadResult> {
  const pre = checkDownloadRequest(opts)
  if (!pre.ok) return pre

  const maxBytes = opts.maxBytes ?? MAX_ASSET_BYTES
  const doFetch = opts.fetchImpl ?? fetch

  // Checking the hostname STRING is not enough: an allowlisted name the
  // attacker controls can resolve to 127.0.0.1, RFC1918 space, or a cloud
  // metadata IP, and fetch() would happily connect there. Resolve first and
  // judge the ADDRESS.
  const resolveAddresses = opts.resolveHost ?? defaultResolveHost
  let addresses: string[]
  try {
    addresses = await resolveAddresses(pre.url.hostname)
  } catch (err) {
    return { ok: false, code: 'fetch-failed', reason: `DNS lookup failed: ${(err as Error).message}` }
  }
  const privateAddress = addresses.find((a) => isPrivateOrLoopbackHost(a))
  if (privateAddress) {
    return {
      ok: false,
      code: 'private-address',
      reason: `Refusing to download: ${pre.url.hostname} resolves to a private or loopback address (${privateAddress}).`,
    }
  }

  let response: Response
  try {
    // `redirect: 'error'` — a 302 could land on a host the user never
    // allowlisted, or on a private address, defeating both checks above.
    //
    // `dispatcher` PINS the connection to the addresses we just vetted.
    // Without it the check above is advisory: fetch performs its OWN lookup,
    // so an attacker controlling an allowlisted name can answer public on our
    // probe and private on theirs (DNS rebinding). Pinning closes the window
    // by removing the second lookup entirely.
    const dispatcher =
      opts.dispatcher !== undefined ? opts.dispatcher : await pinnedDispatcher(addresses)
    if (!dispatcher) {
      // FAIL CLOSED. Falling back to a plain fetch would re-open the exact
      // rebinding window the pin exists to close, and a silent downgrade of a
      // security boundary is worse than a refused download.
      return {
        ok: false,
        code: 'fetch-failed',
        reason:
          'Refusing to download: cannot pin the connection to the address that was checked, so a DNS-rebinding attack could not be ruled out.',
      }
    }
    response = await doFetch(pre.url.toString(), {
      redirect: 'error',
      dispatcher,
    } as RequestInit)
  } catch (err) {
    return { ok: false, code: 'fetch-failed', reason: (err as Error).message }
  }

  if (!response.ok) {
    return {
      ok: false,
      code: 'fetch-failed',
      reason: `Download failed: ${response.status} ${response.statusText}`,
    }
  }

  const contentType = (response.headers.get('content-type') ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase()
  const permitted = CONTENT_TYPE_EXTENSIONS[contentType]
  if (!permitted) {
    return {
      ok: false,
      code: 'wrong-content-type',
      reason: `Refusing to save '${contentType || 'unknown'}' as an image. The server did not return an image.`,
    }
  }
  if (!permitted.has(pre.extension)) {
    // Saving a PNG as .jpg would produce a file whose extension lies about
    // its bytes — confusing at best, and a mismatch a bundler may reject.
    return {
      ok: false,
      code: 'wrong-content-type',
      reason: `The server returned ${contentType}, which does not match '${pre.extension}'. Use ${[...permitted].join(' or ')}.`,
    }
  }

  // Trust the declared length only as an early-out; the real bound is the
  // byte count below, since Content-Length can lie.
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) {
    return {
      ok: false,
      code: 'too-large',
      reason: `Download is ${declared} bytes, over the ${maxBytes}-byte limit.`,
    }
  }

  // Read INCREMENTALLY and abort the moment the cap is passed. Buffering the
  // whole body first would let a hostile allowlisted host stream far past the
  // limit and drive the process into OOM before we ever checked.
  let bytes: Buffer
  try {
    bytes = await readCapped(response, maxBytes)
  } catch (err) {
    const message = (err as Error).message
    if (message === TOO_LARGE) {
      return {
        ok: false,
        code: 'too-large',
        reason: `Download exceeds the ${maxBytes}-byte limit.`,
      }
    }
    return { ok: false, code: 'fetch-failed', reason: message }
  }

  return { ok: true, bytes, contentType }
}

const TOO_LARGE = '__asset_too_large__'

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true })
  return results.map((r) => r.address)
}

/**
 * Read a response body, aborting as soon as `maxBytes` is passed.
 *
 * Falls back to `arrayBuffer()` only when the body is not streamable (some
 * test doubles), where the cap is then applied after the fact.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const body = response.body
  if (!body || typeof body.getReader !== 'function') {
    const buffered = Buffer.from(await response.arrayBuffer())
    if (buffered.byteLength > maxBytes) throw new Error(TOO_LARGE)
    return buffered
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(TOO_LARGE)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * An undici Agent whose DNS lookup can only return `addresses`.
 *
 * This is what makes the private-address refusal a real boundary rather than
 * advice: fetch would otherwise resolve the name a second time, and an
 * attacker controlling an allowlisted host can answer public on our probe and
 * private on fetch's (DNS rebinding). Returns null if undici is unavailable,
 * and the caller then REFUSES: silently downgrading to an unpinned fetch would
 * leave the boundary looking intact while it is not.
 */
async function pinnedDispatcher(addresses: string[]): Promise<unknown | null> {
  try {
    const { Agent } = (await import('undici')) as unknown as {
      Agent: new (opts: unknown) => unknown
    }
    return new Agent({
      connect: {
        lookup: (
          _hostname: string,
          _options: unknown,
          callback: (err: Error | null, address?: string, family?: number) => void,
        ) => {
          const pinned = addresses[0]
          if (!pinned) {
            callback(new Error('no vetted address for host'))
            return
          }
          callback(null, pinned, pinned.includes(':') ? 6 : 4)
        },
      },
    })
  } catch {
    return null
  }
}

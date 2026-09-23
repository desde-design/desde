/**
 * Media-content service — the single "image → model" path (Phase 3 of the
 * visualizer). Turns a captured/uploaded image into the MCP image content block
 * the SDK forwards to Claude as a vision input, with validation + a size cap.
 *
 * Shared seam: the agent screenshot tool (Phase 4) and user image input
 * (editor-user-input-confidence.md Phase 3) both go through here — one place
 * that decides what's a valid, in-budget model image, so there's no second
 * image path.
 *
 * SCOPE: this does NOT downscale/recompress. The right place to shrink a capture
 * is the BRIDGE (resize the canvas + emit JPEG before it ever crosses
 * postMessage → SSE), which needs a bridge change + live smoke — deferred to a
 * session that can verify it. Until then, oversized images are refused with a
 * "scope down" hint rather than sent (the vision API rejects/penalizes very
 * large images), so element/selector captures work and full-page ones degrade
 * gracefully.
 */

/** MCP image content block — `data` is base64 WITHOUT the `data:` prefix. */
export interface ModelImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export type MediaContentResult =
  | { ok: true; image: ModelImageContent; bytes: number }
  | { ok: false; reason: string }

/** Image types Claude's vision input accepts. */
export const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

/**
 * Decoded-byte cap. Anthropic's vision input rejects images over ~5MB of
 * decoded image data; `bytes` below is the DECODED size (not the base64 wire
 * size), so this is set just under 5MB for margin — no base64-expansion reserve
 * (that would double-count and reject valid 3.75–5MB images). A full-page DPR-2
 * PNG can still blow past this, so the refusal nudges the agent to capture a
 * specific element instead.
 */
export const DEFAULT_MAX_IMAGE_BYTES = 4_500_000

const DATA_PREFIX = "data:"
/** The marker separating a data-URL header from its base64 payload. */
const BASE64_MARKER = ";base64,"
/** Strict base64 alphabet with optional 1–2 chars of trailing `=` padding. */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** Approximate decoded byte length of a base64 string (4 chars → 3 bytes, minus padding). */
export function base64ByteLength(base64: string): number {
  const len = base64.length
  if (len === 0) return 0
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((len * 3) / 4) - padding
}

export interface ImageFromDataUrlOptions {
  /** Override the default raw-byte cap. */
  maxBytes?: number
}

/**
 * Parse a base64 data URL (`data:image/png;base64,…`) into a validated,
 * size-capped MCP image content block. Returns `{ ok: false, reason }` for a
 * malformed URL, an unsupported type, invalid base64, or an over-cap image
 * (with a scope-down hint) — never throws.
 *
 * Parsing splits on the literal `;base64,` marker rather than a single regex:
 * that tolerates media-type parameters (`data:image/png;charset=utf-8;base64,…`)
 * and a payload spanning multiple lines, and avoids any regex backtracking on
 * an attacker-sized string.
 */
export function imageFromDataUrl(
  dataUrl: string,
  options: ImageFromDataUrlOptions = {},
): MediaContentResult {
  if (!dataUrl.startsWith(DATA_PREFIX)) {
    return { ok: false, reason: 'Not a base64 image data URL.' }
  }
  // `lastIndexOf`, not `indexOf`: a base64 payload can never contain `;` (the
  // alphabet is [A-Za-z0-9+/=]), so the FINAL `;base64,` is always the true
  // delimiter — this skips a `;base64,` smuggled into a quoted header param
  // (e.g. data:image/png;name="x;base64,";base64,…).
  const markerIdx = dataUrl.lastIndexOf(BASE64_MARKER)
  if (markerIdx === -1) {
    return { ok: false, reason: 'Not a base64 image data URL (no ;base64, marker).' }
  }
  // Header is everything between `data:` and the marker, e.g.
  // "image/png" or "image/png;charset=utf-8" — the MIME is the first segment.
  const header = dataUrl.slice(DATA_PREFIX.length, markerIdx)
  const mimeType = header.split(';', 1)[0].trim().toLowerCase()
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    return {
      ok: false,
      reason: `Unsupported image type "${mimeType}". Supported: ${[
        ...SUPPORTED_IMAGE_MIME_TYPES,
      ].join(', ')}.`,
    }
  }
  // Strip whitespace some producers wrap base64 with (newlines/spaces are not
  // part of the payload) before validating + measuring.
  const data = dataUrl.slice(markerIdx + BASE64_MARKER.length).replace(/\s/g, '')
  if (data.length === 0) {
    return { ok: false, reason: 'Empty image data.' }
  }
  if (data.length % 4 !== 0 || !BASE64_RE.test(data)) {
    return { ok: false, reason: 'Image data is not valid base64.' }
  }
  const bytes = base64ByteLength(data)
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES
  if (bytes > maxBytes) {
    return {
      ok: false,
      reason: `Image is too large (${(bytes / 1e6).toFixed(1)}MB > ${(
        maxBytes / 1e6
      ).toFixed(
        1,
      )}MB cap). Capture a specific element with scope:'element' or scope:'selector' instead of the full page.`,
    }
  }
  return { ok: true, image: { type: 'image', data, mimeType }, bytes }
}

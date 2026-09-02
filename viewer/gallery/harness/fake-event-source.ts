/**
 * A stand-in for the browser's `EventSource`.
 *
 * Two viewer surfaces open a server-sent-events stream on mount: the build
 * panel follows a running build's log, and the comment store listens for a
 * "someone changed something" ping. With no server behind the gallery the real
 * `EventSource` would connect, fail, and retry forever — a console full of
 * network errors, and a build panel stuck on a state nobody chose.
 *
 * The two streams have DIFFERENT shapes, so this fake serves both rather than
 * picking one. The build log sends NAMED events (`event: log`, `event: done`)
 * and is read with `addEventListener`; the comment stream sends bare `data:`
 * frames and is read with `onmessage`. A fake that only did one would silently
 * do nothing for the other.
 *
 * Nothing is emitted unless a fixture asks for it. That is deliberate: an
 * idle stream is what "no build is running" actually looks like, so the
 * default costs nothing and the streaming states stay explicit.
 */

type Listener = (event: { data: string }) => void

class GalleryEventSource {
  static readonly instances: GalleryEventSource[] = []

  readonly url: string
  onmessage: Listener | null = null
  onerror: ((event: unknown) => void) | null = null
  closed = false

  private readonly named = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    GalleryEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.named.get(type) ?? []
    list.push(listener)
    this.named.set(type, list)
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.named.get(type)
    if (!list) return
    this.named.set(
      type,
      list.filter((candidate) => candidate !== listener),
    )
  }

  close(): void {
    this.closed = true
  }

  /** @internal — used by the module-level emit helpers below. */
  dispatchNamed(type: string, data: unknown): void {
    if (this.closed) return
    for (const listener of this.named.get(type) ?? []) {
      listener({ data: JSON.stringify(data) })
    }
  }

  /** @internal */
  dispatchMessage(data: unknown): void {
    if (this.closed) return
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

function live(urlContains: string): GalleryEventSource[] {
  return GalleryEventSource.instances.filter(
    (source) => !source.closed && source.url.includes(urlContains),
  )
}

/**
 * Push a NAMED event onto every open stream whose URL contains `urlContains` —
 * the build log's shape (`event: log` / `event: done`).
 */
export function emitNamedEvent(urlContains: string, type: string, data: unknown): void {
  for (const source of live(urlContains)) source.dispatchNamed(type, data)
}

/**
 * Push a bare `data:` frame — the comment stream's shape, read via `onmessage`.
 */
export function emitMessageEvent(urlContains: string, data: unknown): void {
  for (const source of live(urlContains)) source.dispatchMessage(data)
}

/** True once at least one stream matching `urlContains` is open. */
export function hasOpenStream(urlContains: string): boolean {
  return live(urlContains).length > 0
}

declare global {
  interface Window {
    __VIEWER_GALLERY_EVENT_SOURCE__?: true
  }
}

export function installFakeEventSource(): void {
  if (window.__VIEWER_GALLERY_EVENT_SOURCE__) return
  window.__VIEWER_GALLERY_EVENT_SOURCE__ = true
  // The real constructor's type is wider than what either consumer uses
  // (readyState, withCredentials, the `on*` properties we do not implement),
  // so this is an assignment across a deliberate narrowing.
  window.EventSource = GalleryEventSource as unknown as typeof EventSource
}

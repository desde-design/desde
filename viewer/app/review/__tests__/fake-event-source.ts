/**
 * A drivable stand-in for the browser's `EventSource`, for the suites that
 * exercise the review page's live process-state follow.
 *
 * jsdom DOES provide an `EventSource`, and that is the problem: it opens a
 * real connection to a server no test is running, fails, and reconnects on its
 * own schedule forever. This replaces it with one that connects to nothing and
 * delivers exactly the events a test asks it to.
 *
 * The stream this serves sends NAMED events (`event: origin`), read with
 * `addEventListener`, which is the shape `prototype-origin-routes.ts` writes.
 *
 * Installed through `vi.stubGlobal`, so `viewer/vitest.config.ts`'s
 * `unstubGlobals` removes it after each test with no per-suite teardown.
 */

import { vi } from "vitest"

type Listener = (event: { data: string }) => void

export class FakeEventSource {
  /** Every source constructed since the last `installFakeEventSource()`. */
  static readonly instances: FakeEventSource[] = []

  readonly url: string
  closed = false

  private readonly listeners = new Map<string, Listener[]>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type)
    if (!list) return
    this.listeners.set(
      type,
      list.filter((candidate) => candidate !== listener),
    )
  }

  close(): void {
    this.closed = true
  }

  /**
   * Deliver one named event, framed the way the route frames it: the value is
   * JSON, and the consumer parses `event.data` itself.
   *
   * A closed source delivers nothing, which is what makes "closes on unmount"
   * testable by behaviour as well as by the flag.
   */
  dispatch(type: string, data: unknown): void {
    if (this.closed) return
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ data: JSON.stringify(data) })
    }
  }
}

/** Replace the global `EventSource` and forget every source from an earlier test. */
export function installFakeEventSource(): void {
  FakeEventSource.instances.length = 0
  // The real constructor is wider than anything the hook uses (readyState,
  // withCredentials, the `on*` properties), so this is a deliberate narrowing.
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource)
}

/** The sources still open whose URL contains `urlContains`. */
export function openEventSources(urlContains: string): FakeEventSource[] {
  return FakeEventSource.instances.filter(
    (source) => !source.closed && source.url.includes(urlContains),
  )
}

/** The most recently constructed source, open or not. */
export function latestEventSource(): FakeEventSource | undefined {
  return FakeEventSource.instances.at(-1)
}

import { createAstroHost } from "./astro/host.js"
import { createAttachHost } from "./attach/host.js"
import { createNextHost } from "./next/host.js"
import { createNuxtHost } from "./nuxt/host.js"
import { createReactRouterHost } from "./react-router/host.js"
import { createViteHost } from "./vite/host.js"
import type { DevServerHost, HostId } from "./types.js"

/**
 * The ONE switch on {@link HostId}.
 *
 * Every other file asks this module rather than branching on the id itself, so
 * "which hosts exist" has a single answer and adding one is a compile error
 * here (and, at the detection rewrite, in the signal table) rather than a
 * silently-missing case somewhere downstream.
 *
 * **Total, not `Partial`.** A `null` entry means "this host is designed but not
 * built yet" and is answered with a typed failure by `resolve.ts`. Spelling the
 * unbuilt hosts out costs six lines and buys the property the seam is for: a
 * new `HostId` member cannot compile until someone decides what it maps to.
 *
 * **Factories, not instances.** A host object is cheap, but constructing one
 * must not be able to reach the framework it drives — `astro` and `next` are
 * dynamically imported inside `probe`/`boot`, so importing this registry (which
 * `core.ts` does on every boot, including attach mode) never loads a framework
 * the project may not even have installed.
 */
/**
 * A host of either channel.
 *
 * Deliberately a UNION of the two instantiations rather than
 * `DevServerHost<StamperChannel>`: instantiating `K` to the whole channel union
 * makes `boot`'s injection parameter the whole `StamperInjection` union, and a
 * host that accepts only Vite plugins is not substitutable for one that must
 * also accept a Turbopack loader (tsc rejects it outright). The union says what
 * is actually true — one of these two, decided by `accepts` — and because
 * `accepts` is a literal-typed member it works as the discriminant, so
 * narrowing on it in the pipeline gives the compiler the exact injection shape
 * to check against.
 */
export type AnyDevServerHost = DevServerHost<"vite-plugin"> | DevServerHost<"turbopack-loader">

export type HostFactory = () => AnyDevServerHost

const HOSTS: Record<HostId, HostFactory | null> = {
  vite: createViteHost,
  // BUILT, and default-OFF — see `enabled-hosts.ts`. "Is there an
  // implementation" and "should detection route to it unasked" are different
  // questions, and this map only answers the first.
  "react-router": createReactRouterHost,
  // Also BUILT and default-OFF. Its factory does not import `astro` — the
  // package is resolved from the PROTOTYPE inside `probe`/`boot` — so having it
  // here costs a repo without Astro nothing.
  astro: createAstroHost,
  // Also BUILT and default-OFF. Its factory does not import `@nuxt/cli` — the
  // package is resolved from the PROTOTYPE's own `nuxt` inside `probe`/`boot` —
  // so having it here costs a repo without Nuxt nothing.
  nuxt: createNuxtHost,
  // Also BUILT and default-OFF, and the only entry on the `turbopack-loader`
  // channel. Its factory imports nothing from `next` — the package, the private
  // config seam and the phase constant are all resolved from the PROTOTYPE
  // inside `probe`/`boot` — so having it here costs a repo without Next nothing,
  // which is the property the lazy-factory shape exists for.
  next: createNextHost,
  // A REAL entry as of the detection rewrite. It is not an in-process host —
  // see `inProcessHostIds()` below, and never conflate the two — but it is a
  // host: it declares what it can stamp, what security it cannot provide, what
  // its bridge tags ride on, and what zero stamps mean, exactly as its five
  // peers do. `core.ts` still calls `startAttachProxy` directly rather than
  // dispatching this lane through `runHost`; `hosts/attach/host.ts` says why,
  // and a test pins its declarations against what that branch really does.
  attach: createAttachHost,
}

/** The host, or null when the id is known but not built yet. */
export function getHostFactory(id: HostId): HostFactory | null {
  return HOSTS[id]
}

/** Every id with an implementation, `attach` included. */
export function registeredHostIds(): HostId[] {
  return (Object.keys(HOSTS) as HostId[]).filter((id) => HOSTS[id] !== null)
}

/**
 * The ids a repo can be routed to for an IN-PROCESS boot — everything except
 * `attach`.
 *
 * Two facts that used to be the same one and are not any more. `attach` gained a
 * registry entry at the detection rewrite, and every message that says "the
 * in-process hosts available in this build are …" or accepts a `hosts.<id>`
 * opt-in must exclude it: attach is not something a project turns on, it is what
 * you get by naming a URL, and listing it as an in-process option would offer a
 * lane that has no dev server to boot.
 */
export function inProcessHostIds(): HostId[] {
  return registeredHostIds().filter((id) => id !== "attach")
}

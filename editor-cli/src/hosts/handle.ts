/**
 * The prototype's HTTP surface, however it got there. **Framework-neutral by
 * construction: there is no `vite` member, deprecated or otherwise**, and this
 * file imports nothing.
 *
 * Both lanes produce one of these and nothing else distinguishes them to a
 * consumer:
 *
 *  - **In-process** (`runHost`) — Editor booted the dev server. The result is a
 *    {@link HostRun}, which is this plus everything a host knows about itself.
 *  - **Attached** (`startAttachProxy`) — the user runs their own dev command and
 *    we proxy it. There is no Vite object on our side at all, and for Next there
 *    is no Vite anywhere.
 *
 * **What used to be here, and where it went.** Until the leak-plugging milestone
 * this interface carried `vite?: { server: ViteDevServer }`, and every consumer
 * that wanted anything from the dev server reached through it. Three things did:
 *
 *  1. **Boot warmup + the module-graph walk** → the host's
 *     `moduleGraphEvidence()`, consumed inside `verifyStamping`.
 *  2. **HMR invalidation** → `HostBoot.hmr.invalidate()`. This one was a live
 *     bug, not just a shape: `run.ts` set `vite` to the FIRST captured server,
 *     which on Nuxt is the client lane, so an edit hot-updated the client while
 *     the SSR lane went on serving stale HTML with stale stamps.
 *  3. **`server.config.base`** → {@link PrototypeServerHandle.base}, which is
 *     the FRONT DOOR's base and therefore `/` for every fronted host (Nuxt's
 *     inner Vite resolves `base` to `/_nuxt/`, and reporting that is what breaks
 *     the shell's served-stylesheet → source-file mapping).
 *
 * **Why the host facts are not flattened onto this** — `tasks/dev-server-hosts.md`
 * § 3 sketched it with `hostId` / `hmr` / `security` / `coverage` /
 * `sideDoorOrigins` as members. They are deliberately NOT here yet, for a reason
 * the sketch could not see from where it was written: attach mode does not
 * become a registry entry until the detection rewrite, so today the attach lane
 * would have to invent all five. Four could be stated honestly; `hmr` could not.
 * The honest attach answer is "we do not own the watcher, and the user's own dev
 * server is already watching the files we write" — which `core.ts` expresses by
 * leaving `invalidateFiles` UNDEFINED. A required `hmr` member would replace
 * that with a no-op `invalidate()`, i.e. a stub on exactly the path whose whole
 * design note says "not a stub". Every one of those five facts already travels
 * on `HostRun` / `HostBoot`, where only a host can produce them.
 */
export interface PrototypeServerHandle {
  /** Where the prototype is served — the PROXY's origin whenever it is fronted. */
  url: string
  /**
   * Served path prefix, always trailing-slashed. The shell maps a served
   * stylesheet href back to a prototype-root-relative file with it, so it is
   * authoritative even when it is just `/`.
   */
  base: string
  close(): Promise<void>
}

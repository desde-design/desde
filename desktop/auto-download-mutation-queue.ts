/**
 * Serializes "set auto-download" mutations in INVOCATION order (F6 of the
 * adversarial review of Phase 4).
 *
 * ## The bug this replaces
 *
 * `main.ts`'s `desktop:settings:set-auto-download` IPC handler used to
 * `await setAutoDownload(value)` (the `settings.ts` disk write) then flip
 * the live `updater.setAutoDownload(value)` flag, directly inside an
 * `ipcMain.handle` callback. `ipcMain.handle` does not serialize concurrent
 * invocations — two rapid toggles (true, then false) dispatch two
 * independent handler calls that both start their own disk write
 * concurrently. Atomic rename (`settings.ts`'s temp+rename) prevents a
 * TORN file, but says nothing about ORDER: if the LATER call's write
 * happens to finish first (or the earlier one is merely slower for any
 * reason — filesystem latency is not guaranteed to match call order), the
 * earlier call's completion runs SECOND and overwrites both the persisted
 * file and the live flag with the STALE value, even though the renderer is
 * already showing the user's actual final choice.
 *
 * ## The fix
 *
 * A tiny FIFO promise chain. Each `mutate(value)` call synchronously
 * captures the CURRENT tail of the queue and appends its own work after
 * it, before anything asynchronous happens — so two calls made in quick
 * succession are guaranteed to run their persist-then-apply step in the
 * SAME order they were invoked, never interleaved and never reordered by
 * whichever happens to finish its I/O first. Persistence and the live flag
 * update happen as ONE step per mutation (not as two independently-awaited
 * operations), so a later mutation can never start until an earlier one has
 * fully landed on BOTH.
 *
 * A rejected mutation (e.g. a failed write) does not wedge the queue for
 * whatever comes after it — the internal chain always advances via
 * `.catch(() => {})`, while the ORIGINAL promise returned to that specific
 * caller still rejects, so the IPC handler (and, through it, the renderer's
 * rollback + toast — see `useDesktopUpdates.ts`) still sees the failure.
 *
 * Electron-free by the same reasoning as `updater-reducer.ts` /
 * `restart-and-install.ts`'s own module doc comments: the ordering
 * invariant needs to be provable with injected fakes, not a real Electron
 * `app` or a real settings file. See
 * `__tests__/auto-download-mutation-queue.test.ts`.
 */

export interface AutoDownloadMutationDeps {
  /** Persist the new value — `settings.ts`'s `setAutoDownload`. */
  persist: (value: boolean) => Promise<void>
  /** Flip the LIVE `autoUpdater.autoDownload` flag — `Updater.setAutoDownload`. */
  applyLive: (value: boolean) => void
}

export interface AutoDownloadMutationQueue {
  /** Resolves once THIS value has been persisted and applied live, in its own turn of the queue. Rejects if the persist step fails — the queue itself keeps moving regardless. */
  mutate(value: boolean): Promise<void>
}

export function createAutoDownloadMutationQueue(
  deps: AutoDownloadMutationDeps,
): AutoDownloadMutationQueue {
  let queue: Promise<void> = Promise.resolve()

  function mutate(value: boolean): Promise<void> {
    const next = queue.then(async () => {
      await deps.persist(value)
      deps.applyLive(value)
    })
    // Always resolves — a failed mutation must not permanently wedge the
    // queue for a LATER (possibly successful) one. `next` itself, returned
    // below, still carries the real rejection to THIS call's own caller.
    queue = next.catch(() => {})
    return next
  }

  return { mutate }
}

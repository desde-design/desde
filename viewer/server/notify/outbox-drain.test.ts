import { describe, expect, it, vi } from "vitest"
import { InMemoryStorage } from "../storage/in-memory-storage"
import { loadConfig } from "../config"
import { tmpViewerDataDir } from "../__tests__/test-config"
import type { ReloadableEmailProvider } from "./reloadable-email-provider"
import { resolveProjectName, runOutboxDrainTick, startOutboxDrain } from "./outbox-drain"

/** Recording fake — same shape as email-provider.test.ts's, kept local to avoid a cross-suite import. */
function createRecordingEmailProvider(): ReloadableEmailProvider & {
  calls: Array<{ to: string; subject: string; html: string }>
} {
  const calls: Array<{ to: string; subject: string; html: string }> = []
  return {
    calls,
    // A test that supplies a provider is testing the mail-is-on path.
    isConfigured: () => true,
    reconfigure: () => {},
    async send(to, subject, html) {
      calls.push({ to, subject, html })
      return true
    },
  }
}

async function seed(storage: InMemoryStorage) {
  const project = await storage.createProject({ slug: "acme", name: "Acme", repoUrl: null })
  const participant = await storage.upsertParticipant(project.id, {
    email: "bob@example.com",
    displayName: "Bob",
    status: "active",
  })
  const comment = await storage.createComment(project.id, {
    position: { anchorSelector: "#x", page: "/" },
    body: "hey @[Bob](p-bob) check this",
    author: { uid: "u1", displayName: "Ada", email: "ada@example.com", photoURL: "" },
  })
  const notification = await storage.enqueueNotification({
    projectId: project.id,
    commentId: comment.id,
    recipientIds: [participant.id],
  })
  return { project, participant, comment, notification }
}

describe("runOutboxDrainTick", () => {
  it("claims and sends a pending notification, marking it sent — a second tick sends nothing (exactly once)", async () => {
    const storage = new InMemoryStorage()
    const email = createRecordingEmailProvider()
    const config = loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_DATA_DIR: tmpViewerDataDir() })
    const { notification } = await seed(storage)

    await runOutboxDrainTick({ storage, email, config })
    expect(email.calls).toHaveLength(1)
    expect(email.calls[0].to).toBe("bob@example.com")
    // The subject must render the project's NAME ("Acme"), never its raw
    // (UUID-shaped in production) id — regression coverage for the outbox
    // wiring, on top of mention-email.test.ts's direct unit coverage.
    expect(email.calls[0].subject).toContain("Acme")
    expect(email.calls[0].subject).not.toContain((await storage.getNotification(notification.id))!.projectId)
    expect((await storage.getNotification(notification.id))?.status).toBe("sent")

    // Second tick: the row is no longer pending, so it must not be claimed/sent again.
    await runOutboxDrainTick({ storage, email, config })
    expect(email.calls).toHaveLength(1)
  })

  it("no-ops when email is null — the row stays pending", async () => {
    const storage = new InMemoryStorage()
    const config = loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_DATA_DIR: tmpViewerDataDir() })
    const { notification } = await seed(storage)

    await runOutboxDrainTick({ storage, email: null, config })
    expect((await storage.getNotification(notification.id))?.status).toBe("pending")
  })

  it("skips an opted-out recipient — no send, row still marked sent (0 delivered isn't an error)", async () => {
    const storage = new InMemoryStorage()
    const email = createRecordingEmailProvider()
    const config = loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_DATA_DIR: tmpViewerDataDir() })
    const { participant, project, notification } = await seed(storage)
    await storage.recordOptout({ participantId: participant.id, projectId: project.id })

    await runOutboxDrainTick({ storage, email, config })
    expect(email.calls).toHaveLength(0)
    expect((await storage.getNotification(notification.id))?.status).toBe("sent")
  })

  it("attaches a signed unsubscribe link when VIEWER_UNSUBSCRIBE_SECRET is configured", async () => {
    const storage = new InMemoryStorage()
    const email = createRecordingEmailProvider()
    const config = loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_UNSUBSCRIBE_SECRET: "shh", VIEWER_PUBLIC_URL: "https://viewer.example.com", VIEWER_DATA_DIR: tmpViewerDataDir() })
    await seed(storage)

    await runOutboxDrainTick({ storage, email, config })
    expect(email.calls).toHaveLength(1)
    expect(email.calls[0].html).toContain("https://viewer.example.com/api/v1/unsubscribe?token=")
  })

  it("marks the row error when the comment backing it was deleted", async () => {
    const storage = new InMemoryStorage()
    const email = createRecordingEmailProvider()
    const config = loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_DATA_DIR: tmpViewerDataDir() })
    const { comment, notification } = await seed(storage)
    await storage.deleteComment(comment.id)

    await runOutboxDrainTick({ storage, email, config })
    expect(email.calls).toHaveLength(0)
    expect((await storage.getNotification(notification.id))?.status).toBe("error")
  })

  it("the 'View comment' CTA deep-links to /review/<slug>?commentId=<id> — not the bare origin (Fix 2, phase-2b-2 review)", async () => {
    const storage = new InMemoryStorage()
    const email = createRecordingEmailProvider()
    // A BARE origin — the shape `config.publicUrl` actually has in
    // production. Passing it straight through as the CTA link (pre-fix
    // behavior) sends every recipient to the project-list home page instead
    // of their comment, because nothing reads a `commentId` query param
    // there; the review surface lives at `/review/<slug>`.
    const config = loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_PUBLIC_URL: "https://viewer.example.com", VIEWER_DATA_DIR: tmpViewerDataDir() })
    const { project, comment } = await seed(storage)

    await runOutboxDrainTick({ storage, email, config })
    expect(email.calls).toHaveLength(1)
    expect(email.calls[0].html).toContain(
      `https://viewer.example.com/review/${project.slug}?commentId=${comment.id}`,
    )
  })

  it("a storage failure while listing/claiming pending notifications doesn't reject the tick — it logs, and the next tick (once storage recovers) still sends (Fix 1, phase-2b-2 review)", async () => {
    const storage = new InMemoryStorage()
    const email = createRecordingEmailProvider()
    const config = loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_DATA_DIR: tmpViewerDataDir() })
    const { notification } = await seed(storage)

    const originalList = storage.listPendingNotifications.bind(storage)
    let shouldFail = true
    const listSpy = vi
      .spyOn(storage, "listPendingNotifications")
      .mockImplementation(async (limit: number) => {
        if (shouldFail) throw new Error("SQLITE_BUSY: database is locked")
        return originalList(limit)
      })
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    // Pre-fix, `listPendingNotifications`'s rejection propagated straight out
    // of `runOutboxDrainTick` — called as `void runOutboxDrainTick(deps)` from
    // the scheduler's `setInterval` callback with nothing to catch it, that
    // becomes an unhandled rejection, which crashes the process on Node >=15.
    // The assertion below (the returned promise resolves, not rejects) is
    // exactly what that pre-fix code failed: reverting the try/catch in
    // `runOutboxDrainTick` makes this `resolves` assertion fail because the
    // promise rejects instead.
    await expect(runOutboxDrainTick({ storage, email, config })).resolves.toBeUndefined()
    expect(email.calls).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalled()
    // The row was never claimed — still pending, ready for the next tick.
    expect((await storage.getNotification(notification.id))?.status).toBe("pending")

    shouldFail = false
    await runOutboxDrainTick({ storage, email, config })
    expect(email.calls).toHaveLength(1)
    expect((await storage.getNotification(notification.id))?.status).toBe("sent")

    listSpy.mockRestore()
    errorSpy.mockRestore()
  })
})

describe("startOutboxDrain", () => {
  it("ticks on the given interval and stop() halts further sends", async () => {
    const storage = new InMemoryStorage()
    const email = createRecordingEmailProvider()
    const config = loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_DATA_DIR: tmpViewerDataDir() })
    const { notification } = await seed(storage)

    const stop = startOutboxDrain({ storage, email, config, intervalMs: 10 })
    // Give the interval a couple of cycles to fire.
    await new Promise((resolve) => setTimeout(resolve, 60))
    stop()

    expect(email.calls).toHaveLength(1)
    expect((await storage.getNotification(notification.id))?.status).toBe("sent")

    const callsAfterStop = email.calls.length
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(email.calls).toHaveLength(callsAfterStop) // stop() actually cleared the timer
  })

  it("is safe to call with email: null (no throw, no timer leak) and stop() works", async () => {
    const storage = new InMemoryStorage()
    const config = loadConfig({ VIEWER_ADMIN_TOKEN: "secret", VIEWER_DATA_DIR: tmpViewerDataDir() })
    const stop = startOutboxDrain({ storage, email: null, config, intervalMs: 10 })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(() => stop()).not.toThrow()
  })
})

describe("resolveProjectName", () => {
  it("prefers the project name", () => {
    expect(resolveProjectName({ name: "Acme", slug: "acme" }, "30151e43-3bd4-4fcb-90cb-a04bf43218da")).toBe("Acme")
  })

  it("falls back to the slug when the project has no name", () => {
    expect(resolveProjectName({ name: "", slug: "acme" }, "30151e43-3bd4-4fcb-90cb-a04bf43218da")).toBe("acme")
  })

  it("falls back to the raw project id when the project record is gone", () => {
    expect(resolveProjectName(null, "30151e43-3bd4-4fcb-90cb-a04bf43218da")).toBe(
      "30151e43-3bd4-4fcb-90cb-a04bf43218da",
    )
  })
})

import { describe, expect, it, vi } from "vitest"

/**
 * The provider that makes GUI-editable SMTP possible.
 *
 * `createSmtpEmailProvider` is mocked because the only thing worth asserting
 * here is WHEN a transport gets built: the real one opens a nodemailer
 * connection pool, and "one pool, rebuilt only on a real change" is precisely
 * the property under test.
 */
const created: Array<Record<string, unknown>> = []
vi.mock("../smtp-email-provider", () => ({
  createSmtpEmailProvider: (config: Record<string, unknown>) => {
    created.push(config)
    return { send: async () => true }
  },
}))

const { createReloadableEmailProvider } = await import("../reloadable-email-provider")

const CONFIG = { host: "smtp.example.com", port: 587, user: "u", pass: "p", from: "f@example.com" }

describe("createReloadableEmailProvider", () => {
  it("refuses to send when nothing is configured, without building a transport", async () => {
    created.length = 0
    const provider = createReloadableEmailProvider(null)

    expect(provider.isConfigured()).toBe(false)
    expect(await provider.send("a@b.c", "s", "<p>h</p>")).toBe(false)
    expect(created).toHaveLength(0)
  })

  it("builds the transport lazily, on the first send and not before", async () => {
    created.length = 0
    const provider = createReloadableEmailProvider(CONFIG)

    // Constructing the provider must not open a connection — `index.ts` does
    // this at boot on every deployment, configured or not.
    expect(created).toHaveLength(0)

    await provider.send("a@b.c", "s", "<p>h</p>")
    await provider.send("a@b.c", "s", "<p>h</p>")

    // One transport, reused. Two would be two connection pools against one
    // SMTP server, which is what `index.ts`'s comment warns about.
    expect(created).toHaveLength(1)
  })

  it("turns on at runtime, which is the whole point", async () => {
    created.length = 0
    const provider = createReloadableEmailProvider(null)
    expect(provider.isConfigured()).toBe(false)

    provider.reconfigure(CONFIG)

    expect(provider.isConfigured()).toBe(true)
    expect(await provider.send("a@b.c", "s", "<p>h</p>")).toBe(true)
    expect(created).toHaveLength(1)
  })

  it("rebuilds the transport when the settings actually change", async () => {
    created.length = 0
    const provider = createReloadableEmailProvider(CONFIG)
    await provider.send("a@b.c", "s", "<p>h</p>")

    provider.reconfigure({ ...CONFIG, host: "smtp2.example.com" })
    await provider.send("a@b.c", "s", "<p>h</p>")

    expect(created).toHaveLength(2)
    expect(created[1]?.host).toBe("smtp2.example.com")
  })

  it("does NOT cycle the pool when re-saving identical settings", async () => {
    // Pressing Save on an unchanged form is common, and dropping a live
    // connection pool for it would be a cost with nothing bought.
    created.length = 0
    const provider = createReloadableEmailProvider(CONFIG)
    await provider.send("a@b.c", "s", "<p>h</p>")

    provider.reconfigure({ ...CONFIG })
    await provider.send("a@b.c", "s", "<p>h</p>")

    expect(created).toHaveLength(1)
  })

  it("turns off, and stops sending", async () => {
    created.length = 0
    const provider = createReloadableEmailProvider(CONFIG)
    await provider.send("a@b.c", "s", "<p>h</p>")

    provider.reconfigure(null)

    expect(provider.isConfigured()).toBe(false)
    expect(await provider.send("a@b.c", "s", "<p>h</p>")).toBe(false)
    expect(created).toHaveLength(1)
  })
})

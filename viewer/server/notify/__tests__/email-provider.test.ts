import nodemailer from "nodemailer"
import { describe, expect, it, vi } from "vitest"
import type { EmailProvider } from "../email-provider"
import { createEmailProviderForTransport, createSmtpEmailProvider } from "../smtp-email-provider"

/**
 * Recording fake — proves the EmailProvider *contract* (args shape, return
 * type) without any implementation asserting against itself. Real send
 * behavior for the SMTP impl is exercised separately below via nodemailer's
 * `jsonTransport`, which serializes instead of opening a socket.
 */
function createRecordingEmailProvider(): EmailProvider & {
  calls: Array<{ to: string; subject: string; html: string; opts?: { listUnsubscribe?: string } }>
} {
  const calls: Array<{
    to: string
    subject: string
    html: string
    opts?: { listUnsubscribe?: string }
  }> = []
  return {
    calls,
    async send(to, subject, html, opts) {
      calls.push({ to, subject, html, opts })
      return true
    },
  }
}

describe("EmailProvider contract", () => {
  it("send() resolves to a boolean and forwards all args", async () => {
    const provider = createRecordingEmailProvider()
    const result = await provider.send("a@example.com", "Subject", "<p>hi</p>", {
      listUnsubscribe: "https://viewer.example.com/unsubscribe?token=abc",
    })
    expect(typeof result).toBe("boolean")
    expect(result).toBe(true)
    expect(provider.calls).toEqual([
      {
        to: "a@example.com",
        subject: "Subject",
        html: "<p>hi</p>",
        opts: { listUnsubscribe: "https://viewer.example.com/unsubscribe?token=abc" },
      },
    ])
  })

  it("send() works without opts", async () => {
    const provider = createRecordingEmailProvider()
    const result = await provider.send("b@example.com", "Subject", "<p>hi</p>")
    expect(result).toBe(true)
    expect(provider.calls[0]?.opts).toBeUndefined()
  })
})

describe("createSmtpEmailProvider", () => {
  it("constructs an EmailProvider without opening a network connection", () => {
    const provider = createSmtpEmailProvider({
      host: "smtp.example.com",
      port: 587,
      user: "user",
      pass: "pass",
      from: "noreply@example.com",
    })
    expect(provider).toHaveProperty("send")
    expect(typeof provider.send).toBe("function")
  })
})

describe("createEmailProviderForTransport (jsonTransport)", () => {
  /**
   * The one test the module comment above claimed existed but didn't
   * (audited during OSS viewer Phase 2b-2 live acceptance). `jsonTransport`
   * serializes the fully-composed MIME message instead of opening a socket,
   * so this drives the real `send()` implementation — header mapping
   * included — through nodemailer for real, with no network I/O.
   */
  it("sends via nodemailer's jsonTransport; the captured JSON has the right from/to/subject/html and List-Unsubscribe header", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    const sendMailSpy = vi.spyOn(transport, "sendMail")
    const provider = createEmailProviderForTransport(transport, "noreply@example.com")

    const ok = await provider.send("a@example.com", "You were mentioned", "<p>hi</p>", {
      listUnsubscribe: "https://viewer.example.com/api/v1/unsubscribe?token=abc",
    })

    expect(ok).toBe(true)
    expect(sendMailSpy).toHaveBeenCalledTimes(1)
    const info = await sendMailSpy.mock.results[0]!.value
    const message = JSON.parse(info.message)
    expect(message.from).toEqual({ address: "noreply@example.com", name: "" })
    expect(message.to).toEqual([{ address: "a@example.com", name: "" }])
    expect(message.subject).toBe("You were mentioned")
    expect(message.html).toBe("<p>hi</p>")
    expect(message.headers).toEqual({
      "List-Unsubscribe": "<https://viewer.example.com/api/v1/unsubscribe?token=abc>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    })
  })

  it("omits the List-Unsubscribe headers when no listUnsubscribe option is given", async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true })
    const sendMailSpy = vi.spyOn(transport, "sendMail")
    const provider = createEmailProviderForTransport(transport, "noreply@example.com")

    const ok = await provider.send("a@example.com", "Subject", "<p>hi</p>")

    expect(ok).toBe(true)
    const info = await sendMailSpy.mock.results[0]!.value
    const message = JSON.parse(info.message)
    expect(message.headers).toEqual({})
  })
})

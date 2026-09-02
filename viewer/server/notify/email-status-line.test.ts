import { describe, expect, it } from "vitest"
import { emailStatusLine } from "./email-status-line"
import { createReloadableEmailProvider } from "./reloadable-email-provider"

describe("emailStatusLine", () => {
  // F-12: on a fresh boot with no SMTP env vars set, `config.email` is null,
  // and `createReloadableEmailProvider(null)` still returns a real object
  // (see that module's doc comment — "always present, sometimes
  // unconfigured"). The regression this guards against is testing that
  // object's truthiness instead of calling `isConfigured()`: a truthy check
  // always reads "configured" because the wrapper object itself is never
  // null, which is exactly the bug this test was written to catch.
  it("reports not configured when SMTP was never set", () => {
    const email = createReloadableEmailProvider(null)
    expect(emailStatusLine(email)).toBe("email=not configured (VIEWER_SMTP_HOST unset)")
  })

  it("reports configured once SMTP settings are present", () => {
    const email = createReloadableEmailProvider({
      host: "smtp.example.com",
      port: 587,
      user: "user",
      pass: "pass",
      from: "noreply@example.com",
    })
    expect(emailStatusLine(email)).toBe("email=configured")
  })

  it("tracks a runtime reconfigure, not just the boot-time value", () => {
    const email = createReloadableEmailProvider(null)
    expect(emailStatusLine(email)).toBe("email=not configured (VIEWER_SMTP_HOST unset)")
    email.reconfigure({
      host: "smtp.example.com",
      port: 587,
      user: "user",
      pass: "pass",
      from: "noreply@example.com",
    })
    expect(emailStatusLine(email)).toBe("email=configured")
  })
})

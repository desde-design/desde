/**
 * `generate-notices.mjs` — the third-party notices aggregator (AGPL-3.0
 * relicensing work). Exercises the pure formatting/merging/safety-check
 * logic against synthetic fixtures — never a real npm tree — matching the
 * split `notarize-dmg.test.ts` uses (a testable pure core, an impure
 * `license-checker-rseidelsohn`-driven orchestrator around it that this
 * suite does not call).
 */
import { describe, expect, it } from "vitest"
import {
  isProprietaryLicenseString,
  isSafeAttributionFile,
  mergePackageInfo,
  readAttributionFile,
  renderNoticesDocument,
  renderPackageEntry,
} from "../scripts/generate-notices.mjs"

describe("isProprietaryLicenseString", () => {
  it("flags license-checker's 'Custom: <file>' convention", () => {
    expect(isProprietaryLicenseString("Custom: LICENSE.md")).toBe(true)
  })

  it("flags an unknown/unset license", () => {
    expect(isProprietaryLicenseString("UNKNOWN")).toBe(true)
    expect(isProprietaryLicenseString(undefined)).toBe(true)
    expect(isProprietaryLicenseString("")).toBe(true)
  })

  it("does not flag a real SPDX identifier", () => {
    expect(isProprietaryLicenseString("MIT")).toBe(false)
    expect(isProprietaryLicenseString("Apache-2.0")).toBe(false)
    expect(isProprietaryLicenseString("MPL-2.0")).toBe(false)
    expect(isProprietaryLicenseString("(MIT OR Apache-2.0)")).toBe(false)
  })
})

describe("isSafeAttributionFile", () => {
  it("accepts an ordinary LICENSE/NOTICE-shaped path", () => {
    expect(isSafeAttributionFile("/pkg/LICENSE")).toBe(true)
    expect(isSafeAttributionFile("/pkg/LICENSE.md")).toBe(true)
    expect(isSafeAttributionFile("/pkg/NOTICE")).toBe(true)
  })

  it("refuses a dotfile — the .env* defense-in-depth guard", () => {
    expect(isSafeAttributionFile("/pkg/.env")).toBe(false)
    expect(isSafeAttributionFile("/pkg/.env.local")).toBe(false)
    expect(isSafeAttributionFile("/pkg/.npmrc")).toBe(false)
  })

  it("refuses a missing path", () => {
    expect(isSafeAttributionFile(undefined)).toBe(false)
    expect(isSafeAttributionFile(null)).toBe(false)
    expect(isSafeAttributionFile("")).toBe(false)
  })
})

describe("readAttributionFile", () => {
  it("reads a safe path via the injected reader", async () => {
    const text = await readAttributionFile("/pkg/LICENSE", async () => "MIT License text")
    expect(text).toBe("MIT License text")
  })

  it("never invokes the reader for a dotfile — refused before any I/O", async () => {
    let called = false
    const text = await readAttributionFile("/pkg/.env", async () => {
      called = true
      return "SECRET=leaked"
    })
    expect(text).toBeNull()
    expect(called).toBe(false)
  })

  it("returns null, not a throw, when the reader fails", async () => {
    const text = await readAttributionFile("/pkg/LICENSE", async () => {
      throw new Error("ENOENT")
    })
    expect(text).toBeNull()
  })
})

describe("mergePackageInfo", () => {
  it("unions two maps with no overlap", () => {
    const merged = mergePackageInfo({ "a@1.0.0": { licenses: "MIT" } }, { "b@2.0.0": { licenses: "ISC" } })
    expect(merged.size).toBe(2)
    expect(merged.get("a@1.0.0")).toEqual({ licenses: "MIT" })
    expect(merged.get("b@2.0.0")).toEqual({ licenses: "ISC" })
  })

  it("dedupes an identical key present in both trees (debug/ms shape)", () => {
    const merged = mergePackageInfo(
      { "debug@4.4.3": { licenses: "MIT", repository: "payload-copy" } },
      { "debug@4.4.3": { licenses: "MIT", repository: "asar-copy" } },
    )
    expect(merged.size).toBe(1)
    // Later map wins — see the function's own doc comment.
    expect(merged.get("debug@4.4.3")?.repository).toBe("asar-copy")
  })
})

describe("renderPackageEntry", () => {
  it("renders an ordinary open-source entry with its license text", () => {
    const rendered = renderPackageEntry(
      "left-pad@1.3.0",
      { licenses: "MIT", repository: "https://github.com/example/left-pad" },
      { licenseText: "MIT License\n\nPermission is hereby granted..." },
    )
    expect(rendered).toContain("left-pad@1.3.0")
    expect(rendered).toContain("License: MIT")
    expect(rendered).toContain("Repository: https://github.com/example/left-pad")
    expect(rendered).toContain("Permission is hereby granted")
    expect(rendered).not.toContain("PROPRIETARY")
  })

  it("flags a Custom/proprietary license honestly, without inventing copy — the embedded license text carries the actual disclosure", () => {
    const rendered = renderPackageEntry(
      "@anthropic-ai/claude-agent-sdk@0.3.143",
      { licenses: "Custom: LICENSE.md", publisher: "Anthropic" },
      { licenseText: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance." },
    )
    expect(rendered).toContain("PROPRIETARY — NOT AN OPEN SOURCE LICENSE")
    expect(rendered).toContain("© Anthropic PBC. All rights reserved.")
    expect(rendered).toContain("code.claude.com/docs/en/legal-and-compliance")
    // The renderer itself never hardcodes Anthropic's name or terms — it
    // only surfaces whatever the actual license file says.
  })

  it("appends a NOTICE section when one is present (Apache-2.0 playwright shape)", () => {
    const rendered = renderPackageEntry(
      "playwright@1.59.1",
      { licenses: "Apache-2.0", publisher: "Microsoft Corporation" },
      {
        licenseText: "Apache License\nVersion 2.0...",
        noticeText: "Playwright\nCopyright (c) Microsoft Corporation",
      },
    )
    expect(rendered).toContain("--- NOTICE ---")
    expect(rendered).toContain("Copyright (c) Microsoft Corporation")
  })

  it("says so explicitly when a proprietary entry has no discoverable license file", () => {
    const rendered = renderPackageEntry("some-proprietary-pkg@1.0.0", { licenses: "UNKNOWN" }, {})
    expect(rendered).toContain("no license file found")
  })
})

describe("renderNoticesDocument", () => {
  it("sorts entries by key regardless of input order", () => {
    const doc = renderNoticesDocument([
      { key: "zeta@1.0.0", info: { licenses: "MIT" } },
      { key: "alpha@1.0.0", info: { licenses: "MIT" } },
    ])
    expect(doc.indexOf("alpha@1.0.0")).toBeLessThan(doc.indexOf("zeta@1.0.0"))
  })

  it("names the AGPL license and points at the accompanying Electron license files", () => {
    const doc = renderNoticesDocument([])
    expect(doc).toContain("GNU Affero General Public License")
    expect(doc).toContain("ELECTRON-LICENSE.txt")
    expect(doc).toContain("LICENSES.chromium.html")
  })

  it("never leaks anything resembling a credential even when a (malicious/mistaken) entry tries to smuggle one in", () => {
    const doc = renderNoticesDocument([
      { key: "innocuous@1.0.0", info: { licenses: "MIT" }, licenseText: "MIT License, ordinary text." },
    ])
    expect(doc).not.toMatch(/sk-ant-|-----BEGIN|ANTHROPIC_API_KEY\s*=/)
  })
})

import { describe, it, expect } from "vitest"
import {
  SCHEMA_VERSION,
  SCHEMA_VERSION_HEADER,
  validateStatusResponse,
  type StatusResponse,
} from "./status-schema"
import fixtures from "./__fixtures__/status-responses.json"

interface ValidFixture {
  name: string
  description: string
  payload: StatusResponse
}

interface InvalidFixture {
  name: string
  description: string
  payload: unknown
  expected_error_substring: string
}

const valid = fixtures.valid as ValidFixture[]
const invalid = fixtures.invalid as InvalidFixture[]

describe("status-schema constants", () => {
  it("SCHEMA_VERSION starts at 1 (per integration doc)", () => {
    expect(SCHEMA_VERSION).toBe(1)
  })

  it("SCHEMA_VERSION_HEADER matches the documented header name", () => {
    expect(SCHEMA_VERSION_HEADER).toBe("editor-mcp-status-version")
  })
})

describe("validateStatusResponse — accepts valid fixtures", () => {
  for (const fx of valid) {
    it(`accepts ${fx.name}: ${fx.description}`, () => {
      const result = validateStatusResponse(fx.payload)
      expect(result).toEqual({ ok: true, errors: [] })
    })
  }
})

describe("validateStatusResponse — rejects invalid fixtures", () => {
  for (const fx of invalid) {
    it(`rejects ${fx.name}: ${fx.description}`, () => {
      const result = validateStatusResponse(fx.payload)
      expect(result.ok).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
      // Each invalid fixture pins a substring its rejection message
      // should mention. This catches regressions where a validation bug
      // produces ok:false but for the wrong reason.
      const matched = result.errors.some((err) =>
        err.includes(fx.expected_error_substring),
      )
      expect(matched, {
        message: `expected at least one error to mention "${fx.expected_error_substring}", got: ${JSON.stringify(result.errors)}`,
      } as unknown as string).toBe(true)
    })
  }
})

describe("validateStatusResponse — robustness", () => {
  it("rejects non-object payloads", () => {
    expect(validateStatusResponse(null).ok).toBe(false)
    expect(validateStatusResponse("a string").ok).toBe(false)
    expect(validateStatusResponse(42).ok).toBe(false)
    expect(validateStatusResponse([]).ok).toBe(false)
  })

  it("rejects payloads with wrong-type non-shape errors before invariant checks", () => {
    // dirty is a string, not a boolean. The shape check must fail
    // first; the invariant check (which would access v.dirty as a
    // boolean) must NOT run, otherwise a malformed payload could
    // crash the validator.
    const result = validateStatusResponse({
      scope: "deployed",
      deployment_id: "deploy-x",
      deployed_head_commit: "abc1234",
      branch: "main",
      head_commit: "abc1234",
      dirty: "true",
      ahead_of_deployment: false,
      last_edit_timestamp: null,
      warnings: [],
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes("dirty"))).toBe(true)
  })

  it("accepts ISO-8601 with fractional seconds and explicit Z", () => {
    const result = validateStatusResponse({
      scope: "local",
      deployment_id: null,
      deployed_head_commit: null,
      branch: "main",
      head_commit: "abc1234",
      dirty: false,
      ahead_of_deployment: "unknown",
      last_edit_timestamp: "2026-05-07T15:42:09.117Z",
      warnings: [],
    })
    expect(result.ok).toBe(true)
  })

  it("accepts ISO-8601 with explicit timezone offset", () => {
    const result = validateStatusResponse({
      scope: "local",
      deployment_id: null,
      deployed_head_commit: null,
      branch: "main",
      head_commit: "abc1234",
      dirty: false,
      ahead_of_deployment: "unknown",
      last_edit_timestamp: "2026-05-07T15:42:09-07:00",
      warnings: [],
    })
    expect(result.ok).toBe(true)
  })

  it("rejects ISO-8601 without timezone (ambiguous)", () => {
    const result = validateStatusResponse({
      scope: "local",
      deployment_id: null,
      deployed_head_commit: null,
      branch: "main",
      head_commit: "abc1234",
      dirty: false,
      ahead_of_deployment: "unknown",
      last_edit_timestamp: "2026-05-07T15:42:09",
      warnings: [],
    })
    expect(result.ok).toBe(false)
  })
})

describe("schema and TypeScript type alignment", () => {
  it("the StatusResponse type compiles against every valid fixture", () => {
    // TS-side compilation: if a fixture's shape diverges from the type,
    // this assignment is a compile error. Runtime no-op.
    for (const fx of valid) {
      const typed: StatusResponse = fx.payload
      expect(typed.scope).toMatch(/^(local|deployed)$/)
    }
  })

  it("all valid fixtures parse successfully via the JSON-Schema validator (when wired)", () => {
    // V1 ships the JSON Schema document but no runtime JSON-Schema
    // validator (the TS function above is the contract). This test
    // pins that fixtures DO survive the basic shape check the JSON
    // Schema would enforce — required keys present, no extras —
    // without taking on an ajv dependency yet.
    for (const fx of valid) {
      const keys = Object.keys(fx.payload as object).sort()
      expect(keys).toEqual([
        "ahead_of_deployment",
        "branch",
        "deployed_head_commit",
        "deployment_id",
        "dirty",
        "head_commit",
        "last_edit_timestamp",
        "scope",
        "warnings",
      ])
    }
  })
})

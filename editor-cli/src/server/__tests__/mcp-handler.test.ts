import { afterEach, describe, expect, it } from "vitest"
import type { ServerResponse } from "node:http"
import { _resetGitStatusCacheForTests } from "../git-ops.js"
import { handleStatusQuery, type McpHandlerContext } from "../mcp-handler.js"
import {
  SCHEMA_VERSION,
  SCHEMA_VERSION_HEADER,
  validateStatusResponse,
  type StatusResponse,
} from "../../../../src/editor/mcp/status-schema.js"

afterEach(() => {
  _resetGitStatusCacheForTests()
})

/**
 * Minimal `ServerResponse` shim — captures status, headers, and body
 * so tests can assert on the wire shape without a real HTTP server.
 */
class FakeRes {
  statusCode = 200
  headers: Record<string, string> = {}
  body = ""
  setHeader(name: string, value: string | number | readonly string[]): void {
    this.headers[name.toLowerCase()] = String(value)
  }
  end(payload: string): void {
    this.body = payload
  }
}

function asServerResponse(res: FakeRes): ServerResponse {
  return res as unknown as ServerResponse
}

const TS = "2026-05-04T22:18:31Z"

const cleanGitSpawn = (head: string, branch: string) => async (
  _cwd: string,
  args: readonly string[],
) => {
  const key = args.join(" ")
  if (key === "rev-parse --short HEAD") return { exitCode: 0, stdout: head, stderr: "" }
  if (key === "rev-parse --abbrev-ref HEAD") return { exitCode: 0, stdout: branch, stderr: "" }
  if (key === "status --porcelain") return { exitCode: 0, stdout: "", stderr: "" }
  if (key === "log -1 --format=%cI HEAD") return { exitCode: 0, stdout: `${TS}\n`, stderr: "" }
  throw new Error(`unexpected git args: ${key}`)
}

const dirtyGitSpawn = (head: string, branch: string) => async (
  _cwd: string,
  args: readonly string[],
) => {
  const key = args.join(" ")
  if (key === "rev-parse --short HEAD") return { exitCode: 0, stdout: head, stderr: "" }
  if (key === "rev-parse --abbrev-ref HEAD") return { exitCode: 0, stdout: branch, stderr: "" }
  if (key === "status --porcelain") return { exitCode: 0, stdout: " M file.vue\n", stderr: "" }
  if (key === "log -1 --format=%cI HEAD") return { exitCode: 0, stdout: `${TS}\n`, stderr: "" }
  throw new Error(`unexpected git args: ${key}`)
}

describe("handleStatusQuery — basic shape", () => {
  it("returns a valid StatusResponse with the SCHEMA_VERSION header on a clean tree (no platform integration)", async () => {
    const res = new FakeRes()
    const ctx: McpHandlerContext = {
      repoRoot: "/tmp/repo",
      gitOptions: { spawnFn: cleanGitSpawn("abc1234\n", "main\n"), noCache: true },
    }
    await handleStatusQuery(asServerResponse(res), ctx)

    expect(res.statusCode).toBe(200)
    expect(res.headers[SCHEMA_VERSION_HEADER]).toBe(String(SCHEMA_VERSION))
    expect(res.headers["content-type"]).toMatch(/application\/json/)
    expect(res.headers["cache-control"]).toBe("no-store")

    const payload = JSON.parse(res.body) as StatusResponse
    expect(payload.scope).toBe("local")
    expect(payload.dirty).toBe(false)
    expect(payload.branch).toBe("main")
    expect(payload.head_commit).toBe("abc1234")
    expect(payload.deployment_id).toBeNull()
    expect(payload.deployed_head_commit).toBeNull()
    expect(payload.ahead_of_deployment).toBe("unknown")
    expect(payload.warnings).toEqual([
      'Desde deployment lookup is not implemented. ahead_of_deployment always reports "unknown".',
    ])

    const validation = validateStatusResponse(payload)
    expect(validation.ok).toBe(true)
  })

  it("deployment_id / ahead_of_deployment stay null/'unknown' (no deployment-lookup integration exists)", async () => {
    const res = new FakeRes()
    await handleStatusQuery(asServerResponse(res), {
      repoRoot: "/tmp/repo",
      gitOptions: { spawnFn: cleanGitSpawn("abc1234\n", "main\n"), noCache: true },
    })
    const payload = JSON.parse(res.body) as StatusResponse
    expect(payload.deployment_id).toBeNull()
    expect(payload.deployed_head_commit).toBeNull()
    expect(payload.ahead_of_deployment).toBe("unknown")
    expect(
      payload.warnings.some((w) => w.includes("deployment lookup is not implemented")),
    ).toBe(true)
    expect(validateStatusResponse(payload).ok).toBe(true)
  })
})

describe("handleStatusQuery — git-side state", () => {
  it("dirty tree → ahead_of_deployment 'unknown' (no deployment), schema valid", async () => {
    const res = new FakeRes()
    await handleStatusQuery(asServerResponse(res), {
      repoRoot: "/tmp/repo",
      gitOptions: { spawnFn: dirtyGitSpawn("abc1234\n", "main\n"), noCache: true },
    })
    const payload = JSON.parse(res.body) as StatusResponse
    expect(payload.dirty).toBe(true)
    // Without deployment data the comparison is undefined → "unknown".
    expect(payload.ahead_of_deployment).toBe("unknown")
    expect(validateStatusResponse(payload).ok).toBe(true)
  })

  it("detached HEAD → branch null, surfaces 'local is detached-HEAD' warning", async () => {
    const res = new FakeRes()
    await handleStatusQuery(asServerResponse(res), {
      repoRoot: "/tmp/repo",
      gitOptions: {
        spawnFn: cleanGitSpawn("abc1234\n", "HEAD\n"),
        noCache: true,
      },
    })
    const payload = JSON.parse(res.body) as StatusResponse
    expect(payload.branch).toBeNull()
    expect(payload.head_commit).toBe("abc1234")
    expect(payload.warnings).toContain("local is detached-HEAD")
    expect(payload.ahead_of_deployment).toBe("unknown")
    expect(validateStatusResponse(payload).ok).toBe(true)
  })

  it("unborn HEAD → head_commit null, ahead_of_deployment 'unknown'", async () => {
    const res = new FakeRes()
    await handleStatusQuery(asServerResponse(res), {
      repoRoot: "/tmp/repo",
      gitOptions: {
        spawnFn: async (_cwd, args) => {
          const key = args.join(" ")
          if (key === "rev-parse --short HEAD") {
            return {
              exitCode: 128,
              stdout: "",
              stderr: "fatal: ambiguous argument 'HEAD'\n",
            }
          }
          if (key === "rev-parse --abbrev-ref HEAD") {
            return {
              exitCode: 128,
              stdout: "",
              stderr: "fatal: ambiguous argument 'HEAD'\n",
            }
          }
          if (key === "symbolic-ref --short HEAD") {
            return { exitCode: 0, stdout: "main\n", stderr: "" }
          }
          if (key === "status --porcelain") {
            return { exitCode: 0, stdout: "?? README.md\n", stderr: "" }
          }
          if (key === "log -1 --format=%cI HEAD") {
            return { exitCode: 128, stdout: "", stderr: "fatal: no commits\n" }
          }
          throw new Error(`unexpected: ${key}`)
        },
        noCache: true,
      },
    })
    const payload = JSON.parse(res.body) as StatusResponse
    expect(payload.head_commit).toBeNull()
    expect(payload.branch).toBe("main")
    expect(payload.dirty).toBe(true)
    expect(payload.ahead_of_deployment).toBe("unknown")
    expect(validateStatusResponse(payload).ok).toBe(true)
  })

  it("git error → warnings include the error, response still valid", async () => {
    const res = new FakeRes()
    await handleStatusQuery(asServerResponse(res), {
      repoRoot: "/tmp/repo",
      gitOptions: {
        spawnFn: async (_cwd, args) => {
          const key = args.join(" ")
          if (key === "status --porcelain") {
            return {
              exitCode: 128,
              stdout: "",
              stderr: "fatal: not a git repository\n",
            }
          }
          if (key === "rev-parse --short HEAD") {
            return { exitCode: 0, stdout: "abc1234\n", stderr: "" }
          }
          if (key === "rev-parse --abbrev-ref HEAD") {
            return { exitCode: 0, stdout: "main\n", stderr: "" }
          }
          if (key === "log -1 --format=%cI HEAD") {
            return { exitCode: 0, stdout: `${TS}\n`, stderr: "" }
          }
          throw new Error(`unexpected: ${key}`)
        },
        noCache: true,
      },
    })
    const payload = JSON.parse(res.body) as StatusResponse
    expect(payload.warnings.some((w) => w.startsWith("git:"))).toBe(true)
    // The response is still a valid local-scope payload, even with the
    // git error — that's the graceful-degrade contract.
    expect(validateStatusResponse(payload).ok).toBe(true)
  })
})

describe("handleStatusQuery — last_edit_timestamp semantics", () => {
  it("uses local commit timestamp from git", async () => {
    // Regression guard: an earlier impl (when a deployment-lookup
    // integration still existed) assigned the deployment timestamp to
    // last_edit_timestamp on the LOCAL scope, which is semantically
    // wrong (the spec says local reports its own most-recent commit OR
    // uncommitted save). That integration is gone — see the
    // McpHandlerContext docstring — but the LOCAL-scope semantics this
    // guards still apply.
    const localCommitTs = "2026-05-07T12:00:00Z"
    const res = new FakeRes()
    await handleStatusQuery(asServerResponse(res), {
      repoRoot: "/tmp/repo",
      gitOptions: {
        spawnFn: async (_cwd, args) => {
          const key = args.join(" ")
          if (key === "rev-parse --short HEAD") return { exitCode: 0, stdout: "abc1234\n", stderr: "" }
          if (key === "rev-parse --abbrev-ref HEAD") return { exitCode: 0, stdout: "main\n", stderr: "" }
          if (key === "status --porcelain") return { exitCode: 0, stdout: "", stderr: "" }
          if (key === "log -1 --format=%cI HEAD") return { exitCode: 0, stdout: `${localCommitTs}\n`, stderr: "" }
          throw new Error(`unexpected: ${key}`)
        },
        noCache: true,
      },
    })
    const payload = JSON.parse(res.body) as StatusResponse
    expect(payload.last_edit_timestamp).toBe(localCommitTs)
    expect(validateStatusResponse(payload).ok).toBe(true)
  })

  it("reports null timestamp on unborn HEAD (no commits to draw a timestamp from)", async () => {
    const res = new FakeRes()
    await handleStatusQuery(asServerResponse(res), {
      repoRoot: "/tmp/repo",
      gitOptions: {
        spawnFn: async (_cwd, args) => {
          const key = args.join(" ")
          if (key === "rev-parse --short HEAD")
            return { exitCode: 128, stdout: "", stderr: "fatal: ambiguous argument 'HEAD'\n" }
          if (key === "rev-parse --abbrev-ref HEAD")
            return { exitCode: 128, stdout: "", stderr: "fatal: ambiguous argument 'HEAD'\n" }
          if (key === "symbolic-ref --short HEAD") return { exitCode: 0, stdout: "main\n", stderr: "" }
          if (key === "status --porcelain") return { exitCode: 0, stdout: "", stderr: "" }
          if (key === "log -1 --format=%cI HEAD")
            return { exitCode: 128, stdout: "", stderr: "fatal: no commits\n" }
          throw new Error(`unexpected: ${key}`)
        },
        noCache: true,
      },
    })
    const payload = JSON.parse(res.body) as StatusResponse
    expect(payload.last_edit_timestamp).toBeNull()
    expect(validateStatusResponse(payload).ok).toBe(true)
  })
})

// There is no deployment-lookup integration (see the McpHandlerContext
// docstring in mcp-handler.ts) — these tests guard that the handler
// stays honest about it (always null/"unknown", never a stale or
// fabricated deployment) across the git-state matrix that used to
// exercise the platform call.
describe("handleStatusQuery — no deployment-lookup integration", () => {
  it("clean tree, matching-looking state still reports deployment_id null / ahead_of_deployment 'unknown'", async () => {
    const res = new FakeRes()
    await handleStatusQuery(asServerResponse(res), {
      repoRoot: "/tmp/repo",
      gitOptions: { spawnFn: cleanGitSpawn("abc1234\n", "main\n"), noCache: true },
    })
    const payload = JSON.parse(res.body) as StatusResponse
    expect(payload.deployment_id).toBeNull()
    expect(payload.deployed_head_commit).toBeNull()
    expect(payload.ahead_of_deployment).toBe("unknown")
    expect(
      payload.warnings.some((w) => w.includes("deployment lookup is not implemented")),
    ).toBe(true)
    expect(validateStatusResponse(payload).ok).toBe(true)
  })

  it("dirty tree still reports deployment_id null / ahead_of_deployment 'unknown', not 'true'", async () => {
    const res = new FakeRes()
    await handleStatusQuery(asServerResponse(res), {
      repoRoot: "/tmp/repo",
      gitOptions: { spawnFn: dirtyGitSpawn("abc1234\n", "main\n"), noCache: true },
    })
    const payload = JSON.parse(res.body) as StatusResponse
    expect(payload.dirty).toBe(true)
    expect(payload.deployment_id).toBeNull()
    expect(payload.ahead_of_deployment).toBe("unknown")
    expect(validateStatusResponse(payload).ok).toBe(true)
  })

  it("detached HEAD still reports deployment_id null / ahead_of_deployment 'unknown'", async () => {
    const res = new FakeRes()
    await handleStatusQuery(asServerResponse(res), {
      repoRoot: "/tmp/repo",
      gitOptions: { spawnFn: cleanGitSpawn("abc1234\n", "HEAD\n"), noCache: true },
    })
    const payload = JSON.parse(res.body) as StatusResponse
    expect(payload.branch).toBeNull()
    expect(payload.deployment_id).toBeNull()
    expect(payload.warnings).toContain("local is detached-HEAD")
    expect(validateStatusResponse(payload).ok).toBe(true)
  })
})

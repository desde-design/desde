import { accessSync, constants as fsConstants, existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname } from "node:path"
import {
  claudeAgentSdkPackageName,
  claudeAgentSdkPlatformCandidates,
  readInstalledClaudeAgentSdkVersion,
  resolveClaudeExecutablePathIn,
  resolveClaudeRuntimeDir,
} from "../../../src/editor/llm-providers/claude-runtime-location.js"

/**
 * Rung 3 of the credential ladder: is a `claude` runtime present at all?
 *
 * **This is a presence check, deliberately not an auth check and deliberately
 * not a verification.** It answers "could this user plausibly be on the
 * subscription path", which is the question that decides whether to open the
 * first-run dialog. It does NOT answer "is the binary authentic" (that is
 * `resolveClaudeExecutablePath`'s job at spawn time) and it does NOT answer
 * "is the login still valid" (an expired login still reads as present here,
 * and is handled at runtime by `AUTH_REAUTH_MESSAGE`).
 *
 * **Why not just call `resolveClaudeExecutablePath`.** That function
 * sha256-hashes the ~198MB binary on EVERY call, by design, because its answer
 * feeds a `spawn()`. This runs on a status GET that the settings menu issues
 * on mount, so hashing here would put a multi-hundred-megabyte digest on a
 * page load. Presence is all this rung needs.
 *
 * Erring toward "present" is the correct bias. A false negative prompts
 * someone who did not need prompting, which is the annoying failure; a false
 * positive stays silent and the user still reaches the settings gear through
 * the 401 message.
 */
/** Same check `resolveClaudeExecutablePath` applies to the override. */
function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export function isClaudeRuntimeResolvable(
  env: NodeJS.ProcessEnv = process.env,
  resolveFrom: string = import.meta.url,
): boolean {
  const appSupportDir = env.EDITOR_CLAUDE_RUNTIME_DIR

  // Desktop (Desde): the runtime is fetched on first use into a version-keyed
  // directory outside the app bundle, so before that fetch there is genuinely
  // nothing to authenticate with. This is the population the first-run dialog
  // exists for.
  if (appSupportDir) {
    let sdkVersion: string
    try {
      sdkVersion = readInstalledClaudeAgentSdkVersion(resolveFrom)
    } catch {
      return false
    }
    const runtimeDir = resolveClaudeRuntimeDir({ appSupportDir, sdkVersion })
    return existsSync(
      resolveClaudeExecutablePathIn({ runtimeDir, platform: process.platform }),
    )
  }

  // Terminal: the documented escape hatch wins first, mirroring
  // `resolveClaudeExecutablePath` exactly — including that the override is
  // honoured ONLY outside the desktop app, where every binary must come
  // through the verified well-known path. A user who set it because the
  // optional platform packages were omitted has a working runtime, and the
  // package scan below would have reported them uncredentialed.
  const override = env.EDITOR_CLAUDE_EXECUTABLE_PATH
  if (override && isExecutableFile(override)) return true

  // Otherwise: the SDK resolves its own platform package from `node_modules`.
  //
  // Resolve the package's `package.json`, NOT the bare package name. The
  // platform packages are binary-only — measured on
  // `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.143`, the manifest has
  // no `main` and no `exports`, only `"files": ["claude", …]`. So
  // `require.resolve("@anthropic-ai/claude-agent-sdk-darwin-arm64")` throws
  // even when the package is installed and the binary is right there. An
  // earlier version of this function did exactly that and reported `false`
  // for every terminal user, which would have fired the first-run dialog at
  // subscription users on every launch.
  //
  // A manifest with no `exports` permits `pkg/package.json` subpath
  // resolution, which is what makes this work.
  const require = createRequire(resolveFrom)
  return claudeAgentSdkPlatformCandidates(process.platform, process.arch).some(
    (suffix) => {
      try {
        const manifest = require.resolve(
          `${claudeAgentSdkPackageName(suffix)}/package.json`,
        )
        return existsSync(
          resolveClaudeExecutablePathIn({
            runtimeDir: dirname(manifest),
            platform: process.platform,
          }),
        )
      } catch {
        return false
      }
    },
  )
}

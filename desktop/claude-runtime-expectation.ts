/**
 * Reads the integrity EXPECTATION the claude-runtime installer verifies its
 * download against — the F1 fix's trust anchor.
 *
 * **Why the payload's `package-lock.json`.** `pacote` alone validates the
 * downloaded tarball against the `dist.integrity` the registry response
 * itself supplies — the same party serves both halves, so a compromised
 * registry (or a TLS-intercepting enterprise proxy) can alter metadata and
 * tarball together and still "validate". The independent anchor has to be
 * recorded at BUILD time and shipped inside the app: the staged payload's
 * lockfile (written by `npm install` during `tasks/scripts/
 * build-server-package.mts`'s staging step) records npm's sha512 `integrity`
 * for every `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` variant at
 * the exact pinned version, and the whole payload ships inside the signed,
 * notarized bundle at `Resources/server/` (electron-builder's
 * `extraResources` mapping — the lockfile is covered by macOS's code-signing
 * resource seal). Tampering with the expectation therefore means breaking
 * Apple's signature. The registry can no longer vouch for itself.
 *
 * **Honest boundary:** this anchors the DOWNLOAD to the build. It does not
 * defend against a compromised build machine — the machine that runs
 * `npm install` during staging records whatever it was served, and no
 * runtime control can reach back past that. (It also doesn't verify
 * Anthropic's own supply chain; the anchor pins "the bytes the build saw",
 * which is exactly the property a substitution-at-install-time attack
 * violates.)
 *
 * Fail closed on every branch: a missing lockfile, a missing entry, a
 * version mismatch, or a malformed SRI all THROW — the caller
 * (`main.ts`) turns that into a controller that refuses to install rather
 * than installing unverified. An unverifiable binary is never downloaded,
 * let alone spawned.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { isWellFormedSri } from "../src/editor/llm-providers/claude-runtime-verify.js"

export interface ResolveAnchorPayloadDirInput {
  /** The payload `main.ts` will actually RUN — possibly a `--payload`/env override. */
  payloadRoot: string
  /** `process.resourcesPath` when `app.isPackaged`, `null` otherwise — same convention as `resolvePayloadRoot` (payload-resolve.ts). */
  packagedResourcesPath: string | null
}

/**
 * Which directory the integrity EXPECTATION may be read from. The answer is
 * NOT always the payload being run: in a packaged build, `--payload` /
 * `DESDE_DESKTOP_PAYLOAD` can point `resolvePayloadRoot` at a
 * caller-controlled directory (a deliberate QA affordance), and an anchor
 * read from there would be an anchor read from an UNSIGNED copy — anyone
 * able to influence startup could copy the payload, rewrite one SRI, and a
 * colluding registry serves matching bytes while the app's signature stays
 * intact, because nothing inside the bundle changed. The anchor's entire
 * value is its provenance, so:
 *
 *  - **Packaged app: the anchor ALWAYS comes from
 *    `<resourcesPath>/server`** — the copy under the code-signing resource
 *    seal — regardless of which payload is being run. A QA payload override
 *    still works when its SDK version matches the shipped one (same
 *    version → same expectation, vouched for by the signature);
 *    a different version fails the reader's version check and the install
 *    is refused, which is correct: a packaged app must not download binary
 *    versions its signed build never vouched for.
 *  - **Dev (unpackaged): the payload being run is the only copy there is**
 *    — nothing is signed, and the developer controls the whole machine.
 *
 * Pure so it is unit-testable (main.ts, which imports `electron`, is not).
 */
export function resolveAnchorPayloadDir(input: ResolveAnchorPayloadDirInput): string {
  if (input.packagedResourcesPath !== null) {
    return join(input.packagedResourcesPath, "server")
  }
  return input.payloadRoot
}

export interface ReadClaudeRuntimeExpectedIntegrityInput {
  /** The resolved payload root (`main.ts`'s `payloadRoot`) — `package-lock.json` must sit at its top level. */
  payloadDir: string
  /** The full platform package name, e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64` — computed by the caller with the SAME `claudeAgentSdkPlatformCandidates`/`claudeAgentSdkPackageName` helpers the installer uses. */
  packageName: string
  /** The exact SDK version the payload ships — the lockfile entry must record this same version, or the expectation does not apply and this throws. */
  sdkVersion: string
}

interface LockfilePackagesEntry {
  version?: unknown
  integrity?: unknown
}

/**
 * Returns the sha512 SRI string recorded in the signed payload's lockfile
 * for `packageName@sdkVersion`. Throws (with a message precise enough to
 * diagnose a broken build) rather than returning anything unverifiable.
 */
export function readClaudeRuntimeExpectedIntegrity(
  input: ReadClaudeRuntimeExpectedIntegrityInput,
): string {
  const lockfilePath = join(input.payloadDir, "package-lock.json")

  let raw: string
  try {
    raw = readFileSync(lockfilePath, "utf8")
  } catch (err) {
    throw new Error(
      `cannot read the payload lockfile at ${lockfilePath} — without it there is no integrity ` +
        `expectation to verify the claude runtime download against, so the install is refused. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(
      `the payload lockfile at ${lockfilePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const packages = (parsed as { packages?: unknown } | null)?.packages
  if (typeof packages !== "object" || packages === null) {
    throw new Error(`the payload lockfile at ${lockfilePath} has no "packages" map (lockfileVersion too old?)`)
  }

  const entryKey = `node_modules/${input.packageName}`
  const entry = (packages as Record<string, LockfilePackagesEntry | undefined>)[entryKey]
  if (entry === undefined) {
    throw new Error(
      `the payload lockfile at ${lockfilePath} has no entry for "${entryKey}" — cannot anchor the ` +
        `claude runtime download for this platform`,
    )
  }

  if (entry.version !== input.sdkVersion) {
    throw new Error(
      `the payload lockfile records ${input.packageName}@${String(entry.version)} but the installed SDK ` +
        `is ${input.sdkVersion} — the recorded expectation does not apply to the version that would be ` +
        `downloaded, so the install is refused`,
    )
  }

  if (typeof entry.integrity !== "string" || !isWellFormedSri(entry.integrity)) {
    throw new Error(
      `the payload lockfile's entry for "${entryKey}" carries no well-formed "integrity" value — ` +
        `refusing to download a binary there would be no way to verify`,
    )
  }

  return entry.integrity
}

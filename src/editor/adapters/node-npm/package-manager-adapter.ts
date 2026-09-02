/**
 * Node/npm impl of {@link PackageManagerAdapter}. Auto-detects the
 * user's package manager via the same lockfile signals as the
 * verification adapter (`detectNodePackageManager`).
 *
 * `applyManifestOp` is pure — it parses package.json, mutates the
 * dependencies/devDependencies object in place, and re-serializes
 * with the original indentation. No I/O.
 *
 * `install` runs the resolved package manager's install command
 * (no args). Mirrors the verification adapter's child-process shape
 * so the two can share the same `VerificationRunResult` type.
 */

import { execFile } from 'node:child_process'

import type {
  ApplyManifestOpResult,
  PackageManagerAdapter,
  PackageOp,
} from '../../core/package-manager-adapter'
import type { VerificationRunResult } from '../../core/verification-adapter'
import {
  VERIFICATION_OUTPUT_MAX_BYTES,
  VERIFICATION_TIMEOUT_MS,
} from '../../core/verification-adapter'

import { detectNodePackageManager, type NodePackageManager } from './verification-adapter'

interface BuildOpts {
  repoRoot: string
  /** Override the auto-detected package manager (tests use this). */
  packageManager?: NodePackageManager
}

/**
 * The dependency key on the package.json manifest. Add ops without
 * `dev` land in `dependencies`; with `dev: true` they land in
 * `devDependencies`. Remove ops scan both.
 */
const DEP_FIELD = 'dependencies' as const
const DEV_DEP_FIELD = 'devDependencies' as const

/**
 * NPM-compatible package-name regex (per the spec). Used to refuse
 * obviously-malformed input before we string-splice into JSON.
 * Permits leading `@` for scoped packages.
 */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9-_.]+\/)?[a-z0-9][a-z0-9-_.]*$/i

/**
 * Registry-resolvable version specs only: semver ranges, comparators, wildcards
 * and dist-tags. The character class excludes `:` and `/`, which is what
 * actually rules out `git+ssh://`, `file:`, `http://`, `npm:` aliases and
 * `user/repo` shorthands — every spec form that fetches code from somewhere
 * other than the registry entry for the validated package name.
 */
const VERSION_SPEC_RE = /^[a-zA-Z0-9^~><=.\-+*|\s]{1,64}$/

/**
 * Detect the original file's indentation (2 spaces, 4 spaces, tabs).
 * Falls back to 2 spaces when the file has no nested structure to
 * sample. Stays byte-stable for files that already round-trip cleanly.
 */
function detectIndent(src: string): string {
  const m = src.match(/^([ \t]+)/m)
  if (m && m[1].length > 0) return m[1]
  return '  '
}

/**
 * Whether the original file ended with a trailing newline. We preserve
 * the original convention so git diffs stay minimal.
 */
function hadTrailingNewline(src: string): boolean {
  return src.endsWith('\n')
}

export function applyManifestOp(
  manifestSrc: string,
  op: PackageOp,
): ApplyManifestOpResult {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(manifestSrc) as Record<string, unknown>
  } catch (err) {
    return { ok: false, reason: `package.json is not valid JSON: ${(err as Error).message}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'package.json must be a JSON object' }
  }
  if (!PACKAGE_NAME_RE.test(op.packageName)) {
    return { ok: false, reason: `invalid package name: ${JSON.stringify(op.packageName)}` }
  }

  if (op.kind === 'add') {
    const targetField = op.dev ? DEV_DEP_FIELD : DEP_FIELD
    const target = (parsed[targetField] as Record<string, unknown> | undefined) ?? {}
    const newSpec = op.versionSpec ?? 'latest'
    // The version spec is written verbatim into package.json and then
    // resolved by `npm install`, so npm's own spec grammar is the attack
    // surface, not ours: `git+ssh://…`, `file:../…`, `http://…/x.tgz`,
    // `user/repo#branch` and `npm:other-pkg@1` all install code from a source
    // that has nothing to do with the package NAME we validated above. Only
    // registry-resolvable range/tag syntax is allowed. (Audit S9.)
    if (!VERSION_SPEC_RE.test(newSpec)) {
      return {
        ok: false,
        reason:
          `invalid version spec ${JSON.stringify(newSpec)}: only semver ranges and dist-tags ` +
          `are allowed (e.g. "^1.2.3", "~1.2", "1.x", ">=1 <2", "latest"). URL, git, file and ` +
          `npm-alias specs install code from outside the registry and are refused.`,
      }
    }
    // No-op refusal: same dep already exists at the same version-spec
    // in the same field. We do NOT block "exists in the OTHER field
    // already" — moving a dep from dependencies to devDependencies (or
    // vice-versa) is a legitimate op and yields a real diff.
    if (target[op.packageName] === newSpec) {
      return {
        ok: false,
        reason: `${op.packageName} is already in ${targetField} at "${newSpec}"; nothing to do`,
      }
    }
    const next = { ...target, [op.packageName]: newSpec }
    // Sort alphabetically — both npm and pnpm rewrite the dep blocks
    // sorted on install, so matching that convention now keeps the
    // diff stable across a follow-up `install` call.
    const sortedNext = Object.fromEntries(
      Object.entries(next).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    )
    const updated: Record<string, unknown> = { ...parsed, [targetField]: sortedNext }
    // If we just moved a dep from one field to the other, remove it
    // from the source field to avoid duplicate entries.
    if (op.dev) {
      const deps = updated[DEP_FIELD] as Record<string, unknown> | undefined
      if (deps && Object.prototype.hasOwnProperty.call(deps, op.packageName)) {
        const stripped = { ...deps }
        delete stripped[op.packageName]
        updated[DEP_FIELD] = stripped
      }
    } else {
      const devDeps = updated[DEV_DEP_FIELD] as Record<string, unknown> | undefined
      if (devDeps && Object.prototype.hasOwnProperty.call(devDeps, op.packageName)) {
        const stripped = { ...devDeps }
        delete stripped[op.packageName]
        updated[DEV_DEP_FIELD] = stripped
      }
    }
    return { ok: true, newSrc: stringifyManifest(updated, manifestSrc) }
  }

  // remove
  const deps = parsed[DEP_FIELD] as Record<string, unknown> | undefined
  const devDeps = parsed[DEV_DEP_FIELD] as Record<string, unknown> | undefined
  const inDeps = deps && Object.prototype.hasOwnProperty.call(deps, op.packageName)
  const inDevDeps =
    devDeps && Object.prototype.hasOwnProperty.call(devDeps, op.packageName)
  if (!inDeps && !inDevDeps) {
    return {
      ok: false,
      reason: `${op.packageName} not found in dependencies or devDependencies`,
    }
  }
  const updated: Record<string, unknown> = { ...parsed }
  if (inDeps) {
    const stripped = { ...(deps as Record<string, unknown>) }
    delete stripped[op.packageName]
    updated[DEP_FIELD] = stripped
  }
  if (inDevDeps) {
    const stripped = { ...(devDeps as Record<string, unknown>) }
    delete stripped[op.packageName]
    updated[DEV_DEP_FIELD] = stripped
  }
  return { ok: true, newSrc: stringifyManifest(updated, manifestSrc) }
}

function stringifyManifest(value: unknown, original: string): string {
  const indent = detectIndent(original)
  const body = JSON.stringify(value, null, indent)
  return hadTrailingNewline(original) ? body + '\n' : body
}

function clipOutput(buf: string): string {
  if (buf.length <= VERIFICATION_OUTPUT_MAX_BYTES) return buf
  return `…[truncated ${buf.length - VERIFICATION_OUTPUT_MAX_BYTES} leading bytes]\n` +
    buf.slice(buf.length - VERIFICATION_OUTPUT_MAX_BYTES)
}

export function createNodePackageManagerAdapter(
  opts: BuildOpts,
): PackageManagerAdapter {
  const pm = opts.packageManager ?? detectNodePackageManager(opts.repoRoot)
  const installArgs = installArgsFor(pm)
  return {
    substrateLabel: pm,
    applyManifestOp,
    async install(runOpts): Promise<VerificationRunResult> {
      const start = Date.now()
      return await new Promise<VerificationRunResult>((resolve) => {
        const child = execFile(
          pm,
          installArgs,
          {
            cwd: opts.repoRoot,
            maxBuffer: VERIFICATION_OUTPUT_MAX_BYTES * 4,
            timeout: VERIFICATION_TIMEOUT_MS,
            signal: runOpts?.signal,
            env: { ...installEnv(), FORCE_COLOR: '0', NO_COLOR: '1' },
          },
          (err, stdout, stderr) => {
            const durationMs = Date.now() - start
            const stdoutStr = clipOutput(stdout?.toString() ?? '')
            const stderrStr = clipOutput(stderr?.toString() ?? '')
            const cmd = `${pm} ${installArgs.join(' ')}`
            if (err) {
              const e = err as NodeJS.ErrnoException & {
                code?: number | string
                signal?: NodeJS.Signals
                killed?: boolean
              }
              const aborted = e.name === 'AbortError'
              const timedOut =
                e.killed === true && (e.signal === 'SIGTERM' || e.code === null)
              resolve({
                ok: false,
                exitCode: typeof e.code === 'number' ? e.code : -1,
                stdout: stdoutStr,
                stderr: stderrStr.length > 0 ? stderrStr : e.message,
                durationMs,
                command: cmd,
                aborted: aborted || undefined,
                timedOut: timedOut || undefined,
              })
              return
            }
            resolve({
              ok: true,
              exitCode: 0,
              stdout: stdoutStr,
              stderr: stderrStr,
              durationMs,
              command: cmd,
            })
          },
        )
        void child
      })
    },
  }
}

function installArgsFor(_pm: NodePackageManager): string[] {
  // Plain `install` matches the user's expectation for all three
  // package managers and updates lockfile + node_modules to match
  // package.json. We deliberately do NOT pass --no-audit, --silent,
  // etc. — defaults preserve whatever the user already has in
  // npmrc/yarnrc/pnpmrc.
  //
  // `--ignore-scripts` IS passed, and it is the exception to that rule.
  // This adapter's `install` has exactly one caller: the agent's
  // `manage_package` tool (fs-structural-tools.ts). It is never the user
  // typing `npm install`. A newly-added dependency's `postinstall` would
  // otherwise run arbitrary code as the developer the moment a prompt-injected
  // agent added the package — the last step of the chain the rest of this
  // security pass closes, and the one that needs no file write at all.
  //
  // The cost is real and deliberate: packages that fetch a platform binary in
  // postinstall (esbuild, sharp, playwright) will be incompletely installed
  // until the user runs their own install. That is a visible, recoverable
  // state, and `manage_package` says so in its result — unlike silent
  // execution, which is neither. (Audit S9.)
  return ['install', '--ignore-scripts']
}

/**
 * Parent environment with credentials stripped.
 *
 * `npm install` runs third-party code (resolvers, and — where the caller
 * allows scripts — lifecycle hooks), and it inherits our environment. That
 * environment holds `ANTHROPIC_API_KEY`, the viewer's `dsv_` token, and
 * whatever else the developer exports in their shell. None of it is needed to
 * install a package.
 *
 * npm's OWN credentials are kept: `NPM_TOKEN` and `npm_config_*` are how a
 * private registry authenticates, so scrubbing them would break legitimate
 * installs while protecting nothing npm cannot already read from `.npmrc`.
 */
function installEnv(): NodeJS.ProcessEnv {
  const SECRET_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i
  const KEEP_RE = /^(npm_|NPM_)/
  const out: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(out)) {
    if (SECRET_RE.test(k) && !KEEP_RE.test(k)) delete out[k]
  }
  return out
}

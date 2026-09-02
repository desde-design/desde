/**
 * npm-package ingestion — the *ingest* layer of design-system onboarding
 * for the "customer names their npm package" case (see
 * `tasks/design-system-manifest-onboarding.md`).
 *
 * When a design-system library is NOT already in the prototype's
 * `node_modules`, install it on demand into an isolated scratch dir, read
 * its shipped `.d.ts`, and hand a `{ packageRoot, tsconfigPath, version }`
 * to the existing `vue-dts-meta` extractor — no source needed, same engine
 * as installed-package extraction.
 *
 * Security posture (the customer's named package is untrusted code):
 * - `execFile` (never a shell) with an argv array — no shell-metachar
 *   injection is possible, and the spec is additionally validated to a
 *   registry name + semver range so it can't be a git URL / local path /
 *   `http(s)` tarball that would pull from an unexpected source.
 * - `--ignore-scripts` defangs install lifecycle hooks (pre/post-install),
 *   the primary `npm install` RCE vector.
 * - Installs into a dedicated scratch subdir with its own `package.json`
 *   and `--prefix`, so npm never walks up to (and writes into) the
 *   prototype's real `node_modules`.
 *
 * Pure ingestion only: this module installs + locates; it does not extract
 * or cache. The caller composes it with `vue-dts-meta` discovery + the
 * `CachedManifestSource` persist layer (the version is returned so the
 * cache can key on it).
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

/** npm package name: optional `@scope/`, lowercase, conservative charset. */
const NAME_RE = /^(?:@[a-z0-9][a-z0-9-._]*\/)?[a-z0-9][a-z0-9-._]*$/
/** Version / range: semver chars + range operators only. No path / URL. */
const RANGE_RE = /^[0-9a-zA-Z.\-+~^*<>=| ]{1,100}$/

export class NpmIngestError extends Error {
  constructor(
    message: string,
    public readonly stderr?: string,
  ) {
    super(message)
    this.name = 'NpmIngestError'
  }
}

export interface ParsedSpec {
  /** Validated package name (e.g. `@vue-flow/core`). */
  name: string
  /** Validated version / range, or undefined for "latest". */
  range?: string
}

/**
 * Parse + validate an npm spec (`name` or `name@range`). Rejects git
 * URLs, local paths, tarball URLs, and anything with shell metacharacters
 * — only registry specs are allowed. Throws `NpmIngestError` on anything
 * invalid.
 */
export function parsePackageSpec(spec: string): ParsedSpec {
  if (typeof spec !== 'string' || spec.length === 0 || spec.length > 256) {
    throw new NpmIngestError(`invalid package spec: ${JSON.stringify(spec)}`)
  }
  // The version separator is the LAST `@` — except a leading `@` (scope).
  const sepIndex = spec.lastIndexOf('@')
  const hasRange = sepIndex > 0 // index 0 is a scope marker, not a separator
  const name = hasRange ? spec.slice(0, sepIndex) : spec
  const range = hasRange ? spec.slice(sepIndex + 1) : undefined

  if (!NAME_RE.test(name) || name.length > 214) {
    throw new NpmIngestError(`invalid package name: ${JSON.stringify(name)}`)
  }
  if (range !== undefined && !RANGE_RE.test(range)) {
    throw new NpmIngestError(`invalid package version: ${JSON.stringify(range)}`)
  }
  return { name, range }
}

/** Runs an `npm` invocation. Injectable so tests don't hit the network. */
export type NpmRunner = (args: readonly string[], cwd: string) => Promise<void>

const defaultNpmRunner: NpmRunner = async (args, cwd) => {
  try {
    await execFileP('npm', args as string[], {
      cwd,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
      // Inherit env (npm needs PATH/registry config) but never run a shell.
    })
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string }
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : undefined
    throw new NpmIngestError(stderr || e.message, stderr)
  }
}

export interface NpmIngestOptions {
  /** npm package spec: `name` or `name@range`. Validated. */
  spec: string
  /**
   * Root dir for ingestion scratch space (e.g.
   * `<prototype-root>/.desde/ingested`). A per-spec subdir is created
   * under it; the package installs into `<subdir>/node_modules/<name>`.
   */
  scratchRoot: string
  /** Injected npm runner (tests). Defaults to the real, hardened `npm`. */
  run?: NpmRunner
}

export interface NpmIngestResult {
  /** Resolved package name. */
  package: string
  /** Installed version, read from the package's own `package.json`. */
  version: string
  /** Absolute path to the installed package root. */
  packageRoot: string
  /** Synthesized tsconfig for the extractor's module resolution. */
  tsconfigPath: string
  /** The scratch dir the package was installed into. */
  scratchDir: string
}

const SCRATCH_TSCONFIG = JSON.stringify({
  compilerOptions: {
    module: 'esnext',
    moduleResolution: 'bundler',
    target: 'esnext',
    strict: false,
    skipLibCheck: true,
    noEmit: true,
    baseUrl: '.',
  },
})

/**
 * Filesystem-safe, collision-free single segment for a spec. The readable
 * slug is suffixed with a hash of the *exact* spec so two distinct specs
 * that normalize to the same slug (e.g. punctuation/spacing variants) never
 * share a scratch dir — which, combined with the pre-install wipe, keeps
 * each untrusted install hermetic.
 */
function specSlug(spec: string): string {
  const readable =
    spec.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) ||
    'pkg'
  const hash = createHash('sha1').update(spec).digest('hex').slice(0, 8)
  return `${readable}-${hash}`
}

/**
 * Install an npm package on demand into an isolated scratch dir and return
 * its location + version + a synthesized tsconfig. The caller feeds the
 * result to the `vue-dts-meta` extractor.
 */
export async function ingestNpmPackage(
  options: NpmIngestOptions,
): Promise<NpmIngestResult> {
  const { name, range } = parsePackageSpec(options.spec)
  const run = options.run ?? defaultNpmRunner

  const scratchDir = join(options.scratchRoot, specSlug(options.spec))
  // Hermetic install: wipe any prior contents so we never read a stale or
  // pre-seeded `node_modules` (npm would otherwise skip reinstalling a
  // package whose existing copy already satisfies the range). `recursive`
  // also creates the scratch-root parents.
  await fs.rm(scratchDir, { recursive: true, force: true })
  await fs.mkdir(scratchDir, { recursive: true })
  // A local package.json + manifest pins npm to this dir (so it never
  // walks up into the prototype's node_modules) and stops it from saving
  // deps anywhere meaningful.
  await fs.writeFile(
    join(scratchDir, 'package.json'),
    JSON.stringify({ name: 'desde-ingest-scratch', private: true, version: '0.0.0' }),
    'utf8',
  )
  const tsconfigPath = join(scratchDir, 'tsconfig.json')
  await fs.writeFile(tsconfigPath, SCRATCH_TSCONFIG, 'utf8')

  const installArg = range ? `${name}@${range}` : name
  await run(
    [
      'install',
      installArg,
      '--prefix',
      scratchDir,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-save',
      '--loglevel=error',
    ],
    scratchDir,
  )

  const packageRoot = join(scratchDir, 'node_modules', name)
  let version = '0'
  try {
    const raw = await fs.readFile(join(packageRoot, 'package.json'), 'utf8')
    version = (JSON.parse(raw) as { version?: string }).version ?? '0'
  } catch {
    throw new NpmIngestError(
      `package ${name} not found after install (looked in ${packageRoot})`,
    )
  }

  return { package: name, version, packageRoot, tsconfigPath, scratchDir }
}

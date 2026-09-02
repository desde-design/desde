/**
 * git-repo ingestion — the *ingest* layer of design-system onboarding for the
 * "customer points at a git repo" case (spec §7). Clone a repo into a hermetic
 * scratch dir, install its deps, locate the package, and hand a
 * `{ packageRoot, tsconfigPath, version }` to the extractor — exactly like
 * {@link ingestNpmPackage}, just sourced from git instead of the registry.
 *
 * Trust boundary (load-bearing, spec §7):
 * - *Clone* + *install* are safe-ish: argv-only `execFile` (no shell), an
 *   https/ssh URL allow-list (no local paths / `file://` / flag-injection), and
 *   `npm install --ignore-scripts` defangs lifecycle-hook RCE.
 * - *Build* (`npm run build`) is arbitrary code BY DESIGN. It runs ONLY when
 *   the caller passes `allowBuild` AND the repo ships no `.d.ts`. For Editor
 *   (local) the repo is the user's own/trusted code on their own machine, so
 *   the caller defaults `allowBuild` true. The cloud/viewer must keep it false
 *   until a sandbox exists (a future `BuildSandbox` swap-in).
 *
 * Pure ingestion: clones + installs + (optionally) builds + locates. It does
 * not extract or cache — the caller composes it with the extractor + cache.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { Dirent } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { discoverReactDtsEntries } from '@/editor/adapters/react-dts-meta/presets'

const execFileP = promisify(execFile)

/** https or ssh git URL only — no local path, `file://`, or `-`-flag injection. */
const URL_RE = /^(?:https:\/\/[^\s]+|ssh:\/\/[^\s]+|git@[^\s:]+:[^\s]+)$/
/** Branch/tag/ref: conservative charset, no `..`, no leading `-` (git flag). */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/
/** Subdir within the clone: relative, conservative, no `..` segment, no leading `/`. */
const SUBDIR_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/

export class RepoIngestError extends Error {
  constructor(
    message: string,
    public readonly stderr?: string,
  ) {
    super(message)
    this.name = 'RepoIngestError'
  }
}

export interface ParsedRepo {
  url: string
  ref?: string
  subdir?: string
}

/**
 * Validate a repo source. Rejects non-git(https/ssh) URLs, `..`-traversal refs
 * and subdirs, and anything with shell metacharacters. Throws on invalid.
 */
export function parseRepoSource(o: { url: string; ref?: string; subdir?: string }): ParsedRepo {
  const { url, ref, subdir } = o
  if (typeof url !== 'string' || url.length === 0 || url.length > 512 || !URL_RE.test(url)) {
    throw new RepoIngestError(`invalid repo url: ${JSON.stringify(url)} (https/ssh git URLs only)`)
  }
  if (ref !== undefined && !REF_RE.test(ref)) {
    throw new RepoIngestError(`invalid ref: ${JSON.stringify(ref)}`)
  }
  if (subdir !== undefined) {
    if (!SUBDIR_RE.test(subdir) || subdir.split('/').includes('..')) {
      throw new RepoIngestError(`invalid subdir: ${JSON.stringify(subdir)}`)
    }
  }
  return { url, ref, subdir }
}

/** Runs a `git` invocation, returning trimmed stdout. Injectable for tests. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>
/** Runs an `npm` invocation. Injectable so tests don't install/build for real. */
export type NpmRunner = (args: readonly string[], cwd: string) => Promise<void>

function makeRunner(bin: string, makeError: (msg: string, stderr?: string) => Error, timeout: number) {
  return async (args: readonly string[], cwd: string): Promise<string> => {
    try {
      const { stdout } = await execFileP(bin, args as string[], {
        cwd,
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf8',
      })
      return typeof stdout === 'string' ? stdout.trim() : ''
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stderr?: string }
      const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : undefined
      throw makeError(stderr || e.message, stderr)
    }
  }
}

const defaultGitRunner: GitRunner = makeRunner(
  'git',
  (m, s) => new RepoIngestError(m, s),
  180_000,
)
const npmExec = makeRunner('npm', (m, s) => new RepoIngestError(m, s), 300_000)
const defaultNpmRunner: NpmRunner = async (args, cwd) => {
  await npmExec(args, cwd)
}

export interface RepoIngestOptions {
  url: string
  ref?: string
  subdir?: string
  /** Root for scratch space (e.g. `<prototype>/.desde/ingested`). */
  scratchRoot: string
  /** Permit running the repo's build script (arbitrary code). See trust boundary. */
  allowBuild?: boolean
  /** Injected runners (tests). Default to the real, hardened git/npm. */
  git?: GitRunner
  run?: NpmRunner
}

export interface RepoIngestResult {
  /** Resolved package name (from the located package.json). */
  package: string
  version: string
  packageRoot: string
  tsconfigPath: string
  scratchDir: string
  /** True when the repo's build script was run to emit `.d.ts`. */
  built: boolean
  /** Resolved clone commit SHA (cache identity for mutable branches), or ''. */
  commit: string
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

/** Collision-free scratch segment for a repo source (url+ref+subdir). */
function repoSlug(url: string, ref?: string, subdir?: string): string {
  const readable =
    url
      .replace(/^https:\/\/|^ssh:\/\/|^git@/, '')
      .replace(/\.git$/, '')
      .replace(/[^a-z0-9._-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'repo'
  const hash = createHash('sha1').update(`${url}\0${ref ?? ''}\0${subdir ?? ''}`).digest('hex').slice(0, 8)
  return `${readable}-${hash}`
}

/**
 * The Vue dts roots the EXTRACTOR discovers under — must mirror
 * detect-framework's `VUE_DTS_PROBE_ROOTS`. The ingest probe checks only these
 * so "ships types" agrees with what onboarding can actually extract: a
 * `*.vue.d.ts` under `src/` (or the package root) would otherwise skip the
 * build yet leave detection finding nothing under these roots → `unknown`.
 */
const VUE_DTS_ROOTS = ['dist/types/components', 'dist/types', 'dist']

/** Any `*.vue.d.ts` under the standard Vue dts roots of `packageRoot`. */
async function hasVueDtsInRoots(packageRoot: string): Promise<boolean> {
  for (const root of VUE_DTS_ROOTS) {
    if (await walkForVueDts(join(packageRoot, root))) return true
  }
  return false
}

async function walkForVueDts(dir: string, depth = 0): Promise<boolean> {
  if (depth > 8) return false
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.vue.d.ts')) return true
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.')) {
      if (await walkForVueDts(join(dir, e.name), depth + 1)) return true
    }
  }
  return false
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}

/**
 * Does the package ship declarations the EXTRACTORS can consume? — `*.vue.d.ts`
 * (Vue), a React types entry resolvable by `discoverReactDtsEntries` (the
 * `types`/`typings` field OR `exports["."].types`, the modern layout), or a
 * bare root `index.d.ts` / `main`'s `.d.ts` sibling. Deliberately NOT "any
 * `.d.ts`": incidental stubs like `src/vite-env.d.ts` / `global.d.ts` must NOT
 * count, or a repo that needs its build to emit real declarations would skip it.
 */
async function shipsExtractableTypes(
  packageRoot: string,
  meta: PackageMeta,
): Promise<boolean> {
  if (await hasVueDtsInRoots(packageRoot)) return true
  // Canonical React resolution (covers types/typings/exports["."].types).
  try {
    if (discoverReactDtsEntries(packageRoot).length > 0) return true
  } catch {
    // ignore — fall through to the bare-file fallbacks
  }
  // Fallbacks discoverReactDtsEntries doesn't cover: an undeclared root
  // `index.d.ts`, or `main`'s `.d.ts` sibling.
  const candidates = ['index.d.ts', meta.mainDts].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  )
  for (const c of candidates) {
    if (await fileExists(join(packageRoot, c))) return true
  }
  return false
}

/**
 * Clone + install (+ optionally build) a git repo into a hermetic scratch dir
 * and return the located package + a synthesized tsconfig. The caller feeds the
 * result to the extractor.
 */
export async function ingestRepo(options: RepoIngestOptions): Promise<RepoIngestResult> {
  const { url, ref, subdir } = parseRepoSource(options)
  const git = options.git ?? defaultGitRunner
  const run = options.run ?? defaultNpmRunner

  const scratchDir = join(options.scratchRoot, repoSlug(url, ref, subdir))
  // Stage the whole clone/install/build in a SIBLING dir and swap it into place
  // only on success — so a failed re-onboard never deletes the live scratch dir
  // an existing registry entry still points at. Wipe any stale staging first.
  const stagingDir = `${scratchDir}.staging`
  await fs.rm(stagingDir, { recursive: true, force: true })
  await fs.mkdir(stagingDir, { recursive: true })
  const cloneDir = join(stagingDir, 'repo')

  // Shallow clone. `--` terminates flag parsing so a hostile URL can't be read
  // as a git option (belt-and-suspenders over the `-`-rejecting URL allow-list).
  const cloneArgs = ['clone', '--depth', '1']
  if (ref) cloneArgs.push('--branch', ref)
  cloneArgs.push('--', url, cloneDir)
  await git(cloneArgs, stagingDir)

  // Resolved commit — the cache identity for a mutable branch (a package.json
  // version often doesn't change between commits). Best-effort; '' if git fails.
  let commit = ''
  try {
    commit = (await git(['rev-parse', 'HEAD'], cloneDir)).trim()
  } catch {
    commit = ''
  }

  const packageRoot = subdir ? join(cloneDir, subdir) : cloneDir
  // Validate the subdir / read the package BEFORE installing (a missing subdir
  // should fail clearly, not as an install error).
  const meta = await readPackageJson(packageRoot)

  // Install deps in the PACKAGE dir: for a standalone subpackage this gets its
  // own deps; for a workspace member, `npm install` resolves to the workspace
  // root and installs everything. --ignore-scripts blocks lifecycle-hook RCE.
  // --include=dev forces devDependencies even under NODE_ENV=production / an
  // `omit=dev` npm config — the build needs typescript/vue-tsc/bundlers to emit
  // the `.d.ts` we extract.
  await run(
    [
      'install',
      '--ignore-scripts',
      '--include=dev',
      '--no-audit',
      '--no-fund',
      '--no-save',
      '--loglevel=error',
    ],
    packageRoot,
  )

  // Build-or-fail decision: extract directly if the repo already ships
  // extractable types, else run its build ONLY with explicit consent.
  let built = false
  if (!(await shipsExtractableTypes(packageRoot, meta))) {
    if (!options.allowBuild) {
      throw new RepoIngestError(
        `${url} ships no .d.ts. Enable "allow build" to compile its types (runs the repo's build script).`,
      )
    }
    // Build where the build script actually lives: the package dir when it has
    // its own `build` (package-local / non-workspace layouts), else the clone
    // root (monorepo whose root build emits every package's types). Running at
    // the wrong cwd makes `--if-present` silently skip and the .d.ts re-check
    // fail.
    const buildCwd = meta.hasBuildScript ? packageRoot : cloneDir
    await run(['run', 'build', '--if-present', '--loglevel=error'], buildCwd)
    built = true
    if (!(await shipsExtractableTypes(packageRoot, meta))) {
      throw new RepoIngestError(`${url} produced no extractable .d.ts after its build.`)
    }
  }

  await fs.writeFile(join(cloneDir, 'tsconfig.desde.json'), SCRATCH_TSCONFIG, 'utf8')

  // Everything succeeded — atomically replace the live scratch dir with the
  // staged one. (The brief rm→rename gap is acceptable: serving reads the
  // version-keyed cache, and a concurrent re-onboard of the SAME source is the
  // only writer of this path.)
  await fs.rm(scratchDir, { recursive: true, force: true })
  await fs.rename(stagingDir, scratchDir)

  // Return paths against the FINAL scratch dir (work happened under staging).
  const finalCloneDir = join(scratchDir, 'repo')
  return {
    package: meta.name,
    version: meta.version,
    packageRoot: subdir ? join(finalCloneDir, subdir) : finalCloneDir,
    tsconfigPath: join(finalCloneDir, 'tsconfig.desde.json'),
    scratchDir,
    built,
    commit,
  }
}

interface PackageMeta {
  name: string
  version: string
  hasBuildScript: boolean
  /** `main`'s `.d.ts` sibling (e.g. `dist/index.js` → `dist/index.d.ts`), or null. */
  mainDts: string | null
}

async function readPackageJson(packageRoot: string): Promise<PackageMeta> {
  let raw: string
  try {
    raw = await fs.readFile(join(packageRoot, 'package.json'), 'utf8')
  } catch {
    throw new RepoIngestError(`no package.json at ${packageRoot} (wrong subdir?)`)
  }
  let parsed: { name?: string; version?: string; scripts?: Record<string, unknown>; main?: unknown }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    throw new RepoIngestError(`unreadable package.json at ${packageRoot}`)
  }
  if (!parsed.name) throw new RepoIngestError(`package.json at ${packageRoot} has no "name"`)
  const main = typeof parsed.main === 'string' ? parsed.main : null
  return {
    name: parsed.name,
    version: parsed.version ?? '0',
    hasBuildScript: typeof parsed.scripts?.build === 'string' && parsed.scripts.build.length > 0,
    mainDts: main ? main.replace(/\.[cm]?js$/, '.d.ts') : null,
  }
}

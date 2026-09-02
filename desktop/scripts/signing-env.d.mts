// Hand-written declaration for signing-env.mjs.
//
// `scripts/*.mjs` is plain, un-typechecked JS run directly via `node
// scripts/package.mjs` (no esbuild/tsc step, matching the existing
// `payload-manifest-guard.mjs` / `macho-scan.mjs` pattern — see
// payload-manifest-guard.d.mts's own doc comment for the exact reasoning).
// `desktop/__tests__/signing-env.test.ts` imports it directly to unit-test
// the search-order and parsing logic, and `tsc --noEmit` (this package's own
// `npm run typecheck`, plus the root's) would otherwise resolve that import
// to implicit `any` under `strict` — this file supplies the types so the
// import is checked like any other module.
//
// Kept in sync BY HAND with signing-env.mjs's JSDoc — there is no automation
// enforcing the two agree, same tradeoff as any other hand-written `.d.ts`
// for an untyped JS module.

export const SIGNING_ENV_FILENAME: string
export const SIGNING_ENV_OVERRIDE_VAR: string

export function resolveMainCheckoutRoot(cwd: string): string | null

export function resolveSigningEnvCandidates(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  repoRoot: string,
  cwd: string,
  mainCheckoutRootResolver?: (cwd: string) => string | null,
): { path: string; required: boolean }[]

export function parseEnvFile(contents: string): Record<string, string>

export function loadSigningEnv(
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
  cwd?: string,
  mainCheckoutRootResolver?: (cwd: string) => string | null,
  /** Tests only. Production passes nothing and gets the real checkout root. */
  repoRootOverride?: string | null,
): Record<string, string>

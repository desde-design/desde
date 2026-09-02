// Hand-written declaration for notarize-config.mjs.
//
// `scripts/*.mjs` is plain, un-typechecked JS run directly via `node
// scripts/package.mjs` (no esbuild/tsc step, matching the existing
// `payload-manifest-guard.mjs` / `macho-scan.mjs` pattern — see
// payload-manifest-guard.d.mts's own doc comment for the exact reasoning).
// `desktop/__tests__/notarize-config.test.ts` imports it directly to
// unit-test the pure(-ish) credential-shape resolution, and `tsc --noEmit`
// (this package's own `npm run typecheck`, plus the root's) would otherwise
// resolve that import to implicit `any` under `strict` — this file supplies
// the types so the import is checked like any other module.
//
// Kept in sync BY HAND with notarize-config.mjs's JSDoc — there is no
// automation enforcing the two agree, same tradeoff as any other
// hand-written `.d.ts` for an untyped JS module.

export const API_KEY_VARS: readonly string[]
export const APPLE_ID_VARS: readonly string[]

export type NotarizeResolution =
  | { notarize: true; shape: "api-key" | "apple-id" }
  | { notarize: false; skipReason: string }

export function resolveNotarizeCredentials(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): NotarizeResolution

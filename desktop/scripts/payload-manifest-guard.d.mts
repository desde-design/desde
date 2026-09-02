// Hand-written declaration for payload-manifest-guard.mjs.
//
// `scripts/*.mjs` is plain, un-typechecked JS run directly via `node
// scripts/package.mjs` (no esbuild/tsc step — see package.mjs's own doc
// comment on why: `tsx`/a build step in the electron-builder invocation path
// is unwanted indirection). `desktop/__tests__/payload-manifest-guard.test.ts`
// imports it directly to unit-test the pure comparison, and `tsc --noEmit`
// (this package's own `npm run typecheck`, plus the root's) would otherwise
// resolve that import to implicit `any` under `strict` — this file supplies
// the types so the import is checked like any other module, without adding
// `scripts/**` to tsconfig's `include` (that would ask tsc to check JS this
// module deliberately keeps build-step-free).
//
// Kept in sync BY HAND with payload-manifest-guard.mjs's JSDoc — there is no
// automation enforcing the two agree, same tradeoff as any other hand-written
// `.d.ts` for an untyped JS module.

export type ManifestReadResult =
  // F2 (whole-branch review): `gitCommit` is optional — present (a string,
  // dirty-suffixed when applicable) for any manifest `build-server-package.mts`
  // writes today, `undefined` only for a manifest cached before that field
  // existed. `payloadFingerprint` (F9, fourth pass) is the same "optional,
  // absent on an old manifest" treatment — see `checkPayloadFreshness` below
  // for why THIS field, not `gitCommit`, is what decides staleness now.
  | {
      status: "ok"
      manifestPath: string
      platform: string
      arch: string
      gitCommit?: string
      payloadFingerprint?: string
    }
  | { status: "missing"; manifestPath: string }
  | { status: "malformed"; manifestPath: string; reason: string }

export type ManifestCheckResult = { ok: true } | { ok: false; message: string }

export type FreshnessResult = { ok: true; warning: string | null } | { ok: false; message: string }

export function shellQuote(value: string): string

export function readPayloadManifest(payloadDir: string): ManifestReadResult

export function checkPayloadHostMatch(
  manifestResult: ManifestReadResult,
  hostPlatform: string,
  hostArch: string,
  payloadDir: string,
): ManifestCheckResult

export function checkPayloadFreshness(
  manifestResult: ManifestReadResult,
  // F9 (whole-branch review, fourth pass, P1 fix): `fingerprint` is the
  // packaging checkout's CURRENT payload fingerprint — the decision.
  // `commit`/`dirty` are provenance only now, folded into the
  // human-readable message — see checkPayloadFreshness's own doc comment
  // for why git alone (a commit compare, even a scoped dirty compare)
  // cannot see a change to a gitignored built artifact or to the staging
  // recipe itself.
  current: { commit: string; dirty: boolean; fingerprint: string },
  options: { signing: boolean; allowStale: boolean },
): FreshnessResult

// F7 (whole-branch review, third pass, P1 fix); F9 (fourth pass) demoted
// this from the freshness DECISION to provenance-message-only — see
// PAYLOAD_INPUT_PATHSPECS's own doc comment in payload-manifest-guard.mjs
// for the exact boundary and its reduced role.
export const PAYLOAD_INPUT_PATHSPECS: readonly string[]

export function isPayloadInputsDirty(repoRoot: string): boolean

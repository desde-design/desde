// Hand-written declaration for update-manifest.mjs — same tradeoff as
// macho-scan.d.mts: `scripts/*.mjs` is plain JS with no build step, and
// `desktop/__tests__/update-manifest.test.ts` imports it under `strict`.
// Kept in sync BY HAND.

export function manifestPathFor(artifactPath: string): string | null

export interface UpdateManifestEntryRefresh {
  manifest: string
  url: string
  before: { sha512: string; size: number }
  after: { sha512: string; size: number }
  changed: boolean
}

export function refreshUpdateManifestEntry(artifactPath: string): UpdateManifestEntryRefresh | null

export function verifyUpdateManifest(manifestPath: string): Array<{ url: string; size: number }>

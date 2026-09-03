// Hand-written declaration for sign-archived-machos.mjs — same tradeoff as
// macho-scan.d.mts: `scripts/*.mjs` is plain JS with no build step, and
// both scripts/build-desktop-app.mts and the colocated test import from it
// under `strict`. Kept in sync BY HAND.

export function pickDeveloperIdIdentity(securityOutput: string): { hash: string; name: string }

export function findDeveloperIdIdentity(): { hash: string; name: string }

export function codesignArgs(input: { identityHash: string; timestamp?: string | undefined; file: string }): string[]

export function signMachOsInsideArchive(
  archivePath: string,
  options: {
    identityHash: string
    timestamp?: string | undefined
    signFile?: (file: string) => Promise<void>
  },
): Promise<string[]>

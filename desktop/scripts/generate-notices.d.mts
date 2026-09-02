// Hand-written declaration for generate-notices.mjs.
//
// `scripts/*.mjs` is plain, un-typechecked JS — see notarize-config.d.mts's
// doc comment for the exact reasoning (no build step in the
// electron-builder invocation path). `desktop/__tests__/generate-notices.test.ts`
// imports these directly to unit-test the pure formatting/merging/safety
// logic; this file supplies the types so those imports aren't implicit `any`
// under `strict`.
//
// Kept in sync BY HAND with generate-notices.mjs — no automation enforces
// the two agree, same tradeoff as every other hand-written `.d.mts` here.

export interface PackageLicenseInfo {
  licenses?: string
  repository?: string
  publisher?: string
  licenseFile?: string
  noticeFile?: string
  [key: string]: unknown
}

export interface RenderedPackageEntry {
  key: string
  info: Pick<PackageLicenseInfo, "licenses" | "repository" | "publisher">
  licenseText?: string | null
  noticeText?: string | null
}

export function isProprietaryLicenseString(licenseString: string | undefined | null): boolean

export function isSafeAttributionFile(filePath: string | undefined | null): boolean

export function mergePackageInfo(
  ...packageMaps: Record<string, PackageLicenseInfo>[]
): Map<string, PackageLicenseInfo>

export function renderPackageEntry(
  key: string,
  info: Pick<PackageLicenseInfo, "licenses" | "repository" | "publisher">,
  texts?: { licenseText?: string | null; noticeText?: string | null },
): string

export function renderNoticesDocument(entries: RenderedPackageEntry[]): string

export function readAttributionFile(
  filePath: string | undefined | null,
  readFileFn?: (path: string) => Promise<string>,
): Promise<string | null>

export function generateThirdPartyNotices(opts: { payloadDir: string; desktopRoot: string }): Promise<string>

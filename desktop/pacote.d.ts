/**
 * Minimal ambient types for the ONE `pacote` entry point this package uses
 * (`pacote.extract`, from `claude-runtime-installer.ts`). `pacote` ships no
 * types of its own, and the community `@types/pacote` package (11.1.8) is
 * far behind the runtime version pinned in `package.json` (21.5.1) — a
 * narrow, hand-written declaration for exactly the one call this file makes
 * is safer than trusting a mismatched third-party package for a
 * security-relevant fetch-and-extract path (wrong types here would fail
 * silently at compile time, not runtime).
 */
declare module "pacote" {
  export interface PacoteExtractResult {
    from: string
    resolved: string
    integrity: string | false
  }

  export interface PacoteOptions {
    registry?: string
    cache?: string
    /** Expected SRI of the fetched tarball — pacote verifies the stream against it and raises `EINTEGRITY` on mismatch (verified against pacote 21.5.1's `lib/fetcher.js`, which parses this via ssri). The F1 enforcement hook: see `claude-runtime-installer.ts`. */
    integrity?: string
    /** Registry fetches never run lifecycle scripts through pacote.extract regardless of this — see claude-runtime-installer.ts's doc comment — but pacote's own option surface is wide; this keeps the declaration honest about that without enumerating every option name. */
    [key: string]: unknown
  }

  export function extract(
    spec: string,
    dest: string,
    opts?: PacoteOptions,
  ): Promise<PacoteExtractResult>
}

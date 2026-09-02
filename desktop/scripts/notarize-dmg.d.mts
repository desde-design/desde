// Hand-written declaration for notarize-dmg.mjs — same convention as
// notarize-config.d.mts / macho-scan.d.mts (see those files' own doc
// comments for the full reasoning: scripts/*.mjs is plain, un-typechecked
// JS, and this file exists purely so `tsc --noEmit` checks its imports
// like any other module). Kept in sync BY HAND with notarize-dmg.mjs.

export type NotarizeCredentials =
  | { appleId: string; appleIdPassword: string; teamId: string }
  | { appleApiKey: string; appleApiKeyId: string; appleApiIssuer: string }

export function buildNotarizeCredentials(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): NotarizeCredentials | null

export function notarizeDmg(
  dmgPath: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  notarizeFn?: (args: { appPath: string } & Record<string, string>) => Promise<void>,
): Promise<void>

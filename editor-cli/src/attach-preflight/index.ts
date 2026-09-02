/**
 * Attach-mode stamping preflight — public surface.
 *
 * The CLI calls `runStampingPreflight` at boot, before it starts the proxy,
 * and prints the result. Nothing here writes to the user's repo or exits the
 * process; that decision belongs to the caller.
 */
export { runStampingPreflight } from './preflight.js'
export { detectWired } from './detect-wired.js'
export {
  generateNextBlock,
  generateNextFullConfig,
  generateViteBlock,
  generateViteFullConfig,
  proxyHostname,
} from './generate-block.js'
export { locateConfigFile, candidateConfigPaths, canCreateConfig } from './config-file.js'
export {
  STAMP_DIR,
  STAMP_MARKER,
  VUE_PLUGIN_PATH,
  JSX_PLUGIN_PATH,
  NEXT_LOADER_PATH,
  vitePluginFiles,
  nextLoaderFiles,
} from './stamper-files.js'
export type {
  AttachHost,
  StamperFramework,
  StampingPreflightRequest,
  StampingPreflightResult,
  AlreadyWiredResult,
  NeedsConfigResult,
  NoConfigFileResult,
  RequiredStamperFile,
} from './types.js'
export type { ConfigFileLocation, ModuleSyntax } from './config-file.js'

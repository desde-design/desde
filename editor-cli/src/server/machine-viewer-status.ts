import { readDefaultViewerOrigin, readViewerToken } from "./viewer-token-store.js"

/**
 * The viewer facts that belong to the MACHINE rather than to a repo.
 *
 * Extracted so the launcher can answer the same status route the editor does.
 * The launcher has no checkout, so it has no link to resolve and no committed
 * config to read — but the URL and the token are the same per-machine values,
 * and "Your viewer" is reachable from both gears.
 *
 * Reports presence, never the token itself. The credential stays in the CLI
 * process and is attached by its proxy, so it must not reach a page that also
 * renders a live prototype.
 */
export interface MachineViewerStatus {
  defaultOrigin: string | null
  hasToken: boolean
}

export async function readMachineViewerStatus(): Promise<MachineViewerStatus> {
  const defaultOrigin = await readDefaultViewerOrigin()
  return {
    defaultOrigin,
    hasToken: defaultOrigin ? (await readViewerToken(defaultOrigin)) !== null : false,
  }
}

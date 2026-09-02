/**
 * Where per-prototype Editor config lives, and how we keep reading repos
 * written before the Composer → Editor rename.
 *
 * The file is committed to the user's repo, so renaming it is a breaking
 * change we do not get to make unilaterally: a team that upgrades the Editor
 * would silently lose their read-roots, web policy and Figma setup, with no
 * error to explain it. So the new name is preferred and the old one is still
 * honoured, indefinitely — the cost is one extra `stat` on a miss.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Current name. New files are always written here. */
export const CONFIG_FILENAME = 'desde.config.json'

/** Pre-rename name. Still read; never written. */
export const LEGACY_CONFIG_FILENAME = 'desde-composer.config.json'

export interface ConfigRead {
  /** Raw file contents. */
  text: string
  /** Which filename actually supplied it — callers use this in messages. */
  filename: string
  /** True when the legacy name was used, so callers can nudge a rename. */
  legacy: boolean
}

/**
 * Read the prototype's Editor config, preferring the current filename.
 *
 * Returns null when NEITHER exists — the ordinary case for a prototype that
 * configures nothing. Any other read error propagates: a file that exists but
 * cannot be read is a real problem worth surfacing, unlike an absent one.
 *
 * When both files exist the current one wins outright and the legacy file is
 * ignored. Merging them would make the effective config depend on two places
 * at once, which is harder to reason about than "the new one wins".
 */
export async function readEditorConfigFile(
  worktreeRoot: string,
): Promise<ConfigRead | null> {
  for (const [filename, legacy] of [
    [CONFIG_FILENAME, false],
    [LEGACY_CONFIG_FILENAME, true],
  ] as const) {
    try {
      const text = await readFile(join(worktreeRoot, filename), 'utf8')
      return { text, filename, legacy }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw err
    }
  }
  return null
}

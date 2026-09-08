/**
 * The CLI's ONE per-user state directory: `~/.config/desde/`.
 *
 * Everything the CLI keeps outside a project lives here — the project
 * registry, the per-boot session file, the demo flag and seed lock, and the
 * secret stores (LLM keys, viewer tokens, extension secrets). Before
 * 2026-09-07 this was split across `~/.desde/` (registry, session, demo flag)
 * and `~/.config/desde/` (secrets), with no reason for the split written down
 * anywhere. One directory is what a CLI user expects, and it is what `gh`
 * and `git` do.
 *
 * `~/.config/desde` and not `~/.desde`, deliberately: `vite-supervisor.ts`
 * denies any served path containing a `.desde` segment, so nothing that can
 * ever be served (the demo, a future sample) may sit under a directory of
 * that name. `.config/desde` has no such segment.
 *
 * The desktop shell's OWN state (its settings file, the Claude runtime, the
 * boot log) is NOT here. That lives in Electron's `userData` directory
 * (`~/Library/Application Support/Desde` on macOS), because it belongs to
 * the app and not to the CLI — see `desktop/settings.ts`.
 *
 * `XDG_CONFIG_HOME` is not honoured on purpose. The path is meant to be one
 * fixed answer to "where is my Desde state", and an env-dependent path would
 * undo that.
 *
 * `home` is a parameter so tests never touch the real home directory.
 */
import { chmod, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export function cliStateDir(home: string = homedir()): string {
  return join(home, ".config", "desde")
}

/**
 * Create the state directory, 0700, and tighten it if it already exists.
 *
 * Every writer goes through this, not through its own `mkdir`. The secret
 * stores always created the directory 0700, but the registry, the demo flag
 * and the seed lock did not pass a mode, and whichever writer ran first on a
 * fresh machine decided the directory's mode for good: recursive `mkdir` with
 * a mode does nothing to a directory that exists. On a launcher-first boot
 * that left `~/.config/desde` at 0755 with the secrets inside it 0600, which
 * is safe for the files and wrong for the directory. The `chmod` is what
 * makes the order of first writes stop mattering.
 */
export async function ensureCliStateDir(home: string = homedir()): Promise<string> {
  const dir = cliStateDir(home)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700).catch(() => {})
  return dir
}

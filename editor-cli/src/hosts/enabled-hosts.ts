import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { CONFIG_FILENAME } from "../../../src/editor/core/read-roots.js"
import { inProcessHostIds } from "./registry.js"
import type { HostId } from "./types.js"

/**
 * Which in-process hosts this project has turned ON.
 *
 * **Why a switch at all, when the registry already says what is built.** The
 * two facts differ on purpose. A host lands in the registry when its code
 * exists and its live boot passed; it becomes the DEFAULT for every repo that
 * detection routes to it only after milestone 13's two-script bar has run
 * against a real repo of that framework (`tasks/dev-server-hosts.md` § 5).
 * Between those two moments the host has to be reachable by someone who asks
 * for it and invisible to everyone else, because the alternative is shipping an
 * unproven boot path to a user who only ran `desde .`.
 *
 * **As of 2026-08-11 that gap is closed for every host except `astro`** — see
 * `DEFAULT_ENABLED` below. What remains of this switch is two things: the
 * `astro` hold, and the `false` direction, which is how any user forces a
 * default-on host back to attach mode without editing anything else.
 *
 * A repo whose host is off keeps the pre-flip behaviour: `AttachRequiredError`
 * with the dev command to run and the `--attach` line to paste.
 *
 * The block, in `desde.config.json` at the prototype root — the
 * same file `readRoots`, `designSystems`, `figma` and `chat` already live in:
 *
 * ```jsonc
 * { "hosts": { "astro": true } }   // turn a held host on
 * { "hosts": { "next": false } }   // force a default-on host back to attach
 * ```
 *
 * **Posture on a malformed block: warn and ignore, never refuse.** This is the
 * opposite of `loadReadRoots`, which fails the boot on a bad config, and the
 * difference is what each one costs when it is wrong. A bad read-root silently
 * widens what the agent may read; a bad `hosts` entry can only ever fail to
 * turn something on, and the fallback is the shipped attach path with a message
 * that already tells the user what to do. Refusing to boot over a typo in an
 * opt-in flag would be the more damaging failure.
 */
export interface EnabledHosts {
  /** Ids this project may boot in-process. */
  readonly enabled: ReadonlySet<HostId>
  /** Config problems worth printing. Never fatal — see the note above. */
  readonly warnings: readonly string[]
}

/**
 * Hosts that are on with no configuration at all.
 *
 * `vite` is the path Editor has shipped since D-0 and the one every existing
 * user is already on.
 *
 * **`nuxt`, `react-router` and `next` were added 2026-08-11 — the milestone-13
 * flip** (Mo: *"Turn all new hosts, except for Astro as that has partial
 * functionality."*). That is the moment this work first reached a user who
 * never opted in: before it, someone had to type `{"hosts":{"next":true}}` and
 * had therefore chosen to try it; after it, every user of those frameworks gets
 * an in-process boot from `desde .` alone.
 *
 * Each of the three was flipped against milestone 13's bar, re-run at the
 * commit that flipped it rather than inherited from an older green run — two
 * scripts, because they answer different questions:
 *
 *   - `verify-host.mts` — does this host work at all. **10 PASS / 0 FAIL** on
 *     all three.
 *   - `edit-matrix.mts` — does every edit KIND land in the right place.
 *     **13 PASS / 0 FAIL / 3 SKIP** on all three; every SKIP names a substrate
 *     or dormancy reason (the two dormant lanes, plus the Vue-only or
 *     JSX-only kind the fixture's language cannot exercise).
 *   - Plus the red proof, which is part of the bar and not a nicety:
 *     `--corrupt-column 1` and `--corrupt-line 1` each took **10/10**
 *     coordinate-carrying ops red on all three. On every host one op under
 *     `--corrupt-line` was NOT refused and was caught by the containment
 *     assertion instead — the `ok: true`-in-the-wrong-place signature the
 *     matrix exists for, which is what shows the instrument is connected.
 *
 * ── `astro` is on a DELIBERATE HOLD, not merely un-flipped ─────────────────
 *
 * Product decision 2026-08-11 (`tasks/dev-server-hosts.md` § 9e): *"Make Astro
 * dormant, until we get a signal for user need and desire."* Written down here
 * because the surrounding evidence reads like a host that is ready and the
 * next reader would otherwise finish the job — and after the flip above it
 * reads that way even more strongly, because astro is now the ONLY name
 * missing from a list it used to sit level with. It is not ready, and the gap
 * is not in this file:
 *
 *   - `verify-host.mts` is 10/10 on astro and `edit-matrix` is 13/0/3 on a
 *     React island and 15/0/1 on a Vue island. Both are true and neither is
 *     the blocker.
 *   - The blocker is that `.astro` PAGES are inspect-only while the islands
 *     inside them edit normally — a capability split INSIDE one project, which
 *     no user can form a mental model of. The stamping half works (a `load`
 *     hook using Astro's own compiler stamps 10/10); what is missing is
 *     downstream: there is no `.astro` applicator in
 *     `src/editor/edit-service/`, and no `.astro` case in
 *     `checkExtensionGate` (`server/edit-extension-gate.ts`), so every edit to
 *     a `.astro` page is refused by the extension gate.
 *
 * **Exit criterion — all three, in order:** an `.astro` applicator, an
 * `.astro` case in `checkExtensionGate`, and then a signal that someone wants
 * this. A green gate is a precondition for exposure, not a decision to expose,
 * and this host is holding on the decision rather than on the gate.
 *
 * Costs nothing meanwhile: the hold is the absence of a name here rather than
 * a removal. `hosts/astro/` and its tests stay live and re-flippable in one
 * config line — `{ "hosts": { "astro": true } }`, which is pinned by a test.
 */
const DEFAULT_ENABLED: readonly HostId[] = ["vite", "nuxt", "react-router", "next"]

export async function loadEnabledHosts(prototypeRoot: string): Promise<EnabledHosts> {
  const enabled = new Set<HostId>(DEFAULT_ENABLED)
  const warnings: string[] = []

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(prototypeRoot, CONFIG_FILENAME), "utf-8"))
  } catch (err) {
    // ENOENT is the unconfigured default and says nothing. A parse error DOES
    // get a warning, but it is `loadReadRoots` — which reads the same file a few
    // lines later in `core.ts` and fails the boot on it — that owns being loud
    // about a broken config. Duplicating that here would print it twice.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`${CONFIG_FILENAME}: could not be read for the "hosts" block: ${(err as Error).message}`)
    }
    return { enabled, warnings }
  }

  const block = (raw as { hosts?: unknown } | null)?.hosts
  if (block === undefined) return { enabled, warnings }
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    warnings.push(`${CONFIG_FILENAME}: "hosts" must be an object mapping a host id to true or false.`)
    return { enabled, warnings }
  }

  // IN-PROCESS ids only. `attach` is a registry entry but is not something a
  // project opts into — it is reached by naming a URL — so `hosts.attach: true`
  // gets the "not an in-process host in this build" warning, which is the
  // truth, rather than silently adding a lane that cannot boot.
  const known = new Set<string>(inProcessHostIds())
  for (const [id, value] of Object.entries(block as Record<string, unknown>)) {
    if (!known.has(id)) {
      // Names an unbuilt or misspelled host. Listing what IS available turns a
      // silent no-op into a fixable line.
      warnings.push(
        `${CONFIG_FILENAME}: "hosts.${id}" is not an in-process host in this build. ` +
          `Available: ${inProcessHostIds().join(", ")}.`,
      )
      continue
    }
    if (typeof value !== "boolean") {
      warnings.push(`${CONFIG_FILENAME}: "hosts.${id}" must be true or false.`)
      continue
    }
    // `false` is meaningful for a default-on host: it is how a user forces the
    // plain Vite path back to attach mode without editing anything else.
    if (value) enabled.add(id as HostId)
    else enabled.delete(id as HostId)
  }

  return { enabled, warnings }
}

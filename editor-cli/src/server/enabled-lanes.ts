import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { CONFIG_FILENAME } from "../../../src/editor/core/read-roots.js"

/**
 * Which DORMANT edit lanes this project has turned back on.
 *
 * **What a dormant lane is.** `detach` and `swap` went dormant by product
 * decision on 2026-08-11 (`tasks/dev-server-hosts.md` § 9e). Two facts held at
 * once and only the pair justifies it: the lanes are Vue-only — their
 * applicators mutate SFC AST and there is no JSX sibling, so what the product
 * OFFERS is wider than what it can DELIVER for a React substrate — and, on the
 * only substrate where they do work, they have never been used. An
 * inconsistency nobody relies on is the cheap kind to close, and closing it by
 * removing the offering costs a week less than closing it by writing two JSX
 * applicators.
 *
 * **This is a gate, not a deletion.** Precedent is `EDITOR_CANVAS` (CLAUDE.md
 * § "Screenshot Capture"), where a whole surface went dormant with every
 * component, store, handler and test intact and green. Same here:
 * `apply-detach-edit.ts`, `apply-swap-edit.ts`, their colocated suites and the
 * handler suites that drive them all stay in the DEFAULT test run. A dormant
 * lane whose tests rot is a lane that cannot be un-dormanted, so dormancy
 * covers the product surface and never the gate.
 *
 * **Shaped like `hosts`, read the same way**, in `desde.config.json`
 * at the prototype root — the same file `readRoots`, `hosts`, `designSystems`,
 * `figma` and `chat` already live in:
 *
 * ```jsonc
 * { "lanes": { "detach": true, "swap": true } }
 * ```
 *
 * **Per-lane rather than one flag** because they come back at different times
 * and for different reasons: `detach` needs a JSX detach applicator at parity;
 * `swap` needs that AND the swap-by-role gap closed
 * (`tasks/_archive/one-shot-tasks/swap-by-role.md` — swap currently matches by
 * prop-name overlap and cannot swap Tabs ↔ SegmentedControl, so it is weak even
 * on Vue). One shared flag would hold the easier lane hostage to the harder one.
 *
 * **Posture on a malformed block: warn and ignore, never refuse** — identical to
 * `hosts/enabled-hosts.ts`, and for the identical reason. A bad `lanes` entry
 * can only ever fail to turn something ON; the fallback is the dormant default,
 * which is the shipped product. Failing a boot over a typo in an opt-in flag
 * would be the more damaging failure.
 */
export interface EnabledLanes {
  /** Dormant lanes this project has opted back in to. */
  readonly enabled: ReadonlySet<DormantLaneId>
  /** Config problems worth printing. Never fatal — see the note above. */
  readonly warnings: readonly string[]
}

/**
 * The lanes that are dormant by default.
 *
 * Deliberately typed as a subset of the wire-format edit kinds rather than as
 * `string`: adding a lane here is a compile-time decision, and the refusal
 * message below is generated from the id so a new member cannot ship with a
 * message that names the wrong config key.
 */
export type DormantLaneId = "detach" | "swap"

/** Every dormant lane, in the order they are documented. */
export const DORMANT_LANE_IDS: readonly DormantLaneId[] = ["detach", "swap"]

const DORMANT_LANE_SET: ReadonlySet<string> = new Set<string>(DORMANT_LANE_IDS)

/** Nothing opted in — the shipped default, and the fail-closed fallback. */
export const NO_LANES_ENABLED: ReadonlySet<DormantLaneId> = new Set<DormantLaneId>()

export function isDormantLaneId(kind: string): kind is DormantLaneId {
  return DORMANT_LANE_SET.has(kind)
}

/**
 * The refusal for a dispatch of `kind`, or `null` when it may proceed.
 *
 * Two properties this exists to guarantee, both learned from the offering side
 * of the same gate:
 *
 *  - **It names the config key.** A caller that reaches a dormant lane — a
 *    stale client, a hand-built request, an agent that decided to try — must
 *    get an answer it can act on, not an applicator error thrown three layers
 *    down about SFC AST. The message says which lane, which key, and which
 *    file.
 *  - **An absent set is dormant.** `enabled` is optional because it threads
 *    through call sites that predate it; the fail direction for a dormant lane
 *    is closed, so a call site that forgets to pass it refuses rather than
 *    silently re-opening the lane.
 */
export function dormantLaneRefusal(
  kind: string,
  enabled: ReadonlySet<DormantLaneId> | undefined,
): string | null {
  if (!isDormantLaneId(kind)) return null
  if (enabled?.has(kind)) return null
  // The literal key `lanes.<id>` is load-bearing, not decoration: it is the
  // string a user greps for, and it is what a colocated test pins so the
  // message can never drift into naming a key that does not exist.
  return (
    `The "${kind}" edit lane is dormant: it is Vue-only and has no JSX sibling, ` +
    `so the product does not offer it. Set lanes.${kind} ` +
    `({ "lanes": { "${kind}": true } } in ${CONFIG_FILENAME} at the prototype ` +
    `root) to turn it back on. The applicator is intact and unchanged.`
  )
}

export async function loadEnabledLanes(prototypeRoot: string): Promise<EnabledLanes> {
  const enabled = new Set<DormantLaneId>()
  const warnings: string[] = []

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(prototypeRoot, CONFIG_FILENAME), "utf-8"))
  } catch (err) {
    // ENOENT is the unconfigured default and says nothing. Anything else is
    // worth one line — but see `loadEnabledHosts`, which reads the SAME file
    // and prints its own parse warning: on a genuinely broken config the user
    // gets both, which is noisy but honest about which block was lost.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(
        `${CONFIG_FILENAME}: could not be read for the "lanes" block: ${(err as Error).message}`,
      )
    }
    return { enabled, warnings }
  }

  const block = (raw as { lanes?: unknown } | null)?.lanes
  if (block === undefined) return { enabled, warnings }
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    warnings.push(
      `${CONFIG_FILENAME}: "lanes" must be an object mapping a lane id to true or false.`,
    )
    return { enabled, warnings }
  }

  for (const [id, value] of Object.entries(block as Record<string, unknown>)) {
    if (!isDormantLaneId(id)) {
      // Names a non-dormant kind or a typo. Listing what IS gateable turns a
      // silent no-op into a fixable line — and refuses to let `lanes` become a
      // second, informal switch for lanes that are simply on.
      warnings.push(
        `${CONFIG_FILENAME}: "lanes.${id}" is not a dormant lane. ` +
          `Gateable lanes: ${DORMANT_LANE_IDS.join(", ")}.`,
      )
      continue
    }
    if (typeof value !== "boolean") {
      warnings.push(`${CONFIG_FILENAME}: "lanes.${id}" must be true or false.`)
      continue
    }
    // `false` is the default, so writing it changes nothing — accepted anyway
    // so a user can record the decision in their config explicitly.
    if (value) enabled.add(id)
    else enabled.delete(id)
  }

  return { enabled, warnings }
}

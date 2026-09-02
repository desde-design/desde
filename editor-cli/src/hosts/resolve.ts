import { getHostFactory, inProcessHostIds } from "./registry.js"
import type { HostDetection, HostEvidence, HostFailure, HostId } from "./types.js"

/**
 * Detection evidence → the {@link HostId} this boot should run, or a typed
 * refusal.
 *
 * **Detection observes; this adjudicates.** `server/framework-detection.ts`
 * lists every host the repo could be and the facts behind each; everything that
 * counts as a DECISION — the `--attach` short-circuit, the `--host` override,
 * refusing an ambiguous repo, downgrading an unrecognised one to attach mode —
 * happens here, in one pure function with no I/O.
 *
 * The rules, in the order they run (`tasks/dev-server-hosts.md` § 1):
 *
 *  1. **`--attach <url>` wins unconditionally** → the `attach` host. A developer
 *     running their own dev server is welcome to it. The underlying framework
 *     still matters — attach mode has to know whose config to wire — which is
 *     what {@link attachConfigHostFor} answers, and why the ambiguity check in
 *     rule 3 runs even on this path.
 *  2. **`--host <id>` wins over detection**, but does NOT skip `probe()`. An
 *     override at a host whose seam is missing must still refuse honestly rather
 *     than produce a booting-but-unstamped session.
 *  3. **Two meta-hosts both `certain` → `ambiguous-host`.** Refuse, print both
 *     `because` lists verbatim, name `--host`. The code this replaced took the
 *     first marker in a fixed array — a *silent wrong answer*, and a wrong host
 *     boots, serves 200s and does not stamp. A refusal costs one flag; a wrong
 *     guess costs a debugging session.
 *  4. **No candidate → `no-in-process-host`, a DOWNGRADE rather than a refusal.**
 *     The repo is not out of scope; we just have no dev server of our own to
 *     offer it.
 */

export type HostResolution =
  | {
      ok: true
      hostId: HostId
      /** What decided it, quoted. Printed by `--doctor` and in the boot log. */
      because: string[]
    }
  | { ok: false; failure: HostFailure }

export interface HostOverride {
  /** `--host <id>`. */
  hostId?: HostId | undefined
  /** `--attach <url>`, already normalised to an origin. */
  attachUrl?: string | undefined
}

/**
 * The meta-framework hosts, for rule 3. `next` is excluded deliberately: it
 * beats every other candidate by rule, so `next` + `astro` is a RANKING and not
 * an ambiguity, and `vite` is excluded because detection only emits it when
 * nothing more specific matched.
 */
const META_HOST_IDS: ReadonlySet<HostId> = new Set<HostId>(["nuxt", "astro", "react-router"])

export function resolveHost(detection: HostDetection, override: HostOverride = {}): HostResolution {
  // Rule 3 runs FIRST and on every lane, including `--attach`. An ambiguous repo
  // is ambiguous for attach mode too: the stamping preflight has to pick which
  // config file to read and which block to generate, and it would pick with the
  // same coin-flip this refusal exists to stop. The one lane it does not gate is
  // an explicit `--host`, which is the answer to it.
  const ambiguous = ambiguityAmong(detection.candidates)
  if (ambiguous && !override.hostId) {
    return { ok: false, failure: ambiguousHostFailure(ambiguous) }
  }

  if (override.attachUrl) {
    return {
      ok: true,
      hostId: "attach",
      because: [`--attach ${override.attachUrl} was passed, so Editor is not booting a dev server`],
    }
  }

  if (override.hostId) {
    if (override.hostId === "attach") {
      // `attach` IS a registry entry now, so this no longer refuses by accident
      // — it has to refuse on purpose. The attach host's whole boot is "connect
      // to a URL someone else is already serving", and nothing here knows one.
      return {
        ok: false,
        failure: {
          code: "no-in-process-host",
          summary: "--host attach names a dev server Editor does not start.",
          remediation: [
            "Start your dev server, then pass --attach <its url> (--host attach is implied).",
          ],
          attachCovers: true,
        },
      }
    }
    if (getHostFactory(override.hostId) === null) {
      return { ok: false, failure: unbuiltHostFailure(override.hostId) }
    }
    return {
      ok: true,
      hostId: override.hostId,
      because: [`--host ${override.hostId} was passed explicitly`],
    }
  }

  const top = detection.candidates[0]
  if (!top) return { ok: false, failure: noCandidateFailure() }

  if (getHostFactory(top.hostId) === null) {
    return { ok: false, failure: unbuiltHostFailure(top.hostId) }
  }
  return {
    ok: true,
    hostId: top.hostId,
    because: [`detected ${top.hostId} (${top.confidence}): ${top.because.join("; ")}`],
  }
}

/**
 * Which framework's config attach mode has to wire, for a repo detection has
 * already described.
 *
 * The honest replacement for the deleted `attachHostFor(host, metaFramework)`.
 * That function existed to translate a boot-path tier back into a framework
 * name; with detection naming the host id directly there is nothing to
 * translate, and this is a ranked read with a fallback.
 *
 * `vite` is the fallback rather than a refusal because a plain root
 * `vite.config.*` with a plugins array is the shape a developer attaching to
 * their own `vite dev` has, and it is the shape the preflight can least go wrong
 * on: if there is no such file it reports `no-config-file` with the paths it
 * searched, which is a better answer than guessing at a framework.
 */
export function attachConfigHostFor(detection: HostDetection): Exclude<HostId, "attach"> {
  const top = detection.candidates[0]
  return top && top.hostId !== "attach" ? top.hostId : "vite"
}

/** The two-or-more `certain` meta-host candidates, or null. */
function ambiguityAmong(candidates: readonly HostEvidence[]): HostEvidence[] | null {
  const certain = candidates.filter(
    (c) => c.confidence === "certain" && META_HOST_IDS.has(c.hostId),
  )
  return certain.length >= 2 ? certain : null
}

/**
 * Two frameworks that both own a dev server, both corroborated by their own
 * config file on disk.
 *
 * `attachCovers: false`, and that is not pessimism — attach mode is equally
 * unable to guess. Its stamping preflight reads ONE config file and generates a
 * block for ONE framework, so "start your dev server and pass --attach" would
 * leave the user in the same coin-flip one step later. The remedy for both lanes
 * is the same flag, so the failure names it rather than a fallback that does not
 * help.
 */
function ambiguousHostFailure(certain: readonly HostEvidence[]): HostFailure {
  const ids = certain.map((c) => c.hostId)
  return {
    code: "ambiguous-host",
    summary: `This project looks like ${ids.join(" AND ")} at the same time, and Editor will not guess which dev server owns it.`,
    cause: certain
      .map((c) => `${c.hostId} (${c.confidence}): ${c.because.join("; ")}`)
      .join("\n              "),
    remediation: [
      ...ids.map((id) => `Re-run with --host ${id} if that is the one that serves your app.`),
      "Editor used to take the first match here, which meant a wrong host booted, served 200s and stamped nothing.",
    ],
    attachCovers: false,
  }
}

/**
 * Nothing matched — the `unknown` downgrade.
 *
 * **A downgrade, not a refusal.** The repo is not out of scope; Editor simply has
 * no dev server of its own to offer it. This replaces three exit-3 refusals
 * (`missing-vite`, `no-vite-config`, `no-next-config`) that stated what our old
 * boot path required and sent a user with a perfectly good project to a support
 * matrix to read that they were unsupported.
 *
 * The stamper caveat is stated in the same breath rather than left to be
 * discovered: `--attach` gets a session, and whether that session can EDIT
 * depends on a second, independent fact.
 */
function noCandidateFailure(): HostFailure {
  return {
    code: "no-in-process-host",
    summary: "No in-process dev-server host matched this project.",
    cause:
      "Looked for: next, nuxt, astro, @react-router/dev, and vite (a dependency or a root vite.config.*). None is declared in package.json or present at the root.",
    remediation: [
      "Start the project's own dev server in another terminal.",
      "Re-run Editor with --attach <that server's url>.",
      "Note: Editor's source stamper ships as a Vite plugin and a Next Turbopack loader only. A dev server built on anything else can be inspected but not edited.",
    ],
    attachCovers: true,
  }
}

/**
 * A host the design names but this build does not implement yet.
 *
 * Reachable only through `--host`, since every id detection can produce has an
 * implementation. Kept because {@link getHostFactory} can still return null: the
 * registry is `Record<HostId, HostFactory | null>` so that adding a `HostId`
 * member is a decision with a diff rather than a silently-missing case.
 */
function unbuiltHostFailure(hostId: HostId): HostFailure {
  return {
    code: "no-in-process-host",
    summary: `Editor cannot boot a ${hostId} project in-process in this build.`,
    remediation: [
      "Start the project's dev server in another terminal.",
      "Re-run Editor with --attach <that server's url>.",
      `In-process hosts available in this build: ${inProcessHostIds().join(", ")}.`,
    ],
    attachCovers: true,
  }
}

/**
 * Can the launcher open this folder? Answered BEFORE anything is spawned.
 *
 * ── The defect this closes ────────────────────────────────────────────────
 *
 * `POST /api/launcher/open` validated two things — the path is a string, the
 * path is a directory — and then spawned `desde <path>` and waited
 * for `Editor UI ready at <url>` on the child's stdout. On a repo we cannot
 * boot, the child printed a GOOD failure (summary, cause, numbered
 * remediation, whether `--attach` covers it) to a terminal the user of a GUI
 * launcher never sees, and exited 4. The parent saw only the exit, and the
 * modal said:
 *
 *     editor exited before it was ready (code 4)
 *
 * Every fact needed to say something useful was computed, rendered and thrown
 * away one process boundary from the surface that needed it.
 *
 * ── Why detection can just be re-run here ─────────────────────────────────
 *
 * Because it is a cheap read of the repo. `detectFramework` reads
 * `package.json` plus a handful of `fs.access` calls; `resolveHost` is a pure
 * function over that evidence; `loadEnabledHosts` reads one config file; the
 * repo-state check runs two read-only `git rev-parse` calls. No `node_modules`
 * walk, no npm, no network, and nothing is written. So the launcher can ask the
 * same questions the child would have asked, in the same order, in
 * milliseconds, and answer the user in the UI instead of in a log.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────
 *
 * It is not a replacement for the child's own gate. `core.ts` runs the same
 * three steps at boot and must keep doing so: this module can pass and the boot
 * can still fail for a reason only booting reveals (a missing install, a seam
 * that moved, a config that throws). That residue is what the spawn-exit
 * fallback in `launcher-server.ts` is for, and "exited before it was ready
 * (code N)" is an honest thing to say THERE, because there it is genuinely
 * unexplained.
 *
 * The two paths agree by construction: both call `detectFramework` →
 * `resolveHost` → `loadEnabledHosts` → `preflightCanonicalRoot` in that order,
 * and this module renders the SAME `HostFailure` objects `core.ts` throws
 * rather than composing its own prose for them.
 */

import type { LauncherOpenBlock, LauncherSupportedHost } from "../../../src/types/launcher.js"
import { detectFramework, type FrameworkDetectionResult } from "./framework-detection.js"
import { preflightCanonicalRoot } from "./canonical-preflight.js"
import { resolvePrototypeLocation } from "./prototype-location.js"
import { loadEnabledHosts } from "../hosts/enabled-hosts.js"
import { getHostFactory, inProcessHostIds } from "../hosts/registry.js"
import { resolveHost } from "../hosts/resolve.js"
import type { HostFailure, HostId } from "../hosts/types.js"

/**
 * Why a BUILT host is off, per host, and what that costs the user.
 *
 * A total `Record`, so adding a `HostId` is a compile error here rather than a
 * silently-empty explanation in the one message whose whole job is explaining.
 *
 * These are per-host FACTS and cannot be derived, which is why they are
 * written out — but note what is not here: which hosts are on. That is read
 * from the registry and the project's config every time (see
 * {@link listSupportedHosts}), because the default set moves and a second copy
 * of it would drift.
 */
/**
 * A host that is off for this project is simply NOT SUPPORTED, as far as the
 * launcher says out loud.
 *
 * There used to be a `WHY_OFF` record and a `host-not-enabled` code that
 * explained per host why it was built-but-dormant, on the reasoning that
 * telling an Astro user "unsupported" would be false. Mo cut both on
 * 2026-08-17: *"We do not support Astro at this point, just use the generic
 * not supported banner."*
 *
 * The old reasoning was technically true and practically unhelpful. From where
 * the user stands there is no difference between "we have not built it" and
 * "we built it and will not turn it on": either way this folder does not open,
 * and the only actionable content is the list of frameworks that DO. Splitting
 * that into two banners bought a distinction only the maintainers could act on.
 */

/**
 * `null` when this project can be opened; otherwise the refusal, ready to
 * render.
 *
 * @param repoPath absolute, already known to be a directory.
 */
export async function checkLauncherOpen(repoPath: string): Promise<LauncherOpenBlock | null> {
  // Read ONCE and pass it down. Two calls would be two answers to "what is
  // enabled here" in one response — the inventory and the gate — and they must
  // not be able to disagree.
  const { enabled } = await loadEnabledHosts(repoPath)
  const supported = listSupportedHosts(enabled)

  const detection = await detectFramework(repoPath)
  if (!detection.ok) return frameworkBlock(detection, repoPath, supported)

  const resolution = resolveHost(detection)
  if (!resolution.ok) return fromHostFailure(resolution.failure, supported)

  // `attach` is unreachable from here (the launcher passes no `--attach` URL),
  // but the narrowing is real: `hosts.attach` is not something a project opts
  // into, so it must never be looked up in the enabled set.
  if (resolution.hostId === "attach") return null

  if (!enabled.has(resolution.hostId)) {
    return unsupportedFrameworkBlock(resolution.hostId, supported)
  }

  return repoStateBlock(repoPath, supported)
}

/**
 * The two refusals that have nothing to do with the framework: no git repo,
 * and a repo mid-merge.
 *
 * **Order matters and is copied from `core.ts`, not chosen here.** The boot
 * resolves the prototype's git root (core.ts § "Prototype location") and then
 * runs `preflightCanonicalRoot` on it, AFTER the detection and host gates. A
 * launcher that asked in a different order would answer a different question
 * from the one the boot is about to ask, which is a subtler version of the
 * defect this whole module fixes.
 *
 * MEASURED before this existed: a perfectly good Vue + Vite app in a folder
 * that simply was not a git repo passed every check here, spawned, died on
 * `Could not read .git directory`, exited 1, and the modal said `editor exited
 * before it was ready (code 1)`.
 *
 * This is the one check that runs a subprocess (`git rev-parse`). Read-only,
 * and the alternative is being wrong about whether the boot will succeed.
 */
async function repoStateBlock(
  repoPath: string,
  supported: LauncherSupportedHost[],
): Promise<LauncherOpenBlock | null> {
  let gitRoot: string | null = null
  try {
    gitRoot = (await resolvePrototypeLocation(repoPath)).gitRoot
  } catch {
    gitRoot = null
  }

  if (gitRoot === null) {
    return {
      code: "not-a-git-repo",
      summary: "This folder is not a git repository, and one is required.",
      cause:
        "Edits are written to your working tree in place. Undo comes from a per-edit backup journal, and Commit and Publish are git operations, so there is nothing underneath them without a repo.",
      remediation: [
        `Run git init in ${repoPath}, commit once, then open it again.`,
        "Or open the repository this folder belongs to instead.",
      ],
      // Attach mode does not rescue this: the same preflight runs on that lane.
      attachCovers: false,
      supported,
    }
  }

  const preflight = await preflightCanonicalRoot(gitRoot)
  if (preflight.ok) return null
  return {
    code: "repo-busy",
    summary: "This repository has a git operation in progress, so it can't be edited.",
    cause: preflight.reason,
    remediation: [
      "Finish or abort the operation (git merge --abort, git rebase --abort, git cherry-pick --abort), then open the project again.",
      "Editing over an unresolved merge would write on top of the conflict markers still in your files.",
    ],
    attachCovers: false,
    supported,
  }
}

/**
 * The host inventory on its own, for a caller that has no refusal to attach it
 * to — specifically a boot that failed AFTER this module said yes
 * (`editor-boot-failure.ts`).
 *
 * Re-reads the config rather than threading the earlier read through. That is
 * not a walk-back of "read the hosts config once": the point of that rule is
 * that ONE response must not contain an inventory disagreeing with the refusal
 * printed above it, and on this path the earlier read produced no refusal and
 * no inventory. There is exactly one of each here.
 */
export async function supportedHostsFor(repoPath: string): Promise<LauncherSupportedHost[]> {
  const { enabled } = await loadEnabledHosts(repoPath)
  return listSupportedHosts(enabled)
}

/**
 * Every in-process host in this build, with THIS project's on/off state.
 *
 * Derived twice over: the ids and labels come from the registry (a host's own
 * `displayName`), the on/off state from the caller's `loadEnabledHosts` read,
 * which is the same function the boot gate consults — so it already accounts
 * for the defaults AND for anything the project's own `hosts` block turned on
 * or off.
 */
function listSupportedHosts(enabled: ReadonlySet<HostId>): LauncherSupportedHost[] {
  // `inProcessHostIds()` excludes `attach` at runtime, but its return type is
  // the whole `HostId` union, so the narrowing is done here rather than cast
  // away: `attach` is not something a project opts into.
  const ids = inProcessHostIds().filter((id): id is Exclude<HostId, "attach"> => id !== "attach")
  // Enabled only. A dormant host is not "supported with an asterisk", it is
  // one of the frameworks this folder cannot be opened with, and listing it on
  // a refusal screen tells the user about a door they cannot walk through.
  return ids
    .filter((id) => enabled.has(id))
    .map((id) => {
      const factory = getHostFactory(id)
      return { id, label: factory ? factory().displayName : id }
    })
}

/**
 * The repo is not one Editor can edit at all.
 *
 * `detectFramework`'s own message is carried as the CAUSE verbatim — it names
 * the file it read and links the support matrix — while the summary is the one
 * sentence the notice leads with. Splitting them this way means the message
 * never has to be re-written in two voices for two surfaces.
 */
function frameworkBlock(
  detection: Extract<FrameworkDetectionResult, { ok: false }>,
  repoPath: string,
  supported: LauncherSupportedHost[],
): LauncherOpenBlock {
  const summary = FRAMEWORK_SUMMARY[detection.reason]
  const remediation = FRAMEWORK_REMEDIATION[detection.reason](repoPath)
  return {
    code: "framework-unsupported",
    summary,
    cause: detection.message,
    remediation,
    // FALSE for every case here, and that is the honest answer rather than a
    // pessimistic one: attach mode would proxy the app fine and then refuse
    // every edit, because the missing piece is a source stamper for the
    // dialect, which attaching does not supply.
    attachCovers: false,
    supported,
  }
}

/**
 * The headline for each detection failure.
 *
 * Two rules, both from Mo on 2026-08-17. **Never name the product** ("Editor
 * cannot tell what it is", "Editor edits only those", "Editor supports Vue 3
 * only" are all gone). And **it is not a "project" yet** — the user has picked
 * a folder and nothing has been opened, so calling it a project presumes the
 * step that just failed.
 */
const FRAMEWORK_SUMMARY: Record<Extract<FrameworkDetectionResult, { ok: false }>["reason"], string> =
  {
    "no-package-json": "This folder has no package.json, so its framework can't be identified.",
    "malformed-package-json": "This folder's package.json could not be read.",
    "missing-framework": "This prototype's framework isn't supported.",
    "wrong-vue-major": "Vue 2 isn't supported.",
  }

const FRAMEWORK_REMEDIATION: Record<
  Extract<FrameworkDetectionResult, { ok: false }>["reason"],
  (repoPath: string) => string[]
> = {
  // Kept: the user genuinely may have picked the wrong folder, and naming
  // the one they picked is what makes that visible.
  "no-package-json": (repoPath) => [
    `Check that ${repoPath} is the folder holding your app, not the folder above it.`,
    "If your app lives in a subfolder of a monorepo, open that subfolder directly.",
  ],
  "malformed-package-json": () => ["Fix the JSON in package.json, then try again."],
  // EMPTY on purpose. The supported list rendered under the summary is the
  // whole answer; a step reading "open a project that declares vue or react"
  // restates it in imperative mood. The second step here used to editorialise
  // about Svelte, Solid and Angular having no source stamper, which told the
  // user about our internals rather than about anything they can do.
  "missing-framework": () => [],
  // Also empty. "Upgrade the project to Vue 3" is not advice a designer can
  // act on, and "Vue 2 support is not on the roadmap" is a roadmap statement
  // in an error message.
  "wrong-vue-major": () => [],
}

/**
 * A `HostFailure` from `resolveHost`, rendered for the launcher.
 *
 * Deliberately a pass-through. Its `summary`, `cause` and `remediation` are
 * already the product-facing artifact (`hosts/types.ts` designed them before
 * the happy path); re-phrasing them here would give the GUI and the CLI two
 * different accounts of the same refusal.
 */
function fromHostFailure(
  failure: HostFailure,
  supported: LauncherSupportedHost[],
): LauncherOpenBlock {
  return {
    code: failure.code === "ambiguous-host" ? "ambiguous-host" : "no-in-process-host",
    summary: failure.summary,
    ...(failure.cause ? { cause: failure.cause } : {}),
    remediation: failure.remediation,
    attachCovers: failure.attachCovers,
    supported,
  }
}

/**
 * A framework that resolved to a host this project will not boot.
 *
 * The only framework in this state today is Astro, and the answer it gets is
 * the same "not supported" the detection failures get. See the note where
 * `WHY_OFF` used to live for why the built-but-dormant distinction was dropped.
 *
 * The label comes from the host registry rather than a literal, so the sentence
 * names Astro (or whatever is dormant next) without this file knowing which.
 * `supported` cannot supply it any more, since it now lists only enabled hosts.
 */
function unsupportedFrameworkBlock(
  hostId: Exclude<HostId, "attach">,
  supported: LauncherSupportedHost[],
): LauncherOpenBlock {
  const factory = getHostFactory(hostId)
  const label = factory ? factory().displayName : hostId
  return {
    code: "framework-unsupported",
    summary: `${label} isn't supported.`,
    // No `cause`: there is no evidence to show. The detection worked, the
    // framework is simply not one that opens.
    remediation: [],
    // FALSE, matching every other unsupported case. Attach would proxy the app
    // and then refuse every edit, which is a worse outcome than not offering
    // it: the missing piece is downstream of booting.
    attachCovers: false,
    supported,
  }
}

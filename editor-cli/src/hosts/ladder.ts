import type { HostFailure, HostId, StampEvidence } from "./types.js"

/**
 * What happens when in-process boot cannot be trusted.
 *
 * **The rung that does not exist is the point.** There is no outcome here that
 * boots and continues with a known-broken stamper: `verifyStamping` returning
 * `unstamped` closes the server it just booted BEFORE this module is consulted
 * (see {@link applyStampGate}), so by the time `decide` runs there is nothing
 * left running to keep.
 *
 * Attach mode is the floor under every rung. It needs none of our in-process
 * seams, which is why `attachCovers` is true for every seam / boot / verify
 * failure and why the message always ends in two commands the user can paste.
 */

export type HostMode = "auto" | "in-process" | "attach"

export type LadderDecision =
  | { action: "run-in-process" }
  /** Print WHY in-process was skipped, then the two commands. Exit 4. */
  | { action: "require-attach"; failure: HostFailure; message: string }
  /** `--host-mode=in-process` was explicit. Never degrade silently. Exit 6. */
  | { action: "fail"; failure: HostFailure; message: string }

/**
 * What `decide` needs to know about the host — deliberately NARROWER than
 * `DevServerHost`, which satisfies it structurally, so the ladder can be driven
 * from a booted run's recorded identity without anyone being able to boot the
 * host a second time from a failure path.
 */
export interface HostDescriptor {
  readonly id: HostId
  readonly displayName: string
  /** What to run instead, e.g. `npx nuxt dev`. Printed verbatim as step 1. */
  readonly devCommand: string
}

/** Carries a rendered {@link LadderDecision} out of `startCore` to the CLI. */
export class HostLadderError extends Error {
  constructor(readonly decision: Extract<LadderDecision, { action: "require-attach" | "fail" }>) {
    super(decision.message)
    this.name = "HostLadderError"
  }
}

export function decide(
  mode: HostMode,
  failure: HostFailure | null,
  host: HostDescriptor,
): LadderDecision {
  if (failure === null) {
    if (mode === "attach") {
      // Reaching here means an in-process run succeeded under a mode that said
      // not to attempt one — i.e. `--attach <url>` did not short-circuit
      // upstream as it must. Refusing beats silently honouring the run, because
      // the user asked for their own dev server and would be looking at ours.
      const synthetic: HostFailure = {
        code: "no-in-process-host",
        summary: "--host-mode=attach was requested, so the in-process host must not be used.",
        remediation: ["Pass --attach <url> naming the dev server you started."],
        attachCovers: true,
      }
      return { action: "require-attach", failure: synthetic, message: render(synthetic, host, "auto") }
    }
    return { action: "run-in-process" }
  }

  const message = render(failure, host, mode)

  if (!failure.attachCovers) {
    // § 1 marks this unreachable — a repo we cannot serve at all is
    // `FrameworkUnsupportedError`'s job (exit 3), decided before any host runs.
    // If it IS reached, an upstream gate missed it, and printing "use attach
    // mode" would be advice that cannot work. Fail loudly instead.
    return { action: "fail", failure, message }
  }

  // `--host-mode=in-process` is an explicit request to see the failure rather
  // than be routed around it. Degrading here would make the flag a no-op in
  // exactly the case it was passed for.
  if (mode === "in-process") return { action: "fail", failure, message }

  return { action: "require-attach", failure, message }
}

/**
 * The one renderer. `run.ts` has a provisional `formatHostFailure` for failures
 * that never reach the ladder (a probe refusal thrown as `HostBootError`); this
 * is the full form — it names the seam, quotes the expression, states that the
 * project is fine, and gives the two commands.
 */
function render(
  failure: HostFailure,
  host: HostDescriptor,
  mode: HostMode,
): string {
  const lines: string[] = [failure.summary, ""]

  if (failure.seam) {
    lines.push(`  Seam:       ${failure.seam.id}  (${failure.seam.stability.toUpperCase()})`)
    lines.push(`  Expression: ${failure.seam.expression}`)
    lines.push(`  Buys:       ${failure.seam.buys}`)
  }
  if (failure.detected) {
    lines.push(
      `  Detected:   ${failure.detected.package} ${failure.detected.installed}   ` +
        `(measured working: ${failure.detected.tested})`,
    )
  }
  if (failure.cause) lines.push(`  Cause:      ${failure.cause}`)
  if (failure.seam || failure.detected || failure.cause) lines.push("")

  if (failure.code === "injection-not-observed") {
    // Said explicitly, because "the server is up" and "the server was shut
    // down" are both surprising on their own and the user will otherwise go
    // looking for a dev server that is no longer there.
    lines.push(
      "The dev server has been shut down rather than left running in an inspect-only state.",
      "",
    )
  }

  if (failure.seam && failure.seam.stability !== "public") {
    // The customer's first instinct on any of these is "my project is broken".
    // For a private/experimental seam that is never true, so say so.
    lines.push(
      `This is the failure to expect from a ${host.displayName} upgrade: the seam is`,
      `${failure.seam.stability} and may move in any release. Nothing is wrong with your project.`,
      "",
    )
  }

  // Stated, not instructed. This text is printed to a terminal AND relayed
  // into the launcher's failure block as `cause`, where the reader has no
  // terminal in front of them — so it says what Editor does next rather than
  // handing them a command to run. `host.devCommand` survives because it is
  // the user's own dev command, and naming it tells them which server we mean.
  lines.push(
    `Attach mode does not use this seam and covers ${host.displayName} fully:`,
    `it runs this project's own dev server (${host.devCommand}) and connects to it.`,
    "",
  )

  if (mode === "in-process") {
    lines.push(
      "--host-mode=in-process was passed, so Editor did not fall back to attach mode.",
    )
  } else {
    lines.push("To keep the in-process path and fail loudly instead, pass --host-mode=in-process.")
  }
  if (failure.code === "injection-not-observed") {
    lines.push("If you believe this is wrong, --skip-stamp-verify boots anyway.")
  }

  return lines.join("\n")
}

/* ══════════════════════════════════════════════════════════════════════════
 * The gate itself
 * ══════════════════════════════════════════════════════════════════════════ */

export interface StampGateInput {
  evidence: StampEvidence
  mode: HostMode
  /** `--skip-stamp-verify`. Downgrades a refusal to a warning, never silently. */
  skipVerify: boolean
  host: HostDescriptor
  /**
   * Closes the dev server that was just booted. Awaited BEFORE the decision is
   * returned — § 5 milestone 5: "`unstamped` closes the server". A caller that
   * received a `refuse` may assume nothing is still listening.
   */
  close: () => Promise<void>
}

export type StampGateOutcome =
  /** Keep serving. `warning` is non-null when the verdict was not conclusive. */
  | { kind: "continue"; warning: string | null }
  /** The server has already been closed. Render `decision.message` and exit. */
  | { kind: "refuse"; decision: Extract<LadderDecision, { action: "require-attach" | "fail" }> }

/**
 * Adjudicate one {@link StampEvidence}: continue, warn, or tear down.
 *
 * The asymmetry between the two non-`stamped` verdicts is the whole design.
 * `indeterminate` must NOT close the server — a client-rendered app produces it
 * on every boot, and closing there would refuse to run every SPA. `unstamped`
 * must close it — the server is healthy and every edit would be refused, so
 * leaving it up buys the user an inspect-only session they did not ask for and
 * will discover mid-click.
 */
export async function applyStampGate(input: StampGateInput): Promise<StampGateOutcome> {
  const { evidence } = input

  if (evidence.verdict === "stamped") return { kind: "continue", warning: null }

  if (evidence.verdict === "indeterminate") {
    return {
      kind: "continue",
      warning: `Stamping could not be confirmed at boot: ${evidence.reason}.`,
    }
  }

  if (input.skipVerify) {
    // The override exists so a false positive cannot brick a session. It says
    // out loud what it is overriding — a silent skip would be a worse failure
    // than the one it bypasses.
    return {
      kind: "continue",
      warning:
        `Stamping verification FAILED (${evidence.how}) and --skip-stamp-verify was passed, ` +
        "so Editor is serving anyway. Edits will be refused until the stamper runs.",
    }
  }

  await input.close()
  const decision = decide(input.mode, evidence.failure, input.host)
  if (decision.action === "run-in-process") {
    // `decide` only answers this for a null failure, and we passed one. Kept as
    // an explicit refusal rather than a cast: if that ever changes, a booted
    // server has already been closed and continuing would serve a dead URL.
    throw new Error("Ladder returned run-in-process for a stamping failure. Unreachable.")
  }
  return { kind: "refuse", decision }
}

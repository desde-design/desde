import { isAbsolute, resolve as resolvePath } from "node:path"
import { stampingCoverage } from "./coverage.js"
import { loadEnabledHosts } from "./enabled-hosts.js"
import { getHostFactory, inProcessHostIds } from "./registry.js"
import { attachConfigHostFor, resolveHost } from "./resolve.js"
import { detectFramework } from "../server/framework-detection.js"
import type { AnyDevServerHost } from "./registry.js"
import type { HostDetection, HostId, SourceLanguage } from "./types.js"

/**
 * `--doctor`: what Editor believes about this project, and which seams it would
 * stand on, printed WITHOUT booting anything.
 *
 * **Why this exists.** The failure messages this design is built around name a
 * seam and quote its expression so the fix is greppable — but they only appear
 * once something has broken. A support conversation that starts "it says it
 * cannot boot my Nuxt app" has no facts in it. `--doctor` is the same facts,
 * available before the failure and cheap enough to paste into an issue: what was
 * detected and why, which host would run, what that host stands on, and what it
 * could and could not stamp.
 *
 * **It boots nothing and it probes nothing.** No `probe()` call, no dev server,
 * no `node_modules` resolution — detection reads `package.json` and the host
 * objects are constructed by lazy factories that import no framework. That is
 * what makes it safe to run on a project whose dependencies are not installed,
 * which is exactly the project most likely to be asking for help. The cost is
 * that it reports DECLARED facts: "this project says it is Nuxt", not "Nuxt is
 * installed and its seams still resolve".
 *
 * **Exit code.** `cli.ts` exits 0 whenever a report was produced, including one
 * that reports a refusal. The report is the deliverable; its exit code says
 * whether the report could be written, not whether the project can boot.
 */

export interface DoctorOptions {
  repoPath: string
  /** `--host <id>`, so the report describes the host the next boot would use. */
  hostId?: HostId | undefined
  /** `--attach <url>`, already validated. Makes `attach` the resolved host. */
  attachUrl?: string | undefined
}

/** The whole report, as the block `cli.ts` prints. */
export async function runDoctor(opts: DoctorOptions): Promise<string> {
  const root = isAbsolute(opts.repoPath)
    ? opts.repoPath
    : resolvePath(process.cwd(), opts.repoPath)
  const out: string[] = [`Editor host report for ${root}`, ""]

  const detection = await detectFramework(root)
  if (!detection.ok) {
    out.push(
      `  Detection:    REFUSED (${detection.reason})`,
      "",
      indent(detection.message),
      "",
      "No host is resolved for a project Editor cannot read, so there is nothing further to report.",
    )
    return out.join("\n")
  }

  out.push(...renderDetection(detection))

  const enabled = await loadEnabledHosts(root)
  out.push(
    "",
    "Enabled for in-process boot",
    `  ${[...enabled.enabled].join(", ") || "(none)"}`,
    `  Everything else falls back to attach mode. Turn one on with {"hosts":{"<id>":true}}`,
    `  in desde.config.json. Built in this build: ${inProcessHostIds().join(", ")}.`,
  )
  for (const warning of enabled.warnings) out.push(`  ! ${warning}`)

  const resolution = resolveHost(detection, {
    hostId: opts.hostId,
    attachUrl: opts.attachUrl,
  })
  out.push("")
  if (!resolution.ok) {
    out.push(
      `Resolved host: NONE (${resolution.failure.code})`,
      indent(resolution.failure.summary),
    )
    if (resolution.failure.cause) out.push(indent(`Cause: ${resolution.failure.cause}`))
    for (const [i, step] of resolution.failure.remediation.entries()) {
      out.push(indent(`${i + 1}. ${step}`))
    }
    // ONLY for the downgrade. An `ambiguous-host` refusal fires on the attach
    // lane too — the stamping preflight has to pick one config file to read, and
    // it would pick with the same coin-flip — so naming a config shape here
    // would contradict the refusal three lines above it. Caught by running the
    // real CLI against the ambiguous fixture, which printed both.
    if (resolution.failure.code === "no-in-process-host") {
      out.push("", `Attach mode would wire the ${attachConfigHostFor(detection)} config shape.`)
    }
    return out.join("\n")
  }

  const factory = getHostFactory(resolution.hostId)
  if (factory === null) {
    // `resolveHost` refuses an unbuilt id, so this is defensive narrowing rather
    // than a reachable branch.
    out.push(`Resolved host: ${resolution.hostId} (no implementation in this build)`)
    return out.join("\n")
  }

  out.push(...renderHost(factory(), resolution.because, detection.languages))

  if (resolution.hostId !== "attach" && !enabled.enabled.has(resolution.hostId)) {
    out.push(
      "",
      `NOT ENABLED. \`desde ${opts.repoPath}\` would refuse with the attach instructions`,
      `rather than boot this host. Add {"hosts":{"${resolution.hostId}":true}} to opt in.`,
    )
  }

  return out.join("\n")
}

function renderDetection(detection: HostDetection & { ok: true }): string[] {
  const out = [
    "Detection (reads package.json only: declared, not installed)",
    `  Framework:    ${detection.framework}`,
    `  Languages:    ${detection.languages.join(", ")}`,
    "  Candidates:",
  ]
  if (detection.candidates.length === 0) {
    out.push("    (none: this project would downgrade to attach mode)")
  }
  for (const candidate of detection.candidates) {
    out.push(`    ${candidate.hostId}  (${candidate.confidence})`)
    for (const because of candidate.because) out.push(`      - ${because}`)
  }
  for (const warning of detection.warnings) out.push(`  ! ${warning}`)
  return out
}

function renderHost(
  host: AnyDevServerHost,
  because: readonly string[],
  languages: readonly SourceLanguage[],
): string[] {
  const out = [
    `Resolved host: ${host.id} (${host.displayName})`,
    ...because.map((line) => `  ${line}`),
    "",
    `  Dev command:  ${host.devCommand}`,
    `  Stamper:      ${host.accepts}`,
    `  Bridge tags:  ${host.bridgeTags}`,
    `  Build dirs:   ${host.buildDirs.join(", ") || "(none)"}`,
    `  Version gate: ${
      host.versionGate
        ? `${host.versionGate.packageName} ${host.versionGate.tested} (measured working)`
        : "(no package of ours resolves from the prototype)"
    }`,
    "",
    "  Seams this host stands on",
  ]
  if (host.seams.length === 0) {
    // Attach. Worth a sentence rather than a blank, because "none" here is the
    // reason every other host's failure message can end in "use attach mode".
    out.push("    (none: this is why attach mode is the fallback for every host failure)")
  }
  for (const seam of host.seams) {
    out.push(`    ${seam.id}  [${seam.stability.toUpperCase()}]`)
    out.push(`      expression: ${seam.expression}`)
    out.push(`      buys:       ${seam.buys}`)
    if (host.stamperSeam && host.stamperSeam.id === seam.id) {
      out.push("      ^ the channel a healthy-but-unstamped boot would name")
    }
  }

  // Coverage from the HOST's own answer, not from `detection.languages`: the
  // host is what decides which dialects it stamps (Astro adds `.astro`
  // unconditionally; React Router filters to what its Vite lane transforms), and
  // asking detection instead would report a set nothing acts on.
  //
  // The declared-package set is deliberately EMPTY here, exactly as it is in
  // `runHost` — see `NO_INSTALLED_PACKAGES` there for why widening on it today
  // would produce a coverage claim with no injected stamper behind it.
  const coverage = stampingCoverage(
    host.stampLanguages(doctorContext(languages), new Set<string>()),
    host.accepts,
  )
  out.push("", "  Stamping coverage")
  for (const covered of coverage.covered) {
    out.push(`    ${covered.language}: covered via ${covered.via}`)
  }
  for (const gap of coverage.uncovered) out.push(`    ${gap.language}: NOT covered (${gap.reason})`)
  if (coverage.covered.length === 0) {
    out.push("    Nothing is stampable, so this session would be inspect-only.")
  }
  return out
}

/**
 * The narrowest thing `stampLanguages` actually reads.
 *
 * Every implementation touches `ctx.languages` and nothing else, so a full
 * {@link HostContext} would mean inventing a repo root, a stamp policy, two port
 * pairs and an `AbortSignal` — five fabricated values in a report whose whole
 * claim is that it states facts. The cast is confined to this one function and
 * is why it exists.
 */
function doctorContext(languages: readonly SourceLanguage[]): Parameters<
  AnyDevServerHost["stampLanguages"]
>[0] {
  return { languages } as Parameters<AnyDevServerHost["stampLanguages"]>[0]
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}

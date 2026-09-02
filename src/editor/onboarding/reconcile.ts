/**
 * Boot-time reconciliation of declared design systems (Phase 3 attach/refresh,
 * task 2) — the bridge between `designSystems` declarations in
 * `desde.config.json` (`../core/design-system-declarations.ts`)
 * and the registry those declarations onboard into
 * (`RegisteredDesignSystem` / `RegistryStore`).
 *
 * A declaration is a statement of intent ("this prototype wants
 * `@acme/ds` onboarded"); the registry is the record of what's actually been
 * extracted. Reconciliation is one-directional and additive: it onboards
 * declared-but-unregistered systems, and never removes a registered system
 * whose declaration disappeared — that's a deliberate manual action, not
 * something a boot-time background pass should do silently (spec: destructive
 * syncs are manual; see the GET route's `declared: false` for the signal a
 * caller can act on).
 *
 * Pure/DI: every I/O boundary (list the registry, onboard one declaration) is
 * injected via {@link ReconcileDeps} so this module has zero fs/network of its
 * own and is fully unit-testable with fakes. The editor-cli boot sequence
 * wires `deps.listRegistry` to `createLocalRegistryStore(root).list` and
 * `deps.onboard` to `onboardDesignSystem` + `createDefaultOnboardDeps(root)`.
 */

import { declarationIdentity } from '@/editor/core/design-system-declarations'
import type { DesignSystemDeclaration } from '@/editor/core/design-system-declarations'
import type { DesignSystemSource, OnboardRequest, OnboardResult, RegisteredDesignSystem } from './types'

export interface ReconcileEntryStatus {
  /** `declarationIdentity(source)` — stable dedupe/match key. */
  identity: string
  /** Human-readable package/spec/url for display. */
  label: string
  kind: DesignSystemSource['kind']
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
  /** Failure message, or the skip reason. */
  reason?: string
  /** Set when `state === 'done'` — the registry entry's id. */
  registryEntryId?: string
}

export interface ReconcileStatus {
  startedAt: string | null
  entries: ReconcileEntryStatus[]
}

/**
 * Mutable box the CLI boot sequence writes into (`editor-cli/src/core.ts`,
 * after `startHttpServer` is up) and the HTTP layer reads from per request
 * (`editor-cli/src/server/http-server.ts` → `design-systems-handler.ts`'s
 * GET route). A holder rather than a plain value because reconciliation
 * starts AFTER the options object is constructed and handed to
 * `startHttpServer` — mutating `.current` is how the async result becomes
 * visible to requests that land after it completes.
 */
export interface ReconciliationStatusHolder {
  current: ReconcileStatus | null
}

export interface ReconcileDeps {
  listRegistry: () => Promise<RegisteredDesignSystem[]>
  /** Wraps `onboardDesignSystem` + `createDefaultOnboardDeps` for one prototype root. */
  onboard: (req: OnboardRequest) => Promise<OnboardResult>
  onStatusChange?: (status: ReconcileStatus) => void
}

/**
 * Identity a registered entry is matched against a declaration by. Mirrors
 * the matching rule in the brief: `installed`/`npm` registry entries compare
 * on `entry.package` (the resolved, version-free package name — the same
 * shape `declarationIdentity` produces for `installed`/`npm` declarations);
 * `repo` entries compare on `declarationIdentity(entry.source)` so the
 * url|ref|subdir triple has to match, not just the resolved package name
 * (two different refs of the same repo are distinct declarations).
 */
export function registryEntryIdentity(entry: RegisteredDesignSystem): string {
  return entry.source.kind === 'repo' ? declarationIdentity(entry.source) : entry.package
}

function labelForSource(source: DesignSystemSource): string {
  if (source.kind === 'installed') return source.package
  if (source.kind === 'npm') return source.spec
  return source.url
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Deep-enough clone so a caller's `onStatusChange` snapshot isn't mutated by later steps. */
function cloneStatus(status: ReconcileStatus): ReconcileStatus {
  return { startedAt: status.startedAt, entries: status.entries.map((entry) => ({ ...entry })) }
}

/**
 * Sequentially onboards declared-but-unregistered systems. Never throws —
 * every failure (reading the registry, one onboard call) lands as a
 * `'failed'` entry in the returned status so one bad declaration can't sink
 * the rest. Sequential (not parallel) because onboarding is heavyweight
 * (npm install / git clone / TS-checker walk) and per-package failures should
 * be individually attributable rather than racing.
 */
export async function reconcileDesignSystems(opts: {
  prototypeRoot: string
  declarations: DesignSystemDeclaration[]
  deps: ReconcileDeps
}): Promise<ReconcileStatus> {
  const { prototypeRoot, declarations, deps } = opts

  const status: ReconcileStatus = {
    startedAt: new Date().toISOString(),
    entries: declarations.map((decl) => ({
      identity: declarationIdentity(decl.source),
      label: decl.designSystem ?? labelForSource(decl.source),
      kind: decl.source.kind,
      state: 'pending',
    })),
  }
  const emit = () => deps.onStatusChange?.(cloneStatus(status))
  emit()

  let registeredIdentities: Set<string>
  try {
    const registry = await deps.listRegistry()
    registeredIdentities = new Set(registry.map(registryEntryIdentity))
  } catch (err) {
    // Can't tell what's already registered — mark every declaration failed
    // rather than risk re-onboarding something that's actually fine.
    const reason = `couldn't read the design-system registry: ${errorMessage(err)}`
    for (const entry of status.entries) {
      entry.state = 'failed'
      entry.reason = reason
    }
    emit()
    return status
  }

  for (let i = 0; i < declarations.length; i++) {
    const decl = declarations[i]
    const entry = status.entries[i]

    if (registeredIdentities.has(entry.identity)) {
      entry.state = 'skipped'
      entry.reason = 'already registered'
      emit()
      continue
    }

    entry.state = 'running'
    emit()
    try {
      // `allowBuild` is only meaningful for `repo` sources (permits running
      // the cloned repo's build script to emit `.d.ts`) — the orchestrator's
      // `ingest()` only reads it in the `repo` branch. `validateDeclaration`
      // accepts it structurally on any kind, so passing it through
      // unconditionally here is harmless (installed/npm onboards silently
      // ignore it); we still gate it on `repo` for clarity at the call site.
      //
      // **Defaults to FALSE here, unlike every other lane** (audit S13).
      // Reconciliation is AUTOMATIC and fires at boot for whatever the
      // OPENED REPO's `desde.config.json` declares. `allowBuild`
      // means "clone this URL and run its build script as me" — so an unset
      // value in a file the developer did not author must not be read as
      // consent. The value at a REMOTE url is also invisible to whoever
      // reviews the three-line JSON diff that introduced the declaration,
      // which is the PR-poisoning shape rather than the "you opened a
      // hostile repo" shape.
      //
      // `true` is still honoured when the declaration SAYS `true` — the
      // launcher / panel write that explicitly, through the
      // bearer-authenticated, user-initiated add + refresh routes, which
      // keep their `body.allowBuild !== false` posture. The asymmetry is the
      // point: explicit user-initiated attachment may build; automatic
      // boot-time materialization may not.
      const req: OnboardRequest = {
        source: decl.source,
        prototypeRoot,
        designSystem: decl.designSystem,
        ...(decl.source.kind === 'repo' ? { allowBuild: decl.allowBuild ?? false } : {}),
      }
      const result = await deps.onboard(req)
      entry.state = 'done'
      entry.registryEntryId = result.registryEntryId
      // Defensive: if two declarations somehow share an identity (shouldn't
      // happen — `appendDesignSystemDeclaration` dedupes on write), don't
      // onboard the same package twice in one reconcile pass.
      registeredIdentities.add(entry.identity)
    } catch (err) {
      entry.state = 'failed'
      entry.reason = errorMessage(err)
    }
    emit()
  }

  return status
}

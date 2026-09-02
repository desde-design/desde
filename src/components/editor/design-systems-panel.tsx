"use client"

/**
 * "Design Systems" panel (onboarding milestone 6.4) — the first user-visible
 * surface for self-serve onboarding. Lists the registered design systems, lets
 * the user add a detected installed library in one click or an arbitrary npm
 * spec, and streams onboarding progress live. Backed by {@link useDesignSystems}
 * over the CLI `/api/editor/design-systems` routes.
 */

import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { Callout, Eyebrow, StatusDot, type StatusTone } from "@/components/blocks"
import { useDesignSystems } from "@/hooks/useDesignSystems"
import { useDriftEntries } from "@/hooks/useDriftEntries"
import { supportsProbeHints } from "@/editor/hints/probe-capability"
import type { OnboardStage } from "@/editor/onboarding/types"
import type { ReconcileEntryStatus } from "@/editor/onboarding/reconcile"
import type { DriftEntry, DriftKind } from "@/editor/core"
import { formatRelativeTimeShort } from "@/lib/relative-time"
import { sectionHeaderTextClass } from "./section-header"
import { AddDesignSystem, type AddDesignSystemSource } from "./design-systems/add-design-system"

const DRIFT_KIND_LABEL: Record<DriftKind, string> = {
  "hint-miss": "hint miss",
  "selector-ambiguous": "ambiguous selector",
  "unknown-component": "unknown component",
  "unknown-props": "unknown props",
  "manifest-value-mismatch": "unknown value",
}

type RepairOutcome = NonNullable<DriftEntry["repair"]>["outcome"]

const REPAIR_OUTCOME_LABEL: Record<RepairOutcome, string> = {
  pending: "Auto-repair running…",
  repaired: "Auto-repaired",
  // Escalation copy (Task 5 brief): points explicitly at "Regenerate hints",
  // the first escalation action on this row — the manifest wasn't the
  // problem, so re-extracting it again would repeat the same no-op.
  //
  // "manifest" is OUR word for the cached record of what a component accepts.
  // The reader has no such thing, so the copy says what was checked and what
  // it means for them instead.
  unchanged: "Nothing stale in this component: regenerate hints to refresh them",
  // Same escalation target as `unchanged`, different reason why: there was
  // no cached manifest to compare against at all (a cache miss, not a
  // confirmed-stale value), so a fresh one was written but nothing was
  // actually proven stale. Don't reuse `repaired`'s copy here — that would
  // imply the problem is solved, which isn't demonstrated. The copy has to
  // keep that "read, not fixed" distinction without naming the cache.
  seeded: "This component hadn't been read yet, so it was read now. If this still won't attribute, regenerate hints",
  failed: "Auto-repair failed",
  unsupported: "Auto-repair unavailable for this component",
}

const STAGE_LABEL: Record<OnboardStage, string> = {
  ingesting: "Installing…",
  detecting: "Detecting framework…",
  extracting: "Learning its components",
  "computing-coverage": "Measuring coverage…",
  registering: "Registering…",
}

const HEALTH_STATUS_TONE: Record<"ok" | "skipped" | "failed", StatusTone> = {
  ok: "success",
  skipped: "muted",
  failed: "destructive",
}

const RUNTIME_ERRORS_SHOWN = 5

export function DesignSystemsPanel({
  invalidateManifest,
  showTitle = true,
  padded = true,
  onModeChange,
}: {
  /**
   * Final review fix wave — forwarded straight to `useDriftEntries` so a
   * dismiss/clear/regenerate-hints response's `invalidate` list drops the
   * SAME `CachedManifestLookup` entry `useEditorEditing`'s attribution
   * path reads from (see that hook's `invalidateAttributionManifest`).
   * Optional: omitted in the panel's own colocated tests (which mock
   * `useDriftEntries` directly) and in any host that has no live lookup to
   * invalidate.
   */
  invalidateManifest?: (entries: Array<{ name: string; importPath?: string }>) => void
  /**
   * False when the host already titles this panel. The Design systems dialog
   * does, and printing it twice made the panel read as a nested section.
   */
  showTitle?: boolean
  /**
   * Reports whether the panel is showing its list or its add flow, so a host
   * that owns the title (the Design systems dialog) can name the step the user
   * is actually on instead of leaving "Design systems" over an add form.
   */
  onModeChange?: (mode: "list" | "add") => void
  /**
   * The panel supplies its own padding in the right rail. Inside a dialog the
   * DialogContent already pads, and doubling it inset the content further than
   * every other section in the same dialog.
   */
  padded?: boolean
} = {}) {
  const ds = useDesignSystems()
  const drift = useDriftEntries({ invalidateManifest })
  // Phase 4 Task 5 — opt-in LLM hint-generation lane. Off by default (a real
  // LLM call per unreachable component); one checkbox gates every row's
  // "Generate hints" action below.
  const [useLlmHints, setUseLlmHints] = useState(false)
  /**
   * Non-null means the panel is in add mode: its body is the stepped add flow
   * instead of the list. `source: undefined` starts on the source picker; a
   * drift row's "Add design system" (Phase 5 Task 5) deep-links straight to
   * the npm form with the spec pre-filled.
   *
   * `key`s the <AddDesignSystem> instance so clicking a DIFFERENT row's action
   * forces a remount, since `initialNpmSpec` is only read once, at mount.
   */
  const [addSeed, setAddSeed] = useState<{
    spec: string
    source: AddDesignSystemSource | undefined
  } | null>(null)

  useEffect(() => {
    onModeChange?.(addSeed ? "add" : "list")
  }, [addSeed, onModeChange])

  const registeredPackages = new Set(ds.systems.map((s) => s.package))
  // A library already registered shouldn't show up as a fresh suggestion.
  const freshSuggestions = ds.suggestions.filter((s) => !registeredPackages.has(s.package))

  // Scan-health rows: only sources worth a second look — a clean cache hit
  // that fully succeeded isn't news. `health === null` means no manifest
  // bundle has been built yet this session (not an error) — the section
  // renders nothing at all in that case, not an empty state.
  const healthRows = ds.health?.sources.filter((s) => s.status !== "ok" || s.cache) ?? []
  const runtimeErrors = ds.health?.runtimeErrors ?? []

  // Phase 3 attach/refresh: boot-time reconciliation of declared-but-
  // unregistered systems. `reconciliation` is null before any declarations
  // exist / before the async pass has produced a first snapshot.
  const reconcilingEntries: ReconcileEntryStatus[] =
    ds.reconciliation?.entries.filter((e) => e.state === "pending" || e.state === "running") ?? []
  const failedReconcileEntries: ReconcileEntryStatus[] =
    ds.reconciliation?.entries.filter((e) => e.state === "failed") ?? []

  return (
    <section
      className={cn("flex h-full flex-col gap-3", padded ? "p-3" : "")}
      aria-label="Design systems"
    >
      {/*
        The header keeps its busy readout either way; only the title is
        conditional. Hosted in the Design systems DIALOG the title is already
        the dialog's, and printing it twice made the panel look like a nested
        section rather than the dialog's body.
      */}
      <header className="flex items-center justify-between">
        {showTitle ? (
          <h3 className={sectionHeaderTextClass}>Design systems</h3>
        ) : (
          <span />
        )}
        {ds.busy ? (
          <span className="truncate text-sm text-muted-foreground">
            {ds.hintProgress
              ? `Probing ${ds.hintProgress.component} (${ds.hintProgress.index + 1}/${ds.hintProgress.total})`
              : ds.progress
                ? STAGE_LABEL[ds.progress]
                : "Working…"}
          </span>
        ) : null}
      </header>

      {ds.error ? (
        <Callout
          tone="destructive"
          role="alert"
          className="flex items-start justify-between gap-2"
        >
          <span className="break-words">{ds.error}</span>
          <Button
            type="button"
            variant="link"
            onClick={ds.clearError}
            className="h-auto shrink-0 p-0 font-normal underline-offset-2 hover:underline"
          >
            Dismiss
          </Button>
        </Callout>
      ) : null}

      {ds.declarationsError ? (
        <Callout tone="warning" role="alert">
          Shared config has errors: {ds.declarationsError}
        </Callout>
      ) : null}

      {reconcilingEntries.length > 0 ? (
        <Callout tone="info">
          <p>Setting up {reconcilingEntries.length} declared design system(s)…</p>
          <ul className="mt-0.5 space-y-0.5">
            {reconcilingEntries.map((e) => (
              <li key={e.identity} className="truncate text-xs">
                {e.kind}: {e.label}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {failedReconcileEntries.length > 0 ? (
        <Callout tone="warning">
          <ul className="space-y-0.5">
            {failedReconcileEntries.map((e) => (
              <li key={e.identity} className="truncate">
                {e.label}
                {e.reason ? `: ${e.reason}` : ""}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {/*
        Add mode replaces the body rather than appending to it. The three
        sources used to sit in a permanent tab strip below the list, which made
        this dialog four sections deep and left a half-filled form on screen for
        everyone who only came to read the list.
      */}
      {addSeed ? (
        <AddDesignSystem
          key={`${addSeed.source ?? "pick"}:${addSeed.spec}`}
          suggestions={freshSuggestions}
          loading={ds.loading}
          busy={ds.busy}
          onAddInstalled={ds.addInstalled}
          onAddNpm={ds.addNpm}
          onAddRepo={ds.addRepo}
          initialSource={addSeed.source}
          initialNpmSpec={addSeed.spec}
          onAdded={() => setAddSeed(null)}
          onCancel={() => setAddSeed(null)}
        />
      ) : (
        <>
        {/* Registered systems */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-end gap-1.5">
            {ds.systems.length > 0 ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={ds.busy}
                onClick={() => ds.checkUpdates(true)}
              >
                Check for updates
              </Button>
            ) : null}
            <Button
              size="xs"
              disabled={ds.busy}
              onClick={() => setAddSeed({ spec: "", source: undefined })}
              data-testid="open-add-design-system"
            >
              Add design system
            </Button>
          </div>
          {ds.systems.length > 0 ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <label className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
                    <Checkbox
                      checked={useLlmHints}
                      onCheckedChange={(checked) => setUseLlmHints(checked === true)}
                      data-testid="use-llm-hints-checkbox"
                    />
                    Use LLM for hard-to-reach components
                  </label>
                </TooltipTrigger>
                <TooltipContent>
                  Uses your Claude account/API for components probing and inference can&apos;t reach.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}
          {ds.loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : ds.systems.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No design systems registered yet.
            </p>
          ) : (
            <ul className="space-y-1">
              {ds.systems.map((s) => {
                const stale = ds.updates[s.id]?.state === "update-available"
                // Probe-derived hints (Phase 4 Task 3) mount the component in
                // an isolation page that only ever renders Vue — see
                // `src/editor/hints/probe-capability.ts` for the full reason
                // and the SAME check the CLI's generate-hints route makes
                // (both ends must agree, per CLAUDE.md's "lanes" gating
                // rule). Disabled rather than hidden so the user can tell
                // why, instead of the control just vanishing.
                const hintsSupported = supportsProbeHints(s.framework)
                return (
                <li
                  key={s.id}
                  className="flex items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-1.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-normal">{s.designSystem}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {s.package}
                      {s.version ? `@${s.version}` : ""}
                      {s.resolvedCommit ? ` · ${s.resolvedCommit.slice(0, 12)}` : ""}
                    </p>
                    {!s.declared ? (
                      <p className="truncate text-xs text-muted-foreground">not in shared config</p>
                    ) : null}
                    {s.hintCoverage ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {s.hintCoverage.hinted} of {s.hintCoverage.total} components hinted (
                        {s.hintCoverage.verified} verified)
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {stale ? (
                      <Badge variant="outline" className="text-warning">
                        Update available
                      </Badge>
                    ) : null}
                    <Badge variant="outline">
                      {s.framework}
                    </Badge>
                    {stale ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={ds.busy}
                        onClick={() => ds.refresh(s.id)}
                      >
                        Refresh
                      </Button>
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={ds.busy || !hintsSupported}
                      onClick={() => ds.generateHints(s.id, useLlmHints)}
                      title={
                        hintsSupported
                          ? undefined
                          : `Probe-derived rendering hints are Vue-only today; "${s.framework}" isn't supported yet.`
                      }
                    >
                      Generate hints
                    </Button>
                    {!s.declared ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={ds.busy}
                        onClick={() => ds.share(s.id)}
                      >
                        Add to shared config
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs text-destructive hover:text-destructive"
                      disabled={ds.busy}
                      onClick={() => ds.remove(s.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </li>
                )
              })}
            </ul>
          )}
        </div>

        {ds.health ? (
          <>
            <Separator />
            <div className="shrink-0 space-y-1.5">
              <Eyebrow>Scan health</Eyebrow>
              {healthRows.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  All sources built clean.
                </p>
              ) : (
                <ul className="space-y-1">
                  {healthRows.map((entry) => (
                    <li
                      key={`${entry.step}:${entry.sourceId}`}
                      className="flex items-start gap-2 rounded-md border bg-card px-2.5 py-1.5"
                    >
                      <StatusDot tone={HEALTH_STATUS_TONE[entry.status]} className="mt-1" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-normal">
                          {entry.packageName ?? entry.sourceId}
                          {entry.cache ? (
                            <span className="ml-1.5 text-xs text-muted-foreground">
                              cache {entry.cache}
                            </span>
                          ) : null}
                        </p>
                        {entry.reason ? (
                          <p className="truncate text-xs text-muted-foreground">
                            {entry.reason}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {runtimeErrors.length > 0 ? (
                <Callout tone="warning">
                  <ul className="space-y-0.5">
                    {runtimeErrors.slice(0, RUNTIME_ERRORS_SHOWN).map((e) => (
                      <li key={`${e.sourceId}:${e.method}:${e.at}`} className="truncate">
                        {e.sourceId}: {e.message}
                      </li>
                    ))}
                  </ul>
                  {runtimeErrors.length > RUNTIME_ERRORS_SHOWN ? (
                    <p className="mt-1 text-xs">
                      +{runtimeErrors.length - RUNTIME_ERRORS_SHOWN} more
                    </p>
                  ) : null}
                </Callout>
              ) : null}
            </div>
          </>
        ) : null}

        {/* Drift (Phase 5 Task 5) — hidden entirely when the log is empty,
            not rendered as an empty state; a clean log isn't news. */}
        {drift.entries.length > 0 ? (
          <>
            <Separator />
            <div className="shrink-0 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Eyebrow>Drift</Eyebrow>
                <div className="flex items-center gap-2">
                  {drift.busy && drift.regenerateProgress ? (
                    <span className="truncate text-xs text-muted-foreground">
                      Probing {drift.regenerateProgress.component} (
                      {drift.regenerateProgress.index + 1}/{drift.regenerateProgress.total})
                    </span>
                  ) : null}
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={drift.busy}
                    onClick={() => drift.clearAll()}
                  >
                    Clear all
                  </Button>
                </div>
              </div>

              {drift.error ? (
                <Callout
                  tone="destructive"
                  role="alert"
                  className="flex items-start justify-between gap-2"
                >
                  <span className="break-words">{drift.error}</span>
                  <Button
                    type="button"
                    variant="link"
                    onClick={drift.clearError}
                    className="h-auto shrink-0 p-0 font-normal underline-offset-2 hover:underline"
                  >
                    Dismiss
                  </Button>
                </Callout>
              ) : null}

              <ul className="space-y-1">
                {drift.entries.map((entry) => {
                  // The "Refresh design system" escalation targets the SAME
                  // registered entry the server's own regenerate-hints route
                  // resolves against (see `drift-handler.ts`'s
                  // `handleRegenerateHints`) — designSystem + importPath match.
                  const registeredMatch = entry.designSystem
                    ? ds.systems.find(
                        (s) =>
                          s.designSystem === entry.designSystem &&
                          (entry.importPath === undefined || s.importPath === entry.importPath),
                      )
                    : undefined
                  const showAddDesignSystem =
                    entry.kinds.includes("unknown-component") && !registeredMatch
                  const isRegeneratingThis = drift.regeneratingKey === entry.key

                  return (
                    <li
                      key={entry.key}
                      className="flex flex-col gap-1 rounded-md border bg-card px-2.5 py-1.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-normal">
                            {entry.component}
                            {entry.importPath ? (
                              <span className="ml-1.5 text-xs text-muted-foreground">
                                {entry.importPath}
                              </span>
                            ) : null}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {formatRelativeTimeShort(entry.lastSeen)} · seen ×{entry.count}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                          {entry.kinds.map((kind) => (
                            <Badge key={kind} variant="outline" className="text-xs">
                              {DRIFT_KIND_LABEL[kind]}
                            </Badge>
                          ))}
                        </div>
                      </div>

                      {entry.repair ? (
                        <p
                          className="truncate text-xs text-muted-foreground"
                          title={
                            entry.repair.reason
                              ? `${REPAIR_OUTCOME_LABEL[entry.repair.outcome]}: ${entry.repair.reason}`
                              : REPAIR_OUTCOME_LABEL[entry.repair.outcome]
                          }
                        >
                          {REPAIR_OUTCOME_LABEL[entry.repair.outcome]}
                          {entry.repair.reason ? `: ${entry.repair.reason}` : ""}
                        </p>
                      ) : null}

                      <div className="flex items-center justify-end gap-1.5">
                        {/* The server 422s regenerate-hints unconditionally
                            when the entry has no resolved designSystem (see
                            `handleRegenerateHints`'s "no resolved design
                            system" guard) — hide the action rather than offer
                            one that always fails. */}
                        {entry.designSystem ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={drift.busy}
                            onClick={() => drift.regenerateHints(entry.key)}
                          >
                            {isRegeneratingThis ? "Regenerating…" : "Regenerate hints"}
                          </Button>
                        ) : null}
                        {registeredMatch ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={ds.busy || drift.busy}
                            onClick={() => ds.refresh(registeredMatch.id)}
                          >
                            Refresh design system
                          </Button>
                        ) : null}
                        {showAddDesignSystem ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={ds.busy}
                            onClick={() => setAddSeed({ spec: entry.importPath ?? "", source: "npm" })}
                            data-testid="drift-add-design-system"
                          >
                            Add design system
                          </Button>
                        ) : null}
                        <Button
                          size="xs"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          disabled={drift.busy}
                          onClick={() => drift.dismiss(entry.key)}
                        >
                          Dismiss
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          </>
        ) : null}
        </>
      )}
    </section>
  )
}

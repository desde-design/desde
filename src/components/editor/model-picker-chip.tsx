"use client"

/**
 * Per-session model + effort picker for the chat editor's action row.
 *
 * Fetches the provider catalog once per mount from
 * `/api/editor/chat/model-catalog` (module-level cache so tab
 * switches don't refetch). `value === null` means "runtime default" —
 * the chip renders the catalog default's label. If the catalog can't
 * be fetched the chip renders nothing and the chat runs on defaults —
 * the picker must never block chatting.
 *
 * Load-bearing invariant: **the chip never displays a model different
 * from the one the next turn will actually run.** The chip is the only
 * component holding the catalog, so it owns both halves of keeping that
 * true — see `useEffect` below:
 *
 *  - *Adopt* — a chat with no choice of its own starts on the model the
 *    user last chose. The catalog response carries that as
 *    `lastChosenModel` (the newest session that has one — see
 *    `editor-cli/src/server/model-catalog-handler.ts`), and a choice
 *    made during THIS page-load takes precedence over it, because the
 *    catalog is fetched once per mount and cannot know about a pick
 *    made after it. Two chats reach the adopt branch: the
 *    project-default session (`sessionId === null`, the next turn sends
 *    no id) and a session the client just minted, which the caller
 *    marks by supplying `onAdoptLastChosenModel`. Sessions picked from
 *    the listing get theirs from tab-switch hydration instead.
 *  - *Reconcile* — a persisted/seeded model that has since left the
 *    catalog is dropped back to `null` (runtime default). The server
 *    tolerates a stale PERSISTED value but hard-400s a stale REQUEST
 *    override, so resending one would brick every send while the chip
 *    hid itself.
 *
 * The module-level cache itself (and `invalidateModelCatalogCache`, re-
 * exported below) lives in `src/lib/model-catalog-cache.ts` — see that
 * file's doc comment for why. Saving, removing or toggling a credential
 * invalidates it (`useLlmCredentials.ts`); this component reads the cache
 * through `useSyncExternalStore`, so every mounted chip sees the cache go
 * back to empty and the fetch effect below refetches it.
 */
import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { ChevronDown } from "lucide-react"
import { editorFetch } from "@/lib/editor-fetch"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { reconcileSessionModelConfig } from "@/editor/core/model-catalog"
import type { EffortLevel, SessionModelConfig } from "@/editor/core/model-catalog"
import {
  getCatalogCache,
  getCatalogVersion,
  getPickedThisLoad,
  setCatalogCacheIfVersion,
  setPickedThisLoad,
  subscribeCatalogCache,
  invalidateModelCatalogCache,
  type ModelCatalogResponse as CatalogResponse,
} from "@/lib/model-catalog-cache"

export { invalidateModelCatalogCache }

/** One radio value has to identify BOTH halves: two providers may reuse an id. */
const OPTION_VALUE_SEPARATOR = "::"
const optionValue = (providerId: string, modelId: string) =>
  `${providerId}${OPTION_VALUE_SEPARATOR}${modelId}`

/**
 * Display label for a provider group's `DropdownMenuLabel`.
 *
 * A small local map rather than an import from `src/editor/llm-providers` —
 * that directory reaches node-only code and this module ships in the
 * browser. Falls back to a capitalised provider id so a vendor added without
 * a picker-side update still reads as a name, not raw casing.
 */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
}

function providerLabel(providerId: string): string {
  return (
    PROVIDER_LABELS[providerId] ??
    providerId.charAt(0).toUpperCase() + providerId.slice(1)
  )
}

/**
 * `pickedThisLoad` (what the user picked through this chip since the page
 * loaded) exists to outrank `catalog.lastChosenModel`, which is only
 * current as of the one fetch that filled the cache: pick Opus, then hit
 * "+ New", and the new chat has no choice of its own while the cached
 * catalog still names whatever ran before Opus.
 *
 * It was a `useRef`, which is per-MOUNT. Hiding and re-showing the right rail
 * unmounts the chip and wipes the memory, while the module-level catalog
 * survives untouched, so the very next "+ New" adopted the stale value and
 * silently undid the user's most recent pick. Two lifetimes for one
 * correction is the bug; one lifetime is the fix — both it and the catalog
 * cache now live in `src/lib/model-catalog-cache.ts`, reset the same way the
 * tests already reset the catalog: `vi.resetModules()` and a fresh dynamic
 * import.
 */
const NO_EFFORT_SENTINEL = "__default__"

export interface ModelPickerChipProps {
  /** Current session choice; null = runtime default. */
  value: SessionModelConfig | null
  onChange: (config: SessionModelConfig | null) => void
  /**
   * The session id the NEXT turn will send, or `null` when it will send
   * none (solo/branch mode, or a fresh mount before any tab is picked)
   * — in which case the server resolves the project-default session,
   * which has no choice of its own either, so the last chosen model
   * applies to it too.
   */
  sessionId?: string | null
  /**
   * Adopt path for a session that has no persisted choice of its own.
   * Called with the last chosen model once the catalog resolves, and
   * only while `value` is still null.
   *
   * Passing it is the caller's assertion that `sessionId` names a
   * session the client just minted, which the server has never saved.
   * ABSENT means "do not adopt": an existing session whose value is
   * null legitimately runs on the runtime default, and writing another
   * chat's model onto it would persist a choice its owner never made.
   * The chip cannot tell those two apart, so the caller decides by
   * supplying the callback or not.
   *
   * Takes the config rather than reusing `onChange` so the caller can
   * route it through a seed-only writer keyed to that exact session.
   */
  onAdoptLastChosenModel?: (config: SessionModelConfig) => void
}

export function ModelPickerChip({
  value,
  onChange,
  sessionId = null,
  onAdoptLastChosenModel,
}: ModelPickerChipProps) {
  // Read straight from the shared store rather than local state: a fetch
  // (by this chip OR another mounted one) and `invalidateModelCatalogCache`
  // both go through `setCatalogCache`, which notifies this subscription, so
  // every mounted chip renders the same catalog without a `useEffect` ever
  // having to call `setState` for a value that already changed elsewhere.
  const catalog = useSyncExternalStore(subscribeCatalogCache, getCatalogCache, getCatalogCache)
  // A separate snapshot from `catalog` itself: after a failed fetch,
  // `catalog` stays `null`, and invalidating a cache that is already
  // `null` is a null-to-null "change" `useSyncExternalStore` can't see —
  // see `getCatalogVersion`'s doc comment in `model-catalog-cache.ts`. This
  // counter changes on every invalidation regardless, so the fetch effect
  // below keys off it instead of off `catalog`.
  const catalogVersion = useSyncExternalStore(
    subscribeCatalogCache,
    getCatalogVersion,
    getCatalogVersion,
  )
  const [catalogFailed, setCatalogFailed] = useState(false)
  // The rail passes an inline arrow, so `onChange`'s identity changes
  // every render. Hold it in a ref so it stays out of the sync effect's
  // deps — otherwise that effect reruns on every render for no reason.
  // The ref is updated in its own effect (never during render, which
  // React forbids) declared BEFORE the sync effect, so it always holds
  // the current render's callback by the time the sync effect runs.
  const onChangeRef = useRef(onChange)
  const onAdoptRef = useRef(onAdoptLastChosenModel)
  useEffect(() => {
    onChangeRef.current = onChange
    onAdoptRef.current = onAdoptLastChosenModel
  })
  // The sync effect reads the adopt callback through the ref, so its
  // PRESENCE has to reach the deps as a primitive. Without this a
  // session that becomes adoptable while the catalog, the value and the
  // sessionId all stay put would never adopt.
  const canAdoptLastChosenModel = onAdoptLastChosenModel !== undefined

  useEffect(() => {
    // Already cached — either the first mount saw a warm cache, or another
    // mounted chip's fetch (or this effect's own previous run) already
    // filled it. Nothing to do: `catalog` above already reflects it.
    if (getCatalogCache()) return
    let cancelled = false
    void (async () => {
      setCatalogFailed(false)
      try {
        const res = await editorFetch("/api/editor/chat/model-catalog")
        if (!res.ok) {
          if (!cancelled) setCatalogFailed(true)
          return
        }
        const body = (await res.json()) as CatalogResponse
        // A 200 does not guarantee a SHAPE. Validate before accepting.
        //
        // `res.ok` only says the request succeeded; the body can still be
        // something else entirely — an older server that predates this route,
        // a proxy or dev harness with a catch-all that answers `{ ok: true }`
        // to any unmatched path, an SSO interstitial. Storing that took the
        // success path and then threw on `catalog.catalogs.length` below,
        // crashing the whole rail rather than hiding one chip. That is exactly
        // how the self-host harness broke: its mock backend answers
        // `{ ok: true }` 200 for every unrecognised `/api/editor/*`.
        //
        // An unusable catalog is indistinguishable from an absent one as far
        // as this component is concerned, so it takes the same quiet path.
        if (!body || !Array.isArray(body.catalogs)) {
          if (!cancelled) setCatalogFailed(true)
          return
        }
        // A version-checked write, not a plain `setCatalogCache`: if
        // `invalidateModelCatalogCache()` ran while this fetch was in
        // flight, `catalogVersion` (captured when this effect started) no
        // longer matches the live version, and the stale body is discarded
        // instead of repopulating the cache the invalidation just cleared.
        if (!cancelled) setCatalogCacheIfVersion(catalogVersion, body)
      } catch {
        // Catalog unavailable — chip stays hidden, chat uses defaults.
        if (!cancelled) setCatalogFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [catalogVersion])

  // Keep session state in agreement with what the server will run.
  // Idempotent by construction: every branch either leaves `value`
  // alone or moves it to a fixed point (a catalog-valid config, or
  // null), so the rerun this triggers is a no-op.
  useEffect(() => {
    if (!catalog || catalog.catalogs.length === 0) {
      // No catalog → nothing to validate against. A non-null `value`
      // here can only be a hydrated/seeded PERSISTED config: the chip
      // never rendered, so the user cannot have picked anything this
      // page-load. Drop it rather than resend a value we can't vouch
      // for — a stale one would 400 every send with the picker hidden.
      // Behavior is unchanged either way: with no request override the
      // server re-derives the same choice from its own session record,
      // where a stale model falls back to the default instead of
      // erroring.
      if (catalogFailed && value) onChangeRef.current(null)
      return
    }
    if (value) {
      // Reconcile: run the SAME validator the server runs on a request
      // override, so anything it would 400 on (unknown provider, model
      // gone from the catalog, effort the model no longer accepts) is
      // dropped to the runtime default instead of resent. A config that
      // only needs sanitizing (effort on a no-effort model) is
      // normalized in place rather than discarded.
      //
      // This already checks EVERY served catalog, not just the first —
      // `reconcileSessionModelConfig` walks `catalog.catalogs` and matches
      // on provider id. So a session whose provider stopped being served
      // (an OpenAI key removed mid-session) reconciles to `null` here with
      // no extra code: the provider it names is no longer in the array,
      // the validator reports it unknown, and the chip drops to the
      // runtime default rather than displaying a model the next turn
      // would be refused for.
      const reconciled = reconcileSessionModelConfig(value, catalog.catalogs)
      if (reconciled === null) {
        onChangeRef.current(null)
      } else if (
        reconciled.provider !== value.provider ||
        reconciled.model !== value.model ||
        reconciled.effort !== value.effort
      ) {
        onChangeRef.current(reconciled)
      }
      return
    }
    // Adopt: the last chosen model is only right for a chat that has no
    // choice of its own. Two reach here. The project-default session
    // (`sessionId === null`, the next turn sends no id). And a session
    // the client just minted, which the caller marks by supplying
    // `onAdoptLastChosenModel` — a fresh open mints one, so without
    // this the user's model choice would reset every time they open the
    // project.
    //
    // A pick made during this page-load outranks the catalog's copy,
    // which was resolved at mount and cannot know about it.
    const lastChosen = getPickedThisLoad() ?? catalog.lastChosenModel
    if (!lastChosen) return
    if (sessionId === null) {
      onChangeRef.current(lastChosen)
      return
    }
    onAdoptRef.current?.(lastChosen)
  }, [catalog, catalogFailed, value, sessionId, canAdoptLastChosenModel])

  if (!catalog) return null
  const effective = value ?? catalog.default
  // Keyed on the PAIR. Reading `catalogs[0]` here made a second provider
  // invisible even when the server served it, and looking a model up by id
  // alone assumed ids are globally unique across vendors, which nothing
  // enforces.
  const providerCatalog = catalog.catalogs.find(
    (c) => c.providerId === effective.provider,
  )
  const option = providerCatalog?.models.find((m) => m.id === effective.model)
  if (!providerCatalog || !option) return null

  const chipLabel = effective.effort
    ? `${option.label} · ${effective.effort}`
    : option.label

  // Every explicit pick goes through here so the page-load memory above
  // can never miss one. The config is built from the catalog, so it is
  // valid by construction and needs no reconciling before it is stored.
  const choose = (config: SessionModelConfig): void => {
    setPickedThisLoad(config)
    onChange(config)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0 gap-1 text-xs text-muted-foreground"
          data-testid="editor-model-chip"
        >
          {chipLabel}
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuRadioGroup
          value={optionValue(effective.provider, effective.model)}
          onValueChange={(raw) => {
            const [providerId, ...rest] = raw.split(OPTION_VALUE_SEPARATOR)
            const modelId = rest.join(OPTION_VALUE_SEPARATOR)
            const group = catalog.catalogs.find((c) => c.providerId === providerId)
            const next = group?.models.find((m) => m.id === modelId)
            if (!group || !next) return
            // Carry effort over only if the new model supports it. Crossing
            // providers is the common case for this to matter: the ladders
            // are per model, not per vendor.
            const effort =
              effective.effort && next.effortLevels?.includes(effective.effort)
                ? effective.effort
                : undefined
            choose({
              provider: group.providerId,
              model: next.id,
              ...(effort ? { effort } : {}),
            })
          }}
        >
          {catalog.catalogs.map((group, index) => (
            <Fragment key={group.providerId}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              {/* One label per provider. With a single provider served this
                  reads as the plain "Model" header it always did. */}
              <DropdownMenuLabel className="text-xs">
                {catalog.catalogs.length > 1 ? providerLabel(group.providerId) : "Model"}
              </DropdownMenuLabel>
              {group.models.map((m) => (
                <DropdownMenuRadioItem
                  key={optionValue(group.providerId, m.id)}
                  value={optionValue(group.providerId, m.id)}
                  className="text-sm"
                  data-testid={`editor-model-option-${group.providerId}-${m.id}`}
                >
                  {/* Name and version, nothing else (Mo, 2026-09-02: "this
                      menu is unnecessarily complex"). The description stays
                      on the catalog entry for anything that wants it; the
                      menu does not. */}
                  <span className="truncate">{m.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </Fragment>
          ))}
        </DropdownMenuRadioGroup>
        {option.effortLevels ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs">Effort</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={effective.effort ?? NO_EFFORT_SENTINEL}
              onValueChange={(effort) => {
                choose({
                  provider: effective.provider,
                  model: effective.model,
                  ...(effort !== NO_EFFORT_SENTINEL
                    ? { effort: effort as EffortLevel }
                    : {}),
                })
              }}
            >
              <DropdownMenuRadioItem
                value={NO_EFFORT_SENTINEL}
                className="text-sm"
              >
                Default
              </DropdownMenuRadioItem>
              {option.effortLevels.map((level) => (
                <DropdownMenuRadioItem
                  key={level}
                  value={level}
                  className="text-sm"
                >
                  {level}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

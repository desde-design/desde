"use client"

/**
 * Swap-component dialog (Phase F2).
 *
 * Pulls the catalog from `/api/editor/catalog`, scores each entry
 * for prop-overlap with the selected component, and lets the designer
 * pick a replacement. Once picked, surfaces an editable prop-mapping
 * diff before dispatching the swap.
 */

import { useEffect, useMemo, useState } from "react"
import { ArrowRight, Check, Loader2, X } from "lucide-react"
import type { ComponentManifest } from "@/editor/core"
import {
  Dialog,
  DialogContent,
  DialogCopy,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ListRow } from "@/components/blocks"
import { cn } from "@/lib/utils"
import { editorFetch } from "@/lib/editor-fetch"

interface CatalogEntry {
  id: string
  name: string
  file?: string
  packageName?: string
  isDesignSystem: boolean
  description?: string
  manifest: ComponentManifest
  variantHints?: Array<{
    prop: string
    values: ReadonlyArray<string | number | boolean>
    label?: string
  }>
}

export interface SwapResult {
  toComponentName: string
  toPackageName?: string
  toFile?: string
  propMapping: Record<string, string | null>
  newComponentRequiredProps: string[]
}

interface SwapDialogProps {
  /** Truthy → modal open. */
  open: boolean
  onClose: () => void
  /** Manifest of the currently selected component (the "from"). */
  fromManifest: ComponentManifest | null
  /** Designer confirmed; payload ready for SwapEdit dispatch. */
  onConfirm: (result: SwapResult) => void
}

export function SwapDialog({
  open,
  onClose,
  fromManifest,
  onConfirm,
}: SwapDialogProps) {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  const [showAll, setShowAll] = useState(false)
  const [picked, setPicked] = useState<CatalogEntry | null>(null)
  const [mapping, setMapping] = useState<Record<string, string | null>>({})

  // Fetch catalog on open. Keep the result around — refetching every
  // open burns the user's time when the catalog is stable across an
  // editing session.
  useEffect(() => {
    if (!open) return
    if (catalog !== null) return
    let cancelled = false
    editorFetch("/api/editor/catalog", { headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`catalog responded ${res.status}`)
        return res.json() as Promise<CatalogEntry[]>
      })
      .then((data) => {
        if (cancelled) return
        setCatalog(data)
      })
      .catch((err) => {
        if (cancelled) return
        setError(`Could not load catalog: ${(err as Error).message}`)
      })
    return () => {
      cancelled = true
    }
  }, [open, catalog])

  // Reset transient state when the dialog closes so reopens are clean. The
  // dialog stays mounted (visibility is driven by `open`), so a reset effect is
  // the intended mechanism here rather than remount-on-key.
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPicked(null)
      setMapping({})
      setFilter("")
    }
  }, [open])

  const fromPropNames = useMemo(
    () => new Set((fromManifest?.props ?? []).map((p) => p.name)),
    [fromManifest],
  )

  // Score each candidate by prop-name overlap. Compatible-ish (≥30%
  // shared prop names with the source manifest) ranks first; "show
  // all" relaxes the floor to anything non-zero.
  const ranked = useMemo(() => {
    if (!catalog) return []
    const filterLower = filter.trim().toLowerCase()
    const out: Array<{ entry: CatalogEntry; score: number }> = []
    for (const entry of catalog) {
      if (entry.id === fromManifest?.id) continue
      if (filterLower && !entry.name.toLowerCase().includes(filterLower)) continue
      const entryProps = new Set(entry.manifest.props.map((p) => p.name))
      let shared = 0
      for (const p of fromPropNames) if (entryProps.has(p)) shared++
      const denom = Math.max(fromPropNames.size, 1)
      const score = shared / denom
      if (showAll || score >= 0.3 || filterLower) {
        out.push({ entry, score })
      }
    }
    out.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    return out
  }, [catalog, fromManifest, fromPropNames, filter, showAll])

  // When the designer picks a candidate, compute a default mapping:
  // shared-name props map identity; unmapped source props default to
  // null (dropped) but the designer can override before confirming.
  useEffect(() => {
    if (!picked || !fromManifest) return
    const next: Record<string, string | null> = {}
    const targetNames = new Set(picked.manifest.props.map((p) => p.name))
    for (const p of fromManifest.props) {
      next[p.name] = targetNames.has(p.name) ? p.name : null
    }
    // Intentional: seed the USER-EDITABLE mapping when the picked target (or
    // source manifest) changes — the designer then overrides before confirming.
    // It's editable local state derived from a selection event, not pure derived
    // state, so a render-time computation wouldn't preserve their overrides.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMapping(next)
  }, [picked, fromManifest])

  const requiredOnTarget = useMemo(() => {
    if (!picked) return []
    return picked.manifest.props.filter((p) => p.required).map((p) => p.name)
  }, [picked])

  const resultingNames = useMemo(() => {
    return new Set(
      Object.values(mapping).filter((v): v is string => v !== null),
    )
  }, [mapping])

  const missingRequired = useMemo(
    () => requiredOnTarget.filter((n) => !resultingNames.has(n)),
    [requiredOnTarget, resultingNames],
  )

  function handleConfirm() {
    if (!picked) return
    onConfirm({
      toComponentName: picked.name,
      toPackageName: picked.packageName,
      toFile: picked.packageName ? undefined : picked.file,
      propMapping: mapping,
      newComponentRequiredProps: requiredOnTarget,
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>
            Swap{" "}
            <span>
              {fromManifest?.name ?? "component"}
            </span>
          </DialogTitle>
          <DialogCopy
            description="Replace the selected component with another from the catalog. Props with matching names map identically; unmatched props are dropped, and the mapping can be edited before confirming."
            issues={[
              ...(error
                ? [
                    {
                      key: "error",
                      node: (
                        <span
                          role="status"
                          className="text-destructive"
                          data-testid="swap-error"
                        >
                          {error}
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        </DialogHeader>

        {!picked ? (
          <div className="flex flex-col gap-2">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter components..."
              className="h-8 text-sm"
              data-testid="swap-filter"
            />
            {/*
              "Show all" said nothing about what was hidden. By default the list
              only offers components sharing at least a third of this one's prop
              names, on the theory that a swap between unrelated components
              drops most of what you configured. That floor is the thing the
              checkbox lifts, so the label names it.

              It sits on its own row now: beside the input it wrapped to two
              lines in a narrow dialog, and a checkbox whose label breaks
              mid-phrase is unreadable.

              Typing a filter already bypasses the floor (searching by name
              should find the thing you named), which would leave this control
              silently inert, so it says so instead of looking broken.
            */}
            <label className="flex items-start gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={showAll}
                disabled={filter.trim().length > 0}
                onCheckedChange={(checked) => setShowAll(checked === true)}
                className="mt-0.5"
              />
              <span>
                Include unlikely matches
                {filter.trim().length > 0 ? (
                  <span className="block text-xs">
                    Searching by name already shows every component.
                  </span>
                ) : null}
              </span>
            </label>
            <ScrollArea className="h-72 rounded border">
              {!catalog && !error ? (
                <div className="flex h-full items-center justify-center gap-2 p-3 text-base text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading catalog…
                </div>
              ) : (
                <ul className="divide-y" data-testid="swap-candidates">
                  {ranked.length === 0 ? (
                    <li className="p-3 text-sm text-muted-foreground">
                      No matching components.{" "}
                      {!showAll && !filter.trim() && (
                        <Button
                          variant="link"
                          className="h-auto p-0 text-sm"
                          onClick={() => setShowAll(true)}
                        >
                          Include unlikely matches
                        </Button>
                      )}
                    </li>
                  ) : (
                    ranked.map(({ entry, score }) => (
                      <li key={entry.id}>
                        <ListRow
                          className="flex-col items-stretch gap-0.5 p-2"
                          onClick={() => setPicked(entry)}
                          data-testid="swap-candidate"
                          data-component-id={entry.id}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm">{entry.name}</span>
                            <span className="text-2xs text-muted-foreground">
                              {Math.round(score * 100)}% match
                            </span>
                          </div>
                          {entry.description && (
                            <p className="line-clamp-1 text-xs text-muted-foreground">
                              {entry.description}
                            </p>
                          )}
                        </ListRow>
                      </li>
                    ))
                  )}
                </ul>
              )}
            </ScrollArea>
          </div>
        ) : (
          <MappingEditor
            fromManifest={fromManifest!}
            target={picked}
            mapping={mapping}
            onChange={setMapping}
            missingRequired={missingRequired}
            onBack={() => setPicked(null)}
          />
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {picked && (
            <Button
              onClick={handleConfirm}
              disabled={missingRequired.length > 0}
              data-testid="swap-confirm"
            >
              Swap
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MappingEditor({
  fromManifest,
  target,
  mapping,
  onChange,
  missingRequired,
  onBack,
}: {
  fromManifest: ComponentManifest
  target: CatalogEntry
  mapping: Record<string, string | null>
  onChange: (next: Record<string, string | null>) => void
  missingRequired: string[]
  onBack: () => void
}) {
  const targetNames = useMemo(
    () => target.manifest.props.map((p) => p.name),
    [target],
  )

  return (
    <div className="divide-y rounded-md border">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2 text-base">
          <span>{fromManifest.name}</span>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
          <span>{target.name}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          Pick different
        </Button>
      </div>

      <ScrollArea className="h-64 p-2">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground">
            <tr>
              <th className="pb-1 text-left font-normal">From</th>
              <th className="pb-1 text-left font-normal">Map to</th>
            </tr>
          </thead>
          <tbody>
            {fromManifest.props.map((p) => {
              const value = mapping[p.name]
              return (
                <tr key={p.name} className="border-t">
                  <td className="py-1 pr-2 font-mono">{p.name}</td>
                  <td className="py-1">
                    <Select
                      value={value ?? "__drop__"}
                      onValueChange={(v) => {
                        onChange({
                          ...mapping,
                          [p.name]: v === "__drop__" ? null : v,
                        })
                      }}
                    >
                      <SelectTrigger
                        className="w-full font-mono"
                        data-testid={`mapping-${p.name}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__drop__">(drop)</SelectItem>
                        {targetNames.map((n) => (
                          <SelectItem key={n} value={n} className="font-mono">
                            {n}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                </tr>
              )
            })}
            {target.manifest.props
              .filter(
                (p) =>
                  p.required &&
                  !Object.values(mapping).includes(p.name),
              )
              .map((p) => (
                <tr
                  key={`unfilled-${p.name}`}
                  className="border-t bg-destructive/5"
                >
                  <td className="py-1 pr-2 italic text-destructive">
                    (no source)
                  </td>
                  <td
                    className={cn(
                      "py-1 font-mono",
                      "text-destructive",
                    )}
                  >
                    {p.name} (required)
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </ScrollArea>

      <div className="flex flex-wrap items-center gap-1 px-3 py-2 text-xs text-muted-foreground">
        <Check className="h-3 w-3 text-success" />
        <span>{Object.values(mapping).filter((v) => v !== null).length} mapped</span>
        <X className="ml-2 h-3 w-3 text-destructive" />
        <span>{Object.values(mapping).filter((v) => v === null).length} dropped</span>
        {missingRequired.length > 0 ? (
          <span
            role="status"
            className="ml-2 text-destructive"
            data-testid="missing-required-warning"
          >
            Missing required prop{missingRequired.length > 1 ? "s" : ""}:{" "}
            <span className="font-mono">{missingRequired.join(", ")}</span>
          </span>
        ) : null}
      </div>
    </div>
  )
}

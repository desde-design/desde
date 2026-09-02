"use client"

import { useMemo, useState } from "react"
import type { IconManifest, IconSetSource } from "@/editor/core"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { findIconByTag } from "@/editor/icon-sets/find-icon"
import { sanitizeSvg } from "@/editor/icon-sets/sanitize-svg"
import { type IconSetData } from "@/hooks/useIconSets"
import { sectionHeaderTextClass } from "./section-header"

interface IconPickerSectionProps {
  /** All registered icon sets, fetched via `useIconSets()`. */
  iconSets: readonly IconSetData[]
  /** The tag name of the current selection (e.g. `'DataObjectIcon'`). */
  selectionTag: string | null
  /**
   * Dispatched when the user picks a different icon. The caller wires
   * this to the swap-icon orchestrator. Receiver gets the originating
   * set and the chosen icon manifest (`ref.exportName` etc. are on
   * `icon.ref`).
   */
  onPickIcon: (sourceId: string, icon: IconManifest) => void
}

const DEFAULT_VISIBLE = 60

export function IconPickerSection({
  iconSets,
  selectionTag,
  onPickIcon,
}: IconPickerSectionProps) {
  const currentMatch = useMemo(
    () => (selectionTag ? findIconByTag({ tag: selectionTag, sets: iconSets }) : null),
    [selectionTag, iconSets],
  )

  const [query, setQuery] = useState("")
  const [showAll, setShowAll] = useState(false)
  const [sourceFilter, setSourceFilter] = useState<string | null>(
    currentMatch?.sourceId ?? iconSets[0]?.id ?? null,
  )

  // Don't render the section unless the selection is a recognized icon.
  if (!currentMatch) return null

  const activeSet = iconSets.find((s) => s.id === sourceFilter) ?? iconSets[0]
  if (!activeSet) return null

  const normalizedQuery = query.trim().toLowerCase()
  // Plain computation (not useMemo): this runs after the early returns above,
  // so a hook here would violate rules-of-hooks. The filter is a cheap O(n)
  // pass over the active set's icons — memoization isn't worth the hook.
  const filtered = activeSet.icons.filter((icon) =>
    !normalizedQuery ? true : iconMatchesQuery(icon, normalizedQuery),
  )

  const visible = showAll ? filtered : filtered.slice(0, DEFAULT_VISIBLE)
  const truncated = filtered.length - visible.length

  return (
    <section className="px-3 space-y-3" aria-label="Icon picker">
      <header className="flex items-baseline justify-between">
        <h3 className={sectionHeaderTextClass}>
          Icon
        </h3>
        <Badge variant="outline" className="uppercase tracking-wide">
          {activeSet.displayName}
        </Badge>
      </header>

      {iconSets.length > 1 ? (
        <ToggleGroup
          size="sm"
          type="single"
          variant="outline"
          spacing={0}
          value={activeSet.id}
          onValueChange={(val) => { if (val) setSourceFilter(val) }}
          aria-label="Icon set"
          className="flex-wrap"
        >
          {iconSets.map((set) => (
            <ToggleGroupItem key={set.id} value={set.id} size="sm">
              {set.displayName}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}

      <Input
        type="search"
        size="sm"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setShowAll(false)
        }}
        placeholder={`Search ${activeSet.icons.length} icons…`}
        aria-label="Search icons"
      />

      <div
        role="grid"
        aria-label={`${activeSet.displayName} icons`}
        className="grid grid-cols-6 gap-1.5"
      >
        {visible.map((icon) => {
          const isCurrent =
            currentMatch.sourceId === activeSet.id && currentMatch.icon.id === icon.id
          return (
            // eslint-disable-next-line react/forbid-elements -- aspect-square grid cell with role="gridcell" and dangerouslySetInnerHTML SVG child; Button's inline-flex + fixed sizing would break the aspect-ratio constraint
            <button
              key={icon.id}
              type="button"
              role="gridcell"
              onClick={() => onPickIcon(activeSet.id, icon)}
              title={`${icon.displayName}${icon.category ? ` · ${icon.category}` : ""}`}
              className={
                "group flex aspect-square items-center justify-center rounded border p-1 transition-colors " +
                (isCurrent
                  ? "border-foreground bg-muted"
                  : "border-border hover:border-foreground hover:bg-muted/50")
              }
              aria-label={icon.displayName}
              aria-current={isCurrent ? "true" : undefined}
            >
              <span
                aria-hidden
                className="block h-5 w-5 text-foreground [&_svg]:h-full [&_svg]:w-full"
                dangerouslySetInnerHTML={{
                  // The shell origin holds the bearer token for
                  // /api/editor/* — anything scripted here runs
                  // privileged. Sanitize at this boundary so the
                  // picker can never be the entry point for an XSS
                  // even if an adapter (now or future Phase 5) ships
                  // adversarial markup.
                  __html:
                    icon.preview.kind === "svg"
                      ? sanitizeSvg(icon.preview.markup)
                      : `<img src="${escapeAttr(icon.preview.url)}" alt="" />`,
                }}
              />
            </button>
          )
        })}
      </div>

      {truncated > 0 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Showing {visible.length} of {filtered.length}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowAll(true)}
          >
            Show all
          </Button>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No icons match &quot;{query}&quot;.</p>
      ) : null}
    </section>
  )
}

function iconMatchesQuery(icon: IconManifest, needle: string): boolean {
  if (icon.id.toLowerCase().includes(needle)) return true
  if (icon.displayName.toLowerCase().includes(needle)) return true
  if (icon.category && icon.category.toLowerCase().includes(needle)) return true
  for (const tag of icon.tags) {
    if (tag.toLowerCase().includes(needle)) return true
  }
  return false
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      default:
        return "&#39;"
    }
  })
}

// Re-export the type from useIconSets so callers don't have to import it from two places.
export type { IconSetSource }

"use client"

import { useMemo, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  applyClassMutation,
} from "./tailwind-classes"
import {
  type ColorProperty,
  type ColorValue,
  parseColor,
  previewHex,
  setColor,
  TAILWIND_COLOR_FAMILIES,
  TAILWIND_COLOR_HEX,
  TAILWIND_COLOR_SHADES,
  TAILWIND_SPECIAL_COLORS,
} from "./tailwind-colors"
import { inferColor } from "./infer-from-computed"
import { useDesignTokens } from "@/hooks/useDesignTokens"
import type { DesignToken } from "@/editor/edit-service/design-tokens-source"
import { cn } from "@/lib/utils"
import { Check, ChevronDown, X } from "lucide-react"
import { SectionHeader, fieldRowClass, stackedLabelClass } from "./section-header"

/**
 * Map a color row's property to the matching token subcategory.
 * Tokens are organized as `--acme-color-<subcategory>-...` so we can
 * filter the list per-row: background row → background tokens, etc.
 */
const COLOR_SUBCATEGORY_FOR_PROPERTY: Record<ColorProperty, string> = {
  bg: "background",
  text: "text",
  border: "border",
}

/** The CSS property each color row resolves provenance against. */
const PROVENANCE_PROPERTY_FOR_COLOR: Record<ColorProperty, string> = {
  bg: "background-color",
  text: "color",
  border: "border-color",
}

/** CSS properties the color section needs provenance for (for the parent fetch). */
export const COLOR_PROVENANCE_PROPERTIES = Object.values(
  PROVENANCE_PROPERTY_FOR_COLOR,
)

interface ColorSectionProps {
  classes: readonly string[]
  /** Live computed CSS — fallback when no `bg-…`/`text-…`/`border-…` class is present. */
  computedStyles?: Record<string, string>
  /**
   * Phase 2/3 — when provided, a style edit routes through the scope gate: the
   * section calls this with the edited CSS property + the full NEXT class list,
   * and the panel decides apply-directly vs scope-dialog (and, for "This page",
   * a scoped-css-override instead of a class splice).
   */
  onScopedEdit?: (property: string, nextClasses: string[]) => void
  onClassesChange: (next: string[]) => void
}

/**
 * Three color controls (Background, Text, Border-color) over the
 * Tailwind v4 palette. Each row shows a swatch preview of the
 * currently-applied color; clicking opens a popover with the full
 * 22 × 11 palette grid plus the special values (transparent / white
 * / black / current / inherit) and a "(none)" clear action.
 *
 * **Specials placement.** `current` and `inherit` are technically
 * useful but rarely what a designer wants directly; they sit in the
 * specials row alongside white/black/transparent. The "(none)" tile
 * clears the property entirely (removes every owned class).
 *
 * **Cascade semantics.** When the class list contains multiple
 * matching classes (e.g., `bg-amber-50 bg-slate-700`), the LAST is
 * shown as the active swatch (cascade-correct), but on commit ALL
 * matching classes are removed before the new one is added. Mirrors
 * the spacing-section duplicate-handling fix.
 */
export function ColorSection({
  classes,
  computedStyles,
  onScopedEdit,
  onClassesChange,
}: ColorSectionProps) {
  // Only Background lives here now — Text moved to Typography and
  // Border-color to Border, so each color sits in the section it
  // semantically belongs to.
  return (
    <section aria-label="Color" className="px-3 space-y-3">
      <SectionHeader title="Color" />
      <div className="space-y-2">
        <ColorControlRow
          property="bg"
          classes={classes}
          computedStyles={computedStyles}
          onScopedEdit={onScopedEdit}
          onClassesChange={onClassesChange}
        />
      </div>
    </section>
  )
}

const COLOR_ROW_LABEL: Record<ColorProperty, string> = {
  bg: "Background",
  text: "Text",
  border: "Color",
}

/**
 * A single color control row (label + swatch popover) wired for the
 * scope gate. Standalone export so sibling sections can host the color
 * control that belongs to them — Typography renders `property="text"`,
 * Border renders `property="border"` — instead of all three colors
 * living in one Color section. Fetches design tokens itself and routes
 * the edit through `onScopedEdit` under the matching CSS property.
 */
export function ColorControlRow({
  property,
  label,
  classes,
  computedStyles,
  onScopedEdit,
  onClassesChange,
}: {
  property: ColorProperty
  /** Override the default row label (e.g. "Color" inside the Border section). */
  label?: string
  classes: readonly string[]
  computedStyles?: Record<string, string>
  onScopedEdit?: (property: string, nextClasses: string[]) => void
  onClassesChange: (next: string[]) => void
}) {
  // Fetched per row; the hook dedupes the underlying request so multiple
  // rows across sections don't each re-fetch the token list.
  const tokens = useDesignTokens()
  const cssProp = PROVENANCE_PROPERTY_FOR_COLOR[property]
  return (
    <ColorRow
      label={label ?? COLOR_ROW_LABEL[property]}
      property={property}
      classes={classes}
      computedStyles={computedStyles}
      tokens={tokens}
      onClassesChange={
        onScopedEdit ? (next) => onScopedEdit(cssProp, next) : onClassesChange
      }
    />
  )
}

function ColorRow({
  label,
  property,
  classes,
  computedStyles,
  tokens,
  onClassesChange,
}: {
  label: string
  property: ColorProperty
  classes: readonly string[]
  computedStyles?: Record<string, string>
  tokens: readonly DesignToken[]
  onClassesChange: (next: string[]) => void
}) {
  const parsed = useMemo(() => parseColor(classes, property), [classes, property])

  // Token swatches for this row's subcategory (background tokens for
  // the background row, etc.). Empty when the substrate has no
  // tokens — picker falls back to Tailwind-only.
  const rowTokens = useMemo(() => {
    const sub = COLOR_SUBCATEGORY_FOR_PROPERTY[property]
    return tokens.filter((t) => t.category === "color" && t.subcategory === sub)
  }, [tokens, property])

  // Fall back to the computed-style-derived value when the class list
  // doesn't carry a color utility for this property. The fallback's
  // `raws: []` ensures the mutator only adds a class on commit (there
  // was none to remove). Pass the row's tokens so a token-driven
  // background resolves to its named token instead of going blank.
  const fallback = useMemo(
    () => (parsed === null ? inferColor(computedStyles, property, rowTokens) : null),
    [parsed, computedStyles, property, rowTokens],
  )
  const value: ColorValue = parsed ?? fallback
  const [open, setOpen] = useState(false)

  const hint = formatColorClass(value, property, rowTokens)

  function commit(
    next:
      | { kind: "palette"; family: string; shade: number }
      | { kind: "special"; name: string }
      | { kind: "token"; tokenName: string }
      | null,
  ): void {
    onClassesChange(applyClassMutation(classes, setColor(value, next, property)))
    setOpen(false)
  }

  return (
    <div className={fieldRowClass}>
      <label className={stackedLabelClass}>{label}</label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {/* eslint-disable-next-line react/forbid-elements -- Radix PopoverTrigger asChild composition; styled to mirror SelectTrigger so the color picker reads as a dropdown */}
          <button
            type="button"
            aria-label={`${label} color`}
            className="@container flex h-6 w-full items-center justify-between gap-1.5 rounded-md border border-input bg-input/20 px-2 text-xs whitespace-nowrap transition-colors outline-none hover:bg-input/30 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 dark:bg-input/30 dark:hover:bg-input/50"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className="size-3.5 shrink-0 rounded-[3px] border border-border/60"
                style={swatchStyle(value, rowTokens)}
              />
              <span className={cn("truncate", !value && "text-muted-foreground")}>
                {hint}
              </span>
            </span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground @max-[5rem]:hidden" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[300px] p-0">
          <ColorPopoverContents
            property={property}
            value={value}
            tokens={rowTokens}
            onCommit={commit}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** The commit payloads a color option can carry (mirrors `setColor`). */
type ColorCommit =
  | { kind: "palette"; family: string; shade: number }
  | { kind: "special"; name: string }
  | { kind: "token"; tokenName: string }
  | null

interface ColorOption {
  key: string
  name: string
  /** Secondary text shown right-aligned (hex / token value). */
  detail?: string
  /** Lowercased haystack for the search filter. */
  search: string
  chip: React.CSSProperties
  isActive: boolean
  commit: ColorCommit
}

interface ColorOptionGroup {
  label: string
  options: ColorOption[]
}

/**
 * A slashed chip for colors with no single solid preview (transparent /
 * current / inherit) and the empty state.
 */
const SLASH_CHIP: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(to top right, transparent 47%, currentColor 48% 52%, transparent 53%)",
  color: "rgb(0 0 0 / 0.25)",
}

/**
 * Flatten tokens + specials + the full Tailwind palette into grouped,
 * searchable rows (Figma-style: a small chip + name per row), so a single
 * text filter spans every color the picker can apply.
 */
function buildColorGroups(
  value: ColorValue,
  tokens: readonly DesignToken[],
): ColorOptionGroup[] {
  const groups: ColorOptionGroup[] = []

  if (tokens.length > 0) {
    groups.push({
      label: "Design tokens",
      options: tokens.map((token) => ({
        key: `token:${token.name}`,
        name: token.name,
        detail: token.value,
        search: `${token.name} ${token.description ?? ""}`.toLowerCase(),
        chip: { backgroundColor: token.value },
        isActive: value?.kind === "token" && value.tokenName === token.name,
        commit: { kind: "token", tokenName: token.name },
      })),
    })
  }

  groups.push({
    label: "Specials",
    options: TAILWIND_SPECIAL_COLORS.map((name) => {
      const solid = name === "white" || name === "black"
      return {
        key: `special:${name}`,
        name,
        search: name,
        chip: solid ? { backgroundColor: TAILWIND_COLOR_HEX[name] } : SLASH_CHIP,
        isActive: value?.kind === "special" && value.name === name,
        commit: { kind: "special", name },
      }
    }),
  })

  const palette: ColorOption[] = []
  for (const family of TAILWIND_COLOR_FAMILIES) {
    for (const shade of TAILWIND_COLOR_SHADES) {
      const name = `${family}-${shade}`
      const hex = TAILWIND_COLOR_HEX[name] ?? "#fff"
      palette.push({
        key: `palette:${name}`,
        name,
        detail: hex,
        search: name,
        chip: { backgroundColor: hex },
        isActive:
          value?.kind === "palette" &&
          value.family === family &&
          value.shade === shade,
        commit: { kind: "palette", family, shade },
      })
    }
  }
  groups.push({ label: "Tailwind palette", options: palette })

  return groups
}

function ColorPopoverContents({
  property,
  value,
  tokens,
  onCommit,
}: {
  property: ColorProperty
  value: ColorValue
  tokens: readonly DesignToken[]
  onCommit: (next: ColorCommit) => void
}) {
  const [query, setQuery] = useState("")
  const groups = useMemo(() => buildColorGroups(value, tokens), [value, tokens])
  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!q) return groups
    return groups
      .map((g) => ({ ...g, options: g.options.filter((o) => o.search.includes(q)) }))
      .filter((g) => g.options.length > 0)
  }, [groups, q])

  return (
    <div className="flex flex-col">
      <div className="border-b p-2">
        <Input
          autoFocus
          size="sm"
          placeholder="Search colors…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="max-h-[300px] overflow-y-auto p-1">
        {!q ? (
          <ColorOptionRow
            name="None"
            detail={`Clear ${property}`}
            chip={{}}
            icon={<X className="size-2.5 text-muted-foreground" />}
            isActive={!value}
            onSelect={() => onCommit(null)}
          />
        ) : null}
        {filtered.length === 0 ? (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            No colors match “{query.trim()}”
          </p>
        ) : (
          filtered.map((group) => (
            <div key={group.label} className="pt-1 first:pt-0">
              <p className={cn(stackedLabelClass, "px-2 py-1")}>{group.label}</p>
              {group.options.map((option) => (
                <ColorOptionRow
                  key={option.key}
                  name={option.name}
                  detail={option.detail}
                  chip={option.chip}
                  isActive={option.isActive}
                  onSelect={() => onCommit(option.commit)}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function ColorOptionRow({
  name,
  detail,
  chip,
  isActive,
  icon,
  onSelect,
}: {
  name: string
  detail?: string
  chip: React.CSSProperties
  isActive: boolean
  icon?: React.ReactNode
  onSelect: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onSelect}
      title={detail ? `${name} · ${detail}` : name}
      className={cn(
        "h-7 w-full justify-start gap-2 px-2 font-normal",
        isActive && "bg-muted",
      )}
    >
      <span
        className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border border-border/60"
        style={chip}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-left text-xs">{name}</span>
      {detail ? (
        <span className="shrink-0 text-2xs text-muted-foreground/70">{detail}</span>
      ) : null}
      {isActive ? <Check className="size-3 shrink-0 text-foreground" /> : null}
    </Button>
  )
}

function swatchStyle(
  value: ColorValue,
  tokens: readonly DesignToken[],
): React.CSSProperties {
  if (!value) {
    // Empty state: a checkerboard-ish slash pattern hint.
    return {
      backgroundImage:
        "linear-gradient(to top right, transparent 47%, currentColor 48% 52%, transparent 53%)",
      color: "rgb(0 0 0 / 0.25)",
    }
  }
  if (value.kind === "special") {
    if (value.name === "transparent" || value.name === "current" || value.name === "inherit") {
      return {
        backgroundImage:
          "linear-gradient(to top right, transparent 47%, currentColor 48% 52%, transparent 53%)",
        color: "rgb(0 0 0 / 0.25)",
      }
    }
    return { backgroundColor: previewHex(value) ?? "#fff" }
  }
  if (value.kind === "token") {
    // Look up the token's resolved value in the fetched list.
    // Falls back to var() so the browser does the resolution if
    // we don't have the token cached (handles cases where the token
    // package was added since the inspector mounted).
    const token = tokens.find((t) => t.name === value.tokenName)
    return { backgroundColor: token?.value ?? `var(${value.tokenName})` }
  }
  if (value.kind === "custom") {
    // A themed / arbitrary color with no class representation — render
    // the actual computed value so the chip reflects what's applied.
    return { backgroundColor: value.css }
  }
  return { backgroundColor: previewHex(value) ?? "#fff" }
}

function formatColorClass(
  value: ColorValue,
  property: ColorProperty,
  tokens: readonly DesignToken[],
): string {
  if (!value) return "—"
  if (value.kind === "special") return `${property}-${value.name}`
  if (value.kind === "token") {
    // Show the token name without the property prefix to keep the
    // hint scannable. Designers care about which token, not the
    // emitted Tailwind syntax.
    const token = tokens.find((t) => t.name === value.tokenName)
    if (token?.description) return `${value.tokenName}`
    return value.tokenName
  }
  if (value.kind === "custom") {
    // No Tailwind class — show the raw computed color, labeled so it's
    // clear this came from component CSS, not a utility.
    return `${value.css} (computed)`
  }
  return `${property}-${value.family}-${value.shade}`
}


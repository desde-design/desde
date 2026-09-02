"use client"

import { useMemo } from "react"
import {
  applyClassMutation,
  parseShadow,
  setShadow,
  SHADOWS,
  type ClassMutation,
} from "./tailwind-classes"
import { inferShadow } from "./infer-from-computed"
import { SectionHeader, fieldLabelClass, fieldRowClass } from "./section-header"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

/** CSS properties the shadow section resolves provenance for. */
export const SHADOW_PROVENANCE_PROPERTIES = ["box-shadow"]

const UNSET = "__unset"

interface ShadowSectionProps {
  classes: readonly string[]
  /** Live computed CSS — fallback when no `shadow-…` class is present. */
  computedStyles?: Record<string, string>
  /** Phase 2/3 — route a style edit through the scope gate (property + next classes). */
  onScopedEdit?: (property: string, nextClasses: string[]) => void
  onClassesChange: (next: string[]) => void
}

/**
 * A single box-shadow control over the Tailwind v4 shadow scale
 * (none / 2xs / xs / sm / md / lg / xl / 2xl). The "—" option clears
 * the owned class entirely; `shadow-none` is the explicit "no shadow"
 * utility for overriding an inherited shadow.
 *
 * When no `shadow-*` class is present the value falls back to the live
 * computed `box-shadow`, snapped to the nearest preset — so an element
 * shadowed by component CSS (not a class) still shows an editable value
 * instead of dead-ending on empty. Shadow COLOR utilities
 * (`shadow-blue-500`), arbitrary values, and inset/ring shadows are
 * preserved untouched and surfaced via the escape-hatch note.
 */
export function ShadowSection({
  classes,
  computedStyles,
  onScopedEdit,
  onClassesChange,
}: ShadowSectionProps) {
  const shadow = useMemo(() => parseShadow(classes), [classes])
  const inferred = useMemo(
    () => (shadow.value === null ? inferShadow(computedStyles) : null),
    [shadow.value, computedStyles],
  )
  const display = shadow.value?.value ?? inferred ?? UNSET

  function commit(mutation: ClassMutation): void {
    const next = applyClassMutation(classes, mutation)
    if (onScopedEdit) onScopedEdit("box-shadow", next)
    else onClassesChange(next)
  }

  return (
    <section aria-label="Shadow" className="px-3 space-y-3">
      <SectionHeader title="Shadow" />
      <div className={fieldRowClass}>
        <label className={fieldLabelClass}>
          Box shadow
        </label>
        <Select
          value={display}
          onValueChange={(v) =>
            commit(setShadow(shadow, v === UNSET ? null : v))
          }
        >
          <SelectTrigger size="sm" responsive aria-label="Box shadow" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNSET} aria-label="Not set">—</SelectItem>
            {SHADOWS.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  )
}


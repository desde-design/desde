"use client"

import { useRef, useState } from "react"
import type { ComponentPropManifest } from "@/editor/core"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { fieldLabelClass, fieldRowClass, fieldValueClass } from "./section-header"

export type PropControlValue = string | number | boolean

interface PropControlProps {
  prop: ComponentPropManifest
  /**
   * Live current value of this prop on the selected component instance,
   * surfaced from the bridge's component-tree extraction. Used as the
   * initial value of the control; falls back to the manifest's
   * `defaultValue` only when this is undefined. Without it, the inspector
   * always renders the manifest default — wrong for any instance whose
   * source overrides it (e.g. `<KButton variant="danger">`).
   */
  currentValue?: unknown
  /**
   * When provided, the control becomes interactive and fires `onChange`
   * with the new value on user action. When omitted, the control renders
   * its default value read-only (V1.1 / dev-picker behavior).
   */
  onChange?: (value: PropControlValue) => void
}

/**
 * Renders one prop in the inspector. Interactive when `onChange` is
 * provided (V1.3+ — editor dispatches `PropEdit` through the framework
 * adapter). Read-only otherwise (V1.1 dev picker).
 *
 * V1.3 only supports interactive controls for boolean, finite-choice, text,
 * and number props. Object / array / event / slot / token props remain
 * read-only — those need richer editors that haven't landed yet.
 */
export function PropControl({ prop, currentValue, onChange }: PropControlProps) {
  return (
    <div className={fieldRowClass}>
      <div className="flex min-w-0 flex-col gap-1">
        <Label className={fieldLabelClass} htmlFor={`prop-${prop.name}`}>
          {toSentenceCase(prop.name)}
        </Label>
        {prop.deprecated ? (
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant="destructive">
              deprecated
            </Badge>
          </div>
        ) : null}
      </div>
      <div className="min-w-0">
        <PropControlInput prop={prop} currentValue={currentValue} onChange={onChange} />
      </div>
    </div>
  )
}

function PropControlInput({ prop, currentValue, onChange }: PropControlProps) {
  const id = `prop-${prop.name}`
  const defaultDisplay = formatDefault(prop)
  const interactive = typeof onChange === "function"

  switch (prop.control.kind) {
    case "boolean": {
      // Prefer the live instance value; fall back to the manifest default.
      const initial = currentValue !== undefined ? currentValue === true : readBoolean(prop)
      return (
        <BooleanControl
          id={id}
          initial={initial}
          interactive={interactive}
          onChange={onChange}
        />
      )
    }

    case "finite-choice": {
      const options = prop.control.options ?? []
      const initial =
        currentValue !== undefined
          ? String(currentValue)
          : defaultDisplay !== undefined
            ? String(defaultDisplay)
            : undefined
      return (
        <FiniteChoiceControl
          id={id}
          initial={initial}
          options={options.map((o) => ({
            value: String(o.value),
            label: o.label,
            raw: o.value,
          }))}
          interactive={interactive}
          onChange={onChange}
        />
      )
    }

    case "text":
    case "number": {
      const initial =
        currentValue !== undefined
          ? String(currentValue)
          : defaultDisplay !== undefined
            ? String(defaultDisplay)
            : ""
      return (
        <TextNumberControl
          id={id}
          initial={initial}
          kind={prop.control.kind}
          interactive={interactive}
          onChange={onChange}
        />
      )
    }

    case "object":
    case "array":
    case "event":
    case "function":
    case "slot":
    case "token":
    case "unknown":
    default:
      // The value here is whatever the manifest recorded as the prop's type,
      // and a TS union has no length limit — vue-router's `to` arrives as
      // `string | RouteLocationAsRelativeGeneric | RouteLocationAsPathGeneric
      // | undefined`. In an `h-6` box with no overflow rule that wrapped to
      // three lines and painted over the rows above and below it, so the type
      // that could not be edited hid two props that could.
      //
      // Truncated rather than allowed to grow: this is a readonly annotation
      // in a dense rail, and the full string stays reachable on hover.
      return (
        <div
          className={cn(
            "flex h-6 items-center overflow-hidden rounded-md border bg-muted/30 px-2 text-muted-foreground",
            fieldValueClass,
          )}
          aria-readonly="true"
          title={prop.control.valueType ?? prop.type}
        >
          <span className="truncate">{prop.control.valueType ?? prop.type}</span>
        </div>
      )
  }
}

function BooleanControl({
  id,
  initial,
  interactive,
  onChange,
}: {
  id: string
  initial: boolean
  interactive: boolean
  onChange?: (value: PropControlValue) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <div className="flex h-6 items-center gap-2">
      <Switch
        id={id}
        size="sm"
        checked={value}
        disabled={!interactive}
        aria-readonly={interactive ? undefined : "true"}
        onCheckedChange={(next) => {
          if (!interactive) return
          setValue(next)
          onChange?.(next)
        }}
      />
      <span className={fieldValueClass}>{value ? "true" : "false"}</span>
    </div>
  )
}

function FiniteChoiceControl({
  id,
  initial,
  options,
  interactive,
  onChange,
}: {
  id: string
  initial: string | undefined
  options: Array<{ value: string; label: string; raw: unknown }>
  interactive: boolean
  onChange?: (value: PropControlValue) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <Select
      disabled={!interactive}
      value={value}
      onValueChange={(next) => {
        if (!interactive) return
        setValue(next)
        // Prefer the raw option value when it's a string/number/boolean so the
        // edit service receives the typed form (e.g. number variants stay numeric).
        const match = options.find((o) => o.value === next)
        const raw = match?.raw
        if (
          typeof raw === "string" ||
          typeof raw === "number" ||
          typeof raw === "boolean"
        ) {
          onChange?.(raw)
        } else {
          onChange?.(next)
        }
      }}
    >
      <SelectTrigger id={id} size="sm" className="w-full">
        <SelectValue placeholder="(unset)" />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function TextNumberControl({
  id,
  initial,
  kind,
  interactive,
  onChange,
}: {
  id: string
  initial: string
  kind: "text" | "number"
  interactive: boolean
  onChange?: (value: PropControlValue) => void
}) {
  const [value, setValue] = useState(initial)
  // Track the last value we successfully committed so Enter-then-blur (and
  // any other follow-on commit attempt with the same string) doesn't fire
  // `onChange` twice. Compared against the *current* committed state, not the
  // immutable `initial`, so a designer can edit → commit → edit → commit.
  const lastCommitted = useRef(initial)
  const commit = (raw: string) => {
    if (!interactive) return
    if (raw === lastCommitted.current) return
    if (kind === "number") {
      // `Number("")` is `0`; reject the empty string explicitly so blurring
      // a cleared field doesn't dispatch a spurious `0` edit.
      if (raw.trim() === "") return
      const n = Number(raw)
      if (!Number.isFinite(n)) return
      lastCommitted.current = raw
      onChange?.(n)
    } else {
      lastCommitted.current = raw
      onChange?.(raw)
    }
  }
  return (
    <Input
      id={id}
      size="sm"
      value={value}
      readOnly={!interactive}
      aria-readonly={interactive ? undefined : "true"}
      type={kind === "number" ? "number" : "text"}
      onChange={(e) => {
        if (!interactive) return
        setValue(e.target.value)
      }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault()
          commit((e.target as HTMLInputElement).value)
        }
      }}
    />
  )
}

/**
 * Display a prop name in sentence case. Only the first character is
 * uppercased — the rest is left verbatim so embedded abbreviations
 * (`ariaLabel`, `srcUrl`) and existing capitalization aren't mangled.
 */
function toSentenceCase(name: string): string {
  if (!name) return name
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function readBoolean(prop: ComponentPropManifest): boolean {
  const value = prop.defaultValue?.value
  return value === true
}

function formatDefault(prop: ComponentPropManifest): string | number | boolean | null | undefined {
  const value = prop.defaultValue?.value
  if (value === undefined) return undefined
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value
  }
  return undefined
}

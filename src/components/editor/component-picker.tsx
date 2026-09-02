"use client"

import { useEffect, useState } from "react"
import type { ComponentManifest, ComponentManifestSource } from "@/editor/core"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field } from "@/components/blocks"

interface ComponentPickerProps {
  source: ComponentManifestSource
  selected: ComponentManifest | null
  onSelect: (manifest: ComponentManifest | null) => void
}

/**
 * V1.1 dev-mode component picker. Lists every component the supplied
 * `ComponentManifestSource` exposes; selecting one populates editor's
 * inspector. Replaced by the iframe + bridge selection flow once a real
 * prototype is hosted in dev.
 */
export function ComponentPicker({ source, selected, onSelect }: ComponentPickerProps) {
  const [manifests, setManifests] = useState<ComponentManifest[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    source
      .listComponents()
      .then((list) => {
        if (cancelled) return
        setManifests(list)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setManifests([])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [source])

  const value = selected?.id ?? ""

  return (
    <Field label="Component" htmlFor="editor-component-picker">
      <Select
        value={value || undefined}
        disabled={loading || manifests.length === 0}
        onValueChange={(id) => {
          const next = manifests.find((m) => m.id === id) ?? null
          onSelect(next)
        }}
      >
        <SelectTrigger id="editor-component-picker" className="w-72">
          <SelectValue
            placeholder={loading ? "Loading components…" : "Pick a component"}
          />
        </SelectTrigger>
        <SelectContent>
          {manifests.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}

import { describe, expect, it } from "vitest"
import type { IconManifest, IconSetSource } from "../../../../src/editor/core"
import { InMemoryIconSetRegistry } from "../../../../src/editor/icon-sets/registry"
import { getIconSets } from "../icon-sets-handler"

function fakeSource(opts: {
  id: string
  displayName: string
  packageName: string
  icons: Array<{ id: string; displayName?: string; category?: string }>
}): IconSetSource {
  const icons: IconManifest[] = opts.icons.map((i) => ({
    id: i.id,
    displayName: i.displayName ?? i.id,
    category: i.category,
    tags: [],
    ref: { kind: "named-component-import", exportName: i.id, importPath: opts.packageName },
    preview: { kind: "svg", markup: `<svg id="${i.id}"/>` },
  }))
  return {
    id: opts.id,
    displayName: opts.displayName,
    framework: "vue3",
    usagePattern: { kind: "named-component-import", packageName: opts.packageName },
    listIcons: async () => icons,
    getIcon: async (id) => icons.find((i) => i.id === id) ?? null,
  }
}

describe("getIconSets", () => {
  it("returns 503 when no registry is configured", async () => {
    const result = await getIconSets(null)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.status).toBe(503)
  })

  it("returns ok + empty sets when registry has no sources", async () => {
    const registry = new InMemoryIconSetRegistry()
    const result = await getIconSets(registry)
    expect(result).toEqual({ ok: true, status: 200, sets: [] })
  })

  it("isolates per-source failures — a throwing source does not 500 the endpoint", async () => {
    const registry = new InMemoryIconSetRegistry()
    registry.register({
      id: "broken",
      displayName: "Broken",
      framework: "vue3",
      usagePattern: { kind: "named-component-import", packageName: "@broken/icons" },
      listIcons: async () => {
        throw new Error("simulated enumeration failure")
      },
      getIcon: async () => null,
    })
    registry.register(
      fakeSource({
        id: "good",
        displayName: "Good",
        packageName: "@good/icons",
        icons: [{ id: "AddIcon" }],
      }),
    )

    const result = await getIconSets(registry)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The broken source is omitted; the good source comes through.
    expect(result.sets.map((s) => s.id)).toEqual(["good"])
    expect(result.sets[0].icons.map((i) => i.id)).toEqual(["AddIcon"])
  })

  it("serializes each source with its icons and usage pattern", async () => {
    const registry = new InMemoryIconSetRegistry()
    registry.register(
      fakeSource({
        id: "acme-icons",
        displayName: "Acme Icons",
        packageName: "@acme/icons",
        icons: [
          { id: "DataObjectIcon", displayName: "Data object", category: "solid" },
          { id: "TrashIcon", displayName: "Trash", category: "solid" },
        ],
      }),
    )

    const result = await getIconSets(registry)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sets).toHaveLength(1)

    const [set] = result.sets
    expect(set.id).toBe("acme-icons")
    expect(set.displayName).toBe("Acme Icons")
    expect(set.framework).toBe("vue3")
    expect(set.usagePattern).toEqual({
      kind: "named-component-import",
      packageName: "@acme/icons",
    })
    expect(set.icons).toHaveLength(2)
    expect(set.icons[0]).toMatchObject({
      id: "DataObjectIcon",
      displayName: "Data object",
      category: "solid",
      ref: {
        kind: "named-component-import",
        exportName: "DataObjectIcon",
        importPath: "@acme/icons",
      },
    })
  })
})

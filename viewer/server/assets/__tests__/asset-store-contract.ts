import { describe, expect, it } from "vitest"
import type { AssetStore } from "../types"

export interface AssetStoreContractOptions {
  makeStore: () => Promise<AssetStore> | AssetStore
  cleanup?: () => Promise<void> | void
}

export function assetStoreContract(
  name: string,
  opts: AssetStoreContractOptions,
): void {
  describe(`AssetStore contract: ${name}`, () => {
    it("returns null for a missing asset", async () => {
      const store = await opts.makeStore()
      expect(await store.get("dep-1", "index.html")).toBeNull()
      await opts.cleanup?.()
    })

    it("round-trips a file with its content type", async () => {
      const store = await opts.makeStore()
      await store.put("dep-1", "index.html", Buffer.from("<h1>hi</h1>"))

      const asset = await store.get("dep-1", "index.html")
      expect(asset?.body.toString()).toBe("<h1>hi</h1>")
      expect(asset?.contentType).toBe("text/html; charset=utf-8")

      await opts.cleanup?.()
    })

    it("round-trips binary content unchanged", async () => {
      const store = await opts.makeStore()
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
      await store.put("dep-1", "img/logo.png", bytes)

      const asset = await store.get("dep-1", "img/logo.png")
      expect(asset?.body.equals(bytes)).toBe(true)
      expect(asset?.contentType).toBe("image/png")

      await opts.cleanup?.()
    })

    it("isolates deployments from each other", async () => {
      const store = await opts.makeStore()
      await store.put("dep-1", "index.html", Buffer.from("one"))
      await store.put("dep-2", "index.html", Buffer.from("two"))

      expect((await store.get("dep-1", "index.html"))?.body.toString()).toBe("one")
      expect((await store.get("dep-2", "index.html"))?.body.toString()).toBe("two")

      await opts.cleanup?.()
    })

    it("deletes a whole deployment", async () => {
      const store = await opts.makeStore()
      await store.put("dep-1", "index.html", Buffer.from("one"))
      await store.put("dep-2", "index.html", Buffer.from("two"))

      await store.deleteDeployment("dep-1")

      expect(await store.get("dep-1", "index.html")).toBeNull()
      expect((await store.get("dep-2", "index.html"))?.body.toString()).toBe("two")

      await opts.cleanup?.()
    })

    it("refuses paths that escape the deployment", async () => {
      const store = await opts.makeStore()
      await expect(
        store.put("dep-1", "../escape.html", Buffer.from("nope")),
      ).rejects.toThrow(/invalid asset path/i)
      await expect(store.get("dep-1", "../../etc/passwd")).rejects.toThrow(
        /invalid asset path/i,
      )
      await expect(store.get("dep-1", "/etc/passwd")).rejects.toThrow(
        /invalid asset path/i,
      )
      await opts.cleanup?.()
    })

    it("refuses malicious deploymentIds", async () => {
      const store = await opts.makeStore()
      // "." would target the root instead of a deployment subdirectory
      await expect(store.put(".", "index.html", Buffer.from("nope"))).rejects.toThrow(
        /invalid asset path/i,
      )
      await expect(store.get(".", "index.html")).rejects.toThrow(/invalid asset path/i)

      // "" (empty) also targets the root
      await expect(store.put("", "index.html", Buffer.from("nope"))).rejects.toThrow(
        /invalid asset path/i,
      )
      await expect(store.get("", "index.html")).rejects.toThrow(/invalid asset path/i)

      // ".." tries to escape
      await expect(store.put("..", "index.html", Buffer.from("nope"))).rejects.toThrow(
        /invalid asset path/i,
      )
      await expect(store.get("..", "index.html")).rejects.toThrow(/invalid asset path/i)

      // Path separators in deploymentId try to create nested directories
      await expect(store.put("a/b", "index.html", Buffer.from("nope"))).rejects.toThrow(
        /invalid asset path/i,
      )

      await opts.cleanup?.()
    })

    it("deleteDeployment rejects malicious ids and does not touch other deployments", async () => {
      const store = await opts.makeStore()
      // Set up two deployments
      await store.put("dep-1", "file.txt", Buffer.from("dep1"))
      await store.put("dep-2", "file.txt", Buffer.from("dep2"))

      // Attempting to delete "." should reject, not wipe the whole root
      await expect(store.deleteDeployment(".")).rejects.toThrow(/invalid asset path/i)

      // Both deployments should still be readable
      expect((await store.get("dep-1", "file.txt"))?.body.toString()).toBe("dep1")
      expect((await store.get("dep-2", "file.txt"))?.body.toString()).toBe("dep2")

      await opts.cleanup?.()
    })

    it("refuses relPaths that target the deployment directory itself", async () => {
      const store = await opts.makeStore()
      // "." would target the deployment directory
      await expect(store.put("dep-1", ".", Buffer.from("nope"))).rejects.toThrow(
        /invalid asset path/i,
      )
      await expect(store.get("dep-1", ".")).rejects.toThrow(/invalid asset path/i)

      // "" (empty string) also targets the directory
      await expect(store.put("dep-1", "", Buffer.from("nope"))).rejects.toThrow(
        /invalid asset path/i,
      )
      await expect(store.get("dep-1", "")).rejects.toThrow(/invalid asset path/i)

      // "./" normalizes to "./" and also targets the directory
      await expect(store.put("dep-1", "./", Buffer.from("nope"))).rejects.toThrow(
        /invalid asset path/i,
      )
      await expect(store.get("dep-1", "./")).rejects.toThrow(/invalid asset path/i)

      // "a/../" normalizes to "./" and also targets the directory
      await expect(store.put("dep-1", "a/../", Buffer.from("nope"))).rejects.toThrow(
        /invalid asset path/i,
      )
      await expect(store.get("dep-1", "a/../")).rejects.toThrow(/invalid asset path/i)

      await opts.cleanup?.()
    })
  })
}

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { detectStylingSystem } from "../styling-system-detection.js"

let repoRoot: string

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), "editor-cli-styling-"))
})

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true })
})

async function writePkg(pkg: object): Promise<void> {
  await writeFile(join(repoRoot, "package.json"), JSON.stringify(pkg))
}

describe("detectStylingSystem", () => {
  it("detects tailwind from a dependency (v3 or v4)", async () => {
    await writePkg({ dependencies: { react: "^19.0.0", tailwindcss: "^4.0.0" } })
    expect(await detectStylingSystem(repoRoot)).toBe("tailwind")
  })

  it("detects tailwind from a devDependency", async () => {
    await writePkg({ devDependencies: { tailwindcss: "^3.4.0" } })
    expect(await detectStylingSystem(repoRoot)).toBe("tailwind")
  })

  it("detects tailwind from a tailwind.config.* file (v3)", async () => {
    await writePkg({ dependencies: { react: "^19.0.0" } })
    await writeFile(join(repoRoot, "tailwind.config.js"), "module.exports = {}")
    expect(await detectStylingSystem(repoRoot)).toBe("tailwind")
  })

  it("detects tailwind from a v4 @import directive in a root CSS entry", async () => {
    await writePkg({ dependencies: { react: "^19.0.0" } })
    await mkdir(join(repoRoot, "src"), { recursive: true })
    await writeFile(join(repoRoot, "src/index.css"), '@import "tailwindcss";\n')
    expect(await detectStylingSystem(repoRoot)).toBe("tailwind")
  })

  it("detects tailwind from a legacy @tailwind directive", async () => {
    await writePkg({ dependencies: { react: "^19.0.0" } })
    await mkdir(join(repoRoot, "src"), { recursive: true })
    await writeFile(
      join(repoRoot, "src/main.css"),
      "@tailwind base;\n@tailwind utilities;\n",
    )
    expect(await detectStylingSystem(repoRoot)).toBe("tailwind")
  })

  it("defaults to inline for a plain React app (no Tailwind signal)", async () => {
    await writePkg({ dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" } })
    expect(await detectStylingSystem(repoRoot)).toBe("inline")
  })

  it("defaults to inline when package.json is missing", async () => {
    expect(await detectStylingSystem(repoRoot)).toBe("inline")
  })

  it("defaults to inline when package.json is malformed", async () => {
    await writeFile(join(repoRoot, "package.json"), "{ not json")
    expect(await detectStylingSystem(repoRoot)).toBe("inline")
  })
})

import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/** True when `package.json` lists `name` under dependencies or devDependencies. */
async function dependsOn(checkoutRoot: string, name: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(checkoutRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name])
  } catch {
    return false
  }
}

export { isDir, isFile, dependsOn }

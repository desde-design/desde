/**
 * `/api/editor/read-roots*` — the in-editor surface for reference directories.
 *
 * The launcher writes the same config block at project creation
 * (`launcher-server.ts`), but a user who picks the wrong folder, or wants to
 * add one later, needs a way to change it without hand-editing JSON. That is
 * this file, behind the settings-gear dialog.
 *
 * Three things make it more than a thin config editor:
 *
 *   1. **It validates before writing.** A malformed `readRoots` block aborts
 *      the next CLI boot, so writing whatever the client sent could hand the
 *      user a project that no longer opens.
 *   2. **It reports resolution, not just declaration.** The dialog shows
 *      whether each declared directory currently resolves and whether it is a
 *      git repo, because a root the user added last month may since have been
 *      moved or deleted. The config alone cannot answer that.
 *   3. **It reloads the live registry after a write.** `readRoots` is resolved
 *      once at boot and handed to each chat turn, so without this a user would
 *      add a directory, see it listed, and find the agent could not read it
 *      until they restarted. See `ReadRootsHolder`.
 */

import type { IncomingMessage, ServerResponse } from "node:http"
import { basename, join, resolve as resolvePath } from "node:path"
import { readFile, stat } from "node:fs/promises"

import {
  appendReadRoot,
  checkReadRootPath,
  loadReadRootDeclarations,
  removeReadRoot,
  suggestReadRootName,
  validateReadRootDeclaration,
} from "../../../src/editor/core/read-root-declarations.js"
import {
  CONFIG_FILENAME,
  isGitRepository,
  loadReadRoots,
  type ReadRootRegistry,
} from "../../../src/editor/core/read-roots.js"
import { readJsonBody, runHandler, sendJson } from "./artifact-http.js"
import { folderPickerSupported } from "./folder-picker.js"
import type { FolderPickResult, PickFolder } from "./folder-picker.js"

/**
 * Mutable box holding the registry the agent's tools actually see.
 *
 * A holder rather than a plain value because the route context is rebuilt from
 * captured options on every request — assigning to `ctx.readRoots` would be
 * discarded the moment the request ended. Same shape as
 * `reconciliationStatusHolder` and `homeLauncherHolder` elsewhere in this
 * server.
 */
export interface ReadRootsHolder {
  current: ReadRootRegistry
  /** Warnings from the most recent load (skipped roots, duplicate paths). */
  warnings: string[]
}

export interface ReadRootsHandlerContext {
  /**
   * The directory whose `desde.config.json` is BOTH read and
   * written. One field rather than a read root and a write root, because
   * having two was a bug: they diverge for a package opened inside a larger
   * git repo, and the writes went somewhere the loader never looks.
   */
  configRoot: string
  holder?: ReadRootsHolder
  pickFolder?: PickFolder
}

/**
 * The `readRoots` keys exactly as written on disk, with no validation.
 *
 * Needed because the settings dialog builds its remove buttons from the list,
 * and a declaration that fails validation is absent from every validated view
 * of the config. Without this, a hand-edited bad entry could be neither used
 * nor deleted except by editing JSON, which is what the dialog is for.
 */
async function readRawReadRootNames(configRoot: string): Promise<string[]> {
  try {
    const text = await readFile(join(configRoot, CONFIG_FILENAME), "utf8")
    const parsed = JSON.parse(text) as { readRoots?: unknown }
    const block = parsed.readRoots
    if (typeof block !== "object" || block === null || Array.isArray(block)) return []
    return Object.keys(block)
  } catch {
    return []
  }
}

/** Does this route belong to us? Mirrors `matchesDesignSystemsRoute`. */
export function matchesReadRootsRoute(pathname: string): boolean {
  return pathname === "/api/editor/read-roots" || pathname.startsWith("/api/editor/read-roots/")
}

/**
 * Re-resolve the config and swap the live registry.
 *
 * A load FAILURE deliberately leaves the previous registry in place. The
 * alternative — clearing it — would mean one bad write silently stripped the
 * agent's grounding mid-session, which is worse than briefly serving a
 * slightly stale registry the user is about to correct. The failure is
 * returned so the caller can surface it.
 */
async function reloadRegistry(
  ctx: ReadRootsHandlerContext,
): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  if (!ctx.holder) return { ok: true }
  const result = await loadReadRoots({ worktreeRoot: ctx.configRoot })
  if (!result.ok) return { ok: false, errors: result.errors }
  ctx.holder.current = result.registry
  ctx.holder.warnings = result.warnings
  return { ok: true }
}

interface ReadRootView {
  name: string
  path: string
  description?: string
  isWorktree: boolean
  isGit: boolean
  /**
   * False when the directory is declared in the config but does not currently
   * resolve. Such a root is absent from the registry by design (it warns and
   * skips rather than aborting boot), but it must still appear HERE: the
   * settings dialog builds its remove buttons from this list, so omitting it
   * would leave the user no way to delete a broken entry except by hand-editing
   * JSON, which is the thing this dialog exists to avoid.
   */
  resolves: boolean
}

/**
 * List the roots the session currently has.
 *
 * Unlike the agent-facing `list_read_roots` tool, this DOES return filesystem
 * paths. That difference is deliberate: the tool withholds paths so the model
 * never sees the user's directory layout, while this route answers the user's
 * own question about their own machine, in a dialog they opened.
 */
async function handleList(
  res: ServerResponse,
  ctx: ReadRootsHandlerContext,
): Promise<void> {
  // ALWAYS a fresh load, never the holder. The holder is the agent's snapshot,
  // resolved at boot or at the last write; this route answers "what is true
  // right now", and the two differ exactly when it matters. A folder deleted
  // after boot still sits in the holder and would be reported as fine, and a
  // root added by hand-editing the config would be absent from the holder and
  // get reported as broken. Both are the states a user opens this dialog to
  // see.
  const loaded = await loadReadRoots({ worktreeRoot: ctx.configRoot })
  if (!loaded.ok) {
    sendJson(res, 200, { ok: true, roots: [], warnings: [], errors: loaded.errors })
    return
  }
  const registry = loaded.registry
  const warnings = loaded.warnings

  // Adopt the fresh result as the live registry too. Without this the dialog
  // could show a root as resolved while the agent still could not see it: a
  // directory that was unavailable at boot is absent from the holder, and
  // plugging the drive back in would fix the display and nothing else, until a
  // restart. Reading is the moment we learn the truth, so it is the right
  // moment to publish it.
  if (ctx.holder) {
    ctx.holder.current = registry
    ctx.holder.warnings = warnings
  }

  const roots: ReadRootView[] = registry.roots.map((r) => ({
    name: r.name,
    path: r.path,
    description: r.description,
    isWorktree: r.isWorktree,
    isGit: r.isGit,
    resolves: true,
  }))

  // Merge back the declarations the registry dropped. A declared-but-missing
  // folder is exactly the entry a user most wants to remove.
  const resolved = new Set(roots.map((r) => r.name))
  const declared = await loadReadRootDeclarations(ctx.configRoot)
  // Raw names too, so an entry that fails VALIDATION is still listed and
  // therefore still removable. `declared.declarations` only carries entries
  // that passed; an unremovable broken row is the state this dialog exists to
  // get the user out of.
  const rawNames = await readRawReadRootNames(ctx.configRoot)
  for (const name of rawNames) {
    if (resolved.has(name)) continue
    if (declared.ok && declared.declarations.some((d) => d.name === name)) continue
    roots.push({
      name,
      path: "",
      isWorktree: false,
      isGit: false,
      resolves: false,
    })
    resolved.add(name)
  }
  if (declared.ok) {
    for (const decl of declared.declarations) {
      if (resolved.has(decl.name)) continue
      roots.push({
        name: decl.name,
        path: decl.path,
        description: decl.description,
        isWorktree: false,
        isGit: false,
        resolves: false,
      })
    }
  }

  sendJson(res, 200, {
    ok: true,
    roots,
    warnings,
    // The declarations loader rejects shapes `loadReadRoots` tolerates (a
    // `null` or array block, say). Dropping its errors left the dialog saying
    // there are no reference folders while every add was refused for a reason
    // the user could not see anywhere.
    ...(declared.ok ? {} : { errors: declared.errors }),
    // So the client can hide a Browse button that could only ever no-op. The
    // desktop shell has its own chooser and overrides this on its side.
    pickerSupported: ctx.pickFolder ? folderPickerSupported() : false,
  })
}

async function handleAdd(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ReadRootsHandlerContext,
): Promise<void> {
  const body = await readJsonBody<{ name?: unknown; path?: unknown; description?: unknown }>(req)
  const validated = validateReadRootDeclaration({
    name: body.name,
    path: body.path,
    description: body.description,
  })
  if (!validated.ok) {
    sendJson(res, 400, { ok: false, reason: validated.error })
    return
  }

  // Refuse to append onto a block that is already invalid, matching the
  // launcher's declare route. `appendReadRoot` preserves entries it cannot
  // parse (and would overwrite a non-object block), so writing here would
  // report success and promise a restart that the next boot then rejects.
  const existing = await loadReadRootDeclarations(ctx.configRoot)
  if (!existing.ok) {
    sendJson(res, 400, {
      ok: false,
      reason: `the readRoots block in desde.config.json is invalid, fix it first: ${existing.errors.join("; ")}`,
    })
    return
  }

  // The loader treats a self-reference or a non-directory as a FATAL config
  // error, so writing one here would leave the project unable to boot.
  const usable = await checkReadRootPath(ctx.configRoot, validated.declaration.path)
  if (!usable.ok) {
    sendJson(res, 400, { ok: false, reason: usable.reason })
    return
  }

  const appendResult = await appendReadRoot(ctx.configRoot, validated.declaration)
  if (!appendResult.ok) {
    sendJson(res, 409, { ok: false, reason: appendResult.reason })
    return
  }

  const reload = await reloadRegistry(ctx)
  sendJson(res, 200, {
    ok: true,
    declaration: validated.declaration,
    // Surfaced rather than swallowed: the write succeeded but the session did
    // not pick it up, and the user needs to know a restart is required.
    ...(reload.ok ? {} : { reloadErrors: reload.errors }),
  })
}

async function handleRemove(
  res: ServerResponse,
  ctx: ReadRootsHandlerContext,
  name: string,
): Promise<void> {
  const result = await removeReadRoot(ctx.configRoot, name)
  if (!result.ok) {
    sendJson(res, 404, { ok: false, reason: result.reason })
    return
  }
  const reload = await reloadRegistry(ctx)
  sendJson(res, 200, {
    ok: true,
    removed: name,
    ...(reload.ok ? {} : { reloadErrors: reload.errors }),
  })
}

/**
 * Report what a declaration for `path` would look like, without writing
 * anything: does it resolve to a directory, what should it be called, is it a
 * git repo. The typed-path counterpart to {@link handlePick}, and the same
 * answer `/api/launcher/read-roots/inspect` gives during project creation.
 */
async function handleInspect(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ReadRootsHandlerContext,
): Promise<void> {
  const body = await readJsonBody<{ path?: unknown }>(req)
  if (typeof body.path !== "string" || body.path.trim().length === 0) {
    sendJson(res, 400, { ok: false, reason: "path is required" })
    return
  }
  // Against the CONFIG ROOT, not `process.cwd()`. core.ts moves the process
  // cwd to an auto-detected app directory below the repo, so a bare
  // `resolvePath` would resolve `../production` from somewhere the loader and
  // the add route never use, and could normalize a different folder than the
  // one the user meant.
  const abs = resolvePath(ctx.configRoot, body.path.trim())
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(abs)
  } catch {
    sendJson(res, 400, { ok: false, reason: `Not found: ${abs}` })
    return
  }
  if (!info.isDirectory()) {
    sendJson(res, 400, { ok: false, reason: `Not a directory: ${abs}` })
    return
  }
  const usable = await checkReadRootPath(ctx.configRoot, abs)
  if (!usable.ok) {
    sendJson(res, 400, { ok: false, reason: usable.reason })
    return
  }
  const taken = (ctx.holder?.current.roots ?? []).map((r) => r.name)
  sendJson(res, 200, {
    ok: true,
    path: abs,
    suggestedName: suggestReadRootName(basename(abs), taken),
    isGit: await isGitRepository(abs),
  })
}

/**
 * Pop the OS folder chooser and report what a declaration for that folder
 * would look like — the same inspect the launcher wizard does, combined with
 * the pick so the dialog needs one round trip instead of two.
 */
async function handlePick(
  res: ServerResponse,
  ctx: ReadRootsHandlerContext,
): Promise<void> {
  if (!ctx.pickFolder) {
    sendJson(res, 200, { ok: true, supported: false })
    return
  }
  let picked: FolderPickResult
  try {
    picked = await ctx.pickFolder("reference")
  } catch (err) {
    sendJson(res, 500, { ok: false, reason: (err as Error).message })
    return
  }
  if (!picked.supported || picked.canceled || !picked.path) {
    sendJson(res, 200, { ok: true, ...picked })
    return
  }

  const taken = (ctx.holder?.current.roots ?? []).map((r) => r.name)
  sendJson(res, 200, {
    ok: true,
    supported: true,
    path: picked.path,
    suggestedName: suggestReadRootName(basename(picked.path), taken),
    isGit: await isGitRepository(picked.path),
  })
}

export async function handleReadRootsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ReadRootsHandlerContext,
  url: URL,
): Promise<void> {
  await runHandler(res, async () => {
    const { pathname } = url

    if (req.method === "GET" && pathname === "/api/editor/read-roots") {
      await handleList(res, ctx)
      return
    }
    if (req.method === "POST" && pathname === "/api/editor/read-roots") {
      await handleAdd(req, res, ctx)
      return
    }
    if (req.method === "POST" && pathname === "/api/editor/read-roots/pick") {
      await handlePick(res, ctx)
      return
    }
    if (req.method === "POST" && pathname === "/api/editor/read-roots/inspect") {
      await handleInspect(req, res, ctx)
      return
    }
    if (req.method === "DELETE" && pathname.startsWith("/api/editor/read-roots/")) {
      // Decoded because a name arrives percent-encoded in the path. The name
      // is validated against the slug rule by `removeReadRoot`'s own lookup —
      // an unknown name is a 404, so a traversal-looking value cannot match
      // anything.
      const raw = pathname.slice("/api/editor/read-roots/".length)
      const name = decodeURIComponent(raw)
      if (name.length === 0) {
        sendJson(res, 400, { ok: false, reason: "name is required" })
        return
      }
      await handleRemove(res, ctx, name)
      return
    }

    sendJson(res, 404, { ok: false, reason: "Unknown read-roots endpoint" })
  })
}

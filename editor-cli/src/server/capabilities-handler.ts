import type { IncomingMessage, ServerResponse } from "node:http"

import { readJsonBody } from "./http-body.js"

/**
 * `GET /api/editor/capabilities`, `POST /api/editor/capabilities/enable`, and
 * `POST /api/editor/capabilities/secret`.
 *
 * The enable route accepts a catalog **id and nothing else**. It never takes a
 * `command`, `args`, `env` or a host from the request body — the spec it
 * writes is authored in `capability-catalog.ts`, in source, reviewable in git.
 * Anything else would be an arbitrary-execution primitive reachable from the
 * browser, since `.mcp.json` decides which subprocesses the next turn spawns.
 *
 * The agent itself is denied write access to that file, so this handler is the
 * user's path and the only one.
 *
 * The secret route is the same shape of guard for a different resource. It
 * accepts a VALUE, which the enable route deliberately never does, so the
 * NAME is what has to be constrained: it must be one a catalog entry declares
 * in `requiresEnv`. Anything looser writes an arbitrary variable into
 * `process.env`, which every subprocess we spawn inherits — `PATH` or
 * `NODE_OPTIONS` would turn a settings form into code execution.
 */

interface CapabilitiesContext {
  /**
   * MUST be the same root the chat handler passes to `loadExtensions` (the git
   * root), not a canonicalised subdirectory — otherwise we write a file the
   * loader never opens.
   */
  repoRoot: string
}

type Send = (res: ServerResponse, status: number, body: unknown) => void

export async function handleCapabilitiesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: CapabilitiesContext,
  url: URL,
  sendJson: Send,
): Promise<void> {
  const [catalogMod, extMod, enableMod, webMod, storeMod] = await Promise.all([
    import("../../../src/editor/core/capability-catalog.js"),
    import("../../../src/editor/core/extensions-config.js"),
    import("../../../src/editor/core/enable-capability.js"),
    import("../../../src/editor/core/web-policy.js"),
    import("./extension-secret-store.js"),
  ])

  if (req.method === "GET" && url.pathname === "/api/editor/capabilities") {
    const loaded = await extMod.loadExtensions({ worktreeRoot: ctx.repoRoot })
    const storedSecrets = await storeMod.readExtensionSecrets()
    // A broken config must not blank the panel — the user needs to SEE the
    // error precisely when their file is wrong.
    // DECLARED, not merely loaded. An entry whose ${VAR} is unset is written
    // to .mcp.json but skipped by the loader, so deriving state from
    // `loaded.extensions` alone would show it as off and offer an Enable
    // button that 409s. Read the file to learn what is declared; the loader
    // tells us what is actually live.
    const declaredIds = await enableMod.declaredExtensionIds(ctx.repoRoot)
    const liveIds = loaded.ok ? loaded.extensions.map((e) => e.id) : []
    const enabledExtensionIds = [...new Set([...declaredIds, ...liveIds])]
    // Read the REAL web policy. Hardcoding false here made an already-enabled
    // Web search render as off, with an Enable button that posts to the
    // MCP-only route and fails — worse than showing nothing.
    const web = await webMod.loadWebPolicy({ worktreeRoot: ctx.repoRoot })
    const policy = web.ok && web.policy ? web.policy : null
    const enabled = catalogMod.computeEnabledCapabilityIds({
      enabledExtensionIds,
      webFetchAllowedHosts: policy?.webFetchAllowedHosts ?? [],
      webSearchEnabled: policy?.webSearchEnabled ?? false,
    })

    sendJson(res, 200, {
      ok: true,
      configError: loaded.ok ? null : loaded.errors.join("; "),
      // Warnings carry the "declared but ${VAR} unset" case, which is the
      // single most useful thing the panel can tell someone.
      warnings: loaded.ok ? loaded.warnings : [],
      capabilities: catalogMod.CAPABILITY_CATALOG.map((c) => ({
        id: c.id,
        label: c.label,
        summary: c.summary,
        target: c.target,
        activation: c.activation,
        requiresEnv: c.requiresEnv ?? null,
        // True when the capability only works on the Claude Agent SDK
        // runtime. The panel has no model picker in scope and the user can
        // change models per message, so the row states the standing fact
        // rather than guessing which lane the next message takes. Saying
        // nothing was the defect: a row read "Active" while a turn on the
        // neutral lane had no such tools, because that lane composes builtins
        // plus editor tools and registers no MCP server.
        claudeModelsOnly: !c.runtimes.includes("neutral"),
        // Whether WE hold a key for it. Drives the difference between "Add
        // key" and "Replace key", and whether Remove is offered at all —
        // offering Remove for a key we did not write would be a button that
        // changes nothing.
        secretStored: c.requiresEnv !== undefined && c.requiresEnv in storedSecrets,
        // Set in the environment by someone other than us. An exported value
        // always wins over a stored one (see `applyExtensionSecretsToEnv`), so
        // the form has to say that saving here will not take effect — the
        // alternative is a save that reports success and does nothing.
        secretFromEnvironment:
          c.requiresEnv !== undefined &&
          process.env[c.requiresEnv] !== undefined &&
          process.env[c.requiresEnv] !== storedSecrets[c.requiresEnv],
        enabled: enabled.has(c.id),
        // Only MCP extensions can be turned on from here; everything else is
        // a config edit we deliberately do not automate. The panel shows
        // guidance instead of a button that would 400.
        enableable: c.target === "mcp-extension",
        // Named so the panel knows which key to ask for. The stored VALUE is
        // never sent back — the panel only ever learns set/not-set, which is
        // all it renders.
        // A LIVE extension is env-ready by proof: the loader accepted it, so
        // whatever it needed was satisfied — possibly by a hand-written entry
        // that uses different auth than our catalog spec. Only fall back to
        // probing process.env for something declared but not live.
        envReady: liveIds.includes(c.id)
          ? true
          : // Declared but NOT live means the loader skipped it — that is
            // proof it is not ready, and it outranks any guess from
            // process.env. A hand-written entry may reference a different
            // variable than our catalog names.
            c.target === "mcp-extension" && declaredIds.includes(c.id)
            ? false
            : c.requiresEnv
              ? process.env[c.requiresEnv] !== undefined
              : true,
      })),
      // Servers the user hand-wrote that we have no catalog entry for. Shown
      // read-only so the panel is an honest picture of the file, not just of
      // what we happen to curate.
      unknownExtensions: enabledExtensionIds.filter(
        (id) => !catalogMod.findCapability(id),
      ),
    })
    return
  }

  if (req.method === "POST" && url.pathname === "/api/editor/capabilities/enable") {
    const body = await readJsonBody<{ capabilityId?: unknown }>(req)
    if (typeof body.capabilityId !== "string" || body.capabilityId.trim() === "") {
      sendJson(res, 400, { ok: false, reason: "capabilityId is required" })
      return
    }

    const result = await enableMod.enableCapability({
      repoRoot: ctx.repoRoot,
      capabilityId: body.capabilityId.trim(),
    })

    if (!result.ok) {
      const status =
        result.code === "unknown-capability"
          ? 400
          : result.code === "already-enabled"
            ? 409
            : 422
      sendJson(res, status, { ok: false, reason: result.reason, code: result.code })
      return
    }

    sendJson(res, 200, {
      ok: true,
      capabilityId: result.capability.id,
      activation: result.capability.activation,
      // Non-null ⇒ enabled but inert until the user exports it and restarts.
      // Saying so is the honest thing; pretending it is one click is not.
      envMissing: result.envMissing,
    })
    return
  }

  if (req.method === "POST" && url.pathname === "/api/editor/capabilities/secret") {
    const [storeMod, applyMod] = await Promise.all([
      import("./extension-secret-store.js"),
      import("./apply-extension-secrets.js"),
    ])
    const body = await readJsonBody<{ name?: unknown; value?: unknown }>(req)
    const name = typeof body.name === "string" ? body.name.trim() : ""
    if (name === "") {
      sendJson(res, 400, { ok: false, reason: "name is required" })
      return
    }
    if (!catalogMod.capabilitySecretNames().has(name)) {
      // Deliberately says which names are legal rather than just refusing.
      // The set is small, public, and authored in source; hiding it buys no
      // security and costs a caller the ability to tell a typo from a
      // policy.
      sendJson(res, 400, {
        ok: false,
        reason: `${name} is not a key any extension asks for`,
      })
      return
    }

    // `null` clears. An empty string would too, but it arrives from a form
    // that was submitted blank, which is a mistake rather than an intent —
    // so it is refused instead of silently deleting a working key.
    if (body.value === null) {
      await storeMod.clearExtensionSecret(name)
      delete process.env[name]
      sendJson(res, 200, { ok: true, name, set: false })
      return
    }
    if (typeof body.value !== "string" || body.value.trim() === "") {
      sendJson(res, 400, { ok: false, reason: "value is required" })
      return
    }

    await storeMod.writeExtensionSecret(name, body.value.trim())
    // Injected NOW, not at the next boot. `mcpServers` is rebuilt for every
    // turn from `process.env`, so this is what makes the key take effect on
    // the next message instead of after a restart.
    applyMod.applyExtensionSecretsToEnv({ [name]: body.value.trim() }, process.env)
    sendJson(res, 200, { ok: true, name, set: true })
    return
  }

  sendJson(res, 404, { ok: false, reason: "Unknown capabilities route" })
}

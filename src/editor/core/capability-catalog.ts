/**
 * The curated set of capabilities a prototype can turn on.
 *
 * ## Why a catalog at all
 *
 * Enabling a capability writes config that decides which SUBPROCESSES run
 * (`.mcp.json`) or which hosts the agent may reach. A UI that accepted a
 * `command`, `args` or a host from the client would be an arbitrary-execution
 * primitive wearing a button. So the enable path takes a catalog **id** and
 * nothing else: the spec it writes is authored here, in source, reviewable in
 * git. A capability nobody has curated degrades to a docs link — that is the
 * correct failure, not a gap to close with a free-text field.
 *
 * ## Why the model has to be told
 *
 * An unconfigured MCP server is **invisible** to the agent, not denied: it is
 * never spawned, contributes nothing to the tool list and nothing to
 * tool-search, so there is no failed tool call to react to. The model cannot
 * discover that Figma *could* exist. Everything here therefore feeds two
 * consumers that cover different halves of the problem:
 *
 *   - {@link describeDisabledCapabilities} → the system prompt, so the model
 *     can say "Figma isn't enabled" for an ask with no URL in it
 *     ("recreate the mockups").
 *   - {@link detectCapabilityGaps} → a deterministic scan of the USER's
 *     message, so a pasted `figma.com` link raises an inline offer with no
 *     model tokens spent and no false-positive risk.
 *
 * Neither alone covers the space.
 */

/** What kind of config an enable writes — they are genuinely different files. */
export type CapabilityTarget =
  | 'mcp-extension' // .mcp.json
  | 'web-fetch-host' // desde.config.json → web.webFetchAllowedHosts
  | 'web-search' // desde.config.json → web.webSearchEnabled

/**
 * When the capability actually starts working. A field rather than prose
 * because the UI has to say the honest thing, and the two cases differ:
 * `mcpServers` is fixed when the turn's `query()` is constructed, so a newly
 * written server is live on the NEXT message — never mid-turn.
 */
export type CapabilityActivation = 'next-message' | 'cli-restart'

/**
 * The chat runtimes a capability can be served by.
 *
 * Two exist. `claude-agent-sdk` registers MCP servers and ships WebSearch and
 * WebFetch. `neutral` is Desde's own loop on the `LLMProvider` seam: its tool
 * catalog is builtins plus the editor tools and NOTHING else — it never reads
 * `extensions` or `figmaConfig`, and `builtin-tools.ts` says in its own header
 * that it has no WebFetch and no WebSearch.
 *
 * So the whole catalog is `claude-agent-sdk`-only today, and this field exists
 * because that was being reported as false. `computeEnabledCapabilityIds` had
 * no idea which lane it was answering for, and its own comment claimed
 * "'enabled' here means the same thing the runtime means" — which was true on
 * one lane and untrue on the other. A user turned Figma on, the panel said it
 * was live on the next message, and the model had no such tools.
 *
 * The string union rather than an import: `core/` is framework- and
 * runtime-neutral, and `resolveChatRuntimeKind` lives in `editor-cli`.
 */
export type CapabilityRuntimeId = 'claude-agent-sdk' | 'neutral'

export interface CapabilityDescriptor {
  /** Stable id. The enable API accepts this and nothing else. */
  id: string
  label: string
  /** One line, user-facing. Says what it lets the agent do. */
  summary: string
  target: CapabilityTarget
  activation: CapabilityActivation
  /**
   * Which chat runtimes actually serve this. Required, not defaulted: a new
   * entry has to state it, because the alternative is a capability that
   * silently claims both lanes and is only right about one.
   */
  runtimes: ReadonlyArray<CapabilityRuntimeId>
  /**
   * Env var the capability needs to function, if any.
   *
   * Superseded 2026-08-18: this used to carry the note "we never accept the
   * VALUE — that would put a credential through our UI", and the UI printed
   * `export FIGMA_API_KEY=…` instead. That reasoning applied to a tool with
   * only a terminal. It now serves a window, where refusing the value does
   * not protect anyone: it just moves the same secret into a shell profile in
   * plaintext, and puts the setting out of reach of everyone who never opens
   * a terminal. The value is accepted, stored per-machine at 0600 next to the
   * Anthropic key, and injected into `process.env` at boot and on save.
   *
   * The variable name still lives here, and it is the ALLOWLIST — the HTTP
   * layer and the env injection both refuse a name no capability declares.
   */
  requiresEnv?: string
  /** For `mcp-extension`: the exact server entry written to `.mcp.json`. */
  mcpServer?: {
    command: string
    args?: string[]
    /** Values are `${VAR}` references, written UNinterpolated. */
    env?: Record<string, string>
  }
  /**
   * Detects an ask that needs this capability, from the USER's message text.
   *
   * URL/host-shaped only, deliberately. Keyword matching ("figma", "the
   * mockups") is a false-positive engine, and a banner that cries wolf becomes
   * ambient noise the user stops reading. Returns a short detail string (the
   * matched host/URL) for the banner, or null.
   */
  detect?: (userMessage: string) => string | null
}

const FIGMA_URL = /\bhttps?:\/\/(?:www\.)?figma\.com\/[^\s<>"')]+/i

export const CAPABILITY_CATALOG: ReadonlyArray<CapabilityDescriptor> = [
  {
    id: 'figma',
    label: 'Figma',
    summary: 'Build a screen from a Figma frame, using the project\'s own components.',
    target: 'mcp-extension',
    activation: 'next-message',
    // The SDK lane registers this as an MCP server; the neutral lane composes
    // builtins plus editor tools and never reads `opts.extensions`.
    runtimes: ['claude-agent-sdk'],
    requiresEnv: 'FIGMA_API_KEY',
    mcpServer: {
      command: 'npx',
      args: ['-y', 'figma-developer-mcp', '--stdio'],
      env: { FIGMA_API_KEY: '${FIGMA_API_KEY}' },
    },
    detect: (text) => text.match(FIGMA_URL)?.[0] ?? null,
  },
  {
    id: 'web-search',
    label: 'Web search',
    summary: 'Look things up online while building.',
    target: 'web-search',
    activation: 'next-message',
    // The neutral lane ships no WebSearch and no WebFetch — see the header of
    // `agent-chat-neutral/builtin-tools.ts`, which says so and points here.
    runtimes: ['claude-agent-sdk'],
  },
]

/**
 * The env var names a capability may store a secret under.
 *
 * This is a security boundary, not a convenience. `process.env` decides what
 * every subprocess inherits, so a settings write that could name an arbitrary
 * variable (`PATH`, `NODE_OPTIONS`) is code execution. Both the HTTP handler
 * and `applyExtensionSecretsToEnv` check against this set independently.
 */
export function capabilitySecretNames(): ReadonlySet<string> {
  return new Set(
    CAPABILITY_CATALOG.map((c) => c.requiresEnv).filter((n): n is string => n !== undefined),
  )
}

/**
 * Can this runtime actually serve this capability?
 *
 * Config alone never answers it. `.mcp.json` says a server is DECLARED; the
 * lane says whether anything registers it.
 */
export function runtimeSupportsCapability(
  descriptor: CapabilityDescriptor,
  runtime: CapabilityRuntimeId,
): boolean {
  return descriptor.runtimes.includes(runtime)
}

/**
 * Which catalog ids are already on, given what the CLI loaded this turn.
 *
 * Two inputs, not one. `enabledExtensionIds` says what the CONFIG declares.
 * `chatRuntime` says which lane will read it. A capability is on only when
 * both agree, because "the config declares it" and "the model can call it"
 * are different facts and this function used to conflate them.
 *
 * `chatRuntime` defaults to `claude-agent-sdk`. That is the historical
 * behaviour and the one lane that serves everything in the catalog, so an
 * older caller keeps the answer it always got.
 */
export function computeEnabledCapabilityIds(input: {
  enabledExtensionIds: ReadonlyArray<string>
  webFetchAllowedHosts: ReadonlyArray<string>
  webSearchEnabled: boolean
  chatRuntime?: CapabilityRuntimeId
}): Set<string> {
  const runtime = input.chatRuntime ?? 'claude-agent-sdk'
  const on = new Set<string>()
  for (const descriptor of CAPABILITY_CATALOG) {
    if (!runtimeSupportsCapability(descriptor, runtime)) continue
    if (
      descriptor.target === 'mcp-extension' &&
      input.enabledExtensionIds.includes(descriptor.id)
    ) {
      on.add(descriptor.id)
    }
    if (descriptor.target === 'web-search' && input.webSearchEnabled) {
      on.add(descriptor.id)
    }
    if (
      descriptor.target === 'web-fetch-host' &&
      input.webFetchAllowedHosts.length > 0
    ) {
      on.add(descriptor.id)
    }
  }
  return on
}

export interface CapabilityGap {
  capabilityId: string
  /** What in the message triggered it — the matched URL. Shown in the banner. */
  detail: string
}

/**
 * Scan the USER's message for asks that need a capability that is off.
 *
 * The input is the user's own text and nothing else. Assistant prose, tool
 * output and MCP results are excluded by construction: this drives an
 * affordance that writes the file deciding which subprocesses run, so
 * model-authored or server-returned text must never be on its input side.
 */
export function detectCapabilityGaps(
  userMessage: string,
  enabledIds: ReadonlySet<string>,
  dismissedIds: ReadonlySet<string> = new Set(),
  chatRuntime: CapabilityRuntimeId = 'claude-agent-sdk',
): CapabilityGap[] {
  const gaps: CapabilityGap[] = []
  for (const descriptor of CAPABILITY_CATALOG) {
    if (!descriptor.detect) continue
    // The banner's whole content is an Enable button. On a runtime that would
    // not register the capability anyway, that button is a dead end, so the
    // honest move is to raise nothing and let the prompt block (which now says
    // this needs a different model) carry the explanation.
    if (!runtimeSupportsCapability(descriptor, chatRuntime)) continue
    if (enabledIds.has(descriptor.id) || dismissedIds.has(descriptor.id)) continue
    const detail = descriptor.detect(userMessage)
    if (detail) gaps.push({ capabilityId: descriptor.id, detail })
  }
  return gaps
}

export function findCapability(id: string): CapabilityDescriptor | undefined {
  return CAPABILITY_CATALOG.find((c) => c.id === id)
}

/**
 * The system-prompt section naming what is available but OFF.
 *
 * Returns `null` when everything is on, so a fully-configured prototype's
 * prompt is byte-identical to today's — no cache churn, no tokens spent
 * telling the model about nothing.
 */
export function describeDisabledCapabilities(
  enabledIds: ReadonlySet<string>,
  chatRuntime: CapabilityRuntimeId = 'claude-agent-sdk',
): string | null {
  const off = CAPABILITY_CATALOG.filter((c) => !enabledIds.has(c.id))
  if (off.length === 0) return null

  // Split by WHY each one is off, because the remedy differs and telling the
  // model the wrong one sends the user to a panel that cannot help. A
  // capability this runtime does not serve stays off however the config is
  // written; only a different model brings it back.
  const enableable = off.filter((c) => runtimeSupportsCapability(c, chatRuntime))
  const unavailable = off.filter((c) => !runtimeSupportsCapability(c, chatRuntime))
  const line = (c: CapabilityDescriptor) => `- **${c.label}** (\`${c.id}\`) — ${c.summary}`

  const sections: string[] = [
    '## Capabilities that are available but currently OFF',
    '',
    'These are NOT in your tool list, so you have no tool to try and no error',
    'to react to — you would simply fail without knowing why. If the user asks',
    'for something that needs one, say so plainly. Do not guess at the work.',
    '',
    'Do not attempt to edit config files yourself: you are denied write access',
    'to them, because enabling a capability is the user\'s decision, not yours.',
  ]
  if (enableable.length > 0) {
    sections.push(
      '',
      'The user can turn these on from the Extensions panel (the gear menu):',
      '',
      ...enableable.map(line),
    )
  }
  if (unavailable.length > 0) {
    sections.push(
      '',
      'These cannot be used with the model this conversation is running on, so',
      'the Extensions panel will not help. Say that switching to a Claude model',
      'is what would make them available:',
      '',
      ...unavailable.map(line),
    )
  }
  return sections.join('\n')
}

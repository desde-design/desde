/**
 * The Claude Agent SDK's `canUseTool` binding.
 *
 * `src/editor/agent-chat/edit-ack.ts` owns the actual policy as a
 * Desde-native closure, `buildToolPermissionGate`: path containment, the
 * protected-path list, the new-file extension allowlist, the WebFetch host
 * allowlist, the per-extension read-verb prefixes, the no-op refusal,
 * `old_string` uniqueness, and stale-base conflict detection. That closure
 * has no SDK dependency and is shared by both chat lanes.
 *
 * This file is the SDK-shaped wrapper around it: it translates the SDK's
 * `CanUseTool` callback shape (three args, an `options` object carrying
 * `blockedPath`) into a call on the neutral gate, and casts the neutral
 * `PermissionDecision` result to the SDK's `PermissionResult`. The two types
 * are structurally identical, so this is a type cast around one call, not a
 * translation — there is nowhere for the two lanes to disagree.
 *
 * `@anthropic-ai/claude-agent-sdk` may be imported only from this directory
 * (plus one dynamic import in `editor-cli/src/server/model-catalog-source.ts`)
 * — see `agent-sdk-import-boundary.test.ts`.
 */

import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk'

import {
  buildToolPermissionGate,
  type BuildToolPermissionGateOpts,
} from '../agent-chat/edit-ack'

/** @deprecated Use `BuildToolPermissionGateOpts` from `../agent-chat/edit-ack`. */
export type BuildCanUseToolOpts = BuildToolPermissionGateOpts

export function buildCanUseTool(opts: BuildToolPermissionGateOpts): CanUseTool {
  const gate = buildToolPermissionGate(opts)
  return async (toolName, toolInput, options) => {
    const blockedPath =
      options && typeof options.blockedPath === 'string' && options.blockedPath.length > 0
        ? options.blockedPath
        : undefined
    const decision = await gate(toolName, toolInput, {
      ...(blockedPath !== undefined ? { blockedPath } : {}),
    })
    // `PermissionResult` and `PermissionDecision` are structurally
    // identical — see the file header.
    return decision as PermissionResult
  }
}

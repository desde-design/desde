/**
 * Desde's own tool-permission decision.
 *
 * Structurally identical to the Claude Agent SDK's `PermissionResult` /
 * `CanUseTool`, on purpose: `edit-ack.ts` builds ONE closure and the SDK lane
 * casts it to the SDK's type (`buildCanUseTool`), so no policy is duplicated
 * and no policy is lane-specific.
 *
 * The neutral lane calls the gate for EVERY tool, Read included. Under
 * `permissionMode: 'default'` the SDK never fires `canUseTool` for Read at
 * all (MEASURED, see `file-read-snapshot.ts`), so calling it there is a gap
 * being closed rather than a new restriction.
 */

export type PermissionDecision =
  | {
      behavior: 'allow'
      /**
       * Replacement input, or `{}` for "use the original unchanged". Present
       * because the SDK's runtime Zod schema requires the key even though its
       * TypeScript type marks it optional. The neutral loop ignores a
       * non-empty value: it validates and executes the model's own input, and
       * a gate that wanted to rewrite an argument would be policy hiding in a
       * place nobody looks.
       */
      updatedInput: Record<string, unknown>
    }
  | {
      behavior: 'deny'
      /**
       * Written to be READ BY THE MODEL. It says what was refused and what to
       * do instead, and it deliberately tells the model not to route around
       * the block.
       */
      message: string
    }

export interface ToolPermissionContext {
  signal?: AbortSignal
  toolUseId?: string
  /**
   * A path the RUNTIME has already determined is out of bounds. The SDK sets
   * this on its callback options; the neutral lane never does, because its
   * own tools resolve every path through `resolveRepoPath` before the gate is
   * even reachable. Honoured whenever present, on either lane.
   */
  blockedPath?: string
}

export type ToolPermissionGate = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolPermissionContext,
) => Promise<PermissionDecision>

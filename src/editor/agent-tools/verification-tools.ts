/**
 * The `run_verification` tool. Delegates to a {@link VerificationAdapter}
 * supplied via {@link ToolContext.verificationAdapter}. Substrate-
 * neutral by construction — the Node/npm impl is the only one
 * shipping today, but other substrates plug in behind the same
 * interface.
 *
 * Lives here (alongside the other agent-tools `ToolEntry`s) so the
 * legacy chat-orchestrator can register it via `verificationToolRegistry()`.
 * The SDK runtime wraps the same handler in `editor-tool-handlers.ts`.
 *
 * The tool returns the adapter's structured result verbatim — no
 * additional truncation or transformation. The adapter is responsible
 * for byte caps and abort semantics.
 */

import type {
  VerificationCheck,
} from '../core/verification-adapter'
import type { ToolEntry } from './types'

interface RunVerificationInput {
  check: VerificationCheck
}

export const runVerificationTool: ToolEntry<RunVerificationInput> = {
  def: {
    name: 'run_verification',
    description:
      "Run a verification command in the worktree (typecheck / lint / test / build). Returns { ok, exitCode, stdout, stderr, durationMs, command }. Output is capped at 32KB each on stdout and stderr (the tail is preserved on overflow). When the script is absent and no builtin fallback exists, returns ok=false with noScript=true and the list of available scripts so you can suggest the right one. Use this BEFORE telling the user a change is correct — type errors and lint failures often catch regressions you missed.",
    inputSchema: {
      type: 'object' as const,
      required: ['check'],
      additionalProperties: false,
      properties: {
        check: {
          type: 'string' as const,
          enum: ['typecheck', 'lint', 'test', 'build'] as const,
          description:
            'Which verification verb to run. Mapped to a substrate-specific command by the adapter (e.g. `npm run typecheck`).',
        },
      },
    },
  },
  async run(input, ctx) {
    const adapter = ctx.verificationAdapter
    if (!adapter) {
      return {
        ok: false,
        error:
          'run_verification is not configured for this session: no verification adapter wired. The CLI wires this on every chat turn; this usually means a non-CLI or test context.',
      }
    }
    if (input.check !== 'typecheck' && input.check !== 'lint' && input.check !== 'test' && input.check !== 'build') {
      return {
        ok: false,
        error: `unknown check '${String(input.check)}'. Expected one of: typecheck, lint, test, build`,
      }
    }
    const result = await adapter.run(input.check, { signal: ctx.signal })
    return {
      ok: true,
      output: {
        substrate: adapter.substrateLabel,
        check: input.check,
        ...result,
      },
    }
  },
}

export function verificationToolRegistry(): ReadonlyArray<ToolEntry> {
  return [runVerificationTool] as ToolEntry[]
}

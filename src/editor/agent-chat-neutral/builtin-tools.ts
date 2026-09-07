/**
 * The built-in tool set for the neutral lane.
 *
 * Write and Edit are gated on `writeToolsEnabled`, which is also what the
 * system prompt reads to decide whether to describe them. One flag, two ends:
 * a prompt that describes a tool the catalog does not register is a promise
 * the runtime cannot keep.
 *
 * There is deliberately no WebFetch and no WebSearch. Neither has an
 * equivalent on this lane, and `describeDisabledCapabilities` tells the model
 * so rather than letting it offer something that cannot happen.
 */

import type { ToolSpec } from '../agent-chat/tool-spec'
import { buildEditToolSpec } from './builtin-edit'
import { buildGlobToolSpec, buildGrepToolSpec } from './builtin-glob-grep'
import { buildReadToolSpec, type BuiltinReadOpts } from './builtin-read'
import { buildTodoToolSpec, createTodoStore, type TodoStore } from './builtin-todo'
import { buildWriteToolSpec, type BuiltinWriteOpts } from './builtin-write'

export interface BuiltinToolOpts extends BuiltinReadOpts {
  /** Per-turn checklist store. Created here when the caller supplies none. */
  todoStore?: TodoStore
  /**
   * Offer Write and Edit. Both are also gated at the other end: the model
   * cannot reach a tool the catalog never registered, and the permission gate
   * refuses the call regardless of who asked.
   */
  writeToolsEnabled?: boolean
  /** Everything the write tools need. Required for `writeToolsEnabled`. */
  writeOpts?: BuiltinWriteOpts
}

export function buildBuiltinToolSpecs(opts: BuiltinToolOpts): ToolSpec[] {
  const store = opts.todoStore ?? createTodoStore()
  const specs: ToolSpec[] = [
    buildReadToolSpec(opts),
    buildGlobToolSpec({
      worktreeRoot: opts.worktreeRoot,
      ...(opts.blockSecretReads === true ? { blockSecretReads: true } : {}),
    }),
    buildGrepToolSpec({
      worktreeRoot: opts.worktreeRoot,
      ...(opts.blockSecretReads === true ? { blockSecretReads: true } : {}),
    }),
    buildTodoToolSpec(store),
  ]
  if (opts.writeToolsEnabled === true && opts.writeOpts) {
    specs.push(buildWriteToolSpec(opts.writeOpts), buildEditToolSpec(opts.writeOpts))
  }
  return specs
}

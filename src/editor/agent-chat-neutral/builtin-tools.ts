/**
 * The built-in tool set for the neutral lane.
 *
 * Read-only today. Task 113 adds Write and Edit, gated on
 * `writeToolsEnabled`, which is also what the system prompt reads to decide
 * whether to describe them. One flag, two ends: a prompt that describes a tool
 * the catalog does not register is a promise the runtime cannot keep.
 *
 * There is deliberately no WebFetch and no WebSearch. Neither has an
 * equivalent on this lane, and `describeDisabledCapabilities` tells the model
 * so rather than letting it offer something that cannot happen.
 */

import type { ToolSpec } from '../agent-chat/tool-spec'
import { buildGlobToolSpec, buildGrepToolSpec } from './builtin-glob-grep'
import { buildReadToolSpec, type BuiltinReadOpts } from './builtin-read'
import { buildTodoToolSpec, createTodoStore, type TodoStore } from './builtin-todo'

export interface BuiltinToolOpts extends BuiltinReadOpts {
  /** Per-turn checklist store. Created here when the caller supplies none. */
  todoStore?: TodoStore
}

export function buildBuiltinToolSpecs(opts: BuiltinToolOpts): ToolSpec[] {
  const store = opts.todoStore ?? createTodoStore()
  return [
    buildReadToolSpec(opts),
    buildGlobToolSpec({ worktreeRoot: opts.worktreeRoot }),
    buildGrepToolSpec({ worktreeRoot: opts.worktreeRoot }),
    buildTodoToolSpec(store),
  ]
}

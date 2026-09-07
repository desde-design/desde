/**
 * Desde's own `TodoWrite`.
 *
 * A per-turn scratch list. It is not persisted and is not shown in the chat
 * UI: its value is that writing the plan down measurably keeps a model on a
 * multi-step task, and the echo back is what lets it re-read its own plan
 * later in the same turn without re-deriving it.
 *
 * The list is per TURN, not per session, and the tool says so, because a model
 * told otherwise will assume yesterday's plan is still there.
 */

import { z } from 'zod'

import type { ToolSpec } from '../agent-chat/tool-spec'

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface TodoStore {
  items: TodoItem[]
}

export function createTodoStore(): TodoStore {
  return { items: [] }
}

export function buildTodoToolSpec(store: TodoStore): ToolSpec {
  return {
    name: 'TodoWrite',
    description:
      'Record or update your plan for this turn as a short checklist. Use it when the work has ' +
      'three or more steps, or when the user gave you several things at once, so nothing is ' +
      'dropped. Mark exactly one item `in_progress` at a time and mark each one `completed` as ' +
      'soon as it is done, not at the end. Replace the whole list on every call. The list lasts ' +
      'for this turn only and the user does not see it.',
    kind: 'builtin',
    inputShape: {
      todos: z
        .array(
          z.object({
            content: z.string().describe('What the step is, in a few words.'),
            status: z
              .enum(['pending', 'in_progress', 'completed'])
              .describe('Where the step is now.'),
          }),
        )
        .describe('The complete list, replacing whatever was there before.'),
    },
    handler: async (input) => {
      const todos = Array.isArray(input.todos) ? (input.todos as TodoItem[]) : []
      store.items = todos
      const rendered = todos
        .map((t) => `${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : ' '} ${t.content}`)
        .join('\n')
      return {
        content: [
          {
            type: 'text',
            text: todos.length === 0 ? 'Checklist cleared.' : `Checklist now:\n${rendered}`,
          },
        ],
      }
    },
  }
}

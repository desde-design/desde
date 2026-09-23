/**
 * Live-surface capability registry — the rail for bridge-backed MCP tools.
 *
 * "Live-surface" tools round-trip to the running iframe via the bridge
 * (`bridge_request`): selection, page info, pin — and, once built, screenshot
 * (editor-visualizer.md) and navigate (editor-creation-navigation.md).
 *
 * Declaring them here (vs ad-hoc inline `tool()` calls in editor-tools.ts)
 * keeps the bridge-tool pattern uniform: one place injects the bridge
 * context, one place owns the names (`LIVE_SURFACE_TOOL_NAMES` derives from
 * the list, so it can't drift from what's actually registered), and a new
 * bridge tool is a single registry entry instead of an inline wire + a
 * hand-added name. Framework specifics stay behind the bridge /
 * FrameworkRuntimeAdapter — the handlers here are framework-neutral.
 */
import { z } from 'zod'

import type { BridgeClient } from '../agent-tools/types'
import type { ReviewSurface } from '../core/review-surface'

import {
  captureScreenshot,
  getPageInfo,
  getSelection,
  interact,
  navigate,
  pinSelections,
  type CaptureScreenshotScope,
  type EditorImageToolResult,
  type EditorToolResult,
  type InteractInput,
} from './editor-tool-handlers'

/** Context every live-surface handler needs: the bridge + the turn's abort signal. */
export interface LiveSurfaceContext {
  bridge: BridgeClient
  signal?: AbortSignal
  /**
   * Absolute worktree root (CLI contexts only). Threaded through so
   * `capture_screenshot` can run its no-match auto-navigate recovery
   * (resolve the selector to its source + route from worktree files). Absent in
   * non-CLI contexts → recovery is skipped and a miss is a clean error.
   */
  worktreeRoot?: string
  /**
   * The agent's isolated review surface. When present, the view+drive
   * capabilities (navigate / interact / capture_screenshot) run against it
   * instead of the bridge → user's live iframe — so the agent reviewing its
   * own work never disrupts the page the user is watching. Absent → bridge
   * (prior behavior). See [src/editor/core/review-surface.ts].
   */
  reviewSurface?: ReviewSurface
}

export interface LiveSurfaceCapability {
  /** Bare tool name (namespaced to `mcp__editor__<name>` at registration). */
  name: string
  /** Model-facing description (identical to the prior inline registrations). */
  description: string
  /** Zod raw shape, as `tool()`'s 3rd arg — `{}` for no input. */
  inputSchema: z.ZodRawShape
  /**
   * Handler. `input` is already validated against `inputSchema` by the SDK.
   * Returns a text result, or `EditorImageToolResult` for the one
   * image-producing tool (`capture_screenshot`) — both satisfy the SDK's
   * `CallToolResult`.
   */
  run: (
    ctx: LiveSurfaceContext,
    input: Record<string, unknown>,
  ) => Promise<EditorToolResult | EditorImageToolResult>
}

export const LIVE_SURFACE_CAPABILITIES: readonly LiveSurfaceCapability[] = [
  {
    name: 'get_selection',
    description:
      "Get the user's current selection in the editor: the selected component, the source file it lives in, its props, its position in the component tree, and the surrounding ancestry. Returns null when nothing is selected. Always check this first when the user refers to 'this', 'the button', 'this component', etc.",
    inputSchema: {},
    run: (ctx) => getSelection(ctx),
  },
  {
    name: 'get_page_info',
    description:
      "Get information about the page the user is currently viewing in the iframe: the URL, the route (pathname), the detected framework (e.g. 'vue3', 'react'), and the page title if available. Use this to understand which page the user is working on before reading source files.",
    inputSchema: {},
    run: (ctx) => getPageInfo(ctx),
  },
  {
    name: 'navigate',
    description:
      "Navigate the running prototype to a different route/page (e.g. '/settings', '/ai-gateway/.../models/create'). Use this to work on a page other than the one the user is currently viewing — the agent is otherwise stuck on the visible page. After navigating, call get_page_info / get_selection to inspect the new page. A cross-page navigation reloads the iframe (resolves when the new page reports its route); same-page is a no-op.",
    inputSchema: {
      route: z
        .string()
        .describe(
          "The target route — a pathname (and optional hash), e.g. '/settings' or '/products#reviews'. Use a route the prototype's router actually serves.",
        ),
    },
    run: (ctx, input) => navigate(ctx, { route: input.route as string }),
  },
  {
    name: 'pin_selections',
    description:
      "Pin multiple elements as a simultaneous selection (the chat header will show 'N selected'). Use when the user refers to 'these buttons' / 'the cards in this row' and you need to keep them all in scope across the turn. Subsequent get_selection calls will return all pinned selections.",
    inputSchema: {
      selectors: z
        .array(z.string())
        .describe(
          'CSS selectors to pin as a multi-selection. Each is resolved via the bridge; unresolvable selectors are silently skipped. Pass an empty array to clear multi-select.',
        ),
    },
    run: (ctx, input) =>
      pinSelections(ctx, { selectors: (input.selectors as string[]) ?? [] }),
  },
  {
    name: 'capture_screenshot',
    description:
      "Capture a screenshot of the running prototype and SEE it as an image. Use this to visually verify your work after an edit, to understand a layout/styling issue the user describes, or whenever 'looking' would help more than reading source. scope:'element' captures the user's current selection; scope:'selector' captures a specific element (requires a CSS selector); scope:'viewport' captures the whole page — prefer a tighter scope, large pages may exceed the image size limit and be refused with a hint. If a scope:'selector' target isn't on the page you're currently viewing, the tool resolves the selector to its source + route and auto-navigates there before retrying — so you don't have to navigate first just to screenshot a component you edited elsewhere.",
    inputSchema: {
      scope: z
        .enum(['viewport', 'element', 'selector'])
        .describe(
          "What to capture: 'element' (the user's current selection), 'selector' (a specific element — pass `selector`), or 'viewport' (the whole page).",
        ),
      selector: z
        .string()
        .optional()
        .describe("CSS selector to capture; required when scope is 'selector', ignored otherwise."),
    },
    run: (ctx, input) =>
      captureScreenshot(ctx, {
        scope: input.scope as CaptureScreenshotScope,
        selector: input.selector as string | undefined,
      }),
  },
  {
    name: 'interact',
    description:
      "Click, fill, or select an element by its SEMANTIC TARGET (ARIA role + accessible name), not a CSS selector. Use this to walk a flow live — e.g. click 'Create model', fill the 'Name' field, select an option — when building a screenshot plan or reproducing a user-described flow. The element is resolved on the CURRENTLY-displayed page (navigate first if it's elsewhere). On success it returns the resolved target (role, name, resolvedSelector) — record that in the screenshot plan's step. A miss returns an error: refine role/name/text or navigate to the right page.",
    inputSchema: {
      action: z
        .enum(['click', 'fill', 'select'])
        .describe("What to do: 'click' a button/link, 'fill' a text input, or 'select' an option."),
      role: z
        .string()
        .optional()
        .describe("ARIA role of the target, e.g. 'button', 'link', 'textbox', 'combobox'. Strongly recommended to disambiguate."),
      name: z
        .string()
        .optional()
        .describe("Accessible name / visible label of the target, e.g. 'Create model'. The primary matcher."),
      text: z
        .string()
        .optional()
        .describe('Visible-text fallback when the element has no accessible name.'),
      value: z
        .string()
        .optional()
        .describe("The value to type (action='fill') or the option to choose (action='select')."),
      selector: z
        .string()
        .optional()
        .describe('Optional last-known-good CSS selector to try first (replay cache); normally omit.'),
    },
    run: (ctx, input) =>
      interact(ctx, {
        action: input.action as InteractInput['action'],
        role: input.role as string | undefined,
        name: input.name as string | undefined,
        text: input.text as string | undefined,
        value: input.value as string | undefined,
        selector: input.selector as string | undefined,
      }),
  },
]

/** Namespaced tool names for the live-surface capabilities (derived, never hand-listed). */
export const LIVE_SURFACE_TOOL_NAMES: readonly string[] =
  LIVE_SURFACE_CAPABILITIES.map((c) => `mcp__editor__${c.name}`)

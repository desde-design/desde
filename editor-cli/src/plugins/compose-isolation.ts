import type { Plugin } from "vite"
import {
  composeIsolationPlugin as rootComposeIsolationPlugin,
  type ComposeIsolationPluginOptions,
} from "../../../src/editor/substrate-plugins/vite-plugin-compose-isolation.js"

/**
 * The isolation-page plugin, re-typed against **editor-cli's** Vite.
 *
 * `composeIsolationPlugin` lives in the root package
 * (`src/editor/substrate-plugins/`), which resolves its own `vite` types against
 * the ROOT's `node_modules/vite` — a separate physical install from editor-cli's
 * (measured today: root 7.3.2, editor-cli 8.2.1, a major apart). TypeScript's
 * structural check on private fields (`Environment` / `DevEnvironment`
 * internals) treats the two `Plugin` declarations as incompatible even though
 * the runtime shape — the actual plugin object `createServer` consumes — is
 * identical. The cast is a type-level fix for a duplicate-package-instance
 * quirk, not a behaviour change.
 *
 * **Why it is a file and not a cast at the call site.** The call site is
 * `core.ts`, and § 4's S12 puts `core.ts` outside the set of files allowed to
 * name a Vite type — the cast was the only thing keeping `import type { Plugin }
 * from "vite"` in the boot orchestrator. Moving it into `plugins/`, which owns
 * every other injected plugin, costs one indirection and buys the whole
 * invariant. It also puts the explanation next to the plugins rather than in the
 * middle of a 600-line boot sequence.
 */
export function composeIsolationPlugin(options: ComposeIsolationPluginOptions = {}): Plugin {
  return rootComposeIsolationPlugin(options) as unknown as Plugin
}

import type { Plugin, UserConfig } from "vite"

/**
 * Default Vite's `root` to the prototype root — **only when the repo did not
 * set one itself**.
 *
 * This reproduces `bootSupervisor`'s `userHasRoot` guard
 * (`supervisor/vite-supervisor.ts`: `...(userHasRoot ? {} : { root: prototypeRoot })`)
 * for the hosts that cannot pre-load the repo's config. `bootSupervisor` knows
 * whether the repo set `root` because it called `loadConfigFromFile` itself;
 * React Router forbids that path (`configFile: false` throws), so Vite loads the
 * config and the only place left to ask the question is a plugin hook.
 *
 * **Not an inline `root:`, and that distinction is the whole point.** An inline
 * `createServer({ root })` wins over the repo's own `root` unconditionally,
 * because Vite merges the inline config OVER the file config. A repo that
 * legitimately sets `root: 'app'` would be silently re-rooted at its git root
 * and serve the wrong tree. `??=` semantics are only expressible from inside a
 * hook that can see what the repo asked for.
 *
 * **MEASURED: this is load-bearing, not belt-and-braces.** Booting the
 * `fixture-ssr` React Router app with `configFile: <path>` and no root at all
 * (cwd elsewhere) dies before listen with React Router's own error:
 *
 * ```
 * Error: Could not find a root route module in the app directory as "app/root.tsx"
 *   at createConfigLoader (@react-router/dev/dist/typegen-*.js:353)
 * ```
 *
 * — because Vite fell back to `process.cwd()` and React Router resolved
 * `appDirectory` against it. With this plugin in place the same boot resolved
 * `config.root` to the fixture and served HTTP 200.
 *
 * **Why `enforce: 'pre'` AND `config.order: 'pre'`.** React Router reads
 * `viteUserConfig.root` inside its own normal-enforce `config` hook, so the
 * default has to be written before that hook runs. `enforce` orders the plugin
 * within the pipeline; `config.order` orders this specific hook within the
 * plugin's bucket. Both are set because either alone leaves a bucket in which
 * ties are broken by array position, which is not a property this plugin should
 * depend on.
 */
export function rootDefaultPlugin(prototypeRoot: string): Plugin {
  return {
    name: "@desde/editor-root-default",
    enforce: "pre",
    config: {
      order: "pre",
      handler(config: UserConfig) {
        // Mutate in place and return `undefined`, for the same reason
        // `harden-plugin.ts` does: a returned partial config goes back through
        // `mergeConfig`, and having a merge rule decide `root` is exactly the
        // ambiguity this plugin exists to remove.
        if (typeof config.root !== "string" || config.root.length === 0) {
          config.root = prototypeRoot
        }
        return undefined
      },
    },
  }
}

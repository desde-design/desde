/**
 * Free-identifier analysis for a Vue template.
 *
 * "Free" means: an identifier a template expression reads that is NOT bound
 * by the template itself (`v-for` aliases, `v-slot` props) and is NOT a JS
 * global (`Math`, `Date`, `JSON`, …). Those are exactly the names that must
 * be supplied by the component instance — `<script setup>` bindings, props,
 * options-API members, app-level global properties.
 *
 * Why it exists: applicators that MOVE template markup between components
 * (detach today; attach/extract later) change which instance scope an
 * expression resolves against. An identifier that resolved in the source
 * component may resolve to nothing in the destination, which Vue reports at
 * runtime as `Property "x" was accessed during render but is not defined on
 * instance` — a silent break at edit time. Comparing the free-identifier set
 * before and after the splice turns that into a deterministic refusal.
 *
 * How: rather than re-implementing template scope tracking (v-for aliases,
 * destructured slot props, nested scopes, shorthand object patterns), we run
 * Vue's own compiler with `prefixIdentifiers: true`. In that mode the codegen
 * rewrites every free identifier to `_ctx.<name>` and leaves bound ones and
 * known globals alone, so the free set is readable straight off the generated
 * render function. Component tags become `_resolveComponent("Tag")` and
 * directives `_resolveDirective("d")`, so neither pollutes the set.
 */

import { compile, type CompilerError } from '@vue/compiler-dom'
import type { ParserPlugin } from '@babel/parser'

export type FreeIdentifierResult =
  | { ok: true; identifiers: Set<string> }
  | { ok: false; reason: string }

export interface CollectFreeIdentifiersOptions {
  /**
   * Parse template expressions with the TypeScript plugin. Set when the SFC
   * the template belongs to has a `lang="ts"` script — expressions like
   * `{{ (x as string).length }}` are otherwise a parse error.
   */
  typescript?: boolean
}

/**
 * `_ctx.<ident>` in the generated render function. Codegen only emits this
 * form for real free identifiers (they are always valid JS identifiers, so
 * the bracket form never appears). A text node whose literal content happens
 * to read `_ctx.foo` would produce a phantom entry — harmless, because every
 * consumer of this set treats an extra entry as a reason to refuse, never as
 * a reason to proceed.
 */
const CTX_MEMBER_RE = /_ctx\.([A-Za-z_$][A-Za-z0-9_$]*)/g

export function collectFreeIdentifiers(
  templateContent: string,
  options: CollectFreeIdentifiersOptions = {},
): FreeIdentifierResult {
  const expressionPlugins: ParserPlugin[] = options.typescript ? ['typescript'] : []
  const errors: CompilerError[] = []
  let code: string
  try {
    ;({ code } = compile(templateContent, {
      mode: 'module',
      prefixIdentifiers: true,
      hoistStatic: false,
      cacheHandlers: false,
      expressionPlugins,
      // Collect instead of throwing so a single bad expression yields one
      // honest "could not analyse" rather than an exception with no context.
      // Any error at all invalidates the result: the compiler may have
      // skipped the offending subtree, and an UNDER-collected free set is
      // precisely the failure mode this module exists to prevent.
      onError: (err) => errors.push(err),
      onWarn: () => {},
    }))
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
  if (errors.length > 0) {
    return { ok: false, reason: errors[0].message }
  }

  const identifiers = new Set<string>()
  for (const match of code.matchAll(CTX_MEMBER_RE)) identifiers.add(match[1])
  return { ok: true, identifiers }
}

/**
 * `$`-prefixed names that are bound to THE component instance and therefore
 * mean something different after markup moves to another component.
 *
 * Everything else beginning with `$` is treated as resolvable, because the
 * overwhelmingly common source of such names is `app.config.globalProperties`
 * — `$route`, `$router`, `$t`, `$store`. Those are app-wide and resolve
 * identically in any component, so refusing on them would be a false refusal.
 */
export const INSTANCE_SCOPED_IDENTIFIERS: ReadonlySet<string> = new Set([
  '$props',
  '$attrs',
  '$slots',
  '$emit',
  '$el',
  '$parent',
  '$root',
  '$options',
  '$data',
  // Vue 3's public instance API is a closed, documented set — list ALL of it,
  // not the subset that happened to come up. `$refs` in particular resolves
  // against whichever component the template ends up in, so an inlined
  // `@click="$refs.child.open()"` silently retargets the consumer's refs.
  '$refs',
  '$watch',
  '$nextTick',
  '$forceUpdate',
])

/**
 * `$`-prefixed names that genuinely resolve the same in ANY component because
 * a plugin installs them on the app, not the instance.
 *
 * This is an ALLOW-list on purpose. The obvious formulation — "instance-bound
 * if it is in the built-in set, app-global otherwise" — fails OPEN for every
 * `$name` nobody thought of, which is the exact silent-breakage class this
 * module exists to close. An unknown `$name` is now treated as unresolvable
 * and REFUSED by name, which this codebase's deterministic-first rule
 * ("ambiguity loses") prefers over a wrong write. The cost is a clean,
 * named false refusal for an app global not listed here; add it when one
 * shows up.
 */
const APP_GLOBAL_IDENTIFIERS: ReadonlySet<string> = new Set([
  '$route',
  '$router',
  '$store',
  '$pinia',
  '$t',
  '$tc',
  '$te',
  '$d',
  '$n',
  '$i18n',
])

/**
 * True when `identifier` names something that is bound to a specific
 * component instance rather than to the whole app.
 */
export function isInstanceScopedIdentifier(identifier: string): boolean {
  return INSTANCE_SCOPED_IDENTIFIERS.has(identifier)
}

/**
 * True when `identifier` is a KNOWN app-level global property (`$route`,
 * `$t`, …) — one that resolves identically in any component.
 *
 * Membership, not absence: see APP_GLOBAL_IDENTIFIERS for why an unknown
 * `$name` must not be assumed app-global.
 */
export function isAppGlobalIdentifier(identifier: string): boolean {
  return APP_GLOBAL_IDENTIFIERS.has(identifier)
}

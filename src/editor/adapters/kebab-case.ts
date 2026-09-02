/**
 * kebab-case a component name for a local-source manifest id
 * (`${designSystem}.${kebabCase(name)}`). Shared (audit Task 20 dedup) by
 * `local-vue` and `local-react` — both extract manifests from first-party,
 * app-authored components (PascalCase/camelCase names like `MetricsCard`,
 * `userAvatar`), and had byte-identical copies of this.
 *
 * Deliberately NOT shared with `component-meta/normalize.ts`'s own
 * `kebabCase` — that one uses a different regex
 * (`/([A-Z])/g` → `-$1` on EVERY uppercase letter, not just after a
 * lowercase/digit) and the two disagree on consecutive-capital names, which
 * is exactly the design system's own naming convention: this function's
 * lowercase-before-uppercase transition regex leaves "K" (never preceded by
 * a lowercase/digit) undashed — `kebabCase('UiButton') === 'kbutton'` —
 * while component-meta's dashes every capital including the leading one —
 * `kebabCase('UiButton') === 'ui-button'`. Acme DS component names are
 * always K-prefixed, so unifying would silently change every Acme DS
 * manifest id. See `component-meta/normalize.ts`'s own `kebabCase` for the
 * sibling, and this module's colocated `kebab-case.test.ts` for the
 * behavioral diff pinned in a test.
 */
export function kebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}

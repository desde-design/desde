import type { StyleOrigin } from "@/types/bridge"
import { StyleScopeDialog } from "@/components/editor/style-scope-dialog"
import { availableScopes, type StyleScope } from "@/components/editor/style-scope-decision"
import type { SurfaceEntry } from "../types"

/** Token-driven value winning from a library stylesheet — the canonical ambiguous case. */
const TOKEN_ORIGIN: StyleOrigin = {
  property: "background-color",
  computedValue: "rgb(247,247,247)",
  winningRule: {
    selector: ".acme-empty-state",
    stylesheet: {
      href: "http://x/node_modules/@acme/design-system/s.css",
      package: "@acme/design-system",
    },
    declaration: "background-color: var(--acme-color-background-disabled)",
    specificity: [0, 1, 0],
  },
  varChain: [
    {
      name: "--acme-color-background-disabled",
      value: "#f7f7f7",
      definedAt: { selector: ":root", stylesheet: { href: "http://x/tokens.css" } },
    },
  ],
  tokenUsageCount: 34,
}

/** Value arrives by inheritance — a local class splice would mis-target. */
const INHERITED_ORIGIN: StyleOrigin = {
  property: "color",
  computedValue: "rgb(28,31,35)",
  winningRule: {
    selector: "body",
    stylesheet: { href: "http://x/src/styles/base.css" },
    declaration: "color: #1c1f23",
    specificity: [0, 0, 1],
  },
  varChain: [],
  inherited: true,
}

/** Nothing declares it — un-attributable, the library/UA-default ambiguity. */
const UNATTRIBUTABLE_ORIGIN: StyleOrigin = {
  property: "padding-inline",
  computedValue: "12px",
  winningRule: null,
  varChain: [],
}

/**
 * Which scopes are actually WIRED, mirroring `computeEnabledScopes`
 * (inspector-panel.tsx): element always, plus each other offered scope whose
 * capability the project has.
 *
 * This must never be hand-listed, and it must never be `["element"]` alone:
 * `handleScopedStyleEdit` short-circuits and applies the edit directly when
 * exactly one scope is enabled (inspector-panel.tsx — `if
 * (enabledForOrigin.length === 1)`), so the dialog can only ever be rendered
 * with two or more. A single-enabled fixture would put "(coming soon)" tiles
 * in the screenshots for a dialog the product would never have opened.
 *
 * The fixtures below model a project where page and token editing are both
 * available, which is the case that actually reaches this dialog.
 */
function enabledFor(
  origin: StyleOrigin,
  opts: { elementScopeOutranked?: boolean } = {},
): StyleScope[] {
  const offered = availableScopes(origin, { framework: "vue3", ...opts })
  return offered.filter((scope) => scope !== "component")
}

export const STYLE_SCOPE_SURFACE: SurfaceEntry = {
  id: "style-scope",
  title: "Style scope (where should this write?)",
  kind: "modal",
  sourceFile: "src/components/editor/style-scope-dialog.tsx",
  states: [
    {
      id: "style-scope/token-driven",
      label: "Token-driven, library rule (element/page/token offered)",
      render: (ctx) => (
        <StyleScopeDialog
          open
          property="background-color"
          origin={TOKEN_ORIGIN}
          // Both lists are derived, never hand-listed — see `enabledFor` above
          // and inspector-panel.tsx's identical calls beside the real dialog.
          scopes={availableScopes(TOKEN_ORIGIN, { framework: "vue3" })}
          enabledScopes={enabledFor(TOKEN_ORIGIN)}
          onConfirm={(scope, remember) => ctx.log("onConfirm", scope, remember)}
          onCancel={() => ctx.log("onCancel")}
        />
      ),
    },
    {
      id: "style-scope/inherited",
      label: "Inherited from an ancestor",
      render: (ctx) => (
        <StyleScopeDialog
          open
          property="color"
          origin={INHERITED_ORIGIN}
          scopes={availableScopes(INHERITED_ORIGIN, { framework: "vue3" })}
          enabledScopes={enabledFor(INHERITED_ORIGIN)}
          onConfirm={(scope, remember) => ctx.log("onConfirm", scope, remember)}
          onCancel={() => ctx.log("onCancel")}
        />
      ),
    },
    {
      id: "style-scope/element-outranked",
      label: "Element scope can't win the cascade",
      render: (ctx) => (
        <StyleScopeDialog
          open
          property="background-color"
          origin={TOKEN_ORIGIN}
          scopes={availableScopes(TOKEN_ORIGIN, {
            framework: "vue3",
            elementScopeOutranked: true,
          })}
          enabledScopes={enabledFor(TOKEN_ORIGIN, { elementScopeOutranked: true })}
          elementScopeOutranked
          onConfirm={(scope, remember) => ctx.log("onConfirm", scope, remember)}
          onCancel={() => ctx.log("onCancel")}
        />
      ),
    },
    {
      id: "style-scope/unattributable",
      label: "No winning rule (un-attributable value)",
      render: (ctx) => (
        <StyleScopeDialog
          open
          property="padding-inline"
          origin={UNATTRIBUTABLE_ORIGIN}
          scopes={availableScopes(UNATTRIBUTABLE_ORIGIN, { framework: "vue3" })}
          enabledScopes={enabledFor(UNATTRIBUTABLE_ORIGIN)}
          onConfirm={(scope, remember) => ctx.log("onConfirm", scope, remember)}
          onCancel={() => ctx.log("onCancel")}
        />
      ),
    },
  ],
}

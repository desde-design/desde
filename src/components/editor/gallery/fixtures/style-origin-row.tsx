"use client"

import {
  StyleOriginRow,
} from "@/components/editor/style-origin-row"
import type { StyleOrigin } from "@/types/bridge"
import type { SurfaceEntry } from "../types"
import { InlineFrame } from "./inline-frame"

/**
 * The inspector's "From:" provenance line — the one-liner under a style row
 * that says where a rendered value actually comes from, with a popover holding
 * the full cascade chain.
 *
 * It is a *silent* surface by design: `StyleOriginRow` returns `null` when an
 * origin has no winning rule, no inline override and no transient explanation.
 * Every fixture below therefore has to carry a real reason to render — an
 * origin that renders nothing would be a blank tile in the contact sheet, and
 * the registry's own test would fail it.
 *
 * The popover content is not visible in a screenshot without opening it, so
 * these states show the collapsed line. That IS the surface most people see;
 * the chain behind it is one click away in the live gallery.
 */

const LIBRARY_TOKEN_ORIGIN: StyleOrigin = {
  property: "background-color",
  computedValue: "rgb(247, 247, 247)",
  winningRule: {
    selector: ".acme-empty-state",
    stylesheet: {
      href: "http://localhost:5173/node_modules/@acme/design-system/dist/style.css",
      package: "@acme/design-system",
    },
    declaration: "background-color: var(--acme-color-background-disabled)",
    specificity: [0, 1, 0],
  },
  varChain: [
    {
      name: "--acme-color-background-disabled",
      value: "#f7f7f7",
      definedAt: {
        selector: ":root",
        stylesheet: { href: "http://localhost:5173/node_modules/@acme/design-tokens/tokens.css" },
      },
    },
  ],
  tokenUsageCount: 34,
}

const FIRST_PARTY_ORIGIN: StyleOrigin = {
  property: "padding-inline",
  computedValue: "16px",
  winningRule: {
    selector: ".pricing-card",
    stylesheet: { href: "http://localhost:5173/src/styles/pricing.css" },
    declaration: "padding-inline: 16px",
    specificity: [0, 1, 0],
  },
  varChain: [],
}

const INLINE_OVERRIDE_ORIGIN: StyleOrigin = {
  property: "color",
  computedValue: "rgb(28, 31, 35)",
  winningRule: {
    selector: ".pricing-card__title",
    stylesheet: { href: "http://localhost:5173/src/styles/pricing.css" },
    declaration: "color: #6b7280",
    specificity: [0, 1, 0],
  },
  varChain: [],
  inline: { value: "#1c1f23", important: true },
}

const INHERITED_ORIGIN: StyleOrigin = {
  property: "font-family",
  computedValue: '"Inter", system-ui, sans-serif',
  winningRule: {
    selector: "body",
    stylesheet: { href: "http://localhost:5173/src/styles/base.css" },
    declaration: 'font-family: "Inter", system-ui, sans-serif',
    specificity: [0, 0, 1],
  },
  varChain: [],
  inherited: true,
}

/**
 * A hover-only declaration. `transientRuleApplies` is what turns "a resting
 * rule beside a hovered value" from a contradiction into an explanation — see
 * the module comment on `style-origin-row.tsx`.
 */
const TRANSIENT_ORIGIN: StyleOrigin = {
  property: "background-color",
  computedValue: "rgb(0, 111, 233)",
  winningRule: {
    selector: ".ui-button:hover",
    stylesheet: {
      href: "http://localhost:5173/node_modules/@acme/design-system/dist/style.css",
      package: "@acme/design-system",
    },
    declaration: "background-color: #006fe9",
    specificity: [0, 2, 0],
  },
  varChain: [],
  // With the leading colon, as `style-provenance.ts` emits it
  // (`{ pseudoClass: `:${transientPseudo}` }`). Without it the fixture rendered
  // "only under hover" where the product renders "only under :hover".
  transientRuleApplies: { pseudoClass: ":hover" },
}

function row(origin: StyleOrigin, label: string) {
  return (
    <InlineFrame>
      <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-mono text-code-lg text-foreground">{origin.computedValue}</p>
        <StyleOriginRow origin={origin} />
      </div>
    </InlineFrame>
  )
}

export const STYLE_ORIGIN_ROW_SURFACE: SurfaceEntry = {
  id: "style-origin-row",
  title: "Inspector: style provenance (“From:”)",
  kind: "inline",
  sourceFile: "src/components/editor/style-origin-row.tsx",
  states: [
    {
      id: "style-origin-row/library-token",
      label: "Library rule resolving through a token",
      render: () => row(LIBRARY_TOKEN_ORIGIN, "background-color"),
    },
    {
      id: "style-origin-row/first-party",
      label: "Plain first-party rule",
      render: () => row(FIRST_PARTY_ORIGIN, "padding-inline"),
    },
    {
      id: "style-origin-row/inline-important",
      label: "Inline !important beats the stylesheet",
      render: () => row(INLINE_OVERRIDE_ORIGIN, "color"),
    },
    {
      id: "style-origin-row/inherited",
      label: "Inherited from an ancestor",
      render: () => row(INHERITED_ORIGIN, "font-family"),
    },
    {
      id: "style-origin-row/transient-hover",
      label: "Hover state is what's live",
      render: () => row(TRANSIENT_ORIGIN, "background-color"),
    },
  ],
}

/**
 * Desde Bridge — Style Categories
 *
 * Extracted verbatim from `comment-bridge.ts`. Pure data + a pure predicate
 * used by the inspector to group/filter computed styles. No closure state.
 * `STYLE_CATEGORIES` and `isDefaultValue` are consumed by the inspector;
 * `DEFAULT_VALUES`/`ZERO_VALUES` stay module-private. esbuild inlines this
 * back into the IIFE at bundle time.
 */

interface StyleCategoryDef {
  name: string
  properties: string[]
}

export const STYLE_CATEGORIES: StyleCategoryDef[] = [
  {
    name: "Layout",
    properties: [
      "display", "position", "top", "right", "bottom", "left", "z-index",
      "float", "clear", "flex-direction", "flex-wrap", "flex-grow",
      "flex-shrink", "flex-basis", "justify-content", "align-items",
      "align-self", "align-content", "order", "gap", "row-gap", "column-gap",
      "grid-template-columns", "grid-template-rows", "grid-column",
      "grid-row", "grid-area",
    ],
  },
  {
    name: "Size",
    properties: [
      "width", "height", "min-width", "min-height", "max-width",
      "max-height", "overflow", "overflow-x", "overflow-y",
    ],
  },
  {
    name: "Spacing",
    properties: [
      "margin-top", "margin-right", "margin-bottom", "margin-left",
      "padding-top", "padding-right", "padding-bottom", "padding-left",
    ],
  },
  {
    name: "Typography",
    properties: [
      "font-family", "font-size", "font-weight", "font-style",
      "line-height", "letter-spacing", "text-align", "text-decoration",
      "text-transform", "white-space", "word-break", "word-spacing", "color",
    ],
  },
  {
    name: "Background",
    properties: [
      "background-color", "background-image", "background-size",
      "background-position", "background-repeat",
    ],
  },
  {
    name: "Border",
    properties: [
      "border-top-width", "border-right-width", "border-bottom-width",
      "border-left-width", "border-top-style", "border-right-style",
      "border-bottom-style", "border-left-style", "border-top-color",
      "border-right-color", "border-bottom-color", "border-left-color",
      "border-radius", "border-top-left-radius", "border-top-right-radius",
      "border-bottom-right-radius", "border-bottom-left-radius",
      "outline-width", "outline-style", "outline-color", "outline-offset",
    ],
  },
  {
    name: "Effects",
    properties: [
      "opacity", "box-shadow", "text-shadow", "transform", "transition",
      "animation", "filter", "backdrop-filter", "cursor", "pointer-events",
      "visibility",
    ],
  },
]

const DEFAULT_VALUES: Record<string, Set<string>> = {
  display: new Set(["inline"]),
  position: new Set(["static"]),
  float: new Set(["none"]),
  clear: new Set(["none"]),
  overflow: new Set(["visible"]),
  "overflow-x": new Set(["visible"]),
  "overflow-y": new Set(["visible"]),
  visibility: new Set(["visible"]),
  opacity: new Set(["1"]),
  cursor: new Set(["auto"]),
  "pointer-events": new Set(["auto"]),
  "text-decoration": new Set(["none solid rgb(0, 0, 0)", "none"]),
  "text-transform": new Set(["none"]),
  "white-space": new Set(["normal"]),
  "word-break": new Set(["normal"]),
  "font-style": new Set(["normal"]),
  "background-image": new Set(["none"]),
  "background-size": new Set(["auto"]),
  "background-repeat": new Set(["repeat"]),
  transform: new Set(["none"]),
  transition: new Set(["all 0s ease 0s", "none"]),
  animation: new Set(["none 0s ease 0s 1 normal none running", "none"]),
  filter: new Set(["none"]),
  "backdrop-filter": new Set(["none"]),
  "box-shadow": new Set(["none"]),
  "text-shadow": new Set(["none"]),
}

const ZERO_VALUES = new Set(["0px", "0", "0%", "0em", "0rem"])

export function isDefaultValue(property: string, value: string): boolean {
  if (!value || value === "initial" || value === "normal" || value === "auto") {
    if (
      property.startsWith("margin") || property.startsWith("padding") ||
      property.startsWith("border") || property.startsWith("outline") ||
      ["top", "right", "bottom", "left", "z-index", "order"].includes(property) ||
      property.startsWith("flex-") || property.startsWith("grid-") ||
      ["gap", "row-gap", "column-gap"].includes(property)
    ) return true
  }
  if (ZERO_VALUES.has(value)) {
    if (
      property.startsWith("margin") || property.startsWith("padding") ||
      (property.startsWith("border") && property.includes("width")) ||
      (property.startsWith("outline") && property.includes("width")) ||
      (property.startsWith("border") && property.includes("radius")) ||
      ["gap", "row-gap", "column-gap", "letter-spacing", "word-spacing"].includes(property)
    ) return true
  }
  const defaults = DEFAULT_VALUES[property]
  if (defaults && defaults.has(value)) return true
  if (property.includes("border") && property.includes("style") && value === "none") return true
  return false
}

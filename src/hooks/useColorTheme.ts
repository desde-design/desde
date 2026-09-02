"use client"

/**
 * Color-theme selection for the editor chrome.
 *
 * The palettes themselves live in `src/styles/globals.css` as `[data-theme="…"]`
 * blocks (coral / amber / teal); switching is just the `data-theme` attribute
 * on <html>. The served HTML hard-codes a default (`data-theme="coral"`); this
 * hook lets the user override it from the settings menu and persists the choice
 * to localStorage, re-applying it on the next load.
 *
 * Light/dark is orthogonal (the `.dark` class) and is not touched here.
 */

import { useCallback, useEffect, useState } from "react"

export type ColorThemeId = "coral" | "amber" | "teal"

export interface ColorThemeOption {
  id: ColorThemeId
  label: string
  /** Light-mode `--primary` for the picker swatch. */
  swatch: string
}

export const COLOR_THEMES: ColorThemeOption[] = [
  { id: "coral", label: "Coral", swatch: "oklch(0.615 0.175 25)" },
  { id: "amber", label: "Amber", swatch: "oklch(0.63 0.16 54)" },
  { id: "teal", label: "Teal", swatch: "oklch(0.575 0.135 190)" },
]

const STORAGE_KEY = "desde-color-theme"
const DEFAULT_THEME: ColorThemeId = "teal"

function isColorThemeId(value: string | null): value is ColorThemeId {
  return value === "coral" || value === "amber" || value === "teal"
}

function readInitial(): ColorThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME
  const stored = window.localStorage.getItem(STORAGE_KEY)
  if (isColorThemeId(stored)) return stored
  const attr = document.documentElement.getAttribute("data-theme")
  return isColorThemeId(attr) ? attr : DEFAULT_THEME
}

export function useColorTheme() {
  const [theme, setThemeState] = useState<ColorThemeId>(readInitial)

  // Apply on mount and on every change — this is what makes a persisted choice
  // win over the hard-coded `data-theme` in the served HTML on first load.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme)
  }, [theme])

  const setTheme = useCallback((next: ColorThemeId) => {
    setThemeState(next)
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, next)
    }
  }, [])

  return { theme, setTheme, themes: COLOR_THEMES }
}

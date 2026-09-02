import type {
  TextAlign,
  TextColor,
  TextSize,
  TextStyle,
} from "@/types/canvas"

export const DEFAULT_TEXT_STYLE: TextStyle = {
  size: "md",
  color: "default",
  bold: false,
  italic: false,
  align: "left",
}

export const TEXT_SIZE_PX: Record<TextSize, number> = {
  xs: 12,
  sm: 16,
  md: 24,
  lg: 36,
  xl: 56,
}

export const TEXT_SIZE_LABEL: Record<TextSize, string> = {
  xs: "Extra small",
  sm: "Small",
  md: "Medium",
  lg: "Large",
  xl: "Extra large",
}

export const TEXT_SIZE_ORDER: TextSize[] = ["xs", "sm", "md", "lg", "xl"]

export const TEXT_COLOR_VAR: Record<TextColor, string> = {
  default: "var(--foreground)",
  muted: "var(--muted-foreground)",
  destructive: "var(--destructive)",
  "chart-1": "var(--chart-1)",
  "chart-2": "var(--chart-2)",
  "chart-3": "var(--chart-3)",
  "chart-4": "var(--chart-4)",
  "chart-5": "var(--chart-5)",
}

export const TEXT_COLOR_ORDER: TextColor[] = [
  "default",
  "muted",
  "destructive",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
]

export const TEXT_ALIGN_ORDER: TextAlign[] = ["left", "center", "right"]

export function resolveTextStyle(style: TextStyle | undefined): TextStyle {
  return style ?? DEFAULT_TEXT_STYLE
}

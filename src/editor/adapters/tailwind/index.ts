/**
 * Tailwind substrate adapter. Today it holds exactly one probe: does this
 * prototype compile its utilities with `!important` (v4 global important mode /
 * v3 `important: true`)? That answers the neutral `importantUtilities` substrate
 * capability consumed by the inspector's style-scope decision.
 */
export {
  detectTailwindImportantMode,
  cssEnablesTailwindImportantMode,
  configEnablesTailwindImportantMode,
  type TailwindImportantDetection,
  type TailwindImportantSignal,
} from './detect-important-utilities'

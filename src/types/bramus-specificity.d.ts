/**
 * Ambient declaration for `@bramus/specificity` (v2) — the package ships no
 * bundled `.d.ts`. Types only the surface the style-provenance cascade walker
 * uses: the default export's static `calculate()` and the result's `toArray()`
 * + comparison helpers. See src/bridge/style-provenance.ts.
 */
declare module '@bramus/specificity' {
  interface SpecificityResult {
    a: number
    b: number
    c: number
    /** [id, class, type] specificity triple. */
    toArray(): [number, number, number]
    toObject(): { a: number; b: number; c: number }
    toString(): string
    isEqualTo(other: SpecificityResult): boolean
    isGreaterThan(other: SpecificityResult): boolean
    isLessThan(other: SpecificityResult): boolean
  }

  const Specificity: {
    /** One result per comma-separated selector in the list. */
    calculate(selector: string): SpecificityResult[]
  }

  export default Specificity
}

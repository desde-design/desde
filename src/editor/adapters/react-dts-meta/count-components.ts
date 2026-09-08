/**
 * How many React components does each candidate package export? The cheap
 * count the onboarding suggester's React arm needs (`onboarding/suggest.ts`).
 *
 * "Cheap" is relative to what the Vue arm gets for free: Vue libraries ship
 * one `*.vue.d.ts` per component, so counting them is a file glob. React has
 * no per-component file convention, so the only honest count is "enumerate
 * the entry's exports and keep the ones that type as a component", which is
 * a TS-checker question.
 *
 * What keeps it cheap:
 *  - ONE program for every candidate, not one per package. The cost of a
 *    `.d.ts` program is dominated by the shared lib files (`lib.dom`, the
 *    React types), which are parsed once here and reused across candidates.
 *  - The checker is lazy: the count only resolves the type of each EXPORTED
 *    symbol, never the package's whole declaration graph.
 *  - The predicate is the extractor's own {@link getReactPropsType}, so a
 *    package that counts N here extracts N components when it is onboarded.
 *    A count that disagreed with the extractor would be a suggestion the
 *    user could not act on.
 *
 * Alias-typed components (`declare const Button: ExtendButtonBase<…>`) resolve
 * correctly because this is the checker, not a regex over the declaration
 * text. A syntactic count was considered and rejected on exactly that shape:
 * the largest React design systems declare their components through aliases,
 * and a regex would have counted them as zero.
 */
import { buildProgram } from '../ts-program'
import { getReactPropsType } from './index'

/**
 * The exported React component NAMES per package, in export order. Every key
 * of `entriesByPackage` is present in the result; a package whose entry
 * cannot be loaded gets an empty list rather than being dropped, so the
 * caller can tell "not a component library" from "never asked".
 *
 * Names rather than a bare count because the suggester reads them: an
 * export list that is mostly `*Icon` / `Icon*` is an icon set, which is a
 * different product surface (`adapters/icon-sets`) and not a design system.
 */
export function listReactComponents(
  tsconfigPath: string | null,
  entriesByPackage: ReadonlyMap<string, readonly string[]>,
): Map<string, string[]> {
  const names = new Map<string, string[]>()
  for (const pkg of entriesByPackage.keys()) names.set(pkg, [])

  const allEntries = [...new Set([...entriesByPackage.values()].flat())]
  const program = buildProgram(tsconfigPath, allEntries)
  if (!program) return names
  const checker = program.getTypeChecker()

  for (const [pkg, entries] of entriesByPackage) {
    const seen = new Set<string>()
    for (const entry of entries) {
      const sf = program.getSourceFile(entry)
      if (!sf) continue
      const moduleSym = checker.getSymbolAtLocation(sf)
      if (!moduleSym) continue
      for (const exportSym of checker.getExportsOfModule(moduleSym)) {
        const name = exportSym.getName()
        if (seen.has(name)) continue
        try {
          const type = checker.getTypeOfSymbolAtLocation(exportSym, sf)
          if (getReactPropsType(checker, type, sf, name)) seen.add(name)
        } catch {
          // One bad export must not poison the count (same posture as the extractor).
        }
      }
    }
    names.set(pkg, [...seen])
  }
  return names
}

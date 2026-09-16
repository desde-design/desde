/**
 * Which React components does each candidate package export, and what props
 * does each one take? The cheap listing the onboarding suggester's React arm
 * needs (`onboarding/suggest.ts`).
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
 *  - The checker is lazy: the listing only resolves the type of each EXPORTED
 *    symbol, never the package's whole declaration graph. The props-type key
 *    (below) is chosen so that it stays that way: it never asks the checker
 *    for a props type's members.
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
import * as ts from 'typescript'
import { buildProgram } from '../ts-program'
import { getReactPropsType } from './index'

/**
 * One exported React component, as the suggester sees it.
 *
 * `propsType` is an opaque key for the props type the component takes: two
 * components in the SAME listing have the same key when they take the same
 * props. That is what the icon guard reads (`looksLikeIconSet`): an icon set
 * declares thousands of components over ONE props type (`RemixiconProps`,
 * `IconProps`, `LucideProps`), a design system declares one props type per
 * component. MEASURED 2026-09-15 over 55 packages: every icon set has 286 or
 * more names per props type, every design system 1.29 or fewer.
 *
 * The key is only comparable within one listing. `null` means the props type
 * carries no information about sharing (`any`, `unknown`, `{}`, `object`): a
 * loose declaration, not a shared shape. `@telekom/scale-components-react`
 * types all 442 of its wrappers `any`; that is not 442 components sharing
 * props, it is 442 components saying nothing.
 */
export interface ListedReactComponent {
  name: string
  propsType: string | null
}

/**
 * The exported React components per package, in export order. Every key of
 * `entriesByPackage` is present in the result; a package whose entry cannot
 * be loaded gets an empty list rather than being dropped, so the caller can
 * tell "not a component library" from "never asked".
 */
export function listReactComponents(
  tsconfigPath: string | null,
  entriesByPackage: ReadonlyMap<string, readonly string[]>,
): Map<string, ListedReactComponent[]> {
  const listed = new Map<string, ListedReactComponent[]>()
  for (const pkg of entriesByPackage.keys()) listed.set(pkg, [])

  const allEntries = [...new Set([...entriesByPackage.values()].flat())]
  const program = buildProgram(tsconfigPath, allEntries)
  if (!program) return listed
  const checker = program.getTypeChecker()

  for (const [pkg, entries] of entriesByPackage) {
    const seen = new Set<string>()
    const components: ListedReactComponent[] = []
    const ids = new Map<ts.Type, number>()
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
          const props = getReactPropsType(checker, type, sf, name)
          if (!props) continue
          seen.add(name)
          components.push({ name, propsType: propsTypeKey(checker, props, ids) })
        } catch {
          // One bad export must not poison the count (same posture as the extractor).
        }
      }
    }
    listed.set(pkg, components)
  }
  return listed
}

/**
 * A key for a props type that costs no member resolution.
 *
 * The checker instantiates a generic once per distinct argument list and
 * hands back the same object every time, across files: the 832 icons of
 * `@ant-design/icons` each declare `Omit<AntdIconProps, "ref"> &
 * RefAttributes<HTMLSpanElement>` in their own `.d.ts` and resolve to ONE
 * intersection object. So object identity is the key, and it is free.
 *
 * The one shape identity misses is a type literal written out by hand at
 * every declaration: `@heroicons/react` declares each icon as
 * `Omit<SVGProps<…>, "ref"> & { title?: string; titleId?: string } & …`, and
 * every file's `{ title?: …}` is its own anonymous type. Those mean the same,
 * so a hand-written literal is keyed by its MEMBERS instead: each property's
 * name and the key of its type, recursively, plus any index signatures. Not
 * by its source text: `{ value: Value }` in two files can bind `Value` to two
 * different aliases, and the member key tells them apart where the text
 * would not (codex, whole-branch review, 2026-09-15). Only a literal that was
 * WRITTEN gets this, never one the checker produced by instantiating a
 * generic (`ObjectFlags.Instantiated`): the body of `type Wrap<P> = { inner:
 * P }` is one literal for every `P`, and identity is what tells those apart.
 *
 * `checker.typeToString` would also key by structure, but printing a type
 * resolves its members, and MEASURED 2026-09-15 that costs 2.8 s of a 4.2 s
 * scan on `@chakra-ui/react` (775 components). Identity costs nothing, and the
 * members of a hand-written literal cost only what that literal declares.
 * Identity agreed with the printed text on every package measured except
 * heroicons, which the literal rule covers.
 *
 * What the member key does NOT carry, by ruling (codex delta review 2,
 * 2026-09-15): rest and `this` parameter metadata on a literal's call
 * signatures, so `{ (x: string[]): void }` and `{ (...x: string[]): void }`
 * share a key. A props type is data; no package measured declares a callable
 * props literal at all, and reaching the shared-props threshold would take
 * twenty brand-prefixed components whose props are callable literals that
 * differ only there. Three review rounds had each found the next omission in
 * the previous round's fix to this branch, none with a measured case behind
 * it, which is the loop's stop signal. If a real package ever shows the
 * shape, add the marker here and a case to `Keys.d.ts`.
 */
function propsTypeKey(checker: ts.TypeChecker, type: ts.Type, ids: Map<ts.Type, number>): string | null {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive)) return null
  if (type.isIntersection()) {
    const parts = type.types.map((t) => propsTypeKey(checker, t, ids))
    return parts.some((p) => p === null) ? null : parts.join(' & ')
  }
  if (type.isUnion()) {
    const parts = type.types.map((t) => propsTypeKey(checker, t, ids))
    return parts.some((p) => p === null) ? null : parts.join(' | ')
  }
  if (type.flags & ts.TypeFlags.Object && !type.aliasSymbol) {
    const objectFlags = (type as ts.ObjectType).objectFlags
    if (objectFlags & ts.ObjectFlags.Anonymous && !(objectFlags & ts.ObjectFlags.Instantiated)) {
      const decl = type.symbol?.declarations?.[0]
      // This walk cannot loop. It only descends into a hand-written literal's
      // members, and a member that is itself a hand-written literal is a
      // NESTED node, a tree. Any way back to an enclosing literal (`typeof X`,
      // an alias, an interface, a conditional type) is a type this branch
      // does not enter, so it is keyed by identity below and the walk ends.
      if (decl && ts.isTypeLiteralNode(decl)) {
        // Every kind of member a literal can declare, modifiers included, so
        // two literals get one key only when they declare the same thing
        // (codex, delta review 1: `readonly value` is not `value`, and
        // `{ (): string }` is not `{ (): number }`).
        const key = (t: ts.Type) => propsTypeKey(checker, t, ids)
        const members = type.getProperties().map((prop) => {
          const at = prop.valueDeclaration ?? prop.declarations?.[0] ?? decl
          const readonly = ts.getCombinedModifierFlags(at) & ts.ModifierFlags.Readonly ? 'readonly ' : ''
          const optional = prop.flags & ts.SymbolFlags.Optional ? '?' : ''
          return `${readonly}${prop.getName()}${optional}: ${key(checker.getTypeOfSymbolAtLocation(prop, at))}`
        })
        const indexes = checker
          .getIndexInfosOfType(type)
          .map((info) => `${info.isReadonly ? 'readonly ' : ''}[${key(info.keyType)}]: ${key(info.type)}`)
        const signature = (sig: ts.Signature) => {
          const params = sig
            .getParameters()
            .map((p) => key(checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? p.declarations?.[0] ?? decl)))
          return `(${params.join(', ')}) => ${key(sig.getReturnType())}`
        }
        const signatures = [
          ...type.getCallSignatures().map(signature),
          ...type.getConstructSignatures().map((sig) => `new ${signature(sig)}`),
        ]
        return `{ ${[...members, ...indexes, ...signatures].join('; ')} }`
      }
      // `{}` says nothing about sharing either. The checker keeps ONE empty
      // type literal for the whole program, with no declaration behind it.
      if (!decl && type.getProperties().length === 0) return null
    }
  }
  let id = ids.get(type)
  if (id === undefined) {
    id = ids.size
    ids.set(type, id)
  }
  return `#${id}`
}

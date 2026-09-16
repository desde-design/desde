// One of a PAIR with LiteralB.d.ts: the same type-literal TEXT in two files.
// `{ title?: string; titleId?: string }` means the same thing in both (the
// @heroicons/react shape) and must share a key. `{ value: Value }` does not:
// each file binds `Value` to its own alias, so the two are different props
// types and must NOT share a key, whatever their text says.
interface ReactElement {
  readonly $$typeof: symbol;
}
type Value = 'a';
declare const HeroA: (props: { title?: string; titleId?: string }) => ReactElement;
declare const BoundA: (props: { value: Value }) => ReactElement;
export { HeroA, BoundA };

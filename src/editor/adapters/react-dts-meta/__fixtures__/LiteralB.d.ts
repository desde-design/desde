// The other half of the pair; see LiteralA.d.ts.
interface ReactElement {
  readonly $$typeof: symbol;
}
type Value = 'b';
declare const HeroB: (props: { title?: string; titleId?: string }) => ReactElement;
declare const BoundB: (props: { value: Value }) => ReactElement;
export { HeroB, BoundB };

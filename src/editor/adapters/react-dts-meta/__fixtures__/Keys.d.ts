// Props-type KEYS, as `listReactComponents` reports them to the icon guard.
// Two components that take the same props must get the same key; two that
// take their own props must not; a props type that says nothing (`any`)
// must get no key at all.
interface ReactElement {
  readonly $$typeof: symbol;
}
type ComponentType<P> = { new (props: P): { props: P } } | ((props: P) => ReactElement);

// An icon set's shape: every export takes the ONE shared props interface,
// through React's union-typed `ComponentType<P>`.
interface IconProps {
  size?: number;
  color?: string;
}
declare const RiAlarmFill: ComponentType<IconProps>;
declare const RiAlarmLine: ComponentType<IconProps>;
declare const RiAlignLeft: ComponentType<IconProps>;

// The @heroicons/react shape: a type literal WRITTEN OUT at every declaration.
// Each `{ title?: string }` is its own anonymous type to the checker, but they
// print the same and mean the same.
declare const HeroOne: (props: { title?: string; titleId?: string }) => ReactElement;
declare const HeroTwo: (props: { title?: string; titleId?: string }) => ReactElement;

// A design system's shape: each component takes its own props.
interface ButtonProps {
  tone?: 'primary' | 'danger';
}
interface CardProps {
  title?: string;
}
declare const Button: (props: ButtonProps) => ReactElement;
declare const Card: (props: CardProps) => ReactElement;

// Loose declarations that say nothing about sharing. `any` and `{}` are the
// shapes under test here (`@telekom/scale-components-react` types every
// wrapper `any`), so the lint rules against them are switched off per line.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const LooseOne: (props: any) => ReactElement;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const LooseTwo: (props: any) => ReactElement;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
declare const EmptyOne: (props: {}) => ReactElement;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
declare const EmptyTwo: (props: {}) => ReactElement;

// Literals that differ only in a modifier or a signature are still different
// props, and must not share a key.
declare const ReadonlyOne: (props: { readonly value: string }) => ReactElement;
declare const MutableOne: (props: { value: string }) => ReactElement;
declare const CallOne: (props: { (): string }) => ReactElement;
declare const CallTwo: (props: { (): number }) => ReactElement;

export {
  RiAlarmFill,
  RiAlarmLine,
  RiAlignLeft,
  HeroOne,
  HeroTwo,
  Button,
  Card,
  LooseOne,
  LooseTwo,
  EmptyOne,
  EmptyTwo,
  ReadonlyOne,
  MutableOne,
  CallOne,
  CallTwo,
};

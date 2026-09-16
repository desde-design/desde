// Union-typed components. React's own canonical component type,
// `ComponentType<P>`, is `ComponentClass<P> | FunctionComponent<P>`: one
// half is constructable and the other callable, so the union carries
// neither signature itself. Every export declared that way has to be
// recovered by looking INSIDE the union (`@remixicon/react` declares all
// 3,228 of its exports like this and used to count as zero components).
interface ChipProps {
  /** @default 'filled' */
  variant?: 'filled' | 'outlined';
  label?: string;
}

interface ReactElement {
  readonly $$typeof: symbol;
}

interface ChipClass {
  new (props: ChipProps): { props: ChipProps; render(): ReactElement };
}
type ChipFunction = (props: ChipProps) => ReactElement;
type ComponentType<P> = { new (props: P): { props: P } } | ((props: P) => ReactElement);

// The `ComponentType<P>` shape exactly: class half first, function half second.
declare const Chip: ChipClass | ChipFunction;

// The same thing through a generic alias, and with the callable half FIRST:
// the order of the constituents must not matter.
declare const Tag: ComponentType<{ text?: string }>;

// A union with no component half at all stays rejected: a primitive-arg
// callable is not a component, and neither is a string.
declare const Formatter: ((value: number) => ReactElement) | string;

// A union of a component and `undefined` (an optional export) is a component.
declare const Badge: ChipFunction | undefined;

export { Chip, Tag, Formatter, Badge };

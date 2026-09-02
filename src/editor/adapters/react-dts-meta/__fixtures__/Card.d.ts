// Class-component shape: a construct signature whose instance carries
// `props`. Exercises the extractor's second props-recovery path.
interface CardProps {
  /** @default 'outlined' */
  variant?: 'outlined' | 'elevated';
  title?: string;
}

interface ReactElement {
  readonly $$typeof: symbol;
}

declare const Card: {
  new (props: CardProps): { props: CardProps; render(): ReactElement };
};
export { Card };

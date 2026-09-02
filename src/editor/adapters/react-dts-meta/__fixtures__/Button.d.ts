// Hermetic React-ish fixture: a function component whose call signature
// returns a (locally-declared) ReactElement, so the extractor recognizes
// it as a component without needing @types/react installed. Props mix a
// cross-file enum, scalars, a library callback (kept), and framework
// props (key/ref, filtered by name).
import type { Tone } from './shared';

interface ButtonProps {
  /** @default 'primary' */
  tone?: Tone;
  /** Visible label. */
  label?: string;
  /** @default false */
  disabled?: boolean;
  /** Click count budget. */
  count?: number;
  /** Library callback — React keeps these as props (unlike Vue emits). */
  onPress?: () => void;
  // Framework props the extractor must drop (by name).
  key?: string | number;
  ref?: unknown;
}

interface ReactElement {
  readonly $$typeof: symbol;
}

declare const Button: (props: ButtonProps) => ReactElement;

// A PascalCase component typed to return `null` (valid React) — must be
// ACCEPTED despite the non-React-ish return type.
declare const Spacer: (props: { size?: number }) => null;

// A PascalCase callable that is NOT a component: its first arg is a
// primitive, not a props object — must be REJECTED (no bogus `value` prop).
declare const RenderValue: (value: number) => ReactElement;

// A camelCase hook: callable, but not a component name — must be REJECTED.
declare const useToggle: (initial: boolean) => boolean;

// A plain value and a type-only export: both must be skipped.
declare const BUTTON_VERSION: string;
export type { Tone };
export { Button, Spacer, RenderValue, useToggle, BUTTON_VERSION };

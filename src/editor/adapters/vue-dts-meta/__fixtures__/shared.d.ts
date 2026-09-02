// Sibling type file: variant aliases imported by the component's props.
// Mirrors how design systems declare shared variant unions in a separate
// file (e.g. the design system's ButtonAppearance / HeaderTag). The nested
// alias (WidgetMethod) exercises recursive cross-file resolution.
export type WidgetMethod = 'get' | 'post';
export type WidgetAppearance = 'info' | 'success' | WidgetMethod;
export type WidgetSize = 'small' | 'large';

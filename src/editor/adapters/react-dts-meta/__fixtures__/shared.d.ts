// Variant aliases imported cross-file by a component's props — only the
// real checker resolves the nested alias. Mirrors how design systems
// declare shared unions (e.g. a `tone`/`variant` union in its own file).
export type ButtonKind = 'solid' | 'ghost';
export type Tone = 'primary' | 'danger' | ButtonKind;

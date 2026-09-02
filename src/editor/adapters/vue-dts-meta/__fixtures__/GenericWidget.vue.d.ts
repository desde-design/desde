// Synthetic component declaration mirroring the GENERIC VLS function
// shape vue-tsc emits for components with generic type params — e.g.
// the design system's `UiTableView`/`UiTableData` (`<Header, Data>(__VLS_props:
// …) => VNode`). Unlike the `DefineComponent` shape (see `Widget.vue.d.ts`),
// the default export is a generic call signature whose RETURN type is a
// bare node with NO `$props`; the resolved public props are the type of
// the first parameter (`__VLS_props`). The extractor must fall back to
// that parameter, otherwise the whole component is dropped from the
// manifest. Kept vue-free so the test stays hermetic.
import type { WidgetAppearance } from './shared';

declare const __VLS_export: <Row extends Record<string, unknown> = Record<string, unknown>>(
  __VLS_props: {
    /**
     * Visual style of the widget.
     * @default 'info'
     */
    appearance?: WidgetAppearance;
    /** Rows to render — generic over the row shape. */
    rows?: readonly Row[];
    /**
     * Whether the widget is loading.
     * @default false
     */
    loading?: boolean;
    /** Visible label text. */
    label?: string;
    // Vue-injected members the extractor must filter: an emit handler
    // (`on[A-Z]`) and a VNode prop (`key`).
    onSort?: (payload: Row) => void;
    key?: string | number;
  },
  __VLS_ctx?: unknown,
) => { __isVNode: true };
declare const _default: typeof __VLS_export;
export default _default;

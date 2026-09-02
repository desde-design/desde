// Synthetic component declaration mirroring a shipped `.vue.d.ts`: a
// default export whose construct signature yields an instance carrying
// `$props`. Variant props are typed via imported aliases (cross-file),
// which only the real checker resolves. Kept vue-free so the test is
// hermetic — the construct-signature → instance → `$props` shape is all
// the extractor needs.
import type { WidgetAppearance, WidgetSize } from './shared';

interface WidgetProps {
    /**
     * Visual style of the widget.
     * @default 'info'
     */
    appearance?: WidgetAppearance;
    /**
     * Size variant.
     * @default 'small'
     */
    size?: WidgetSize;
    /** Visible label text. */
    label?: string;
    /**
     * Whether the widget is disabled.
     * @default false
     */
    disabled?: boolean;
    /** Free-form width. */
    width?: number | string;
}

// `$props` also carries Vue-injected members the extractor must filter:
// an emit handler (`on[A-Z]`) and a VNode prop (`key`).
declare const _default: new () => {
    $props: WidgetProps & { onClick?: () => void; key?: string | number };
};
export default _default;

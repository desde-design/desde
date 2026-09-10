# Tailwind reference tables

`tailwind-classes.ts`, `tailwind-colors.ts` and `tailwind-declarations.ts` hold
Tailwind's own stock class ramps and color palette, plus the resolver that
turns a Tailwind class into raw CSS declarations. They read the CUSTOMER's
prototype, not Desde's own UI.

They are pure data and functions. They import nothing outside their own
directory, so any layer could import them. The bridge does not import them
today: `src/bridge/resize-quantize.ts` keeps its own hand-mirrored copy of
`SPACING_SCALE`, updated by hand whenever this file's table changes. Having
the bridge import this directory instead is a separate bridge change, not
done here.

Per CLAUDE.md, `FONT_SIZE_VALUES` here is Tailwind's stock ramp. It must never
be aligned to Desde's own named type scale (`text-base` at 13px and so on).

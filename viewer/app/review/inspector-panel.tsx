"use client"

import { useMemo, useState, type ReactElement } from "react"
import { Search, ChevronRight, MousePointerClick } from "lucide-react"
import { Input } from "@/components/ui/input"
import { EmptyState } from "@/components/blocks"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { summarizeStyleProperties, type SummarizedStyleProperty } from "./summarize-style-properties"
import type {
  InspectionData,
  BoxModelData,
  ComponentTreeNode,
  StyleCategory,
  DesignToken,
} from "@/types/bridge"

/**
 * Read-only element inspector for the Viewer's review screen (the "Dev" tab
 * of the right rail). Renders exactly what the bridge reports on
 * `InspectionData` — no edit affordances, no writes to prototype source.
 * The Editor's `src/components/editor/inspector-panel.tsx` is the editing
 * version of this idea; this component shares none of its code or state.
 */
export interface ViewerInspectorPanelProps {
  /** Null until the reviewer clicks an element with the inspector active. */
  inspection: InspectionData | null
  /** True while the bridge's inspector overlay is armed. */
  active: boolean
  /**
   * Repo web URL (e.g. "https://github.com/acme/proto") plus the git ref to
   * link source files against. Null when the caller was not shown a repo
   * config — which for a non-owner is the normal case, not an error.
   */
  repo: RepoRef | null
  className?: string
}

interface RepoRef {
  htmlUrl: string
  /**
   * The git ref source links resolve against — today the built BRANCH, not
   * the built commit.
   *
   * Named `ref` rather than `commitSha` because it is one. The commit would
   * be more precise, since it is literally what the reviewer is looking at,
   * but the deployment's `commitSha` is deliberately kept off the wire (see
   * `ProjectView.activeDeployment` in `server/api/projects-routes.ts`) and
   * widening the public projection just to build a link is the wrong trade.
   * A branch link always resolves. If a commit ever does reach the client,
   * pass it here and nothing in this file changes.
   */
  ref: string
}

/**
 * Shared section rhythm. Padding only, no rule between blocks.
 *
 * It carried `border-t border-border` until 2026-08-28 (Mo: "let's try
 * removing the dividers between sections"). Every section is already titled
 * and most are collapsible, so the headings were doing the separating on
 * their own and the rules added a second, weaker answer to the same question
 * — eleven of them stacked down a 320px rail, which read as a table of
 * hairlines rather than a set of blocks.
 */
const SECTION = "px-3 py-2"

function isColorValue(value: string): boolean {
  const v = value.trim().toLowerCase()
  return v.startsWith("#") || v.startsWith("rgb") || v.startsWith("hsl") || v.startsWith("oklch")
}

function ColorSwatch({ value }: { value: string }) {
  if (!isColorValue(value)) return null
  // The one place an inline style is correct: the swatch color is data
  // read off the prototype, not a static design choice.
  return (
    <span
      aria-hidden
      className="inline-block size-3 shrink-0 rounded-sm border border-border"
      style={{ background: value }}
    />
  )
}

function SourceLink({ repo, file, line }: { repo: RepoRef | null; file: string; line?: number }) {
  const suffix = line ? `:${line}` : ""
  if (repo) {
    const href = `${repo.htmlUrl}/blob/${repo.ref}/${file}${line ? `#L${line}` : ""}`
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-xs text-primary hover:underline"
      >
        {file}
        {suffix}
      </a>
    )
  }
  // No repo shown to this caller — a dead link is worse than plain text.
  return (
    <span className="break-all text-xs text-muted-foreground">
      {file}
      {suffix}
    </span>
  )
}

/**
 * Who this element is, and where it came from — and nothing else (Mo,
 * 2026-08-20).
 *
 * It used to also carry every class as a chip and the element's pixel size.
 * That made the first thing a reader sees the busiest block on the panel,
 * and both of those had better homes: the classes belong with the selector,
 * since they ARE how the element is addressed, and the dimensions were
 * already stated by the box model a few rows down.
 */
function ElementHeader({
  data,
  repo,
}: {
  data: InspectionData
  repo: RepoRef | null
}) {
  const componentName = data.component?.name
  const displayName = componentName ?? data.tagName
  const source = data.pageSourceFile ?? data.authoredAt?.file

  // No `#id` here. It reads as a selector, and the Selector section says the
  // same thing a few rows down — where it sits next to the classes it belongs
  // with, instead of competing with the component's name for the first line.

  return (
    /*
      No `space-y` between the name and its path (Mo, 2026-08-29: "tighten up
      the spacing between the component name and the path below, make it match
      how the elements in structure do it").

      MEASURED: `space-y-1` put 5.5px here against the Structure rows' 2.3px,
      which is what made the same name/path pair read as two facts up here and
      one two-line label down there. Structure gets its 2.3px from leading
      alone, with no margin at all, so matching it means removing the rule
      rather than tuning it down a step.
    */
    <div className="px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className="text-base font-semibold text-foreground">{displayName}</span>
        {componentName && (
          <span className="text-xs text-muted-foreground">&lt;{data.tagName}&gt;</span>
        )}
      </div>
      {source ? (
        <SourceLink
          repo={repo}
          file={source}
          line={data.pageSourceFile ? undefined : data.authoredAt?.line}
        />
      ) : null}
    </div>
  )
}

// Fixed lookup rather than an arbitrary computed pixel value — indentation
// stays on the spacing scale (pl-3 .. pl-24), capped so a deep chain doesn't
// run the tree off the rail.
const INDENT_CLASSES = ["pl-3", "pl-6", "pl-9", "pl-12", "pl-16", "pl-20", "pl-24"]

function indentClass(depth: number): string {
  return INDENT_CLASSES[Math.min(depth, INDENT_CLASSES.length - 1)]
}

function ComponentTreeSection({
  tree,
  repo,
  defaultOpen,
}: {
  tree: ComponentTreeNode[]
  repo: RepoRef | null
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(SECTION, "flex w-full items-center gap-1.5 text-left text-xs font-medium hover:bg-muted/50")}
      >
        {/* "Structure", matching the Editor's own panel title
            (`editor/layers-panel.tsx`) — the same thing seen from the other
            surface should not have two names. No icon: it is the only
            section here that had one, and a glyph that appears once is
            decoration rather than a system. */}
        Structure
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pb-2 pt-1">
          {tree.map((node, i) => (
            <div key={`${node.name}-${i}`} className={cn(indentClass(i), "py-0.5 pr-3")}>
              <span className="text-xs font-medium text-foreground">{node.name}</span>
              {node.file && (
                <div>
                  <SourceLink repo={repo} file={node.file} line={node.line} />
                </div>
              )}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function formatSide(v: number): string {
  return v === 0 ? "0" : `${Math.round(v)}`
}

/**
 * A ring's name and its top value. Both spans are `text-2xs`, which is what
 * makes the row 13px instead of 15.4px: a flex row is as tall as its tallest
 * child, so a number one step above the label was setting the height of all
 * three headers.
 */
function RingHeader({ label, value }: { label: string; value: number }) {
  return (
    // The value is centred on the RING, not on what is left over after the
    // label. It used to be `flex` with a `flex-1 text-center` value, which
    // centres it inside the remaining space — so every top number sat visibly
    // right of the box it measures, by half the label's width. The label is
    // taken out of flow instead, which is the only way the two can share a
    // row without one displacing the other.
    <div className="relative mb-0.5 flex items-center justify-center">
      <span className="pointer-events-none absolute left-1 text-2xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-2xs text-muted-foreground">{formatSide(value)}</span>
    </div>
  )
}

/**
 * One edge measurement.
 *
 * `text-2xs`, not `text-code`. These were on the MONO ramp while rendering in
 * DM Sans — 11px of sans text sized off the scale for code. The two ramps are
 * separate because they have different floors: 11px is as small as mono may
 * go, and 10px sans still reads where 10px mono does not. Sans belongs on the
 * sans ramp, and moving it there is also what buys back most of the height.
 *
 * The content box keeps `text-code`, because that one IS mono and is already
 * sitting on its floor.
 */
function SideValue({ value, block }: { value: number; block?: boolean }) {
  return (
    <span className={cn("text-2xs text-muted-foreground", !block && "w-4 shrink-0 text-center")}>
      {formatSide(value)}
    </span>
  )
}

function BoxModelDiagram({ data }: { data: BoxModelData }) {
  return (
    <div className="px-3 py-2">
      {/* All three rings carry the SAME `px-0.5 py-1`. The outer one used to
          be a step roomier, which read as stray padding rather than as
          hierarchy: a nested diagram already shows its levels through the
          nesting, so unequal padding just makes the outermost band look
          loose.

          2px, so each band gives its numbers 3px of air once its own 1px
          border is counted. That is the floor: below it the numbers touch
          the line that is supposed to contain them. */}
      <div className="rounded-md border border-dashed border-border bg-muted/20 px-0.5 py-0.5">
        <RingHeader label="margin" value={data.margin.top} />
        <div className="flex items-center gap-0.5">
          <SideValue value={data.margin.left} />
          <div className="flex-1 rounded border border-border bg-muted/30 px-0.5 py-0.5">
            <RingHeader label="border" value={data.border.top} />
            <div className="flex items-center gap-0.5">
              <SideValue value={data.border.left} />
              <div className="flex-1 rounded border border-dashed border-border bg-muted/40 px-0.5 py-0.5">
                <RingHeader label="padding" value={data.padding.top} />
                {/* `gap-1` here, `gap-0.5` on the outer rows. Measured, the
                    outer numbers sit 5px apart because each ring contributes
                    its own padding and border on top of the gap; the innermost
                    row has no ring between it and the content box, so the same
                    gap value would leave the padding numbers 2px off it and
                    reading as glued on. */}
                <div className="flex items-center gap-1">
                  <SideValue value={data.padding.left} />
                  <div className="flex-1 rounded border border-border bg-muted py-0.5 text-center">
                    <span className="text-2xs text-foreground">
                      {Math.round(data.content.width)} &times; {Math.round(data.content.height)}
                    </span>
                  </div>
                  <SideValue value={data.padding.right} />
                </div>
                <div className="mt-0.5 text-center">
                  <SideValue value={data.padding.bottom} block />
                </div>
              </div>
              <SideValue value={data.border.right} />
            </div>
            <div className="mt-0.5 text-center">
              <SideValue value={data.border.bottom} block />
            </div>
          </div>
          <SideValue value={data.margin.right} />
        </div>
        <div className="mt-0.5 text-center">
          <SideValue value={data.margin.bottom} block />
        </div>
      </div>
    </div>
  )
}

function StylesSection({
  category,
  query,
  defaultOpen,
}: {
  category: StyleCategory
  query: string
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  // Four identical `border-*-width` rows say one thing four times. See
  // `summarize-style-properties.ts` for the rule and what it deliberately
  // does NOT collapse.
  const summarized = useMemo(
    () => summarizeStyleProperties(category.properties),
    [category.properties],
  )
  // A collapsed row must still answer to the longhand names it replaced, or
  // typing "border-top" finds nothing in a panel that used to find it.
  const filtered = summarized.filter(
    (p) =>
      !query ||
      p.name.toLowerCase().includes(query) ||
      p.members?.some((m) => m.toLowerCase().includes(query)),
  )
  if (filtered.length === 0) return null

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(SECTION, "flex w-full items-center gap-1.5 text-left text-xs font-medium hover:bg-muted/50")}
      >
        {category.name}
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pb-2 pt-1">
          {filtered.map((prop) => (
            /* A fixed label column and a LEFT-aligned value, not a
               right-aligned one. Right alignment in a list or a table is for
               numbers, where it lines the digits up by place value; on
               strings it just makes every row start somewhere different and
               the eye has to find the beginning each time. See
               docs/design.md.

               Both columns are sans (Mo, 2026-08-21). The label/value split
               is carried by colour alone — muted name, full-ink value. Mono
               was doing very little work here: a computed style is a short
               keyword or a number, not a span anyone reads character by
               character, and thirty-odd rows of it made the panel look like
               a file rather than a list of facts. Where mono still earns its
               place in this panel, it is because the thing is meant to be
               copied verbatim: the selector, and source paths. */
            <div
              key={prop.name}
              className="grid grid-cols-[7.5rem_1fr] items-baseline gap-2 px-3 py-0.5 hover:bg-muted/30"
            >
              <span className="truncate text-xs text-muted-foreground" title={prop.name}>
                {prop.name}
              </span>
              <span
                className="flex min-w-0 items-center gap-1.5 text-xs text-foreground"
                title={rowTitle(prop)}
              >
                <ColorSwatch value={prop.value} />
                <span className="truncate">{prop.rawValue ?? prop.value}</span>
              </span>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * The hover title for one style row.
 *
 * Two facts can each be worth saying, and a collapsed row can carry both: the
 * computed value behind an authored one, and the longhands this row stands
 * for. Naming the members matters more than it looks — it is the only place
 * the panel still admits that `border-width` is four properties, which is
 * what someone reading a box model needs to know before they trust it.
 */
function rowTitle(prop: SummarizedStyleProperty): string | undefined {
  const parts: string[] = []
  if (prop.rawValue) parts.push(`Computed: ${prop.value}`)
  if (prop.members) parts.push(`All four sides: ${prop.members.join(", ")}`)
  return parts.length ? parts.join("\n") : undefined
}

function TokensSection({ tokens, defaultOpen }: { tokens: DesignToken[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(SECTION, "flex w-full items-center gap-1.5 text-left text-xs font-medium hover:bg-muted/50")}
      >
        Design tokens
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pb-2 pt-1">
          {tokens.map((token) => (
            /* Same two-column shape as the style rows above, so the two
               lists read as one panel.

               The `--` prefix is stripped: every token in this list has it,
               so it is 2 characters of noise per row that distinguish
               nothing. The full name is on the `title` for anyone who needs
               to copy it.

               The `element` / `inherited` badge is gone (Mo, 2026-08-20). It
               was the loudest thing on the row and answered a question only
               someone debugging the cascade asks. */
            <div
              key={token.name}
              className="grid grid-cols-[7.5rem_1fr] items-baseline gap-2 px-3 py-0.5 hover:bg-muted/30"
            >
              <span className="truncate text-xs text-muted-foreground" title={token.name}>
                {token.name.replace(/^--/, "")}
              </span>
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground">
                <ColorSwatch value={token.value} />
                <span className="truncate">{token.value}</span>
              </span>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * How this element is addressed: its selector and its classes, written as one
 * line the way a selector is written down anyway.
 *
 * It was a filled code block with the classes beneath it as outline chips —
 * three different treatments for what is one list of names for one element.
 * Mo's read: "everything is formatted so oddly". Now it is a single run of
 * mono text, space separated, all one ink. No middot between the parts and no
 * copy button: a selector separated by spaces is already the thing you would
 * paste, and the button was chrome on a single line of text.
 *
 * It sits BELOW the property filter with a collapsible title, alongside Layout
 * and the other categories, so every titled section in the lower half of the
 * panel behaves the same way.
 */
function SelectorSection({ selector, classes }: { selector: string; classes: readonly string[] }) {
  const [open, setOpen] = useState(true)
  const line = [selector, ...classes.map((cls) => `.${cls}`)].join(" ")

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(SECTION, "flex w-full items-center gap-1.5 text-left text-xs font-medium hover:bg-muted/50")}
      >
        Selector
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {/* `break-words`, not `break-all`: the spaces are real wrap
            opportunities, so a long list breaks between class names rather
            than through one. */}
        <p className="break-words px-3 pb-2 pt-1 text-xs leading-relaxed text-foreground">{line}</p>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function ViewerInspectorPanel({
  inspection,
  active,
  repo,
  className,
}: ViewerInspectorPanelProps): ReactElement {
  const [query, setQuery] = useState("")

  if (!inspection) {
    return (
      /* The panel empty state — see `EmptyState`'s own docs for the rule.
         One sentence, no box, centred in the panel's height, carried as the
         `title` so it reads at title weight rather than as a caption for a
         heading that is not there. "Nothing selected" used to sit above this
         line and said the same thing twice. */
      <EmptyState
        frame="panel"
        icon={<MousePointerClick />}
        title={
          active
            ? "Click any element in the prototype to inspect it."
            : "The inspector is off. Turn it on to click an element in the prototype."
        }
        className={className}
      />
    )
  }

  const normalizedQuery = query.trim().toLowerCase()
  const hasStyles = inspection.styles.length > 0

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <ScrollArea className="flex-1">
        <ElementHeader data={inspection} repo={repo} />
        {inspection.componentTree && inspection.componentTree.length > 0 && (
          <ComponentTreeSection
            tree={inspection.componentTree}
            repo={repo}
            defaultOpen={inspection.componentTree.length <= 6}
          />
        )}
        <BoxModelDiagram data={inspection.boxModel} />
        {hasStyles && (
          <div className={SECTION}>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                size="sm"
                placeholder="Filter properties"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-7"
              />
            </div>
          </div>
        )}
        <SelectorSection selector={inspection.selector} classes={inspection.classes} />
        {inspection.styles.map((category) => (
          <StylesSection key={category.name} category={category} query={normalizedQuery} defaultOpen />
        ))}
        {inspection.tokens.length > 0 && <TokensSection tokens={inspection.tokens} defaultOpen />}
      </ScrollArea>
    </div>
  )
}

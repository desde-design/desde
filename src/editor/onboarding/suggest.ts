/**
 * "Use what my prototype already imports" (spec §8) — scan the prototype's
 * installed design-system libraries and rank them by how often the
 * prototype's own source imports them, so the onboarding UI can seed or
 * offer one-click adds without the user naming anything.
 *
 * Two arms, one ranking:
 *
 *  - **Vue** — `scanInstalledVueLibraries` walks `node_modules` for packages
 *    shipping `*.vue.d.ts`. That marker is precise (only a Vue component
 *    library has one), so a declared dependency that carries it is a
 *    suggestion even if nothing imports it yet.
 *  - **React** (added 2026-09-08; it was a "follow-up" in this header from
 *    6.3 to then) — `scanInstalledReactLibraries` is bounded to the
 *    prototype's declared dependencies that list `react` as a dependency or
 *    peer AND resolve a `.d.ts` entry. That is a weaker signal than
 *    `*.vue.d.ts`: a hooks library, a router and a data-fetching client all
 *    pass it. So the React arm asks two more questions the Vue arm can skip:
 *      1. does the prototype's own source import it at all
 *         (`importFrequency >= 1`), and
 *      2. does its entry export at least one thing that types as a React
 *         component (`listReactComponents`, the extractor's own predicate
 *         over ONE shared TS program), and
 *      3. is it not an icon set: an export list that is mostly `*Icon` /
 *         `Icon*`, one spread over too many distinct component FAMILIES, or
 *         a brand-prefixed one whose names all take the SAME props, is
 *         icons. MEASURED on a shadcn dashboard: the icon package was the
 *         top suggestion by import count (140 files) and would have arrived
 *         with 6,211 "components". This test used to be "the list is in the
 *         hundreds" instead; see {@link looksLikeIconSet} for why a raw
 *         count was the wrong question and what replaced it.
 *
 *         Failing this question does NOT hand the package to the icon
 *         picker. That surface has its own detection pass, at CLI boot,
 *         over dependencies whose NAME contains "icon"
 *         (`icon-sets/auto-detect.ts`) — `lucide-react` and `react-feather`
 *         are not candidates there either. Excluded here means offered
 *         nowhere, which is why the rule leans toward keeping.
 *    A package failing any of the three is not offered. The count is real,
 *    not approximate: it is what onboarding the package would extract.
 *
 * The two arms differ in how sure they are, and the result says so
 * (`confidence`). `*.vue.d.ts` is `certain`: only a component library ships
 * it. The React marker is `likely`: MEASURED on the same shadcn dashboard the
 * arm returns 13 packages the prototype genuinely renders from (charts, a
 * date picker, a toaster, a drawer, an OTP input, the primitives under its
 * own wrappers), and no heuristic can say which of those the user calls a
 * design system.
 *
 * **Nothing downstream acts on that difference today.** This header used to
 * say `likely` rows were "OFFERED, one click each, not seeded". That stopped
 * being true on 2026-09-08: the New Project step seeds EVERY detection into
 * the list and ignores `confidence` outright (`new-project-page.tsx` — Mo:
 * "found means added; remove what is not a design system"). So a `likely`
 * row is opt-OUT, and the field is carried for a consumer that does not exist
 * yet. That is what makes a wrong verdict in {@link looksLikeIconSet} cost
 * more than a row the user can ignore; see its doc comment.
 *
 * Neither arm sees a component library that is NOT a package — a design
 * system copied into the repo as source (the shadcn/ui distribution model)
 * is first-party code, and first-party components are catalogued by
 * `local-react` / `local-vue` on every boot with nothing to register. The
 * onboarding UI's copy says so, because an empty list here used to read as
 * "nothing was found" when the truth was "nothing here is a package".
 *
 * Pure read-only over the filesystem; no network. The React arm builds a TS
 * program (in memory) and nothing else.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ListedReactComponent } from '@/editor/adapters/react-dts-meta/count-components'
import type { FrameworkId } from '@/editor/core/manifest'

export interface DesignSystemSuggestion {
  package: string
  version: string
  framework: FrameworkId
  /**
   * Components the package exports: discovered `*.vue.d.ts` files (Vue), or
   * exported symbols that type as a React component (React).
   */
  componentCount: number
  /** Times the prototype's own source imports this package. */
  importFrequency: number
  /**
   * How sure the marker is that this is a design system. `certain` is Vue's
   * `*.vue.d.ts`; `likely` is the React arm's weaker one. See the header for
   * why they differ, and for the fact that no consumer reads this yet: the
   * New Project step seeds both kinds alike.
   */
  confidence: 'certain' | 'likely'
}

/** `XIcon` and `IconX`: the two naming conventions React icon sets use. */
const ICON_NAME_RE = /(^Icon[A-Z]|Icon$)/

/**
 * A component name's FAMILY: its first CamelCase word. `DialogRoot`,
 * `DialogTrigger` and `DialogBackdrop` are all one family, `Dialog`.
 * Leading acronyms stop at the next capitalized word, so `HStack` is `H`.
 */
const FAMILY_RE = /^[A-Z]+(?![a-z])|^[A-Z][a-z0-9]*/

/**
 * A list spread over this many families is icons whatever its shape. No
 * design system measured comes close — the largest is 127.
 */
const ICON_SET_MIN_FAMILIES = 250

/**
 * The flat-catalog pair, applied together: this many families AND fewer than
 * this many names in each. Catches an icon set too small for
 * {@link ICON_SET_MIN_FAMILIES}, without catching a large compound design
 * system, which is dense by construction. See signal 3 below.
 */
const FLAT_MIN_FAMILIES = 150
const FLAT_MAX_PARTS_PER_FAMILY = 2

/**
 * The brand-prefixed pair, applied together: this many names per family or
 * more (every name starts with the same word, so the list collapses to a
 * handful of families) AND this many names per distinct props type or more
 * (the names all take the same props). Catches an icon set the family
 * signals cannot see, without catching a brand-prefixed design system, whose
 * components each take their own props. See signal 4 below.
 */
const BRAND_PREFIX_MIN_PARTS_PER_FAMILY = 10
const SHARED_PROPS_MIN_NAMES_PER_TYPE = 20

/**
 * Is this export list an icon set rather than a design system?
 *
 * Four signals. Any one of them on its own is enough:
 *
 *  1. **Most of the names are icon-named** — half or more match `XIcon` or
 *     `IconX`.
 *  2. **The names are spread over 250 or more families.** A family is a
 *     name's first CamelCase word, so `DialogRoot`, `DialogTrigger` and
 *     `DialogBackdrop` are one family, `Dialog`.
 *  3. **The names are spread over 150 or more families AND average fewer
 *     than 2 per family.** A flat catalog of mostly one-off names.
 *  4. **The names are brand-prefixed AND share their props.** Ten or more
 *     names per family (every name starts with the same word, `Ri…`,
 *     `Fa…`, `Icon…`), AND twenty or more names per distinct props type
 *     (the whole list takes `RemixiconProps`). A props type that says
 *     nothing (`any`, `unknown`, `{}`) counts as unique to its component.
 *
 * A list under 20 names is never judged. A design system may ship a few icons
 * of its own, and a ratio over a handful of names means nothing.
 *
 * ## Why families and not a count of exports
 *
 * Until 2026-09-15 the rule was "400 or more exports is an icon set". It
 * assumed the largest React design systems export a few hundred components.
 * Chakra v3 exports 775, because its compound API (`Dialog.Root`,
 * `Dialog.Trigger`, `Menu.Item`) genuinely ships hundreds of parts. So a
 * top-five library was classified as icons and silently dropped.
 *
 * Moving the number would not have fixed it. The two groups OVERLAP on raw
 * count: `@ant-design/icons` exports 832 and Chakra exports 775, so no cutoff
 * separates them. They do not overlap on families: 319 against 114. A
 * compound API multiplies the parts per family, never the family count, which
 * is exactly why counting parts broke and counting families does not.
 *
 * ## Why signal 3 exists as a PAIR
 *
 * Signal 2 alone left `react-feather` (286 names, no name containing `Icon`,
 * 195 families) judged a design system. That is not free. A wrongly-onboarded
 * icon set lands in the agent's grounding digest, which is sorted by name and
 * capped at 250 (`DIGEST_COMPONENT_CAP`, `agent-chat/grounding-tools.ts`).
 * `react-feather`'s names are front-loaded alphabetically (`Activity`,
 * `Airplay`, `AlertCircle`…), so it fills that cap on its own and pushes the
 * real design system's components into the "+N more" overflow.
 *
 * Dropping signal 2's threshold to 150 would have caught it, and would have
 * left Chakra only 1.2x of room below the line. That is how the ORIGINAL bug
 * happened: a threshold tuned just above the biggest thing anyone had looked
 * at. So the low threshold is paired with a density test instead.
 *
 * The pair is what makes it safe. To be caught wrongly, a design system has
 * to be flat AND have more families than any measured today. Those two pull
 * against each other. A design system grows families by adding components,
 * and a large one adds PARTS as it grows (`Root`, `Trigger`, `Item`), which
 * is exactly what raises parts-per-family above 2. The flat ones stay small:
 * the flattest measured, `antd` and `@arco-design/web-react`, sit at 66 and
 * 68 families, and the largest flat one, `@shopify/polaris`, at 89.
 *
 * ## Why signal 4 exists, and why it is a PAIR too
 *
 * Signals 2 and 3 count families, so they are blind to a list that has
 * almost none. `@remixicon/react` is 3,227 names that ALL start `Ri`: three
 * families at 1,076 names each. `react-icons/fa` is 1,611 names in two
 * families. Neither contains the word `Icon`. The three signals above see a
 * small, dense list, which is what a design system looks like, and remixicon
 * would be seeded into the New Project list with 3,227 components, eleven
 * times the `react-feather` case above. (It was not, only because the
 * extractor could not see union-typed exports at all; that gap closed on
 * 2026-09-15, in the same change as this signal. See `getReactPropsType`.)
 *
 * The obvious rule, "enormous names-per-family means icons", is WRONG. No
 * ordinary design system exceeds 6.8 names per family (Chakra), against 103
 * to 1,076 for the brand-prefixed icon sets, so it looks like a 15x margin.
 * But that number means "brand-prefixed", not "icons", and design systems
 * are brand-prefixed too: `@elastic/eui` names everything `Eui*` (262 names,
 * 7 families, 37 per family), `@coreui/react` everything `C*` (137 names,
 * ONE family), `@ionic/react` everything `Ion*`, and Stencil- and Lit-built
 * design systems do it by construction (`@siemens/ix-react`,
 * `@porsche-design-system/components-react`, `@shoelace-style/shoelace`,
 * `@baloise/…`, `@swisspost/…`, `igniteui-react`, `@telekom/scale-…`). On
 * names per family the two groups overlap completely: brand-prefixed design
 * systems run 19.6 to 221, brand-prefixed icon sets 103 to 1,076.
 *
 * What separates them is the PROPS. An icon set declares every export over
 * one props type: every remixicon export is `ComponentType<RemixiconProps>`,
 * every tabler export takes `IconProps`, every lucide export `LucideProps`.
 * A design system declares one props type per component, because a Button
 * and a Modal do not take the same props. MEASURED (table below): every icon
 * set has 286 or more names per distinct props type, and every design system
 * 1.29 or fewer. The brand-prefixed ones on each side: 1,611 and up against
 * 1.06 and under. That is a 1,000x separation, and the props type is already
 * in hand: `listReactComponents` reports it as an opaque key next to each
 * name (`ListedReactComponent.propsType`), at no extra cost, keyed by the
 * checker's own object identity (see `propsTypeKey` in `count-components.ts`
 * for the one shape identity misses and how it is covered).
 *
 * Both halves are needed. The family half keeps the props half away from
 * lists that are NOT brand-prefixed, which is every ordinary design system,
 * so a hypothetical design system whose components share a props type is
 * still only at risk if it is ALSO brand-prefixed. The props half is what
 * keeps the brand-prefixed design systems. And a props type of `any` is not
 * a shared props type: `@telekom/scale-components-react` types all 442 of its
 * `Scale*` wrappers `any`, and that is 442 components saying nothing, not
 * 442 components sharing props. So `null` keys count as unique, and Scale
 * sits at 1.0 name per props type.
 *
 * The thresholds: 10 per family sits above Chakra's 6.8 and below Ionic's
 * 19.6, the lowest brand-prefixed design system. 20 per props type sits 15x
 * above the highest design system (`theme-ui`, 1.29) and 14x below the
 * lowest icon set (`react-feather`, 286); `evergreen-ui` at 7.69 is the
 * ships-both case below, and it is not brand-prefixed (1.65 per family) so
 * the family half keeps signal 4 out of it either way.
 *
 * `package.json` `keywords` was measured as a cheap secondary signal and is
 * NOT used. Over the icon sets below, a keyword containing "icon" is present
 * on 10 of the 16 root packages (absent on `@ant-design/icons`,
 * `@fluentui/react-icons`, `@heroicons/react`, `@radix-ui/react-icons`,
 * `@tabler/icons-react` and `react-icons`) and on no design system: precision
 * 100%, recall 62%. The package NAME containing "icon" does better (14 of
 * 16, missing only `lucide-react` and `react-feather`, no false positive)
 * and is already the icon picker's own detection rule
 * (`icon-sets/auto-detect.ts`). Neither is needed once the props type is in
 * hand, and a name rule here would make two surfaces disagree about the same
 * package for the wrong reason.
 *
 * ## MEASURED 2026-09-15
 *
 * 55 packages installed at the versions shown and run through the real
 * {@link listReactComponents} and this function. `n` is exported symbols that
 * type as a React component. `icon%` is the share matching `XIcon`/`IconX`.
 * `p/f` is names divided by families. `props` is distinct props types, with
 * `+k` for the components whose props type says nothing (`any`, `{}`), and
 * `n/props` counts those as unique. Every row is classified correctly by the
 * four signals except the ships-both case at the bottom.
 *
 * ```
 *   design systems                             n   icon%   families      p/f   props  n/props
 *     react-admin 5.15.3                     304    0.3%        127     2.39   287+4     1.04
 *     @chakra-ui/react 3.37.0                775    0.8%        114      6.8     755     1.03
 *     @mantine/core 7.17.8                   228    2.2%        106     2.15     227        1
 *     @patternfly/react-core 6.6.1           306    0.7%         89     3.44     303     1.01
 *     @carbon/react 1.116.0                  254    2.8%         89     2.85   243+2     1.04
 *     @shopify/polaris 13.9.5                110    0.9%         89     1.24   109+1        1
 *     @fluentui/react-components 9.74.7      256      0%         85     3.01   228+1     1.12
 *     @ui5/webcomponents-react 2.26.3        193      1%         82     2.35     193        1
 *     @cloudscape-design/components 3.0.1379  95    2.1%         81     1.17      95        1
 *     @mui/material 6.5.0                    148    4.1%         77     1.92   142+1     1.03
 *     rsuite 5.83.4                           99      1%         74     1.34      99        1
 *     @adobe/react-spectrum 3.47.5           100      1%         67     1.49     100        1
 *     antd 5.29.3                             68      0%         66     1.03      68        1
 *     grommet 2.57.0                         109      0%         65     1.68    98+5     1.06
 *     @nordhealth/react 4.12.41 (*)          136    0.7%         63     2.16     136        1
 *     @blueprintjs/core 5.19.1                95    1.1%         62     1.53    89+2     1.04
 *     flowbite-react 0.12.17                 125   16.8%         59     2.12     107     1.17
 *     @heroui/react 2.8.10                   117    0.9%         56     2.09     106      1.1
 *     @primer/react 37.31.0                   68    1.5%         54     1.26    63+4     1.01
 *     @vaadin/react-components 25.2.10        94    1.1%         52     1.81      94        1
 *     semantic-ui-react 2.1.5                163    2.5%         51      3.2     163        1
 *     react-bootstrap 2.10.10                110      0%         43     2.56     109     1.01
 *     @radix-ui/themes 3.3.0                  44   13.6%         40      1.1      41     1.07
 *     @ant-design/pro-components 2.8.10      114      0%         39     2.92   102+3     1.09
 *     theme-ui 0.17.4                         40      5%         37     1.08      31     1.29
 *     @headlessui/react 2.2.10                63      0%         24     2.63      61     1.03
 *
 *   brand-prefixed design systems              n   icon%   families      p/f   props  n/props
 *     @elastic/eui 122.0.0 (*)               262    1.1%          7    37.43   248+2     1.05
 *     @ionic/react 9.0.3                      98      1%          5     19.6    97+1        1
 *     @telekom/scale-components-react 3.0.0  442    0.5%          2      221   0+442        1
 *     @siemens/ix-react 5.2.1                114    0.9%          2       57     114        1
 *     @porsche-design-system/… 4.7.0          75    1.3%          2     37.5      71     1.06
 *     @coreui/react 5.13.0                   137      0%          1      137     137        1
 *     @baloise/design-system-… 15.2.4        128    1.6%          1      128     128        1
 *     igniteui-react 19.8.1 (*)               73    1.4%          1       73      73        1
 *     @shoelace-style/shoelace/dist/react (*) 58    1.7%          1       58      58        1
 *     @swisspost/design-system-… 10.5.0       44    2.3%          1       44      44        1
 *
 *   icon sets                                  n   icon%   families      p/f   props  n/props
 *     @fluentui/react-icons 2.0.341        26629      0%       2256     11.8       2  13314.5
 *     @mui/icons-material 6.5.0            10615      0%       1043    10.18       1    10615
 *     lucide-react 0.460.0                  5211   33.4%        730     7.14       2   2605.5
 *     @phosphor-icons/react 2.1.10          3042   50.3%        688     4.42       2     1521
 *     iconoir-react 7.12.1                  1671      0%        658     2.54       2    835.5
 *     react-bootstrap-icons 1.11.6          2077      0%        561      3.7       1     2077
 *     @blueprintjs/icons 6.13.0             1413     50%        422     3.35       2    706.5
 *     @ant-design/icons 5.6.1                832    0.1%        319     2.61       2      416
 *     @primer/octicons-react 19.35.0         388    100%        217     1.79       1      388
 *     @radix-ui/react-icons 1.3.2            318    100%        198     1.61       1      318
 *     react-feather 2.0.10                   286      0%        195     1.47       1      286
 *     @heroicons/react/24/outline 2.2.0 (*)  324    100%        152     2.13       1      324
 *
 *   brand-prefixed icon sets                   n   icon%   families      p/f   props  n/props
 *     react-icons/md 5.7.0 (*)              4341      0%         42   103.36       1     4341
 *     @icons-pack/react-simple-icons 13.15  3453      0%         18   191.83       1     3453
 *     react-icons/bs 5.7.0 (*)              2754      0%         12    229.5       1     2754
 *     @tabler/icons-react 3.46.0            6250   99.9%          7   892.86       1     6250
 *     react-icons/ri 5.7.0 (*)              3229      0%          3  1076.33       1     3229
 *     @remixicon/react 4.9.0                3227      0%          3  1075.67       1     3227
 *     react-icons/fa 5.7.0 (*)              1611    0.1%          2    805.5       1     1611
 *
 *   ships both                                 n   icon%   families      p/f   props  n/props
 *     evergreen-ui 7.1.9                     623   86.8%        377     1.65      81     7.69
 * ```
 *
 * Rows marked `(*)` were handed to this function by hand, because
 * `scanInstalledReactLibraries` cannot reach them today. They are in the
 * table so the RULE is measured against them even though DISCOVERY is not,
 * and each is a separate open gap in discovery, none of them in this rule:
 *
 *  - *No declared types, implicit layout* — `grommet` (345 exports behind a
 *    bare root `index.d.ts`, no `types` field) and
 *    `@cloudscape-design/components` (191, behind `exports["."]: "./index.js"`).
 *    FIXED 2026-09-15: `discoverReactDtsEntries` now falls back to the layout
 *    TypeScript itself resolves, and both are offered.
 *  - *Types only under subpaths* — `react-icons/fa`, `react-icons/md`
 *    (`react-icons` itself exports 2 things and sits under the 20-name
 *    floor), `@heroicons/react/24/outline`, `@shoelace-style/shoelace/dist/react`,
 *    and `primereact/button`. The package root genuinely has no declarations
 *    for them. Resolving these means walking `exports` subpaths and deciding
 *    which to scan; still OPEN. When they are reached, the rule already
 *    classifies every one of them correctly (rows above).
 *  - *Union-typed components* — `@remixicon/react` declares all 3,228 of its
 *    exports as `ComponentType<P>`, which is `ComponentClass | FunctionComponent`,
 *    and a union has no signatures of its own. FIXED 2026-09-15 in
 *    `getReactPropsType` (recurse into the union), landed together with
 *    signal 4 because the fix alone would have seeded remixicon as a
 *    3,227-component design system. MEASURED: `@remixicon/react` 0 -> 3,227,
 *    `@mui/material` 146 -> 148, every other count unchanged.
 *  - *Ambient-module bundles* — `@elastic/eui` ships one 31k-line `eui.d.ts`
 *    of `declare module '…'` blocks. The file is not itself a module, so it
 *    has no module symbol to enumerate exports from; still OPEN. Its row above
 *    was measured through `checker.getAmbientModules()`, which is one way the
 *    gap could be closed.
 *  - *`react` is not in the package's dependencies* — `igniteui-react` is a
 *    Lit wrapper that lists `@lit/react` and its web-components package, not
 *    `react`, so the scan's "depends on react" question excludes it (73
 *    `Igr*` components). Still OPEN.
 *  - *A `types` path that does not exist* — `@nordhealth/react` declares
 *    `lib/index.d.ts`; the file is at `lib/src/index.d.ts`. TypeScript itself
 *    would not resolve it either. Not ours to fix.
 *  - *No declarations at all* — `@iconscout/react-unicons` and
 *    `@syncfusion/ej2-react-buttons` ship no `.d.ts`. Nothing to scan.
 *
 * `baseui` (4 exports) and `react-icons` (2) are not gaps: their root entries
 * really do expose almost nothing, and both land under the 20-name floor.
 *
 * ## How to read the table before changing a number
 *
 * Read `icon%` before trusting signal 1. Most icon sets are under 50% and
 * many are effectively zero — the largest, `@fluentui/react-icons`, names
 * nothing `Icon` at all. `@tabler/icons-react` is the mirror image: every
 * name starts `Icon`, so it collapses to 7 families and signals 1 and 4 are
 * the only things that catch it. The signals cover each other's blind spots.
 *
 * Read the `families` column for where signals 2 and 3 sit. The largest
 * design system is `react-admin` at 127. The smallest icon set signal 1
 * misses is `react-feather` at 195. 150 sits in that gap. 250 sits well
 * above it, as the unconditional catch-all for a spread no design system can
 * reach.
 *
 * Read `p/f` for why 150 is safe. The design systems at or above 150 families:
 * none. The design systems under 2 p/f: many, and the largest of them is 89
 * families. Nothing measured is in both halves at once, and the nearest design
 * system, `react-admin`, misses on BOTH — 127 families and 2.39 p/f.
 *
 * Read `p/f` again for signal 4's family half: 10 separates the ordinary
 * design systems (6.8 and under) from the brand-prefixed lists (19.6 and up),
 * and crossing it costs nothing on its own. Then read `n/props` for the half
 * that decides: 20 separates every design system, brand-prefixed or not
 * (1.29 and under), from every icon set (286 and up).
 *
 * The gaps are not centered, and that is deliberate. The two mistakes do not
 * cost the same. Calling a design system "icons" removes it from onboarding
 * with no trace. Calling an icon set "a design system" seeds a row the user
 * has to notice and remove — the New Project step adds every detection and
 * ignores `confidence` (`new-project-page.tsx`, Mo 2026-09-08: "found means
 * added; remove what is not a design system") — plus the digest crowding
 * described above. Visible and reversible beats silent, so the design-system
 * side keeps the headroom.
 *
 * ## One known miss
 *
 * `evergreen-ui` is judged an icon set. It ships its icons in the same entry
 * as its components: 623 exports, 541 of them icon-named, 82 real components
 * (`Pane`, `Alert`, `Avatar`, `Button`, `Card`). Signal 1 claims the whole
 * package at 86.8%. It did under the old rule too, so this is not a
 * regression, and signal 4 says nothing about it (1.65 names per family).
 * Fixing it means judging the list with the icon-named names REMOVED, which
 * changes signal 1 for every package and changes what count onboarding
 * reports, so it is its own change.
 */
export function looksLikeIconSet(components: readonly ListedReactComponent[]): boolean {
  const n = components.length
  if (n < 20) return false

  const iconNamed = components.filter(({ name }) => ICON_NAME_RE.test(name)).length
  if (iconNamed / n >= 0.5) return true

  const families = new Set<string>()
  for (const { name } of components) families.add(FAMILY_RE.exec(name)?.[0] ?? name)
  if (families.size >= ICON_SET_MIN_FAMILIES) return true

  const partsPerFamily = n / families.size
  if (families.size >= FLAT_MIN_FAMILIES && partsPerFamily < FLAT_MAX_PARTS_PER_FAMILY) return true

  if (partsPerFamily < BRAND_PREFIX_MIN_PARTS_PER_FAMILY) return false
  // A props type that says nothing (`null`: `any`, `unknown`, `{}`) is
  // counted as unique to its component, so it can never look shared.
  const propsTypes = new Set<string>()
  let uninformative = 0
  for (const { propsType } of components) {
    if (propsType === null) uninformative += 1
    else propsTypes.add(propsType)
  }
  return n / (propsTypes.size + uninformative) >= SHARED_PROPS_MIN_NAMES_PER_TYPE
}

const SOURCE_FILE_RE = /\.(vue|ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache', 'coverage'])
const IMPORT_SPECIFIER_RE = /(?:import\s[^'"]*?from\s*|import\s*|export\s[^'"]*?from\s*|require\(\s*)['"]([^'"]+)['"]/g

/**
 * Resolve an import specifier to its bare npm PACKAGE name, or null for a
 * relative/absolute path. `@scope/pkg/sub` → `@scope/pkg`; `pkg/sub` → `pkg`.
 */
export function extractPackageName(specifier: string): string | null {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  }
  return parts[0] || null
}

export async function suggestDesignSystems(
  prototypeRoot: string,
): Promise<DesignSystemSuggestion[]> {
  const [
    { scanInstalledVueLibraries },
    { discoverVueDtsComponents },
    { resolvePackageVersion },
    { scanInstalledReactLibraries },
    { listReactComponents },
    { resolveTsconfig },
  ] = await Promise.all([
    import('@/editor/adapters/vue-dts-meta/auto-scan'),
    import('@/editor/adapters/vue-dts-meta/presets'),
    import('@/editor/adapters/cached'),
    import('@/editor/adapters/react-dts-meta/auto-scan'),
    import('@/editor/adapters/react-dts-meta/count-components'),
    import('@/editor/core/resolve-tsconfig'),
  ])

  const [vueScanned, reactScanned, declaredDeps, importCounts, tsconfigPath] = await Promise.all([
    scanInstalledVueLibraries(prototypeRoot),
    scanInstalledReactLibraries(prototypeRoot),
    readDeclaredDependencies(prototypeRoot),
    countPackageImports(prototypeRoot),
    resolveTsconfig(prototypeRoot),
  ])

  const suggestions: DesignSystemSuggestion[] = []
  const suggested = new Set<string>()

  for (const { packageName, packageRoot, dtsRoot } of vueScanned) {
    // Intersect with declared deps — a transitively-installed package the
    // prototype never declares isn't a design system the user "uses". (No
    // package.json → no declared deps → no suggestions; add via npm/installed.)
    if (!declaredDeps.has(packageName)) continue
    const components = discoverVueDtsComponents(packageRoot, {
      dtsRoots: [path.relative(packageRoot, dtsRoot) || '.'],
    })
    if (components.length === 0) continue
    suggested.add(packageName)
    suggestions.push({
      package: packageName,
      version: resolvePackageVersion(packageRoot) ?? 'unknown',
      framework: 'vue3',
      componentCount: components.length,
      importFrequency: importCounts.get(packageName) ?? 0,
      confidence: 'certain',
    })
  }

  // React arm. `scanInstalledReactLibraries` is already bounded to declared
  // dependencies; the import gate is the extra question its weaker marker
  // needs (see the header). A package the Vue arm already claimed is Vue.
  const reactCandidates = reactScanned.filter(
    ({ packageName }) => !suggested.has(packageName) && (importCounts.get(packageName) ?? 0) > 0,
  )
  if (reactCandidates.length > 0) {
    const names = listReactComponents(
      tsconfigPath,
      new Map(reactCandidates.map(({ packageName, entryFiles }) => [packageName, entryFiles])),
    )
    for (const { packageName, packageRoot } of reactCandidates) {
      const components = names.get(packageName) ?? []
      if (components.length === 0 || looksLikeIconSet(components)) continue
      suggestions.push({
        package: packageName,
        version: resolvePackageVersion(packageRoot) ?? 'unknown',
        framework: 'react',
        componentCount: components.length,
        importFrequency: importCounts.get(packageName) ?? 0,
        confidence: 'likely',
      })
    }
  }

  // Most-imported first; break ties by richer component coverage.
  suggestions.sort(
    (a, b) => b.importFrequency - a.importFrequency || b.componentCount - a.componentCount,
  )
  return suggestions
}

/** Names from the prototype's package.json deps + devDeps + peerDeps. */
async function readDeclaredDependencies(prototypeRoot: string): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(path.join(prototypeRoot, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as Record<string, Record<string, string> | undefined>
    const names = new Set<string>()
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = pkg[field]
      if (deps) for (const name of Object.keys(deps)) names.add(name)
    }
    return names
  } catch {
    return new Set()
  }
}

/** Count, per imported package, how many prototype source files import it. */
async function countPackageImports(prototypeRoot: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 12) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        await walk(full, depth + 1)
      } else if (e.isFile() && SOURCE_FILE_RE.test(e.name)) {
        await tallyFile(full, counts)
      }
    }
  }
  await walk(prototypeRoot, 0)
  return counts
}

async function tallyFile(file: string, counts: Map<string, number>): Promise<void> {
  let content: string
  try {
    content = await fs.readFile(file, 'utf8')
  } catch {
    return
  }
  // Count each package AT MOST ONCE per file (frequency = files-that-import).
  const seen = new Set<string>()
  for (const m of content.matchAll(IMPORT_SPECIFIER_RE)) {
    const pkg = extractPackageName(m[1])
    if (pkg) seen.add(pkg)
  }
  for (const pkg of seen) counts.set(pkg, (counts.get(pkg) ?? 0) + 1)
}

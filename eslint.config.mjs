import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // An `_`-prefixed binding means "deliberately unused" — an ignored Express
  // `_next`, an unused fake-callback param, or the destructure-to-omit idiom
  // (`const { autoDeploy: _autoDeploy, ...rest } = obj`). The codebase already
  // writes them that way everywhere; without this the linter warned on every
  // one, so the warning floor was permanent noise that new, real warnings
  // could hide inside.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  // The Vercel AI SDK lives behind ONE file. `ai` and `@ai-sdk/*` shipped two
  // breaking majors inside a year (`maxSteps` became `stopWhen`; per-tool
  // `needsApproval` became a `toolApproval` option), and the mitigation this
  // repo chose is that a major bump is a one-directory migration rather than a
  // sweep. `src/editor/llm-providers/ai-sdk-*.ts` is that directory-of-one.
  // Everything else reaches the SDK through `LLMProvider`, which is vendor
  // neutral and predates it.
  {
    ignores: ["src/editor/llm-providers/ai-sdk-*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "ai",
              message:
                "Import the AI SDK only from src/editor/llm-providers/ai-sdk-*.ts. Elsewhere, depend on the vendor-neutral LLMProvider in src/editor/llm-providers/types.ts.",
            },
          ],
          patterns: [
            {
              group: ["ai/*", "@ai-sdk/*"],
              message:
                "Import the AI SDK only from src/editor/llm-providers/ai-sdk-*.ts. Elsewhere, depend on the vendor-neutral LLMProvider in src/editor/llm-providers/types.ts.",
            },
          ],
        },
      ],
    },
  },
  // Dev-only live smoke / probe harnesses. They drive Playwright `page.evaluate`,
  // whose results are inherently `any` at the boundary; forcing types on these
  // throwaway scripts is noise, not safety. Not shipped in any bundle.
  {
    files: ["tasks/scripts/**/*.mts", "scripts/**/*.mts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  // Frontend house-style guardrails (see the `frontend-ui` skill). Scoped to the
  // shell / composer React components — NOT the shadcn primitives in
  // src/components/ui (which legitimately wrap raw <button> and own the scale).
  {
    files: [
      "src/components/**/*.tsx",
      "src/editor-ui/**/*.tsx",
      "viewer/app/**/*.tsx",
      // The viewer's surface gallery is UI that gets looked at while judging
      // the UI beside it, so it is held to the same bar as the app itself.
      "viewer/gallery/**/*.tsx",
    ],
    ignores: ["src/components/ui/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // Arbitrary pixel font sizes fragment the type scale. Use the named
          // steps: text-2xs (10px, sans only) / text-xs (11) / text-sm (12) /
          // text-base (13). Mono has its own: text-code (11) / text-code-lg (13).
          selector: "Literal[value=/text-\\[\\d+px\\]/]",
          message:
            "Arbitrary font size (text-[Npx]) is banned. Use the named scale: text-2xs/xs/sm/base, or text-code/text-code-lg for mono. The ramp is the @theme block in src/styles/globals.css.",
        },
        {
          selector: "TemplateElement[value.cooked=/text-\\[\\d+px\\]/]",
          message:
            "Arbitrary font size (text-[Npx]) is banned. Use the named scale: text-2xs/xs/sm/base, or text-code/text-code-lg for mono. The ramp is the @theme block in src/styles/globals.css.",
        },
        {
          // The tinted-surface recipe, hand-written. `Alert` shipped with only
          // `default` and `destructive`, so any banner wanting warning/success/
          // info had to write the triple out, and a banner whose author did not
          // know the incantation fell through to `default` and rendered white.
          // The recipe now lives once, in `src/lib/tone-surface.ts`, reached
          // through `Alert`'s and `Callout`'s named tone variants.
          //
          // Matches the BORDER AND FILL PAIR of one tone, not either half on
          // its own. A lone `bg-destructive/10` is house style — CLAUDE.md
          // prefers an opacity modifier on a token over a new arbitrary
          // colour, and badges, inline strips and status dots use one legitim-
          // ately. It is `border-x/N bg-x/N` together that means "I am hand-
          // building a tinted surface", which is the thing that has a name.
          selector:
            "Literal[value=/border-(destructive|warning|success|info)\\/\\d+\\s+bg-\\1\\//]",
          message:
            "Hand-written tone tint. Use a named tone variant on <Alert> or <Callout>; the recipe lives in src/lib/tone-surface.ts. The tone recipe and the Callout block (src/components/blocks/callout.tsx) show the pattern. If this is genuinely not a tinted surface, eslint-disable this line with a reason.",
        },
      ],
      // Raw <button> should almost always be the shadcn Button (dense xs/icon-xs
      // variants exist). Warn (not error) — rare legit cases use an inline
      // eslint-disable with a reason. See the frontend-ui skill.
      "react/forbid-elements": [
        "warn",
        {
          forbid: [
            {
              element: "button",
              message:
                "Use the shadcn <Button> (variant/size, incl. xs/icon-xs) instead of a raw <button>. If genuinely needed, eslint-disable this line with a reason.",
            },
          ],
        },
      ],
    },
  },
  // Test files render raw <button> as scaffolding/fixtures — the Button-primitive
  // rule is noise there. The font-size rule still applies (assertions).
  {
    files: ["src/components/**/*.test.tsx", "src/editor-ui/**/*.test.tsx"],
    rules: { "react/forbid-elements": "off" },
  },
  // The Editor shell UI is bundled by VITE for the CLI, not by Next.js —
  // `editor-cli/ui-src/src/main.tsx` imports `@/editor-ui/editor-page`, and the
  // Next app under `src/app/` imports none of it. So `next/image` does not
  // exist in this bundle and `no-img-element` is a false positive here, not a
  // deferred cleanup. (It was also unactionable on the merits: the two sites it
  // flagged are a remote avatar `photoURL` from an arbitrary host, which would
  // need a `remotePatterns` entry per provider, and an html2canvas `data:` URI,
  // which next/image cannot optimize at all.)
  {
    files: ["src/components/editor/**", "src/components/annotations/**", "src/editor-ui/**"],
    rules: { "@next/next/no-img-element": "off" },
  },
  // `no-html-link-for-pages` scans for a pages-router directory and prints
  // "Pages directory cannot be found at <root>/pages or <root>/src/pages" on
  // EVERY run. That notice is emitted by the rule itself, outside the normal
  // problem list, so `--max-warnings 0` cannot see it and the 0/0 bar cannot
  // clear it — it is permanent console noise of exactly the kind the bar
  // exists to prevent.
  //
  // It is also unactionable rather than deferred: the root stopped being a
  // Next app when `src/app/` and `next.config.ts` were deleted 2026-08-08, and
  // the one surviving Next app (`viewer/app`) is app-router. There is no pages
  // directory anywhere in the repo to point the rule at, and the rule only
  // governs `<a>` vs `<Link>` for pages-router routes.
  //
  // Deleting eslint-config-next wholesale would be wrong — its react-hooks and
  // app-router rules still cover viewer/app and every React component here.
  {
    rules: { "@next/next/no-html-link-for-pages": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    "**/.next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/bridge/**",
    "public/vendor/**",
    // Generated build output — never authored source (covers
    // editor-cli/ui-src/dist, ai-gateway-prototype/dist, and the
    // tracked-but-generated dist/bridge-bundle.js).
    "**/dist/**",
    // The website's static export. `out/**` above is anchored at the repo
    // root, so it does not cover website/out — which holds Next's minified
    // chunks and produced ~1,800 warnings the moment the site was added.
    "**/out/**",
    // Generated from website/content/docs by scripts/generate-static-assets.mjs.
    "website/public/search-index.json",
    // Minified vendored bundles.
    "**/*.min.js",
    // The dogfood substrate (a gitignored sibling checkout with its own
    // tooling) and any per-prototype scratch worktrees / manifest cache.
    "ai-gateway-prototype/**",
    "**/.desde/**",
    // verify-host.mts fixtures (same class as ai-gateway-prototype above):
    // gitignored sibling repos with their own tooling and tsconfig. Booting
    // the react-router-fixture through verify-host.mts regenerates
    // `.react-router/types/**` (React Router's own typegen output, not
    // authored source) and a root lint swept it — 5 errors from a fixture,
    // not from this checkout. See tasks/scripts/verify-host.mts.
    "next-fixture/**",
    "react-router-fixture/**",
    // The viewer's runtime data dir (SQLite + PUBLISHED PROTOTYPE ASSETS).
    // It is gitignored but was not lint-ignored, which went unnoticed only
    // because no successful build had ever populated it in a working tree.
    // Once builds work, it holds multi-MB minified vendor bundles, and
    // linting one OOMs Babel outright ("Ineffective mark-compacts near heap
    // limit") — a crash, not a warning, so `npm run lint` just dies.
    "**/.desde-viewer/**",
    // Its pre-rename name. A checkout that ran a viewer before the
    // ProtoTools → Desde rename still has this directory sitting on disk,
    // full of the same multi-MB minified bundles, and the rename only
    // updated the name above — so the gate started failing on a directory
    // that had been correctly ignored the day before. `viewer/.gitignore`
    // lists both names for exactly this reason; this is the lint half of
    // that same pairing.
    "**/.prototools-viewer/**",
    // Archived spikes / one-shot artifacts — dead code, not maintained.
    "tasks/_archive/**",
    // Other sessions' git worktrees. Their source matches every glob above,
    // so a root lint reports THEIR problems as if they were this checkout's —
    // a worktree predating the Composer → Editor rename contributed 60 errors
    // that no file in this tree could explain. Mirrors the same exclusion in
    // vitest.config.ts.
    "**/.claude/worktrees/**",
    // Electron packaging (tasks/electron-app.md Phase 3) generates two large
    // directories under desktop/: the staged CLI payload
    // (desktop/.package-payload/, built by scripts/build-desktop-app.mts)
    // and electron-builder's own output (desktop/release/ — the unpacked
    // .app, dmg, zip). Both are gitignored but were not lint-ignored, the
    // same class of miss `.desde-viewer` describes above: the moment
    // either has been built locally, `npm run lint` sweeps a copy of the
    // editor UI's minified vendor chunks (CodeMirror language grammars, the
    // bridge bundle) and reports THEIR pre-existing lint shape as if it were
    // new problems in this checkout — 109 errors / ~10,800 warnings,
    // measured, the first time a Phase 3 package build ran locally.
    "desktop/.package-payload/**",
    "desktop/release/**",
  ]),
]);

export default eslintConfig;

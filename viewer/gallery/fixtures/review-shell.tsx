"use client"

import { useEffect } from "react"
import { ReviewShell, type ReviewShellProject } from "../../app/review/[slug]/review-shell"
import { REVIEWER_IDENTITY_STORAGE_KEY } from "../../app/review/reviewer-identity"
import {
  ME_SIGNED_OUT,
  SAMPLE_COMMENTS,
  SAMPLE_FAILED_BUILD_LOG,
  SAMPLE_FAILED_BUILD_STEPS,
  sampleRunningBuildSteps,
  sampleDeployment,
} from "../harness/fixture-data"
import { Scenario } from "../harness/scenario"
import {
  fail,
  ok,
  PENDING,
  type FetchOverrideResult,
} from "@/components/gallery/fetch-override"
import {
  clickLikeUser,
  findButtonByText,
  findByText,
  runDrivenInteraction,
  setNativeValue,
  waitForElement,
} from "@/components/gallery/dom-interaction"
import type { SurfaceEntry } from "@/components/gallery/types"

/**
 * The review screen — the product's main surface. A reviewer lands here from
 * a project link, leaves comments on the live prototype in the iframe, and
 * replies to threads other people left.
 *
 * `ReviewShell` fetches everything itself (the comment store, `/api/v1/me`,
 * the participant directory) — it takes only one prop, `project`. Every
 * state below is either that prop, a `Scenario` route table, or a driven
 * click/type sequence; nothing here re-creates the component's own markup.
 *
 * ## The iframe points at a real file, not a 404
 *
 * `project.slug` is `"ai-gateway"`, matching `SAMPLE_PROJECTS[0]`, and
 * `viewer/gallery/public/p/ai-gateway/index.html` is a tiny static page
 * this catalog ships — Vite serves the gallery's `public/` dir at the
 * site root, so the iframe's `/p/ai-gateway/` `src` resolves to it. Read
 * that file's own comment for why it exists: several states below need to
 * post a message that LOOKS like it came from inside that iframe.
 *
 * ## Reaching the bridge-only states honestly
 *
 * `use-viewer-bridge.ts` only trusts a message whose `event.source`
 * is literally `iframeRef.current.contentWindow` — a plain
 * `window.postMessage(...)` from this module's own script is silently
 * ignored, because `source` is always the CALLING realm, not whatever
 * object a method was invoked on. Most states below dodge this entirely by
 * clicking a rail row instead (that reaches the exact same `activeCommentId`
 * state a `COMMENT_PIN_CLICKED` message would). Only two things have no
 * click-driven alternative — a fresh comment draft
 * (`NEW_COMMENT_POSITION`), and the page route — and both are reached via
 * `fireFromIframe` below, which calls a function this iframe's OWN document
 * defines, so the message it posts genuinely originates from the iframe's
 * realm.
 */

const PROJECT_ID = "proj-gateway"

/**
 * Fallback mode, which is what a deployment that configures nothing gets: the
 * prototype is embedded from the shell's own `/p/{slug}/` prefix. That is what
 * makes the fake prototype at `gallery/public/p/ai-gateway/index.html` load
 * here, and every bridge-driven state below depends on it loading.
 */
const REVIEW_PROJECT: ReviewShellProject = {
  id: PROJECT_ID,
  slug: "ai-gateway",
  name: "AI Gateway",
  access: "invited",
  publicLinksEnabled: true,
  serveDomain: null,
  capability: null,
  shellOrigin: "http://localhost:3100",
  prototypeOrigin: null,
  mode: "fallback",
}

/**
 * The same project under prototype-origin isolation: the shell was reached on
 * `localhost`, so the prototype is served by a per-deployment listener on the
 * paired loopback address at its own ephemeral port.
 *
 * The iframe is the subject of this state, not the rail. Two attributes are
 * worth looking at, and neither is visible anywhere else in the catalog:
 * `src` is an absolute URL on a DIFFERENT origin from the shell, and
 * `sandbox` carries `allow-same-origin` — the token that is a full sandbox
 * escape on a same-origin frame and merely restores the frame's own origin on
 * a cross-origin one. The resolver proves the origins differ before it can
 * emit that token; this row is what makes the result reviewable.
 *
 * Nothing serves that port in the gallery, so the frame stays blank. That is
 * the honest picture: the attributes are the state, and faking a load would
 * mean pointing `src` back at the gallery's own origin, which is precisely
 * the case the resolver refuses.
 */
const LOOPBACK_REVIEW_PROJECT: ReviewShellProject = {
  ...REVIEW_PROJECT,
  prototypeOrigin: "http://127.0.0.1:45001",
  mode: "loopback",
}

const COMMENTS_PATH = `/api/v1/projects/${PROJECT_ID}/comments`

/** What the fake prototype reports as its current page. */
const SAMPLE_ROUTE = {
  url: "/checkout/review",
  sourceFile: "src/pages/CheckoutReview.vue",
}

// `{ comments: [...] }`, not a bare array — `viewer-http-comment-store.ts`
// throws "response missing 'comments' array" otherwise, and the rail shows its
// load-error state instead of the one the fixture claims.
const COMMENTS_OK = ok({ comments: SAMPLE_COMMENTS })

// ---- reaching the fake iframe's bridge stub -------------------------------

interface FakeBridgeMessage {
  source: "desde-bridge"
  type: string
  payload?: unknown
}

function findBridgeStub(
  iframe: HTMLIFrameElement,
): ((message: FakeBridgeMessage) => void) | null {
  const win = iframe.contentWindow as
    | (Window & { __desdeFireBridgeMessage?: (message: FakeBridgeMessage) => void })
    | null
  return typeof win?.__desdeFireBridgeMessage === "function"
    ? win.__desdeFireBridgeMessage
    : null
}

async function waitForBridgeStub(
  iframe: HTMLIFrameElement,
  timeoutMs = 3000,
): Promise<((message: FakeBridgeMessage) => void) | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const fn = findBridgeStub(iframe)
    if (fn) return fn
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  console.warn("[gallery] review-shell: the fake prototype's bridge stub never appeared")
  return null
}

/** Waits for the review iframe, then for its bridge stub, then fires one message. */
async function fireFromIframe(
  cancelled: () => boolean,
  message: FakeBridgeMessage,
): Promise<void> {
  const iframe = await waitForElement(() => document.querySelector<HTMLIFrameElement>("iframe"))
  if (cancelled() || !iframe) return
  const fire = await waitForBridgeStub(iframe)
  if (cancelled() || !fire) return
  fire(message)
}

const NEW_COMMENT_DRAFT = {
  anchorSelector: ".hero-cta",
  page: "/",
  anchorX: 240,
  anchorY: 160,
  elementRect: { x: 200, y: 140, width: 120, height: 40, top: 140, right: 320, bottom: 180, left: 200 },
}

// ---- driven interactions ---------------------------------------------------
// Each function below is the click/type sequence one state needs, kept as a
// named step so a compound state (open the popup, THEN click Reply) reads as
// two calls rather than one long inline effect.

/**
 * The rail row itself, NOT the `<li>` wrapping it.
 *
 * The row is a `<button>` INSIDE the `<li>`, and the click handler is on the
 * button. A synthetic click dispatched at the `<li>` bubbles upward, away from
 * the button, so it never reaches the handler — the row stays unselected and
 * every state that clicks one silently shows the unselected rail instead.
 * Caught by the registry sweep, which is the only thing that would have.
 */
function findCommentRow(pattern: RegExp): HTMLButtonElement | null {
  return findByText<HTMLButtonElement>('[data-testid^="comment-row-"]', pattern)
}

async function clickShowResolved(cancelled: () => boolean): Promise<void> {
  // A `Switch` since 2026-08-19, not a button with a label — so it is found
  // by test id and its state is read off Radix's `data-state`.
  const toggle = await waitForElement(() =>
    document.querySelector<HTMLButtonElement>('[data-testid="show-resolved"]'),
  )
  if (cancelled() || !toggle) return
  clickLikeUser(toggle)
}

async function clickCommentMode(cancelled: () => boolean): Promise<void> {
  // "Add comment", in the Comments panel's own header — it was "Comment" in a
  // page-wide `<header>` until the rail was rebuilt on 2026-08-19.
  const button = await waitForElement(() => findButtonByText(/^Add comment$/))
  if (cancelled() || !button) return
  clickLikeUser(button)
}

/** Clicks one of the rail's three tabs by its visible label. */
async function clickTab(cancelled: () => boolean, label: RegExp): Promise<void> {
  const tab = await waitForElement(() =>
    findByText<HTMLButtonElement>('[role="tab"]', label),
  )
  if (cancelled() || !tab) return
  clickLikeUser(tab)
}

async function clickRow(cancelled: () => boolean, pattern: RegExp): Promise<void> {
  const row = await waitForElement(() => findCommentRow(pattern))
  if (cancelled() || !row) return
  clickLikeUser(row)
}

async function openReplyBox(cancelled: () => boolean): Promise<void> {
  await clickRow(cancelled, /Spacing between the two cards/)
  if (cancelled()) return
  const replyButton = await waitForElement(() => findButtonByText(/^Reply$/))
  if (cancelled() || !replyButton) return
  clickLikeUser(replyButton)
}

async function openResolvedThread(cancelled: () => boolean): Promise<void> {
  await clickShowResolved(cancelled)
  if (cancelled()) return
  await clickRow(cancelled, /Typo: "recieve"/)
}

async function clickAccess(cancelled: () => boolean): Promise<void> {
  // Behind the rail header's settings menu since 2026-08-19 — two clicks, not
  // one, and the menu has to mount in between.
  await openSettingsMenu(cancelled)
  if (cancelled()) return
  const item = await waitForElement(() =>
    document.querySelector<HTMLElement>('[data-testid="rail-settings-access"]'),
  )
  if (cancelled() || !item) return
  clickLikeUser(item)
}

async function clickRepo(cancelled: () => boolean): Promise<void> {
  await openSettingsMenu(cancelled)
  if (cancelled()) return
  const item = await waitForElement(() =>
    document.querySelector<HTMLElement>('[data-testid="rail-settings-repo"]'),
  )
  if (cancelled() || !item) return
  clickLikeUser(item)
}

async function openSettingsMenu(cancelled: () => boolean): Promise<void> {
  // The account menu IS the settings menu now — the rail's separate gear was
  // folded into it on 2026-08-25.
  const trigger = await waitForElement(() =>
    document.querySelector<HTMLButtonElement>('[data-testid="account-menu"]'),
  )
  if (cancelled() || !trigger) return
  clickLikeUser(trigger)
}

async function openComposer(cancelled: () => boolean): Promise<void> {
  await fireFromIframe(cancelled, {
    source: "desde-bridge",
    type: "NEW_COMMENT_POSITION",
    payload: NEW_COMMENT_DRAFT,
  })
}

async function typeMentionQuery(cancelled: () => boolean, query: string): Promise<void> {
  const textarea = await waitForElement(() =>
    document.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="Add a comment… (@ to mention)"]',
    ),
  )
  if (cancelled() || !textarea) return
  setNativeValue(textarea, `@${query}`)
}

async function openComposerWithMentionQuery(cancelled: () => boolean, query: string): Promise<void> {
  await openComposer(cancelled)
  if (cancelled()) return
  await typeMentionQuery(cancelled, query)
}

/**
 * What the bridge reports for one clicked element. Deliberately a BUSY
 * example — a component with a tree, a real box model, several style
 * categories including colours, and tokens from both sources — because the
 * Inspect panel's failure mode is cramping at 320px, and a sparse fixture would
 * never show it.
 */
const SAMPLE_INSPECTION = {
  tagName: "button",
  id: "checkout-submit",
  classes: ["btn", "btn-primary", "btn-lg", "w-full", "shadow-sm", "rounded-md"],
  rect: { x: 240, y: 412, width: 288, height: 44, top: 412, right: 528, bottom: 456, left: 240 },
  selector: "#checkout-submit",
  pageRoute: "/checkout/review",
  pageSourceFile: "src/pages/CheckoutReview.vue",
  component: {
    framework: "vue" as const,
    name: "KButton",
    file: "src/components/KButton.vue",
    line: 12,
    props: { appearance: "primary", size: "large", disabled: false },
  },
  componentTree: [
    { name: "CheckoutReview", file: "src/pages/CheckoutReview.vue" },
    { name: "OrderSummary", file: "src/components/OrderSummary.vue" },
    { name: "KButton", file: "src/components/KButton.vue" },
  ],
  boxModel: {
    width: 288,
    height: 44,
    margin: { top: 16, right: 0, bottom: 0, left: 0 },
    border: { top: 1, right: 1, bottom: 1, left: 1 },
    padding: { top: 10, right: 20, bottom: 10, left: 20 },
    content: { width: 246, height: 22 },
  },
  styles: [
    {
      name: "Layout",
      properties: [
        { name: "display", value: "inline-flex" },
        { name: "align-items", value: "center" },
        { name: "justify-content", value: "center" },
      ],
    },
    {
      name: "Typography",
      properties: [
        { name: "font-family", value: "DM Sans, sans-serif" },
        { name: "font-size", value: "13px" },
        { name: "font-weight", value: "500" },
        { name: "color", value: "oklch(0.99 0.006 190)" },
      ],
    },
    {
      name: "Background",
      properties: [
        { name: "background-color", value: "oklch(0.575 0.135 190)" },
        { name: "border-color", value: "#0f766e" },
        { name: "box-shadow", value: "0 4px 10px rgb(0 0 0 / 0.05)" },
      ],
    },
  ],
  tokens: [
    { name: "--primary", value: "oklch(0.575 0.135 190)", source: "element" as const },
    { name: "--primary-foreground", value: "oklch(0.99 0.006 190)", source: "element" as const },
    { name: "--radius", value: "0.5rem", source: "inherited" as const },
  ],
}

async function collapseRail(cancelled: () => boolean): Promise<void> {
  const button = await waitForElement(() =>
    document.querySelector<HTMLButtonElement>('[data-testid="collapse-rail"]'),
  )
  if (cancelled() || !button) return
  clickLikeUser(button)
}

async function collapseThenExpandRail(cancelled: () => boolean): Promise<void> {
  await collapseRail(cancelled)
  if (cancelled()) return
  const button = await waitForElement(() =>
    document.querySelector<HTMLButtonElement>('[data-testid="expand-rail"]'),
  )
  if (cancelled() || !button) return
  clickLikeUser(button)
}

export async function openDeploymentsTab(cancelled: () => boolean): Promise<void> {
  // The route arrives from `ReviewShellFixture`'s own default now.
  await clickTab(cancelled, /^Deployments$/)
}

/** Open the Deployments tab, then click a row to open its detail dialog. */
async function openDeploymentDetail(cancelled: () => boolean): Promise<void> {
  await clickTab(cancelled, /^Deployments$/)
  if (cancelled()) return
  const row = await waitForElement(() =>
    document.querySelector<HTMLButtonElement>('[data-testid^="deployment-dep"]'),
  )
  if (cancelled() || !row) return
  clickLikeUser(row)
}

/** No ROUTE_CHANGED fired — the header's page line shows its placeholder. */
async function showHeaderWithNoRoute(cancelled: () => boolean): Promise<void> {
  await waitForElement(() => document.querySelector('[data-testid="rail-page-path"]'))
  if (cancelled()) return
}

async function openInspectTab(cancelled: () => boolean): Promise<void> {
  await clickTab(cancelled, /^Inspect$/)
}

async function openInspectTabWithSelection(cancelled: () => boolean): Promise<void> {
  await clickTab(cancelled, /^Inspect$/)
  if (cancelled()) return
  await fireFromIframe(cancelled, {
    source: "desde-bridge",
    type: "ELEMENT_INSPECTED",
    payload: SAMPLE_INSPECTION,
  })
}

// ---- the driven wrapper -----------------------------------------------------

/**
 * EXPORTED for `fixtures/build-panel.tsx` (2026-08-21). Mo's call: the build panel's
 * states should render inside the real review chrome, with the iframe shrunk,
 * rather than as isolated cards — "I rather the iframe area become thinner so
 * that all the viewer chrome is showing."
 *
 * A fixture importing another fixture is unusual and is the right trade here:
 * this wrapper carries the shell's project, its default route and the
 * one-wrapper rule that six states once bypassed. Copying it into a second
 * file would be copying exactly the thing that rule exists to prevent.
 */
export function ReviewShellFixture({
  project = REVIEW_PROJECT,
  routes,
  run,
  route = SAMPLE_ROUTE,
}: {
  project?: ReviewShellProject
  routes: Record<string, FetchOverrideResult | (() => FetchOverrideResult)>
  /**
   * The click/type sequence this state needs, if any. Optional: a state with
   * nothing to drive still mounts through here, so it gets the route below.
   * Every state going through ONE wrapper is the point — six of them rendered
   * `<Scenario>` directly and silently missed the route entirely.
   */
  run?: (cancelled: () => boolean) => Promise<void>
  /**
   * The page the prototype reports on load. Defaults to a real-looking one so
   * the header's page line shows a PATH rather than its "—" placeholder in
   * every state — the line is part of the header's design and a catalog that
   * never populates it cannot be used to review it. Pass `null` for the one
   * state that is specifically about not having a route yet.
   */
  route?: { url: string; sourceFile?: string } | null
}) {
  useEffect(() => {
    let cancelled = false
    // The route is kicked off WITHOUT being awaited. It is decoration for the
    // header, not a precondition for anything a state does — and awaiting it
    // would put `fireFromIframe`'s 3s wait for the iframe's bridge stub in
    // front of every interaction. In jsdom that stub never appears (the
    // iframe's document is not loaded), so awaiting it delayed every driven
    // state past its own `readyWhen` and failed the registry sweep.
    if (route) {
      runDrivenInteraction(() =>
        fireFromIframe(() => cancelled, {
          source: "desde-bridge",
          type: "ROUTE_CHANGED",
          payload: route,
        }),
      )
    }
    if (run) {
      runDrivenInteraction(async () => {
        await run(() => cancelled)
      })
    }
    return () => {
      cancelled = true
    }
    // `run` is a module-level function reference per state, stable across
    // renders — omitting it from deps avoids re-running the interaction on
    // every re-render this fixture causes (e.g. the composer's own typing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Scenario routes={routes}>
      <ReviewShell project={project} />
    </Scenario>
  )
}

/** Opens the public-link banner, then dismisses it. */
function DismissedPublicNotice() {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      const button = await waitForElement(() =>
        document.querySelector<HTMLButtonElement>('[data-testid="dismiss-public-notice"]'),
      )
      if (cancelled || !button) return
      clickLikeUser(button)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <ReviewShellFixture
      routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
      project={{ ...REVIEW_PROJECT, access: "public-link", publicLinksEnabled: true }}
    />
  )
}

export const REVIEW_SHELL_SURFACE: SurfaceEntry = {
  id: "review",
  title: "Review screen",
  kind: "page",
  sourceFile: "viewer/app/review/[slug]/review-shell.tsx",
  states: [
    {
      id: "review/rail-loading",
      label: "Comment rail — loading",
      render: () => (
        <ReviewShellFixture routes={{ [COMMENTS_PATH]: PENDING }} />
      ),
    },
    {
      id: "review/rail-error",
      label: "Comment rail — couldn't load",
      render: () => (
        <ReviewShellFixture routes={{ [COMMENTS_PATH]: fail(500, "internal error") }} />
      ),
    },
    {
      id: "review/rail-empty",
      label: "Comment rail: no comments",
      render: () => (
        <ReviewShellFixture routes={{ [COMMENTS_PATH]: ok({ comments: [] }) }} />
      ),
    },
    {
      id: "review/rail-populated",
      label: "Comment rail — populated (unresolved)",
      render: () => (
        <ReviewShellFixture routes={{ [COMMENTS_PATH]: COMMENTS_OK }} />
      ),
    },
    {
      // The iframe is the subject here, not the rail — see
      // `LOOPBACK_REVIEW_PROJECT` for what to look at and why the frame is
      // blank. `readyWhen` pins the two attributes the state exists for, so a
      // regression that quietly drops the isolated origin fails the registry
      // sweep instead of just looking the same.
      id: "review/loopback-embed",
      label: "Prototype embed — loopback origin, cross-origin sandbox",
      render: () => (
        <Scenario routes={{ [COMMENTS_PATH]: COMMENTS_OK }}>
          <ReviewShell project={LOOPBACK_REVIEW_PROJECT} />
        </Scenario>
      ),
      readyWhen: 'iframe[src^="http://127.0.0.1:45001/"][sandbox~="allow-same-origin"]',
    },
    {
      // Folds two must-have states into one screenshot: the resolved row
      // (muted text + check icon) only shows once "Show resolved" is on, and
      // that same click is what the header's "Show resolved — active" badge
      // demonstrates too. Two states that differ by one boolean would just
      // be the same screenshot twice.
      id: "review/rail-populated-show-resolved",
      label: "Comment rail — Show resolved on (resolved row visible)",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => clickShowResolved(cancelled)}
        />
      ),
      readyWhen: '[data-testid="show-resolved"][data-state="checked"]',
    },
    {
      id: "review/header-effectively-public",
      label: "Public-link banner — dismissable, between the path and the tabs",
      render: () => (
        <ReviewShellFixture routes={{ [COMMENTS_PATH]: COMMENTS_OK }} project={{ ...REVIEW_PROJECT, access: "public-link", publicLinksEnabled: true }} />
      ),
      readyWhen: '[data-testid="public-notice"]',
    },
    {
      // Stored as "public-link", but the instance-wide kill switch is off, so
      // `canReadProject` (server/auth/authorize.ts) treats it exactly like
      // "all-members" and `effectivelyPublic` is false — no banner, sign-in
      // still required. The pair to the banner state above, and the only
      // thing that now tells the two apart: the "Public" badge that used to
      // be the difference was removed on 2026-08-25.
      id: "review/header-public-link-disabled-by-instance",
      label: "Public-link project, but the instance kill switch is off — no banner",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          project={{ ...REVIEW_PROJECT, access: "public-link", publicLinksEnabled: false }}
        />
      ),
      readyWhen: 'aside [role="tablist"]',
    },
    {
      id: "review/header-effectively-public-dismissed",
      label: "Public-link banner — dismissed, the rail closes back up",
      render: () => (
        <DismissedPublicNotice />
      ),
      // The banner is gone; this is what the rail looks like afterwards.
      readyWhen: 'aside [role="tablist"]',
    },
    {
      id: "review/comment-mode-active",
      label: "Comments — Add comment armed",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => clickCommentMode(cancelled)}
        />
      ),
      readyWhen: '[data-testid="comment-mode"][aria-pressed="true"]',
    },
    {
      id: "review/row-selected",
      label: "Comment rail — row selected",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => clickRow(cancelled, /Spacing between the two cards/)}
        />
      ),
      readyWhen: '[data-testid^="comment-row-"][aria-current="true"]',
    },
    {
      id: "review/thread-popup-with-replies",
      label: "Popup — thread card, unresolved, with a reply",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => clickRow(cancelled, /The CTA copy reads a little flat/)}
        />
      ),
      readyWhen: 'button[title="Resolve"]',
    },
    {
      id: "review/thread-popup-resolved",
      label: "Popup — thread card, resolved",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => openResolvedThread(cancelled)}
        />
      ),
      readyWhen: 'button[title="Resolved"]',
    },
    {
      id: "review/reply-box-open",
      label: "Popup — reply textarea open",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => openReplyBox(cancelled)}
        />
      ),
      readyWhen: 'textarea[placeholder="Reply… (@ to mention)"]',
    },
    {
      id: "review/new-comment-composer",
      label: "Popup — new comment composer",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => openComposer(cancelled)}
        />
      ),
      readyWhen: 'textarea[placeholder="Add a comment… (@ to mention)"]',
      needsBrowser:
        "The message that opens this state must be posted from inside the prototype iframe's own realm, so the iframe's document has to have loaded — jsdom does not load it.",
    },
    {
      id: "review/mention-picker-matches",
      label: "Popup — @-mention picker, matches",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => openComposerWithMentionQuery(cancelled, "mo")}
        />
      ),
      readyWhen: '[class*="bg-popover"]',
      needsBrowser:
        "The message that opens this state must be posted from inside the prototype iframe's own realm, so the iframe's document has to have loaded — jsdom does not load it.",
    },
    {
      id: "review/mention-picker-no-matches",
      label: "Popup — @-mention picker, no matches",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => openComposerWithMentionQuery(cancelled, "zzzznotfound")}
        />
      ),
      readyWhen: '[class*="bg-popover"]',
      needsBrowser:
        "The message that opens this state must be posted from inside the prototype iframe's own realm, so the iframe's document has to have loaded — jsdom does not load it.",
    },
    {
      id: "review/identity-form",
      label: "Popup — \"Who's commenting?\" identity form",
      render: () => {
        // Cleared here (before mount, same as `setGalleryConfig`'s call
        // pattern elsewhere in this catalog) so a name typed and saved on a
        // PREVIOUS visit to this same state — the form's own "Save" button
        // writes to real localStorage — can never leave `identity` non-null
        // and silently swap this state to the composer instead.
        localStorage.removeItem(REVIEWER_IDENTITY_STORAGE_KEY)
        return (
          <ReviewShellFixture
            routes={{ [COMMENTS_PATH]: COMMENTS_OK, "/api/v1/me": ok(ME_SIGNED_OUT) }}
            run={(cancelled) => openComposer(cancelled)}
          />
        )
      },
      readyWhen: "input#reviewer-name",
      needsBrowser:
        "The message that opens this state must be posted from inside the prototype iframe's own realm, so the iframe's document has to have loaded — jsdom does not load it.",
    },
    {
      // The detail a row opens. This is where a finished build's log lives
      // now: the tab itself no longer shows one, because a log is what you
      // read when something went wrong, not the first thing on the panel.
      id: "review/deployment-detail",
      label: "Deployment detail — opened from its row",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => openDeploymentDetail(cancelled)}
        />
      ),
      readyWhen: '[data-testid="deployment-detail"]',
      needsBrowser:
        "Reached by clicking a row on the Deployments tab, which needs the tab's own list to have loaded first.",
    },
    {
      // A build that DIED, opened from its row. The step list is what makes
      // "failed at Install" readable without opening the log.
      id: "review/deployment-detail-failed",
      label: "Deployment detail — failed at Install",
      render: () => (
        <ReviewShellFixture
          routes={{
            [COMMENTS_PATH]: COMMENTS_OK,
            [`/api/v1/projects/${PROJECT_ID}/deployments`]: ok({
              deployments: [
                sampleDeployment({
                  id: "dep-failed",
                  status: "failed",
                  buildLog: SAMPLE_FAILED_BUILD_LOG,
                  steps: SAMPLE_FAILED_BUILD_STEPS,
                }),
              ],
            }),
          }}
          run={(cancelled) => openDeploymentDetail(cancelled)}
        />
      ),
      readyWhen: '[data-testid="deployment-steps"]',
      needsBrowser:
        "Reached by clicking a row on the Deployments tab, which needs the tab's own list to have loaded first.",
    },
    {
      // A build IN FLIGHT: two phases done, one spinning. The only state
      // where the running glyph shows, and the reason the step list is worth
      // having live rather than only after the fact.
      id: "review/deployment-detail-running",
      label: "Deployment detail — a build still running",
      render: () => (
        <ReviewShellFixture
          routes={{
            [COMMENTS_PATH]: COMMENTS_OK,
            [`/api/v1/projects/${PROJECT_ID}/deployments`]: ok({
              deployments: [
                sampleDeployment({
                  id: "dep-running",
                  status: "building",
                  commitSha: null,
                  steps: sampleRunningBuildSteps(),
                }),
              ],
            }),
          }}
          run={(cancelled) => openDeploymentDetail(cancelled)}
        />
      ),
      readyWhen: '[data-testid="deployment-steps"] .animate-spin',
      needsBrowser:
        "Reached by clicking a row on the Deployments tab, which needs the tab's own list to have loaded first.",
    },
    {
      // No steps at all: an uploaded bundle ran no phases, and neither did any
      // build from before the runner recorded them. The list is absent rather
      // than empty.
      id: "review/deployment-detail-no-steps",
      label: "Deployment detail — an upload, so no phases to show",
      render: () => (
        <ReviewShellFixture
          routes={{
            [COMMENTS_PATH]: COMMENTS_OK,
            [`/api/v1/projects/${PROJECT_ID}/deployments`]: ok({
              deployments: [sampleDeployment({ id: "dep-upload", steps: null })],
            }),
          }}
          run={(cancelled) => openDeploymentDetail(cancelled)}
        />
      ),
      readyWhen: '[data-testid="deployment-detail"]',
      needsBrowser:
        "Reached by clicking a row on the Deployments tab, which needs the tab's own list to have loaded first.",
    },
    {
      id: "review/deployments-tab",
      label: "Deployments tab — the build list, newest first",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => openDeploymentsTab(cancelled)}
        />
      ),
      readyWhen: '[data-testid^="deployment-"]',
      needsBrowser:
        "The route this panel reports arrives as a ROUTE_CHANGED posted from inside the prototype iframe's own realm, so the iframe's document has to have loaded — jsdom does not load it.",
    },
    {
      id: "review/header-no-route",
      label: "Header — before the prototype reports a page",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          route={null}
          run={(cancelled) => showHeaderWithNoRoute(cancelled)}
        />
      ),
      readyWhen: '[data-testid="rail-page-path"]',
    },
    {
      id: "review/inspect-tab-empty",
      label: "Inspect tab — armed, nothing selected",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => openInspectTab(cancelled)}
        />
      ),
      readyWhen: '[role="tabpanel"]',
    },
    {
      id: "review/inspect-tab-populated",
      label: "Inspect tab — an element inspected",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => openInspectTabWithSelection(cancelled)}
        />
      ),
      readyWhen: '[role="tabpanel"] [data-slot="badge"]',
      needsBrowser:
        "ELEMENT_INSPECTED has to be posted from inside the prototype iframe's own realm, so the iframe's document has to have loaded — jsdom does not load it.",
    },
    {
      id: "review/rail-collapsed",
      label: "Rail collapsed — the prototype has the whole window",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => collapseRail(cancelled)}
        />
      ),
      readyWhen: '[data-testid="expand-rail"]',
    },
    {
      id: "review/rail-reopened",
      label: "Rail collapsed, then reopened — the tab you were on is still open",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => collapseThenExpandRail(cancelled)}
        />
      ),
      readyWhen: '[data-testid="collapse-rail"]',
    },
    {
      id: "review/access-dialog",
      label: "Access dialog open",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => clickAccess(cancelled)}
        />
      ),
      readyWhen: '[data-slot="dialog-content"]',
    },
    {
      id: "review/repo-dialog",
      label: "Repo dialog open",
      render: () => (
        <ReviewShellFixture
          routes={{ [COMMENTS_PATH]: COMMENTS_OK }}
          run={(cancelled) => clickRepo(cancelled)}
        />
      ),
      readyWhen: '[data-slot="dialog-content"]',
    },
  ],
}

"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import Link from "next/link"
import {
  ArrowUp,
  Home,
  MessageCirclePlus,
  MapPin,
  MapPinOff,
  Maximize2,
  Minimize2,
  Search,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Callout, EmptyState, Field, FieldGroup, ProjectLoader } from "@/components/blocks"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AnnotationCard, annotationCardSurface } from "@/components/annotations/annotation-card"
import { MentionText } from "@/components/annotations/mention-text"
import { MentionInput } from "@/components/annotations/mention-input"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { createViewerHttpCommentStore } from "@/services/artifact-stores/viewer-http-comment-store"
import { createLocalOverlayCommentStore } from "@/services/artifact-stores/local-overlay-comment-store"
import { cn } from "@/lib/utils"
import { avatarInitial } from "@/lib/initials"
import { formatRelativeTimeShort } from "@/lib/relative-time"
import { LoadFailure } from "../../load-failure"
import type { Comment, CommentAuthor, DOMRectJSON } from "@/types/bridge"
import {
  prototypeAnonymouslyReadable,
  prototypeEmbedOrigin,
  resolvePrototypeEmbed,
  type OriginMode,
  type PrototypeEmbedTarget,
} from "../../prototype-origin"
import { resolveAuthor, saveReviewerIdentity } from "../reviewer-identity"
import { useViewerBridge } from "../use-viewer-bridge"
import { DeploymentsPanel } from "../deployments-panel"
import { AccountMenu } from "../../account-menu"
import { failureMessage } from "../../api-client"
import { repoSourceBase, useProjectDetail } from "../use-project-detail"
import { ViewerInspectorPanel } from "../inspector-panel"
import { useParticipants, type ReviewParticipant } from "../use-participants"
import { extractMentionIds } from "@/components/annotations/mention-encoding"
import { useCurrentUser } from "../../use-current-user"
import { ProjectAccess } from "../../project-access"
import type { ProjectAccessValue } from "../../project-access-copy"
import { canAdministerInstance, canManageProjects } from "../../instance-role"
import { clearUrlParams } from "../../github-access-flow"
import { ProjectRepoPanel } from "../../project-repo-panel"
import { GITHUB_APP_SETUP_INTRO, GithubAccessSetupStep } from "../../github-app-setup-card"
import { RootAbsoluteWarningCallout } from "../../root-absolute-warning"
import { shouldShowRootAbsoluteWarning } from "../../build-log-utils"

export interface ReviewShellProject {
  id: string
  slug: string
  name: string
  access: ProjectAccessValue
  /**
   * The instance-wide public-link kill switch (`server/instance-settings.ts`).
   * Read alongside `access` everywhere "is this genuinely reachable with no
   * sign-in" is decided — the badge below, and `prototype-origin.ts`'s
   * `prototypeAnonymouslyReadable` — because a `"public-link"` project with
   * this off behaves exactly like `"all-members"`.
   */
  publicLinksEnabled: boolean
  /**
   * `VIEWER_SERVE_DOMAIN`, or `null` in the default path mode. Passed to the
   * Deployments panel, which uses it to decide whether a deploy-time
   * root-absolute-asset warning is worth showing for this project's access
   * setting. NOT used to build the review iframe's origin — that is resolved
   * server-side in `page.tsx` (see `shellOrigin`/`prototypeOrigin` below).
   */
  serveDomain: string | null
  /**
   * A short-lived, deployment-scoped read capability minted by `page.tsx`
   * for a prototype whose assets would otherwise need the session cookie —
   * `null` when none applies. It is what lets the iframe below be sandboxed
   * even for a private prototype (`../../prototype-origin.ts`).
   */
  capability: string | null
  /**
   * The origin THIS shell is on for this request, resolved server-side from
   * the allowlisted `Host` (`page.tsx`'s `reviewShellOrigin`).
   *
   * Load-bearing, not informational: `resolvePrototypeEmbed` refuses to grant
   * `allow-same-origin` until it has confirmed the prototype's origin is not
   * this one. On a laptop the reviewer's spelling is not knowable at boot,
   * which is why it is a prop rather than `publicUrl`.
   */
  shellOrigin: string
  /**
   * The origin the server offers for THIS prototype right now, or `null` when
   * it has none to offer (fallback mode, or nothing built yet).
   */
  prototypeOrigin: string | null
  /** The mode that answer came back in. Decides which embed rule applies. */
  mode: OriginMode
}

const POPUP_WIDTH = 320

/**
 * The rail's three tabs. "Dev" is the label, `inspect` the value — the label
 * is the original's word for it and the value says what it does.
 */
type RailTab = "comments" | "inspect" | "deployments"

export function ReviewShell({ project }: { project: ReviewShellProject }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  /**
   * The one resolved answer to "where is this prototype, and how contained".
   *
   * Everything about the embed comes from this single target: the iframe's
   * `src` and `sandbox` (spread from `resolvePrototypeEmbed`) and the origin
   * the bridge pins its messages to (`prototypeEmbedOrigin`, which reads the
   * resolver's own answer back rather than deciding again). Two independent
   * computations here would be free to disagree, and a disagreement is
   * invisible: a message posted to an origin the frame is not on is dropped
   * with no error anywhere.
   *
   * Deliberately reads `project.access` / `project.capability` and not
   * `liveAccess` below. The capability was minted server-side once, at page
   * load, against the access this page was rendered under; a client-side
   * access change cannot re-mint it, which is why the access dialog reloads
   * the page instead (see `handleAccessChange`).
   */
  const embedTarget: PrototypeEmbedTarget = useMemo(
    () => ({
      slug: project.slug,
      shellOrigin: project.shellOrigin,
      prototypeOrigin: project.prototypeOrigin,
      mode: project.mode,
      capability: project.capability,
      anonymouslyReadable: prototypeAnonymouslyReadable(project.access, project.publicLinksEnabled),
    }),
    [
      project.slug,
      project.shellOrigin,
      project.prototypeOrigin,
      project.mode,
      project.capability,
      project.access,
      project.publicLinksEnabled,
    ],
  )
  const iframeProps = useMemo(() => resolvePrototypeEmbed(embedTarget), [embedTarget])
  const bridgeOrigin = useMemo(() => prototypeEmbedOrigin(embedTarget), [embedTarget])

  const {
    bridgeReadyEpoch,
    pinClick,
    clearPinClick,
    draft,
    clearDraft,
    syncComments,
    enterCommentMode,
    exitCommentMode,
    setShowResolved: bridgeSetShowResolved,
    setPinsHidden: bridgeSetPinsHidden,
    highlightComment,
    page,
    pageBackground,
    inspection,
    activateInspector,
    deactivateInspector,
  } = useViewerBridge(iframeRef, { prototypeOrigin: bridgeOrigin, mode: project.mode })

  /**
   * Reads from the server always; writes go to the server only when this caller
   * is allowed to make them, and otherwise stay in this browser.
   *
   * That is what makes a public demo work. An operator who turns off
   * `allowAnonymousComments` stops strangers writing to a project linked from
   * a public page, which is the only complete answer to comment abuse. Without
   * this overlay the visitor would then see a disabled composer and never get
   * to try the one thing the surface is for; with it they place a pin, type,
   * and watch it appear, and none of it leaves their machine.
   *
   * The overlay is NOT a security control. The server's refusal is. This only
   * decides what the UI does.
   */
  const store = useMemo(
    () =>
      createLocalOverlayCommentStore({
        base: createViewerHttpCommentStore({ baseUrl: "", projectId: project.id }),
      }),
    [project.id],
  )

  const { participants, reload: reloadParticipants } = useParticipants(project.id)

  /**
   * The project record the Info and Dev tabs both read — loaded once here
   * rather than in each panel, because Radix unmounts an inactive
   * `TabsContent` and a per-panel fetch would re-run on every tab switch.
   */
  const { detail: projectDetail, error: projectDetailError } = useProjectDetail(project.id)

  // Feeds the ref the comment store above reads. Declared here rather than
  // beside the ref because it depends on the detail, which loads below the
  // store's construction.
  // Tells the comment store whether writes may reach the server. It defaults to
  // allowing them, so this only ever narrows, and only once the server has
  // said so. Calling a method rather than mutating something memoized here is
  // what keeps the store's own state out of React's render model.
  useEffect(() => {
    if (projectDetail?.canComment !== undefined) {
      store.setAllowRemoteWrites(projectDetail.canComment)
    }
  }, [store, projectDetail?.canComment])
  const projectRepo = repoSourceBase(projectDetail)

  const { user: currentUser, loading: currentUserLoading } = useCurrentUser()
  // Who may change access / manage the invite list in the dialog below —
  // the caller's INSTANCE role, mirroring the server's
  // `hasProjectManageAuthority` (`server/auth/authorize.ts`). A `viewer`
  // sees a read-only sentence instead; the server enforces this
  // independently, so this is a UX courtesy, not the real gate. The
  // predicate itself is shared (`app/instance-role.ts`) rather than spelled
  // out here — see its doc comment.
  const canManageAccess = canManageProjects(currentUser?.role)

  // Invite-by-email affordance surfaced inline in the mention picker's
  // footer (cold-start case: nobody in the directory yet). POSTs to Task
  // 2's participants route, reloads the directory, and hands the created
  // participant back so the caller can immediately insert a mention for
  // them — the invite and the mention are one motion for the reviewer.
  // `POST /projects/:id/participants` requires an identified caller (security
  // audit B5), so for an anonymous public-link reviewer the invite row is an
  // action that returns 401 every time, clears the address they typed, and
  // says nothing. Same dead end, and the same fix, as the admin affordances
  // above: gate on `currentUser`, not on whether auth is configured.
  const canInvite = currentUser !== null

  const inviteParticipant = useCallback(
    async (email: string): Promise<ReviewParticipant | null> => {
      try {
        const res = await fetch(`/api/v1/projects/${encodeURIComponent(project.id)}/participants`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        })
        if (!res.ok) return null
        const created = (await res.json()) as ReviewParticipant
        reloadParticipants()
        return created
      } catch {
        return null
      }
    },
    [project.id, reloadParticipants],
  )

  const [comments, setComments] = useState<Comment[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  // Flips true on the FIRST successful comment-store emit and never resets.
  // The store's `subscribe` only calls its success listener when the
  // serialized list CHANGES (dedup — see `emitIfChanged` in
  // `viewer-http-comment-store.ts`), so a transient SSE `onerror` (proxy
  // hiccup, server restart) with no concurrent comment change never fires
  // the listener again — `setLoadError(null)` there alone can't be relied
  // on to clear a stale error. Gating the blocking error UI on
  // `!hasLoadedOnce` instead makes correctness independent of dedup: once
  // real data has been shown, a later reconnect blip is never a reason to
  // blank the rail.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
  const [identity, setIdentity] = useState<CommentAuthor | null>(null)
  const [showResolved, setShowResolvedState] = useState(false)
  const [commentMode, setCommentMode] = useState(false)
  /**
   * Hides the comment PINS inside the prototype. The rail keeps its list —
   * the point is to see the design without the overlay on top of it, not to
   * stop reviewing.
   */
  const [pinsHidden, setPinsHidden] = useState(false)
  /**
   * Component state, so the notice comes back on reload.
   *
   * Deliberately NOT persisted. It reports that this project is readable by
   * anyone holding the link, which stays true until somebody adds a member —
   * a standing condition, not an event. A dismissal that outlived the session
   * would let one click permanently silence the only place the product says
   * so.
   */
  const [publicNoticeDismissed, setPublicNoticeDismissed] = useState(false)
  /** Same non-persistence reasoning as `publicNoticeDismissed` above: the
   * root-absolute warning reports a standing condition of the deployed
   * build, so a dismissal lasts the session, not forever. */
  const [rootAbsoluteWarningDismissed, setRootAbsoluteWarningDismissed] = useState(false)
  /**
   * The prototype's own load, which had no signal at all: a reviewer opening
   * a review link watched a blank rectangle until the iframe painted.
   *
   * `onLoad` fires for a sandboxed cross-origin frame too — it reports that
   * the BROWSER finished loading the document, which needs no access to its
   * contents. It does NOT mean the prototype has finished booting its own JS;
   * nothing outside the frame can know that, and the bridge's own handshake
   * is the closest thing. This is the honest signal available, and it is far
   * better than nothing.
   */
  const [prototypeLoaded, setPrototypeLoaded] = useState(false)
  /**
   * The overlay clears on EITHER the iframe's own load event or the bridge
   * handshake, because the load event alone loses a race it cannot recover
   * from.
   *
   * This `<iframe>` is part of the SSR'd HTML, so the browser starts fetching
   * the prototype while this document is still parsing. When the frame
   * finishes before React hydrates and attaches `onLoad`, that event has
   * already fired at nobody: there is no replay, and cross-origin means we
   * cannot read `contentDocument.readyState` to ask after the fact either.
   * The overlay then sits on top of a prototype that has loaded perfectly and
   * never goes away. MEASURED 2026-09-01: Mo opened the demo and got a
   * permanent spinner, while the same frame rendered fine on its own and was
   * posting DOM_MUTATED to this shell the whole time.
   *
   * `bridge-protocol.md` documents this exact race for `BRIDGE_READY` and
   * closes it with a PING on mount, which `useViewerBridge` sends. So the
   * handshake already has the recovery the load event lacks, and reusing it
   * here costs nothing: a bridge that answers is a frame that loaded.
   *
   * Both signals stay, rather than replacing one with the other. A prototype
   * whose bridge never boots (a strict CSP, an older bundle) still clears the
   * overlay on `onLoad`, and a frame whose load event was missed still clears
   * on the handshake.
   */
  const prototypeVisible = prototypeLoaded || bridgeReadyEpoch > 0
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null)
  const [accessOpen, setAccessOpen] = useState(false)
  /**
   * The Repo dialog, openable by URL as well as by the menu.
   *
   * `?repo=1` exists so the combined GitHub-access flow can come BACK here
   * (2026-08-29). That flow leaves for github.com and returns through the
   * OAuth callback, and a dialog held only in local state would be closed on
   * arrival — the reader would land on the review screen with no idea their
   * one click had finished.
   *
   * Read in a lazy initializer for the reason `SettingsNav` records for its
   * own `?section=`: an effect would paint the closed state first and open a
   * frame later, and reading `window` during render is safe here because a
   * dialog's open state is not part of the server-rendered markup — Radix
   * portals its content, so the server and the client's first paint agree on
   * an empty container either way.
   */
  const [repoOpen, setRepoOpen] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).has("repo"),
  )
  /**
   * Closing drops `?repo=1`, so a reload does not reopen a dialog the reader
   * just dismissed and a copied link does not reopen it for whoever they sent
   * it to (codex, 2026-08-29). The parameter's only job is to REOPEN, so it
   * has to die with the dialog.
   */
  /** The App-setup step inside the repo dialog — see `projects-list.tsx`'s
   * `addingGithubAccess` for the pattern (Mo, 2026-08-29: its own step). */
  const [repoGithubAccess, setRepoGithubAccess] = useState(false)
  const closeRepoDialog = useCallback(() => {
    setRepoOpen(false)
    setRepoGithubAccess(false)
    clearUrlParams("repo")
  }, [])

  // The access dialog can change `project.access` mid-session; `project`
  // itself is an immutable prop from the Server Component page, so the
  // header badge below reads this instead. The iframe's `src`/`sandbox`
  // deliberately keep reading `project.access`/`project.capability` — the
  // capability was minted server-side once, at page load, against the
  // ORIGINAL access, and a client-side access change can't re-mint it.
  const [liveAccess, setLiveAccess] = useState(project.access)
  /**
   * What happens after the access dialog saves — Fix wave 6 (codex round 6).
   *
   * Updating the badge is not enough, because the thing under review is an
   * `<iframe>` whose `src` and `sandbox` were resolved ONCE, server-side, from
   * the access this page was rendered under. So the frame keeps running on the
   * old policy after a save: a project just made private goes on serving its
   * prototype through the capability minted while it was public-link, and a
   * project just made public-link goes on being framed under the isolation
   * rules of a private one. The rail said one thing and the page did another,
   * with nothing to tell the person which was true.
   *
   * A full reload is the whole fix, and deliberately the blunt one: only the
   * SERVER can re-mint the capability for the new policy, so anything smaller
   * would be a client-side guess at a server-side decision. The dialog only
   * enables Save when the pick differs from the saved value, so this fires
   * once per real transition; the equality check is a guard against a future
   * caller that reports a no-op save.
   */
  const handleAccessChange = useCallback(
    (next: ProjectAccessValue) => {
      setLiveAccess(next)
      if (next === liveAccess) return
      window.location.reload()
    },
    [liveAccess],
  )

  // "Effectively public" — the dismissable banner between the path and the
  // tabs fires here (redesign), on the viewer-membership data model: a
  // `public-link` project is only genuinely reachable with no sign-in while
  // the instance-wide kill switch is on. Derived from the LIVE access so it
  // tracks a mid-session access change, exactly like the badge above.
  //
  // Shown only to an ADMIN, and that is the whole point of the banner rather
  // than a caveat on it.
  //
  // An anonymous visitor reached this page without signing in, so "no sign-in
  // is needed to view this" is not news to them; it is a description of what
  // they just did.
  //
  // And it is admin rather than merely signed-in because of where the banner's
  // one action goes. "Set up authentication" links to `?section=github`, which
  // lives in `SettingsNav`'s ADMIN_SECTIONS and does not exist for an editor or
  // a viewer. Gating on `currentUser !== null` fixed the anonymous dead end and
  // left the identical one for every non-admin member. Found by a codex review
  // of that first fix.
  //
  // It also stops the banner being a dead end. Its one action is "Set up
  // authentication", which goes to Settings, which an anonymous visitor
  // cannot open. Telling the wrong person about a misconfiguration and then
  // handing them a link they cannot follow is the same shape as the disabled
  // project card fixed earlier today (F-28).
  //
  // MEASURED on the public demo at demo.desde.design, which is deliberately
  // open with no sign-in configured at all: every visitor's first sight of
  // the product was a warning that its intended configuration was a mistake.
  const effectivelyPublic =
    liveAccess === "public-link" &&
    project.publicLinksEnabled &&
    !currentUserLoading &&
    canAdministerInstance(currentUser?.role)
  /**
   * The active deployment's root-absolute-asset warning, when the project's
   * CURRENT access + serve mode make it worth saying — the same gate the
   * Deployments tab used while the banner lived there. It moved up here
   * (Mo, 2026-08-30: its own section between the rail header and the tabs)
   * because "may not load fully" is about the prototype the reviewer is
   * looking at, not about the deployment history one tab happens to list.
   */
  const recordedRootAbsolute =
    projectDetail?.activeDeployment?.warnings?.find((w) => w.kind === "root-absolute-assets") ?? null
  const rootAbsoluteWarning =
    recordedRootAbsolute !== null &&
    shouldShowRootAbsoluteWarning({
      access: liveAccess,
      publicLinksEnabled: project.publicLinksEnabled,
      serveDomain: project.serveDomain,
    })
      ? recordedRootAbsolute
      : null
  // A reply typed before the reviewer had a saved identity — held here so
  // the identity form can gate the SEND rather than losing the draft (see
  // `handleReply` below). Cleared once the deferred reply flushes or the
  // popup closes.
  const [pendingReplyBody, setPendingReplyBody] = useState<string | null>(null)
  // The iframe's own `getBoundingClientRect()` offset from the outer
  // window — read from a ref in an effect (never during render, `react-
  // hooks/refs` forbids that) and re-derived on resize/scroll so
  // `popupStyle` below can translate the bridge's iframe-local pin/draft
  // coordinates into shell-viewport coordinates.
  const [iframeOffset, setIframeOffset] = useState({ x: 0, y: 0 })
  /**
   * Where the selected rail row is, in WINDOW coordinates.
   *
   * The popup used to anchor ONLY to rects the bridge sent — a clicked pin or
   * a fresh draft, both IFRAME-relative. Selecting a comment from the rail
   * sent neither, so `popupAnchorRect` stayed null and the thread rendered at
   * `top: -9999` with `opacity: 0`: in the DOM, invisible on screen. Every
   * `readyWhen` in the gallery matched it happily, which is why nothing
   * caught it until someone looked.
   *
   * Measured in a LAYOUT EFFECT rather than captured from the click. The
   * first attempt read `event.currentTarget.getBoundingClientRect()` in the
   * handler and put the popup at x=8 — the rect a click hands back is taken
   * mid-interaction, before the rail has settled. Measuring after layout, off
   * the row that is actually selected, is both correct and self-correcting on
   * re-render.
   */
  const [rowAnchorRect, setRowAnchorRect] = useState<DOMRectJSON | null>(null)

  // Identity resolution: `resolveAuthor` prefers the signed-in user (Phase
  // 3) over the self-declared, localStorage-backed identity (Phase 2) —
  // localStorage doesn't exist during SSR and `currentUser` only settles
  // after `useCurrentUser`'s mount-time fetch, so both sources hydrate in an
  // effect (server render and first client render agree: both start
  // `null`), re-running whenever the signed-in user resolves. Once signed
  // in, `identity` is never null again, which is what suppresses
  // `IdentityFormCard` below without any extra gating.
  useEffect(() => {
    setIdentity(resolveAuthor(currentUser))
  }, [currentUser])

  useEffect(() => {
    const unsubscribe = store.subscribe(
      (list) => {
        setComments(list)
        setLoadError(null)
        setHasLoadedOnce(true)
      },
      (err) => setLoadError(failureMessage(err)),
    )
    return unsubscribe
  }, [store])

  const visibleComments = useMemo(
    () => (showResolved ? comments : comments.filter((c) => !c.resolved)),
    [comments, showResolved],
  )

  const [commentQuery, setCommentQuery] = useState("")

  /*
    The rail's filter. It narrows THE LIST ONLY — `visibleComments` is what
    gets pushed to the bridge, and this derives from it rather than replacing
    it, so the pins in the prototype do not move while someone types.

    That is deliberate and it differs from "Show resolved", which does reach
    the bridge. A view setting the user parked is a statement about what the
    page should show; a search is a way to FIND something, and having the
    prototype's pins vanish and reappear per keystroke loses the spatial map
    you are searching against. It would also mean a postMessage round trip on
    every character.

    Fields searched are the four a reader can see on a row: the comment body,
    the bodies of its replies, the path, and the display names of everyone who
    wrote in the thread. Deliberately NOT the author email — it is not
    rendered on the row, and a hit the reader cannot account for reads as a
    bug rather than a feature.
  */
  const filteredComments = useMemo(() => {
    const q = commentQuery.trim().toLowerCase()
    if (!q) return visibleComments
    return visibleComments.filter((c) =>
      [
        c.body,
        c.position.page,
        c.author.displayName,
        ...c.replies.map((r) => r.body),
        ...c.replies.map((r) => r.author.displayName),
      ].some((field) => field?.toLowerCase().includes(q)),
    )
  }, [visibleComments, commentQuery])

  // Push the current comment list into the bridge whenever it's ready
  // (including re-handshakes after an iframe reload) or the visible set
  // changes (new comment, resolve toggle, show-resolved filter).
  useEffect(() => {
    if (bridgeReadyEpoch > 0) syncComments(visibleComments)
  }, [bridgeReadyEpoch, visibleComments, syncComments])

  // Same "resync on ready OR change" pattern as comments above, for the
  // other two pieces of bridge-side state the header exposes. Without this,
  // a re-handshake (iframe reload/navigation inside the prototype) boots the
  // bridge back at ITS defaults — pins-for-resolved-comments hidden,
  // crosshair off — while the header buttons keep rendering whatever was
  // active before the reload, silently desyncing shell and bridge.
  useEffect(() => {
    if (bridgeReadyEpoch > 0) bridgeSetShowResolved(showResolved)
  }, [bridgeReadyEpoch, showResolved, bridgeSetShowResolved])

  useEffect(() => {
    if (bridgeReadyEpoch > 0) bridgeSetPinsHidden(pinsHidden)
  }, [bridgeReadyEpoch, pinsHidden, bridgeSetPinsHidden])

  useEffect(() => {
    if (bridgeReadyEpoch === 0) return
    if (commentMode) enterCommentMode()
    else exitCommentMode()
  }, [bridgeReadyEpoch, commentMode, enterCommentMode, exitCommentMode])

  /**
   * Comments this shell asked the bridge to highlight, awaiting their echo.
   *
   * Selecting a rail row posts `HIGHLIGHT_COMMENT`, and the bridge answers
   * with a `COMMENT_PIN_CLICKED` carrying the pin's rect — after a 350ms
   * settle for its smooth scroll (`comment-pins.ts`, `highlightComment`). The
   * shell cannot tell that echo from a real click on a pin by its payload:
   * they are the same message.
   *
   * Left unfiltered it produced a visible jump (Mo, 2026-09-01: "the comment
   * appears next to the rail and then moves to the right position"). The
   * popup anchored to the rail row immediately, then a third of a second
   * later the echo's `pinRect` won the precedence below and moved it to the
   * pin. Two anchors for one selection, applied in sequence.
   *
   * So the origin decides the anchor, once: a selection made in the rail
   * stays anchored to its row, and a selection made on a pin anchors to the
   * pin. A ref rather than state because nothing renders from it, and a SET
   * rather than one id because two rail clicks in quick succession have two
   * echoes in flight and the second must not consume the first's.
   */
  const awaitingHighlightEcho = useRef<Set<string>>(new Set())

  // A pin click closes any in-progress new-comment draft and opens that
  // comment's thread card.
  //
  // `useLayoutEffect`, not `useEffect`: it has to consume the echo BEFORE the
  // browser paints, or the frame that set `pinClick` is the frame that shows
  // the popup in the wrong place — which is the whole defect.
  useLayoutEffect(() => {
    if (!pinClick) return
    if (awaitingHighlightEcho.current.delete(pinClick.commentId)) {
      // Our own highlight coming back. The row is already selected and
      // already anchored; drop the rect so it cannot re-anchor.
      clearPinClick()
      return
    }
    clearDraft()
    setActiveCommentId(pinClick.commentId)
  }, [pinClick, clearDraft, clearPinClick])

  // A new-comment placement closes any open thread card.
  useEffect(() => {
    if (draft) {
      clearPinClick()
      setActiveCommentId(null)
    }
  }, [draft, clearPinClick])

  const closePopup = useCallback(() => {
    clearPinClick()
    clearDraft()
    setActiveCommentId(null)
    setPendingReplyBody(null)
  }, [clearPinClick, clearDraft])

  // Bridge sync for both of these now lives entirely in the resync effects
  // above (same "ready OR changed" pattern the comment list uses) — that's
  // what makes a re-handshake after an iframe reload re-establish them
  // instead of leaving the bridge silently at its defaults.
  const toggleCommentMode = useCallback(() => {
    setCommentMode((prev) => !prev)
  }, [])

  const toggleShowResolved = useCallback(() => {
    setShowResolvedState((prev) => !prev)
  }, [])

  /**
   * Which rail tab is showing. The tab is not only a view — it also owns the
   * bridge TOOL that belongs to it, which is why this goes through a handler
   * rather than straight into `setActiveTab`.
   *
   * The rule, taken from the original Desde: leaving a tab puts its tool
   * away, and entering the Dev tab arms the inspector. Comment mode is the
   * deliberate exception — entering the Comments tab does NOT arm
   * click-to-place, because a reviewer opens that tab to READ comments far
   * more often than to leave one, and an armed crosshair over the whole
   * prototype makes ordinary clicking impossible. It is armed by the panel's
   * own "Add comment" button instead.
   */
  const [activeTab, setActiveTab] = useState<RailTab>("comments")

  const handleTabChange = useCallback(
    (next: string) => {
      const tab = next as RailTab
      if (activeTab === "comments" && tab !== "comments") setCommentMode(false)
      if (activeTab === "inspect" && tab !== "inspect") deactivateInspector()
      if (tab === "inspect") activateInspector()
      setActiveTab(tab)
    },
    [activeTab, activateInspector, deactivateInspector],
  )

  /**
   * Collapsing hands the whole window to the prototype — the reviewer's actual
   * subject — and leaves one small control to bring the rail back. The
   * original Desde had this and the rebuild had dropped it.
   *
   * NOT persisted. A rail that is still hidden on the next visit is a screen
   * with a missing panel and no explanation; the cost of re-collapsing is one
   * click.
   */
  const [railCollapsed, setRailCollapsed] = useState(false)

  /**
   * Collapsing puts the INSPECTOR away but leaves comment mode alone, and the
   * asymmetry is deliberate. It is the same question the bridge protocol asks
   * about surfacing failures: does the user's work survive?
   *
   * - The inspector's entire output is the Dev panel. Armed with the panel
   *   hidden, every click produces a result nobody can see — work that does
   *   not survive. So it is disarmed, and re-armed on expand if Dev is still
   *   the open tab.
   * - A comment placed while collapsed leaves a pin in the iframe and opens
   *   its composer as a popup OVER the iframe. All of that is still visible.
   *   Nothing is lost, so nothing is taken away.
   */
  const setRailCollapsedAndTools = useCallback(
    (collapsed: boolean) => {
      setRailCollapsed(collapsed)
      if (activeTab !== "inspect") return
      if (collapsed) deactivateInspector()
      else activateInspector()
    },
    [activeTab, activateInspector, deactivateInspector],
  )

  const handleRowClick = useCallback(
    (id: string) => {
      clearDraft()
      setActiveCommentId(id)
      setPendingReplyBody(null)
      // Record it BEFORE asking, so the echo cannot arrive first. It cannot
      // today (the bridge waits 350ms), but a shell that depends on the
      // network being slow is a shell with a race in it.
      awaitingHighlightEcho.current.add(id)
      highlightComment(id)
    },
    [clearDraft, highlightComment],
  )

  const activeComment = comments.find((c) => c.id === activeCommentId) ?? null

  useLayoutEffect(() => {
    if (!activeCommentId) {
      setRowAnchorRect(null)
      return
    }
    const measure = () => {
      const row = document.querySelector<HTMLElement>(
        `[data-testid="comment-row-${activeCommentId}"]`,
      )
      const next = row ? row.getBoundingClientRect() : null
      // Only commit a rect that actually moved. This runs on every scroll
      // frame while a thread is open, and a fresh object each time would
      // re-render the whole shell for a popup that has not moved.
      setRowAnchorRect((prev) => {
        if (!next) return prev === null ? prev : null
        if (
          prev &&
          prev.top === next.top &&
          prev.left === next.left &&
          prev.width === next.width &&
          prev.height === next.height
        ) {
          return prev
        }
        return next
      })
    }
    measure()
    // The row moves under its own popup when the rail LIST scrolls, which the
    // original one-shot measurement never noticed. `true` for capture, so a
    // scroll inside the rail's own overflow container is seen: it does not
    // bubble to `window`.
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    return () => {
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
    }
  }, [activeCommentId, comments])

  // Hoisted (rather than defined inline inside the JSX ternaries below) so
  // `activeComment`/`identity`/`draft` are guarded with an explicit early
  // return in the SAME function body that reads them, instead of relying on
  // narrowing to survive into a closure nested inside a conditional JSX
  // branch.
  const handleReply = useCallback(
    async (encodedBody: string): Promise<{ ok: boolean }> => {
      if (!activeComment) return { ok: false }
      if (!identity) {
        // No saved identity yet — hold the typed reply and swap the popup
        // to the identity form (see the render branch below) instead of
        // silently dropping the send. The flush effect submits it once
        // `identity` lands. `ok: true` here is deliberate: AnnotationCard
        // clears its own local draft on success, which is correct since
        // we're about to unmount it in favor of the identity form (the
        // body now lives in `pendingReplyBody`, not lost).
        setPendingReplyBody(encodedBody)
        return { ok: true }
      }
      try {
        await store.addReply(activeComment.id, {
          body: encodedBody,
          author: identity,
          mentions: extractMentionIds(encodedBody),
        })
        return { ok: true }
      } catch {
        return { ok: false }
      }
    },
    [activeComment, identity, store],
  )

  // Flushes a reply that was typed before the reviewer had a saved
  // identity, once `handleSaveIdentity` (below) provides one.
  useEffect(() => {
    if (!identity || pendingReplyBody === null || !activeComment) return
    const body = pendingReplyBody
    setPendingReplyBody(null)
    void store.addReply(activeComment.id, { body, author: identity, mentions: extractMentionIds(body) })
  }, [identity, pendingReplyBody, activeComment, store])

  const handleResolve = useCallback(() => {
    if (!activeComment) return
    void store.update(activeComment.id, { resolved: !activeComment.resolved })
  }, [activeComment, store])

  const handleDeleteComment = useCallback(() => {
    if (!activeComment) return
    void store.delete(activeComment.id)
    closePopup()
  }, [activeComment, store, closePopup])

  const handleCreateComment = useCallback(
    async (body: string, mentions: string[]) => {
      if (!draft || !identity) return
      await store.create({
        position: {
          anchorSelector: draft.anchorSelector,
          page: draft.page,
          anchorX: draft.anchorX,
          anchorY: draft.anchorY,
        },
        body,
        author: identity,
        mentions,
      })
      closePopup()
      setCommentMode(false)
      exitCommentMode()
    },
    [draft, identity, store, closePopup, exitCommentMode],
  )

  const handleSaveIdentity = useCallback(
    (input: { displayName: string; email?: string }) => {
      setIdentity(saveReviewerIdentity(input))
    },
    [],
  )

  /**
   * What the thread popup hangs off, and WHICH coordinate space that rect is
   * in. The two differ and cannot be mixed: the bridge measures inside the
   * iframe's document, so its rects need `iframeOffset` added; a rail row is
   * measured in this window and must not be offset at all.
   */
  const popupAnchor = pinClick?.pinRect
    ? { rect: pinClick.pinRect, inIframe: true }
    : draft?.elementRect
      ? { rect: draft.elementRect, inIframe: true }
      : rowAnchorRect
        ? { rect: rowAnchorRect, inIframe: false }
        : null
  const popupAnchorRect = popupAnchor?.rect ?? null

  // `pinRect`/`elementRect` come from the bridge's own `getBoundingClientRect()`
  // call INSIDE the iframe's document — i.e. iframe-viewport-relative, not
  // outer-window-relative. Reading the iframe's own rect has to happen in an
  // effect (never during render — `react-hooks/refs`), and is re-derived on
  // resize/scroll since the iframe's offset from the outer window isn't
  // guaranteed constant.
  useLayoutEffect(() => {
    if (!popupAnchorRect) return
    const recompute = () => {
      const rect = iframeRef.current?.getBoundingClientRect()
      setIframeOffset({ x: rect?.left ?? 0, y: rect?.top ?? 0 })
    }
    recompute()
    window.addEventListener("resize", recompute)
    window.addEventListener("scroll", recompute, true)
    return () => {
      window.removeEventListener("resize", recompute)
      window.removeEventListener("scroll", recompute, true)
    }
  }, [popupAnchorRect])

  const popupStyle = useMemo<CSSProperties>(() => {
    if (!popupAnchorRect) {
      return { position: "fixed", top: -9999, left: -9999, opacity: 0, pointerEvents: "none" }
    }
    // Zero for a rail row: it was measured in this window already.
    const offset = popupAnchor?.inIframe ? iframeOffset : { x: 0, y: 0 }
    const anchorLeft = popupAnchorRect.left + offset.x
    const anchorRight = popupAnchorRect.right + offset.x
    const anchorTop = popupAnchorRect.top + offset.y
    const anchorBottom = popupAnchorRect.bottom + offset.y

    const vw = window.innerWidth
    const vh = window.innerHeight
    // A rail row is anchored BESIDE, not over. The generic rule below would
    // place the popup at `anchorRight - POPUP_WIDTH`, which for a full-width
    // row lands exactly on the rail and covers the list the reader just
    // clicked in. Sitting it to the left puts it over the prototype, where
    // there is room, and leaves the thread visible next to its own row.
    const left = popupAnchor?.inIframe
      ? anchorLeft < vw / 2
        ? Math.max(8, anchorLeft)
        : Math.max(8, anchorRight - POPUP_WIDTH)
      : Math.max(8, anchorLeft - POPUP_WIDTH - 8)
    const style: CSSProperties = { position: "fixed", left }
    if (anchorTop < vh / 2) {
      style.top = Math.max(8, anchorTop)
    } else {
      style.bottom = Math.max(8, vh - anchorBottom)
    }
    return style
  }, [popupAnchorRect, popupAnchor?.inIframe, iframeOffset])

  const isPopupVisible = !!activeComment || !!draft

  return (
    /*
     * NO page header. The prototype fills the window from y=0, and everything
     * that would have sat in a top bar lives in the rail's own header block
     * below. That is the original Desde' layout, restored 2026-08-19:
     * the rebuild had grown a 40px `<header>` with the project name, Members,
     * Repo, the account menu and the comment toggle in it, which pushed the
     * thing under review down the page and split the controls across two
     * chromes. One chrome, on the right.
     */
    <div className="flex h-screen">
      <div className="relative flex-1 overflow-hidden">
        {/*
          `src` and `sandbox` are spread from ONE resolver rather than
          written out here, so the two can never disagree. Fallback mode's
          sandbox omits `allow-same-origin` on purpose: that is what stops
          a hostile prototype reaching `window.parent` and calling the
          viewer API as the reviewer (security audit finding B1), and it
          costs the session cookie on every subresource, so it applies only
          to prototypes whose assets load without one — either because
          nothing gates them, or because `project.capability` authorizes
          them instead.

          In loopback and subdomain mode the frame is on a REAL origin of
          its own, so it keeps a sandbox but gains `allow-same-origin`: on a
          cross-origin frame that token restores only the frame's own
          origin and grants nothing toward the parent. The equal-origin
          check inside the resolver is what makes that safe, and it runs
          before any mode can reach that branch. Read
          `../../prototype-origin.ts` before changing any of it.
        */}
        <iframe
          ref={iframeRef}
          {...iframeProps}
          className="h-full w-full border-0"
          onLoad={() => setPrototypeLoaded(true)}
        />

        {/* Over the iframe, not in place of it: the frame has to be in the DOM
            and loading for this to ever go away. `bg-background` rather than a
            scrim — there is nothing underneath worth showing through yet. */}
        {prototypeVisible ? null : (
          /* Wrapped for a `data-testid` of its own. There are TWO loaders on
             this screen, this one and the comment rail's, and `ProjectLoader`
             hardcodes a single shared testid, so a test asking for "the
             loader" got both and could not say which had cleared. */
          <div data-testid="prototype-loader" className="absolute inset-0 z-10 bg-background">
            <ProjectLoader label="Loading" className="h-full" />
          </div>
        )}

        {/*
          The way back. It sits over the prototype because the rail it
          restores is gone — there is nowhere else for it to be.

          A bare glyph, and a bigger one (Mo, 2026-08-29: "make the icon
          bigger and remove the panel text"). It carried the word "Panel"
          from 2026-08-19 on the argument that collapsing takes away every
          control at once, so an unlabelled icon in the corner of someone
          else's page is easy to miss. The glyph grows to carry that on its
          own: a 28px `icon` button carrying a 16px glyph, against the 10px
          one the labelled `xs` pill had, so the shape reads at a glance
          rather than as a speck in a circle.

          The size goes ON THE SVG, not on the button as `[&_svg]:size-4`.
          Every `Button` size variant sets its icon with
          `[&_svg:not([class*='size-'])]:size-N`, and that `:not()` is the
          primitive's own override seam: a class on the button loses to it,
          while a `size-*` on the glyph opts out of it entirely. MEASURED
          before the fix: the icon stayed 12px.

          `aria-label` and `title` still say "Open panel", so the name
          survives for assistive tech and for a hover — what is gone is the
          word taking up room over someone else's page.

          Filled, bordered and shadowed because it floats over prototype
          content this shell knows nothing about. A ghost button would
          disappear over a dark hero.
        */}
        {railCollapsed ? (
          <Button
            variant="outline"
            size="icon"
            aria-label="Open panel"
            title="Open panel"
            onClick={() => setRailCollapsedAndTools(false)}
            data-testid="expand-rail"
            className="absolute top-3 right-3 z-40 rounded-full bg-background shadow-md"
          >
            <Minimize2 className="size-4" />
          </Button>
        ) : null}
      </div>

      {/*
        `w-80` (320px), matching the original. The rebuild's `w-64` was 64px
        narrower, which is the difference between a style row reading
        `padding-inline-start: 12px` and reading `padding-inline-…`.
      */}
      {railCollapsed ? null : (
      /*
        Two cards floating on the page's own ground (Mo, 2026-08-28),
        replacing one flat panel divided by rules.

        The cards take `bg-background`, the warm paper, NOT `bg-card`. Those
        two differ by about 1% lightness in every theme (teal: 0.986 against
        0.996) and the difference is entirely that `--card` is the whiter of
        the pair, so `bg-card` here read as white panels on a warm page. Mo
        wanted them the warm colour, which is `--background`.

        That makes the cards the same tone as what is behind them, and their
        border and shadow are what define them — which is why this container
        carries no BACKGROUND of its own: a `bg-background` container in front
        of a `bg-background` body was painting the same colour twice.

        It does carry a `border-l` again (Mo, 2026-09-01: "let's add back in
        the light left border in the panel / rail. It looks a little off with
        it just ending"). It was dropped on 2026-08-28 on the argument that
        the cards' own left edges were now the rail's edge. On screen they are
        not: the cards are inset by `p-2`, so the rail ended in whatever the
        prototype had painted, at no particular line.

        `border-border/60`, not the full-strength `border-border` the cards
        wear. It is the same value the Editor's rail uses, so the two surfaces
        state their edge identically, and it is deliberately lighter than the
        cards it contains — a container rule that competed with its own
        contents would read as a third card.

        Note this sits between the shell and the PROTOTYPE's colour (see the
        `style` below), so it is the one border on this screen whose ground is
        not ours.

        `p-2` + `gap-2` is what the rules used to do. The header block and the
        panel were told apart by a `border-b`; now they are told apart by
        being separate objects, so the borders inside them come out.
      */
      <aside
        className="flex h-full w-80 flex-none flex-col gap-2 border-l border-border/60 p-2"
        /*
          The prototype's own page colour, so the iframe's edge stops being a
          seam (Mo, 2026-08-28). Inline because it is a genuinely dynamic
          value read off another document at runtime, which is the one case
          `style` is for.

          `undefined` — not a colour — when the bridge has not reported one,
          so the rail falls back to the `bg-background` it inherits rather
          than to a guess. That covers an older bridge bundle, a prototype
          still booting, and a substrate the resolver could not read.

          Only the RAIL takes it. The cards keep `bg-background` deliberately:
          they are the shell's own surface and their legibility cannot depend
          on somebody else's stylesheet. Nothing but the cards and the
          dismissable banner sits on this ground, and both bring their own
          background, so no text is ever left reading against an unknown
          colour.
        */
        style={pageBackground ? { background: pageBackground } : undefined}
      >
        {/* Card one: where you are, and what you can do about it. */}
        <section className="flex flex-none flex-col rounded-lg border border-border bg-background shadow-xs">
        {/*
          ONE header row (Mo, 2026-08-19). It used to be three — a wordmark
          line, a project line, and a warning line — which is two levels of
          chrome to reach four controls, over a rail 320px wide.

          The wordmark is gone with them. A breadcrumb says the same thing and
          more: it names where you are AND gives you the way out, in the space
          the logo took. Modelled on the Editor's `EditorBreadcrumb`.

          NO background of its own. This row and the page path below carried a
          `bg-muted/40`, which made the rail two-tone: a tinted header block
          over a `bg-background` list (Mo, 2026-08-20). The Editor's rail has
          no background class at all — it inherits the page's — so one tone is
          what matches it. The border under the path row is what separates the
          header from the tabs; it does not need a fill as well.
        */}
        {/* No border under this row: it and the page path below are ONE header
            block, and a rule between them cut it in half. The block's own
            bottom border lives on the path row. */}
        <div className="flex flex-none items-center gap-0.5 px-2 pt-1.5 pb-0">
          <Breadcrumb className="min-w-0 flex-1">
            {/* `text-inherit` because the primitive's list hard-codes
                `text-muted-foreground`, a step lighter again than this row's
                tone. `flex-nowrap` so a long project name truncates instead
                of wrapping the home icon onto a second line — which would
                re-create the two-row header this replaced. */}
            <BreadcrumbList className="flex-nowrap gap-0 text-inherit sm:gap-0">
              <BreadcrumbItem>
                <Button
                  asChild
                  variant="ghost"
                  size="icon-sm"
                  aria-label="All projects"
                  title="All projects"
                  data-testid="rail-home"
                >
                  <Link href="/">
                    <Home />
                  </Link>
                </Button>
              </BreadcrumbItem>
              {/* The primitive's stock chevron — same shape the Editor's
                  breadcrumb uses. */}
              <BreadcrumbSeparator />
              <BreadcrumbItem className="min-w-0">
                <span className="truncate text-xs font-medium" title={project.name}>
                  {project.name}
                </span>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>

          {/* Order, left to right: hide comments, settings, profile, collapse
              (Mo, 2026-08-20). It runs from the most local to the most
              global — a thing you toggle while reading, then the project's
              settings, then your account, then the window itself. */}
          {/* Pin visibility, carried over from the original Desde rail.
              It hides the PINS, not the comments — the list is right there
              underneath, and taking that away would be a different feature.

              The icon shows what the CLICK DOES, not what is currently true
              (Mo, 2026-08-20): a crossed-out pin means "hide these", so it is
              what you see while they are showing. Both conventions are
              defensible and a toggle can only pick one; this is the one a
              reader tests by pressing it. The accessible name and the tooltip
              say it in words either way, which is what stops a crossed-out
              pin reading as "delete". */}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={pinsHidden ? "Show comment pins" : "Hide comment pins"}
            title={pinsHidden ? "Show comment pins" : "Hide comment pins"}
            aria-pressed={pinsHidden}
            onClick={() => setPinsHidden((prev) => !prev)}
            data-testid="toggle-pins"
          >
            {pinsHidden ? <MapPin /> : <MapPinOff />}
          </Button>
          {/* ONE control for the project's settings and the person's, not
              two (Mo, 2026-08-25). The gear that used to sit here is folded
              into this menu as a labelled "Project" section. */}
          <AccountMenu
            projectActions={{
              onOpenAccess: () => setAccessOpen(true),
              onOpenRepo: () => setRepoOpen(true),
            }}
          />
          {/* `Maximize2`, matching the Editor's expand/collapse vocabulary
              (`border-section.tsx`). It names the RESULT rather than the
              mechanism: collapsing the rail is how you give the prototype the
              whole window. The pill that brings it back is its `Minimize2`
              twin. */}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Collapse panel"
            title="Collapse panel"
            onClick={() => setRailCollapsedAndTools(true)}
            data-testid="collapse-rail"
          >
            <Maximize2 />
          </Button>
        </div>

        {/*
          The page under the breadcrumb (Mo, 2026-08-19). It answers "what am
          I actually looking at" on every tab, which is why it sits in the
          header rather than in a panel — it is context, not a topic.

          It prefers the SOURCE FILE, because that is the thing that can be
          linked to GitHub, and falls back to the route when the substrate
          ships no source stamp. Both come from the bridge's ROUTE_CHANGED.
          A prototype that never navigates never sends one, so an empty line
          here is ordinary rather than a failure — hence a quiet placeholder
          rather than an error.
        */}
        <div className="flex flex-none items-center px-3 pb-1.5">
          {page?.sourceFile && projectRepo ? (
            /* Foreground, not `text-primary`, and no external-link glyph
               (Mo, 2026-08-20). This line's first job is to say WHERE YOU
               ARE; that it also opens the file on GitHub is a bonus, and
               dressing it as a link made the most contextual thing in the
               header read as the most clickable. The underline on hover is
               what says it is a link, at the moment someone is asking.

               SANS, not mono, and a deliberate exception to the rule that
               file paths are mono (docs/design.md, "Mono is for code"). Here
               the path is the breadcrumb's second line — it says where you
               are, and nobody transcribes it. Mono earns its place when a
               string has to be read character by character, and it costs
               width and evenness when it does not. The comment rows' path
               stays mono because it sits among prose, where the face is what
               separates an identifier from a sentence; this one sits under a
               breadcrumb, where it is the sentence.

               `text-sm`, one step up from the `text-xs` it carried until
               2026-08-28 (Mo). That also makes the claim this comment has
               always made TRUE for the first time: it said the path was the
               same size as the project name above it, and MEASURED it was
               11px under a 12px breadcrumb. At `text-sm` the two lines really
               do match, so they read as one two-line breadcrumb rather than a
               title with a caption under it.

               Weight still differs on purpose (`font-medium` against the
               breadcrumb's 300): the crumb is a link you may follow, the path
               is the thing you are looking at. */
            <a
              href={`${projectRepo.htmlUrl}/blob/${projectRepo.ref}/${page.sourceFile}`}
              target="_blank"
              rel="noreferrer"
              title={page.sourceFile}
              className="min-w-0 truncate text-sm font-medium text-foreground hover:underline"
              data-testid="rail-page-path"
            >
              {page.sourceFile}
            </a>
          ) : page?.sourceFile ? (
            /* Known, but not linkable — the caller was not shown a repo
               config, so there is no URL to build. The path is still worth
               saying. */
            <span
              className="min-w-0 truncate text-sm font-medium text-foreground"
              title={page.sourceFile}
              data-testid="rail-page-path"
            >
              {page.sourceFile}
            </span>
          ) : (
            <span
              className="min-w-0 truncate text-sm font-medium text-muted-foreground"
              data-testid="rail-page-path"
            >
              {page?.url ?? "—"}
            </span>
          )}
          </div>
        </section>

        {/*
          `gap-0` overrides the primitive's own `gap-2`, which sat between the
          tab strip and whichever panel is open.

          It is why the Add comment button had 20px above it and 12px below,
          from a row whose padding is a symmetric 12/12 — the extra 8px was
          this gap, outside the row entirely. Measuring the ROW answers the
          wrong question; the gap a reader sees runs from the rule to the
          button, across both boxes.

          Zero rather than a smaller number: with the rule right there, the
          panel should start at it. Every tab benefits — the inspector and the
          deployments list both carry their own section padding, so the gap was
          only ever adding to it.
        */}
        {/*
          A dismissable banner rather than the "Public" chip this replaced
          (Mo, 2026-08-20). The chip fitted the header row by shrinking a
          sentence to one word and hiding the rest in a `title` — which is the
          shape of a thing nobody reads. This says the whole sentence once,
          where a banner between the header and the panel is unmissable, and
          then gets out of the way when it has been read.

          Between the path and the tabs on purpose: it is about the PROJECT,
          so it belongs above the tab strip with the rest of the project's
          identity, not inside whichever panel happens to be open.
        */}
        {effectivelyPublic && !publicNoticeDismissed ? (
          <Callout
            tone="warning"
            /* Between the cards, so the rail's own `gap-2` spaces it. It
               used to carry `mx-2 mb-2` against a rail with no padding.

               `shadow-xs` to match the cards either side of it (Mo,
               2026-08-28). It sits in the same column, on the same ground, at
               the same width, so a flat banner between two lifted cards read
               as the one element that had been forgotten. */
            className="flex-none shadow-xs"
            onDismiss={() => setPublicNoticeDismissed(true)}
            data-testid="public-notice"
          >
            {/*
              "No authentication", not "No members" (Mo, 2026-08-28). The old
              phrasing described the project's ACCESS LIST, which is an
              internal noun, and left the reader to work out the consequence.
              This states the consequence first: viewing this needs no sign-in.

              The link goes to SETTINGS, at the GitHub section, not to this
              project's access dialog (Mo, 2026-08-28: "move them to the
              correct settings page so that they hopefully understand that
              this isn't a project level setting, but a Viewer level
              setting").

              It pointed at the access dialog first, on the reasoning that a
              deployment can have GitHub sign-in fully configured and still
              have one project deliberately open, so the project's own
              access was the nearer cause. True, but it taught the wrong
              model: leaving someone inside a per-project dialog implies
              authentication is a per-project thing. Sending them to the
              Viewer's own settings is the answer that generalises, and
              `?section=github` means they land on the area rather than on
              Settings' front page having to find it.

              A real `<a>`, because it now goes somewhere: it gets browser
              navigation, middle-click and "open in new tab" for free, and it
              is announced as a link rather than a button that moves you.

              It runs on in the SAME sentence, in the same face and size (Mo,
              2026-08-28: "should not be a different font and just add it the
              copy, it doesn't need a new line"), which an anchor does
              natively where `Button` — `inline-flex`, fixed height, its own
              `text-*`, `whitespace-nowrap` — could not.
            */}
            No authentication. Anyone with the link can view this project.{" "}
            <a
              href="/settings?section=github"
              className="underline underline-offset-2 hover:no-underline"
              data-testid="public-notice-set-up-auth"
            >
              Set up authentication
            </a>
          </Callout>
        ) : null}

        {rootAbsoluteWarning && !rootAbsoluteWarningDismissed ? (
          /* Same flat-banner treatment as the public-link notice above:
             between the header card and the tabs card, `shadow-xs` so it
             does not read as the one forgotten element between two lifted
             cards. */
          <RootAbsoluteWarningCallout
            warning={rootAbsoluteWarning}
            className="flex-none shadow-xs"
            onDismiss={() => setRootAbsoluteWarningDismissed(true)}
          />
        ) : null}

        {/* Card two: the tabs and the panel they control. `overflow-hidden`
            so a scrolling panel is clipped by the rounded corner instead of
            painting over it. */}
        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-lg border border-border bg-background shadow-xs"
        >
          {/*
            The segmented strip, not the underlined one (Mo, 2026-08-28).
            This rail carried `variant="line"` from 2026-08-20 on the argument
            that an underline sitting directly on the pane reads as "this
            pane". The card took that argument away: the strip and the pane
            are now inside one bordered container, so the container is what
            says they belong together, and an underline would be a second rule
            a few pixels inside a real edge.

            It also puts the Viewer back on ONE tab treatment with the Editor
            and with Settings, which is where the product started before the
            rail forked off.

            No `border-b` wrapper any more — that rule was standing in for the
            card edge that now exists — and no active-tab override: the
            segmented variant's own `data-active:bg-background` is the active
            cue, and the `after:` bar it used to colour only renders under
            `variant="line"`.
          */}
          {/* `pb-1` on top of the row below's own `pt-2`, so the gap under
              the tab strip is 12px where every other gap in this card is 8px
              (Mo, 2026-08-28: "give the tabs a little more bottom margin").

              The extra 4px is a grouping signal, not a rhythm break: the
              strip is NAVIGATION between panels, and everything under it
              belongs to the panel it selected. Sitting it at the same 8px as
              the controls made it read as the first row of the panel rather
              than the thing choosing which panel this is. */}
          <div className="flex-none p-2 pb-1">
            <TabsList size="sm" className="w-full">
              <TabsTrigger value="comments" data-testid="rail-tab-comments">
                Comments
              </TabsTrigger>
              <TabsTrigger value="inspect" data-testid="rail-tab-inspect">
                Inspect
              </TabsTrigger>
              <TabsTrigger value="deployments" data-testid="rail-tab-deployments">
                Deployments
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="comments" className="flex min-h-0 flex-1 flex-col">
            {/* The comment tools live in the panel that owns them, not in a
                page header. "Add comment" is what arms click-to-place —
                opening this tab does not, because reading comments is the
                commoner reason to be here and an armed crosshair makes the
                prototype unusable. */}
            {/* `py-2`, matching the 8px the tab strip above and the filter
                below both use. MEASURED before: the three rows disagreed —
                8px from the card edge to the tabs, 12px from the tabs to
                this row, and 16px from this row to the filter (its own 8px
                bottom pad plus the filter's 8px top pad). Mo, 2026-08-28. */}
            <div className="flex flex-none items-center gap-2 px-2 py-2">
              {/*
                A size up from `xs` and outlined (Mo, 2026-08-19 — primary
                first, then outline on a second look). It is the one thing
                this panel exists to let you do, so it keeps the size; it is
                not the one thing on the SCREEN, so it does not keep the fill.

                Tertiary weight at rest, PRIMARY fill while the mode is
                armed (Mo, 2026-08-28). `ghost` IS the tertiary step in this
                system: no fill, no border, hover tint only. There is no
                variant named `tertiary`, and adding one as an alias would put
                two names on one recipe.

                So the button is quiet until it is doing something, and the
                teal appears only while placement is running. Colour and weight
                both carry the state now, where before it was weight alone
                within one colour. That is still the Editor's pattern
                (`comment-mode-button.tsx`): the one active control in a row
                becomes the loudest thing in it, and nothing else has to
                change. `aria-pressed` carries the same state for assistive
                tech.
              */}
              <Button
                variant={commentMode ? "default" : "ghost"}
                size="sm"
                onClick={toggleCommentMode}
                aria-pressed={commentMode}
                title={commentMode ? "Stop placing comments" : "Add a comment"}
                data-testid="comment-mode"
              >
                <MessageCirclePlus data-icon="inline-start" />
                Add comment
              </Button>
              {/* A switch, not a button (Mo, 2026-08-19). It is a persistent
                  view setting rather than an action, and a button that stays
                  filled to mean "on" is the shape people misread as "click me
                  to do it again". */}
              {/* `font-normal` is doing real work here. `body` sets
                  `font-weight: 300` app-wide, so this label inherited 300
                  while the comment metadata beside it is 400 — same colour
                  token, visibly lighter text, which reads as a third shade of
                  grey that nobody chose. Weight, not colour, was the
                  difference (Mo, 2026-08-20). */}
              {/* Just "Resolved" (Mo, 2026-08-28). "Show" was describing the
                  control rather than the thing it controls, which a switch
                  already says. `aria-label` on the Switch keeps the full
                  "Show resolved comments" for anyone who cannot see that the
                  label and the switch are one pair. */}
              <label className="ml-auto flex cursor-pointer items-center gap-2 text-xs font-normal text-muted-foreground">
                Resolved
                <Switch
                  size="sm"
                  checked={showResolved}
                  onCheckedChange={() => toggleShowResolved()}
                  aria-label="Show resolved comments"
                  data-testid="show-resolved"
                />
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
            {/* Every message in this panel is `frame="panel"` — see
                `EmptyState`'s header. A rail that centres one message and
                top-aligns the next reads as two surfaces, and these three
                states replace each other in the SAME space. Loading is a
                message too, so it takes the frame rather than being the one
                line pinned to the top. */}
            {loadError && !hasLoadedOnce ? (
              <LoadFailure
                size="sm"
                frame="panel"
                title="Couldn't load comments"
                description={loadError}
              />
            ) : !hasLoadedOnce ? (
              /*
                 The house wait, not a bare word (Mo, 2026-08-28: "there
                 should be a loading spinner"). It was an `EmptyState` with
                 `illustration={false}`, so the panel showed the text
                 "Loading" and nothing moving, which reads as a rendered
                 result rather than a wait.

                 `ProjectLoader` rather than a new spinner: it is already the
                 product's one loading animation, and this same rail shows it
                 over the iframe a few hundred lines up. A second loading look
                 introduced here would be two answers to one question on one
                 screen.

                 Half its 160 default, and labelled (Mo, 2026-08-28). At 112
                 and wordless the cat was the only thing in a tall empty
                 column, which reads as a picture the panel is showing rather
                 than a wait. The label is what names it, so the animation can
                 be small enough to be an indicator.

                 Just "Loading" (Mo, 2026-08-29). It said "Loading comments"
                 for a day, on the reasoning that the Deployments tab swaps
                 into this same space and shows the same cat. The selected tab
                 is already on screen saying which one it is, so the noun was
                 the surface repeating itself — see docs/design.md, "Don't
                 repeat the noun the surface already carries".
              */
              /* `pb-20` is the same optical-centring lift `EmptyState`'s
                 `frame="panel"` carries (see its header): 80px of bottom pad
                 against no top pad raises the centre by 40px, the same
                 amount. The loading, empty and failure states replace each
                 other in this exact space, so they have to agree, and this
                 one is a `ProjectLoader` rather than an `EmptyState`, so it
                 cannot inherit the frame and has to restate it. */
              <ProjectLoader size={80} label="Loading" className="h-full pb-20" />
            ) : visibleComments.length === 0 ? (
              <EmptyState
                size="sm"
                frame="panel"
                title="No comments"
                description="Click Comment, then click anywhere in the prototype to leave one."
              />
            ) : (
              /*
                Search is the group's FIRST ROW, not a control above it (Mo,
                2026-08-28: "merge search into the comments, so that Search is
                like the first item in the comments"). It shares the group's
                border and divider, and it strips the `Input`'s own border,
                background and radius so it reads as a row rather than a box
                inside a box.

                It wraps the no-matches state as well as the list, and that is
                the load-bearing part. Rendering it only in the list branch
                would take the field off screen the moment a query matched
                nothing — leaving no way to EDIT the query, only the empty
                state's "Clear search" to throw it away.
              */
              /*
                `mt-1` against the action row's own `pb-2` puts 12px above
                this group, the same extra Mo asked for under the tab strip
                ("add an equivalent amount of spacing between the add comment
                row and the search input"). Sides and bottom stay at the
                card's 8px.
              */
              <div className="mx-2 mt-1 mb-2 flex flex-col overflow-hidden rounded-md border border-border">
                <div className="relative border-b border-border">
                  <Search
                    className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    type="search"
                    size="sm"
                    value={commentQuery}
                    onChange={(e) => setCommentQuery(e.target.value)}
                    /* "Search" (Mo, 2026-08-28). The field sits inside the
                       Comments panel, so the noun was repeating its own
                       container. `aria-label` stays specific, because an
                       assistive-tech user reaching this field by tabbing has
                       no such container in earshot. */
                    placeholder="Search"
                    aria-label="Search comments"
                    /*
                      Everything that made this a standalone field comes off,
                      because the group around it now draws the edges.

                      That includes the RING, and it has to (Mo, 2026-08-28:
                      "the highlight on the search is a bit odd, maybe no
                      highlight is needed"). `Input`'s focus ring is a 2px
                      box-shadow drawn OUTSIDE the element, and the group
                      clips it with `overflow-hidden`, so all that escaped was
                      a teal line along the bottom edge — a stray rule rather
                      than a highlight.

                      It is replaced, not deleted. A field with no focus
                      indicator at all fails keyboard users, who have nothing
                      else telling them where they are. A background tint
                      cannot be clipped by the group and reads the way a
                      focused row should, which is also how `ListRow` shows
                      selection in this same rail.
                    */
                    className="rounded-none border-0 bg-transparent pl-8 focus-visible:ring-0 focus-visible:bg-muted/50"
                    data-testid="comment-search"
                  />
                </div>
                {filteredComments.length === 0 ? (
                  /* Distinct from "No comments" above, and it has to be: that
                     one means "leave one", this one means "the query is too
                     narrow". Repeating the how-to-comment instruction here
                     would answer a question nobody asked.

                     No `frame="panel"` any more: inside the group it is a
                     block a few rows tall, not a rail waiting for a
                     selection, and `h-full` centring would stretch the group
                     down the whole panel. */
                  <EmptyState
                    size="sm"
                    title="No matching comments"
                    description={`Nothing here matches "${commentQuery.trim()}".`}
                    data-testid="comment-search-no-matches"
                  >
                    <Button variant="outline" size="sm" onClick={() => setCommentQuery("")}>
                      Clear search
                    </Button>
                  </EmptyState>
                ) : (
                  /*
                    The border, radius and 8px inset moved UP to the group
                    wrapper when search became its first row, so this is a
                    plain column now. The rows stay square (`rounded-none` on
                    `CommentRow`) and the wrapper's `overflow-hidden` is what
                    rounds the last row's bottom corners — the top pair
                    belongs to the search field above.
                  */
                  <ul className="flex flex-col">
                {filteredComments.map((c) => {
                  const replies = c.replies.length
                  return (
                    /* The divider lives on the `<li>`, not on the row inside
                       it. `last:border-b-0` on the row switched EVERY divider
                       off: the row is its `<li>`'s only child, so it is always
                       `:last-child`. The `<li>`s are the actual siblings.

                       `last:border-b-0` DOES work here, where the identical
                       class on the row did not: the `<li>`s are siblings, so
                       exactly one of them is `:last-child`, whereas the row is
                       its own `<li>`'s only child and was always last.

                       The last divider comes off now that the group is
                       bordered all round (Mo, 2026-08-28). It used to be kept
                       deliberately — "a list that just stops reads as if it
                       were cut off" (Mo, 2026-08-19) — and the group's own
                       bottom edge now does that job. Keeping both would draw
                       two lines 1px apart. */
                    <li key={c.id} className="border-b border-border last:border-b-0">
                      <CommentRow
                        comment={c}
                        selected={c.id === activeCommentId}
                        replies={replies}
                        onClick={() => handleRowClick(c.id)}
                      />
                    </li>
                  )
                })}
                  </ul>
                )}
              </div>
            )}
            </div>
          </TabsContent>

          <TabsContent value="inspect" className="min-h-0 flex-1 overflow-y-auto">
            <ViewerInspectorPanel
              inspection={inspection}
              active={activeTab === "inspect"}
              repo={projectRepo}
            />
          </TabsContent>

          <TabsContent value="deployments" className="min-h-0 flex-1 overflow-y-auto">
            <DeploymentsPanel
              projectId={project.id}
              detail={projectDetail}
              error={projectDetailError}
            />
          </TabsContent>
        </Tabs>
      </aside>
      )}

      {isPopupVisible ? (
        <>
          <div className="fixed inset-0 z-40" onClick={closePopup} />
          <div className="z-50" style={popupStyle}>
            {activeComment ? (
              pendingReplyBody !== null && !identity && !currentUserLoading ? (
                <IdentityFormCard onSave={handleSaveIdentity} onClose={closePopup} />
              ) : (
                <AnnotationCard
                  variant="comment"
                  body={activeComment.body}
                  author={activeComment.author}
                  replies={activeComment.replies}
                  resolved={activeComment.resolved}
                  onReply={handleReply}
                  onResolve={handleResolve}
                  onDelete={handleDeleteComment}
                  onClose={closePopup}
                  participants={participants}
                  onInvite={canInvite ? inviteParticipant : undefined}
                />
              )
            ) : draft ? (
              identity ? (
                <NewCommentCard
                  participants={participants}
                  onInvite={canInvite ? inviteParticipant : undefined}
                  onSubmit={handleCreateComment}
                  onClose={closePopup}
                />
              ) : currentUserLoading ? null : (
                <IdentityFormCard onSave={handleSaveIdentity} onClose={closePopup} />
              )
            ) : null}
          </div>
        </>
      ) : null}

      <Dialog open={accessOpen} onOpenChange={setAccessOpen}>
        {/* `size="xl"` — the decision-dialog width (radio cards), not
            `size="lg"`: this dialog picks one of three mutually exclusive
            options, the same shape as every other decision dialog in the
            product. */}
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>Access: {project.name}</DialogTitle>
          </DialogHeader>
          <ProjectAccess
            projectId={project.id}
            access={liveAccess}
            publicLinksEnabled={project.publicLinksEnabled}
            canManage={canManageAccess}
            currentUserLoading={currentUserLoading}
            open={accessOpen}
            onAccessChange={handleAccessChange}
            onClose={() => setAccessOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={repoOpen} onOpenChange={(next) => (next ? setRepoOpen(true) : closeRepoDialog())}>
        <DialogContent size="lg">
          {repoGithubAccess ? (
            <>
              <DialogHeader>
                <DialogTitle>Set up GitHub access</DialogTitle>
                <DialogDescription>{GITHUB_APP_SETUP_INTRO}</DialogDescription>
              </DialogHeader>
              <GithubAccessSetupStep
                onBack={() => setRepoGithubAccess(false)}
                onClose={() => closeRepoDialog()}
                returnTo={`/review/${project.slug}?repo=1`}
              />
            </>
          ) : (
            <>
              <DialogHeader>
                {/* "Repository settings", not "Repo: {name}" (Mo, 2026-08-29):
                    the reader is already inside this project, and the colon
                    form read as if a repo were named after it. */}
                <DialogTitle>Repository settings</DialogTitle>
              </DialogHeader>
              <ProjectRepoPanel
                projectId={project.id}
                onClose={() => closeRepoDialog()}
                /* Come back with this dialog open, not to a bare review screen. */
                returnPath={`/review/${project.slug}?repo=1`}
                onSetUpGithub={() => setRepoGithubAccess(true)}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * One comment in the rail, built to the original Desde' recipe
 * (`components/comments/comment-panel.tsx`): who said it and when on the top
 * line, two lines of the comment itself, and its page and state underneath.
 *
 * It replaced a dense one-liner that showed a sequence NUMBER and the first
 * line of the body. The number is gone because it was the only thing on the
 * row nobody was looking for — comments are identified by what they say and
 * who said it, and the number is an implementation detail of the store. The
 * author is the thing a reviewer actually scans for and it was missing
 * entirely (Mo, 2026-08-19).
 *
 * A `Button` rather than the `ListRow` block: `ListRow` is a dense
 * single-line recipe, and this is three lines with its own internal
 * alignment. `h-auto` + `items-stretch` + `whitespace-normal` is what lets a
 * Button hold a block like this and stay keyboard- and disabled-aware.
 *
 * ## The hierarchy, which was upside down until 2026-08-19
 *
 * The comment itself was `text-xs text-muted-foreground` — the same size AND
 * the same colour as the author, the timestamp and the page beside it. The one
 * thing on the row a person came to read was tied for last with the labels
 * describing it. (The original had the same inversion in colour; it only got
 * away with it because its body was a size larger.)
 *
 * So the body is the only `text-foreground` on the row, and the only
 * `text-sm`. Everything else is `text-xs text-muted-foreground`, and the
 * author is told apart from the rest of the metadata by WEIGHT rather than by
 * contrast — the same trick the wordmark and the page title use to differ
 * without either getting louder.
 *
 * Dividers are drawn by the `<li>` wrapping this, because THAT is what has
 * siblings — see the note at the call site. Every row gets one, the last
 * included, so the list visibly ends rather than just stopping.
 */
function CommentRow({
  comment,
  selected,
  replies,
  onClick,
}: {
  comment: Comment
  selected: boolean
  replies: number
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      aria-current={selected ? "true" : undefined}
      data-testid={`comment-row-${comment.id}`}
      className={cn(
        "h-auto w-full flex-col items-stretch gap-1 rounded-none px-3 py-2.5 text-left whitespace-normal",
        // `bg-clip-border`, and it is load-bearing. `Button`'s base carries
        // `border border-transparent` AND `bg-clip-padding`, so its background
        // is clipped to the PADDING box and stops 1px short on every side.
        // On an ordinary button nobody sees that; on a full-bleed row it left
        // a hairline of un-highlighted ground down both edges of the selected
        // and hovered states, inside dividers that DID reach the edge.
        //
        // Clipping to the border box rather than dropping the border: the
        // border is what `focus-visible:border-ring` colours, so removing it
        // would pay for a 1px fix with half the keyboard focus ring.
        "bg-clip-border",
        // A tint of the brand teal rather than the neutral `bg-muted` the
        // ghost Button ships with, in two steps: a whisper on hover, a clear
        // one when selected.
        //
        // MEASURED over the rail's own ground, compositing each tint and then
        // each text colour on top:
        //
        //   ground              body    metadata
        //   bg-muted (was)      15.38   3.73
        //   primary/6  (hover)  17.65   4.28
        //   primary/10 (select) 16.70   4.05
        //
        // The comment body is never in question at 16-17:1. The METADATA is
        // the constraint, and it is worth being straight about: at 11px it
        // counts as normal text, so 4.5:1 is the bar and none of these clear
        // it. Every one of them BEATS the neutral they replace, though —
        // going teal made the weakest text on the row more readable, not
        // less. Do not deepen past /10 without re-measuring; /12 is already
        // back down to 3.95.
        "hover:bg-primary/6",
        selected && "bg-primary/10 hover:bg-primary/10",
      )}
    >
      <span className="flex items-center gap-2">
        {/* `xs` (16px). This avatar sets the height of the row's top line, so
            every pixel it takes is a pixel of vertical space in a list people
            scan. It is a real primitive size rather than a `size-4` here: the
            presets are `data-[size=…]` variants and outrank a plain utility
            class, so a `size-4` at this call site did nothing at all and the
            avatar stayed 24px through two rounds of "make it smaller". */}
        <Avatar size="xs" className="flex-none">
          <AvatarImage src={comment.author.photoURL} alt="" />
          <AvatarFallback>{avatarInitial(comment.author.displayName)}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {comment.author.displayName}
        </span>
        {/*
          One status slot, next to the timestamp. It holds "Resolved" when the
          thread is closed and the reply count when it is open — never both,
          and never one under the other.

          Reply count moved up here on 2026-08-19 because it answers the same
          question the timestamp does: how much happened, and how long ago.
          "Resolved" replaced it there on 2026-08-20, because once a thread is
          closed the count is answering a question nobody has left — what you
          want to know about a resolved comment is that it IS resolved. A row
          that says "Resolved" and "1 reply" makes you read both to learn one
          thing.

          Plain text, not a `Badge`. A badge is for something that interrupts
          a scan; "Resolved" is the calmest thing a comment can be, and it sat
          on the state line drawing more attention than the comment above it.
        */}
        <span className="flex flex-none items-center gap-1 text-xs font-normal text-muted-foreground">
          {comment.resolved ? (
            <>
              <span>Resolved</span>
              <span aria-hidden>·</span>
            </>
          ) : replies > 0 ? (
            <>
              <span>
                {replies} {replies === 1 ? "reply" : "replies"}
              </span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <span>{formatRelativeTimeShort(comment.createdAt)}</span>
        </span>
      </span>

      {/* Two lines of the comment, not one — a single truncated line loses the
          half of a sentence that says what the person actually wanted. */}
      <span
        className={cn(
          "line-clamp-2 text-sm font-normal",
          // A resolved comment is done with, so it steps back to the weight of
          // its own metadata rather than staying the loudest thing in a list
          // of things still open.
          comment.resolved ? "text-muted-foreground" : "text-foreground",
        )}
      >
        <MentionText text={comment.body} />
      </span>

      <span className="flex items-center gap-1.5">
        {/* Plain text, not a chip. It is the quietest thing on the row — a
            filled badge gave it the same weight as "Resolved", which is a
            state someone acted on. */}
        {/* Sans at `text-2xs` (10px), not mono. Same reasoning as the
            header's path (docs/design.md, "Mono is for code"): this is a
            location matched at a glance against pages the reader already
            knows, never transcribed, so the face buys nothing and costs
            width. A `<span>`, not a `<code>` — the element should not claim
            the string is code when the styling says it is not. */}
        <span className="min-w-0 truncate text-2xs text-muted-foreground">
          {comment.position.page}
        </span>
      </span>
    </Button>
  )
}


function IdentityFormCard({
  onSave,
  onClose,
}: {
  onSave: (input: { displayName: string; email?: string }) => void
  onClose: () => void
}) {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")

  return (
    <div className="flex w-72 flex-col gap-3 rounded-sm border border-border bg-background p-3 shadow-xl">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Who&apos;s commenting?</span>
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <X className="h-2.5 w-2.5" />
        </Button>
      </div>
      <FieldGroup>
      <Field label="Name" htmlFor="reviewer-name">
        <Input
          id="reviewer-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jane Doe"
          autoFocus
        />
      </Field>
      <Field label="Email (optional)" htmlFor="reviewer-email">
        <Input
          id="reviewer-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="jane@example.com"
        />
      </Field>
      </FieldGroup>
      <Button
        size="sm"
        disabled={!name.trim()}
        onClick={() => onSave({ displayName: name, email: email.trim() || undefined })}
      >
        Save
      </Button>
    </div>
  )
}

function NewCommentCard({
  participants,
  onInvite,
  onSubmit,
  onClose,
}: {
  participants: ReviewParticipant[]
  onInvite?: (email: string) => Promise<ReviewParticipant | null>
  onSubmit: (body: string, mentions: string[]) => Promise<void>
  onClose: () => void
}) {
  const [text, setText] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = useCallback(async () => {
    const body = text.trim()
    if (!body || submitting) return
    setSubmitting(true)
    try {
      await onSubmit(body, extractMentionIds(body))
    } finally {
      setSubmitting(false)
    }
  }, [text, submitting, onSubmit])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void handleSubmit()
    }
  }

  return (
    /* No `overflow-hidden`, deliberately. The mention picker inside is
       absolutely positioned and opens out of this card by design, and a clip
       here cut its list in half, leaving a sliver of rows above the invite
       row. `overflow-hidden` was doing nothing else: this card's radius is
       `rounded-sm` and none of its children paint a background to the
       corners, so there is nothing for it to clip. */
    <div
      className="flex w-80 flex-col rounded shadow-xl"
      /* The SAME surface as the thread popup, from one definition
         (`annotationCardSurface`). These two open in the same place a click
         apart, and they had drifted into a grey `border border-border` here
         against the popup's teal outline, plus `rounded-sm` against its
         `rounded`. */
      style={annotationCardSurface("comment")}
    >
      <div className="flex flex-none items-center justify-between px-3 py-1.5">
        <span className="text-xs text-muted-foreground">New comment</span>
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <X className="h-2.5 w-2.5" />
        </Button>
      </div>
      {/* No rule under the header. The popup's `border-t` sits above its REPLY
          box, where it separates the composer from the comment and replies
          above it — a real boundary. Here there is nothing above but the
          title, so the same line was dividing a header from the only content
          the card has. */}
      <div className="p-3">
        <div className="relative">
          {/* The same input the thread card's reply box mounts. It owns the
              picker, the caret tracking and the `@[Name](id)` insertion, so
              the two composers cannot drift into offering different mention
              behaviour a click apart. */}
          <MentionInput
            placeholder="Add a comment"
            value={text}
            onChange={setText}
            onKeyDown={handleKeyDown}
            participants={participants}
            onInvite={onInvite}
            className="min-h-[56px] resize-none pr-10 text-base"
            autoFocus
          />
          {/* `icon-xs` (20px), down from `icon-sm` (24px). A submit button
              tucked inside a textarea is a confirmation, not an invitation —
              it only appears once there is something to send, so it does not
              need to advertise itself.

              The arrow gets a heavier stroke to survive the shrink. Lucide
              draws at `stroke-width: 2` by default, which is tuned for ~16px;
              at 12px in a filled circle the glyph thins out and reads as
              grey. 2.5 holds the same optical weight it had at the larger
              size — this is the one case where a smaller icon needs MORE
              stroke, not proportionally less. */}
          <Button
            size="icon-xs"
            aria-label="Send"
            className="absolute bottom-2 right-2 rounded-full"
            onClick={() => void handleSubmit()}
            disabled={!text.trim() || submitting}
          >
            <ArrowUp className="size-3" strokeWidth={2.5} />
          </Button>
        </div>
      </div>
    </div>
  )
}

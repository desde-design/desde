"use client"

import { useEffect, useState } from "react"
import SettingsPage from "../../app/settings/page"
import {
  ME_AUTH_DISABLED,
  ME_LOCAL_OPERATOR,
  ME_SIGNED_IN,
  ME_SIGNED_IN_EMAIL_ONLY,
  ME_SIGNED_OUT,
  SAMPLE_PLAINTEXT_TOKEN,
  SAMPLE_TOKENS,
} from "../harness/fixture-data"
import { Scenario } from "../harness/scenario"
import { fail, ok, PENDING, type FetchOverrideResult } from "@/components/gallery/fetch-override"
import {
  clickLikeUser,
  findByText,
  runDrivenInteraction,
  setNativeValue,
  waitForElement,
} from "@/components/gallery/dom-interaction"
import type { SurfaceEntry } from "@/components/gallery/types"

/**
 * Settings — machine token (PAT) management.
 *
 * `TokensPanel` is the component under review, but `app/settings/page.tsx`
 * is a synchronous Server Component with no state of its own, so it renders
 * here too — that is the only way the eyebrow/title/intro sentence stay
 * under review instead of being hand-copied and left to drift.
 *
 * `TokensPanel` takes zero props: every state below is reached by mocking
 * `/api/v1/me` and `/api/v1/tokens`, or by driving a real click/keystroke
 * sequence at internal `useState` no prop can reach (the create form, the
 * reveal box, the revoke dialog).
 *
 * Two collapses from the audited state list, both noted where they happen:
 * the three create-error copy variants (server message / generic HTTP /
 * unexpected shape / network) collapse to one, since they differ only in
 * the string shown in the same Callout; the three "token row" variants
 * (expired, never-used, multi-scope) collapse into the one populated list,
 * since `SAMPLE_TOKENS` already contains all three. Not built: the loading
 * gate before `/api/v1/me` resolves (renders nothing — nothing to review)
 * and the revoke dialog's stale-id fallback copy (needs a raced id, not a
 * single click, to reach honestly).
 */

/**
 * A non-admin signed-in user (viewer-membership Task 8) — `ME_SIGNED_IN`'s
 * `SAMPLE_USER` is `role: "admin"`, so the admin sections need an explicit
 * override to prove `MembersPanel` / `DomainRulesPanel` / `InstanceSettingsPanel`
 * render nothing for anyone else, with no gap or error where they'd have been.
 */
const ME_SIGNED_IN_VIEWER = {
  ...ME_SIGNED_IN,
  user: { ...ME_SIGNED_IN.user, role: "viewer" as const },
}

/** What `POST /api/v1/tokens` returns on success — a row plus the one-time plaintext. */
const CREATED_TOKEN = {
  id: "tok-new",
  name: "editor-macbook",
  scopes: ["read"],
  createdAt: "2026-08-19T12:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  token: SAMPLE_PLAINTEXT_TOKEN,
}

/**
 * Clicks through to the Tokens section.
 *
 * The page opens on Account (2026-08-21, when settings gained its own
 * navigation), so every token state starts here. Returns false if the nav
 * item never appeared, which is how a driver tells "not signed in yet" from
 * "clicked".
 */
async function openTokensTab(): Promise<boolean> {
  const item = await waitForElement(() =>
    document.querySelector<HTMLButtonElement>('[data-testid="settings-nav-tokens"]'),
  )
  if (!item) return false
  clickLikeUser(item)
  return true
}

/**
 * Opens the create dialog and returns its `#token-name` input.
 *
 * The form moved behind an Add button (2026-08-21) when creation and listing
 * were split, so every create-side driver starts here instead of reaching
 * straight for the input.
 */
async function openCreateDialog(): Promise<HTMLInputElement | null> {
  if (!(await openTokensTab())) return null
  const openButton = await waitForElement(() =>
    findByText<HTMLButtonElement>("button", /^create token$/i),
  )
  if (!openButton) return null
  clickLikeUser(openButton)
  return waitForElement(() => document.querySelector<HTMLInputElement>("#token-name"))
}

/**
 * The dialog's own submit button.
 *
 * Scoped to the dialog on purpose: the section's "Create token" button, which
 * opened it, matches the same text and is still in the document behind it.
 */
async function dialogSubmit(): Promise<HTMLButtonElement | null> {
  const dialog = await waitForElement(() => document.querySelector<HTMLElement>('[role="dialog"]'))
  if (!dialog) return null
  return waitForElement(() => findByText<HTMLButtonElement>("button", /^create token$/i, dialog))
}

/**
 * Drives the create form to a state with all three validation errors
 * visible at once: a whitespace-only name (has length, so the error shows,
 * but trims to empty), no scope selected, and an out-of-range expiry.
 */
function CreateValidationErrorsFixture() {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      const name = await openCreateDialog()
      if (cancelled || !name) return
      setNativeValue(name, "   ")

      // Document order inside the dialog: Scopes renders Read then Write;
      // Expiry's "Expires after" checkbox comes after both.
      const checkboxes = document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')
      const readCheckbox = checkboxes[0]
      const expiryCheckbox = checkboxes[2]
      if (cancelled || !readCheckbox || !expiryCheckbox) return
      clickLikeUser(readCheckbox) // unchecks Read; Write is already off, so no scope remains
      clickLikeUser(expiryCheckbox) // enables the days input

      const days = await waitForElement(() =>
        document.querySelector<HTMLInputElement>('input[type="number"]'),
      )
      if (cancelled || !days) return
      setNativeValue(days, "0") // outside the server's 1-365 bound
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Scenario routes={{ "/api/v1/me": ok(ME_SIGNED_IN), "GET /api/v1/tokens": ok({ tokens: [] }) }}>
      <SettingsPage />
    </Scenario>
  )
}

/**
 * Types a valid name and submits the create form, then answers the POST
 * with `postResult` — shared by the busy and failed states, which differ
 * only in what that response is.
 */
function CreateActionFixture({ postResult }: { postResult: FetchOverrideResult }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      const name = await openCreateDialog()
      if (cancelled || !name) return
      setNativeValue(name, "editor-macbook")
      const button = await dialogSubmit()
      if (cancelled || !button) return
      clickLikeUser(button)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Scenario
      routes={{
        "/api/v1/me": ok(ME_SIGNED_IN),
        "GET /api/v1/tokens": ok({ tokens: [] }),
        "POST /api/v1/tokens": postResult,
      }}
    >
      <SettingsPage />
    </Scenario>
  )
}

/**
 * Creates a token (POST always succeeds here) and, when `withCopy` is set,
 * clicks the reveal box's Copy button too.
 */
function RevealFixture({ withCopy }: { withCopy: boolean }) {
  // Flips once the Copy click has been CONFIRMED to land — see the comment
  // by `setCopyDone` below for why this exists at all.
  const [copyDone, setCopyDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      // `navigator.clipboard` isn't guaranteed to exist in every context this
      // gallery can render in (no secure-context grant, some CI sandboxes).
      // Stubbed so `handleCopy`'s `await navigator.clipboard.writeText(...)`
      // resolves instead of throwing — that resolve is what flips `copyOk`.
      if (withCopy && !navigator.clipboard) {
        Object.defineProperty(navigator, "clipboard", {
          value: { writeText: async () => {} },
          configurable: true,
        })
      }

      const name = await openCreateDialog()
      if (cancelled || !name) return
      setNativeValue(name, "editor-macbook")
      const createButton = await dialogSubmit()
      if (cancelled || !createButton) return
      clickLikeUser(createButton)

      const revealCode = await waitForElement(() => document.querySelector("code.text-code"))
      if (cancelled || !revealCode || !withCopy) return

      const copyButton = await waitForElement(() => findByText<HTMLButtonElement>("button", /^copy$/i))
      if (cancelled || !copyButton) return
      clickLikeUser(copyButton)

      // "Copy" becoming "Copied" is a text-node change with nothing else in
      // the DOM to distinguish it — no attribute, no structural difference —
      // so a plain CSS `readyWhen` selector can't key off the click having
      // landed. Confirm the label actually changed, THEN add a marker
      // element of our own for `readyWhen` to watch instead.
      const copied = await waitForElement(() => findByText<HTMLButtonElement>("button", /^copied$/i))
      if (cancelled || !copied) return
      setCopyDone(true)
    })
    return () => {
      cancelled = true
    }
  }, [withCopy])

  return (
    <>
      <Scenario
        routes={{
          "/api/v1/me": ok(ME_SIGNED_IN),
          "GET /api/v1/tokens": ok({ tokens: [] }),
          "POST /api/v1/tokens": ok(CREATED_TOKEN),
        }}
      >
        <SettingsPage />
      </Scenario>
      {withCopy && copyDone ? <div data-gallery-copy-done="" hidden /> : null}
    </>
  )
}

/** Clicks a row's Revoke button, opening the confirm dialog on the first token. */
function RevokeConfirmFixture() {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      if (!(await openTokensTab())) return
      // By aria-label, not by text: the row's control became an icon button
      // (2026-08-21), so it has no text node to match. The dialog's confirm
      // still says "Revoke", which is why the driver below can keep using
      // `findByText` for that one.
      const rowRevoke = await waitForElement(() =>
        document.querySelector<HTMLButtonElement>('[aria-label^="Revoke "]'),
      )
      if (cancelled || !rowRevoke) return
      clickLikeUser(rowRevoke)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Scenario
      routes={{ "/api/v1/me": ok(ME_SIGNED_IN), "GET /api/v1/tokens": ok({ tokens: SAMPLE_TOKENS }) }}
    >
      <SettingsPage />
    </Scenario>
  )
}

/**
 * Opens the confirm dialog and clicks its own Revoke button, then answers
 * the DELETE with `deleteResult` — shared by the busy and failed states.
 */
function RevokeActionFixture({ deleteResult }: { deleteResult: FetchOverrideResult }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      if (!(await openTokensTab())) return
      // By aria-label, not by text: the row's control became an icon button
      // (2026-08-21), so it has no text node to match. The dialog's confirm
      // still says "Revoke", which is why the driver below can keep using
      // `findByText` for that one.
      const rowRevoke = await waitForElement(() =>
        document.querySelector<HTMLButtonElement>('[aria-label^="Revoke "]'),
      )
      if (cancelled || !rowRevoke) return
      clickLikeUser(rowRevoke)

      const dialog = await waitForElement(() => document.querySelector<HTMLElement>('[role="dialog"]'))
      if (cancelled || !dialog) return
      // Scoped to the dialog: the row's own Revoke button also matches
      // /^revoke$/i, and it is still in the document behind the dialog.
      const confirmButton = await waitForElement(() =>
        findByText<HTMLButtonElement>("button", /^revoke$/i, dialog),
      )
      if (cancelled || !confirmButton) return
      clickLikeUser(confirmButton)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Scenario
      routes={{
        "/api/v1/me": ok(ME_SIGNED_IN),
        "GET /api/v1/tokens": ok({ tokens: SAMPLE_TOKENS }),
        "DELETE /api/v1/tokens": deleteResult,
      }}
    >
      <SettingsPage />
    </Scenario>
  )
}

/**
 * The settings page with the Tokens section already selected.
 *
 * The page opens on Account, so a state that wants to show the token list has
 * to click through first. This is a one-click driver rather than a prop,
 * because the section is `SettingsNav`'s own `useState` and no prop reaches
 * it — which is the point: the gallery drives the real component, not a
 * variant of it built for the gallery.
 */
function TokensTabFixture({ routes }: { routes: Record<string, FetchOverrideResult> }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      if (cancelled) return
      await openTokensTab()
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Scenario routes={routes}>
      <SettingsPage />
    </Scenario>
  )
}

export const SETTINGS_SURFACE: SurfaceEntry = {
  id: "settings",
  title: "Settings — account and tokens",
  kind: "page",
  sourceFile: "viewer/app/settings/settings-nav.tsx",
  states: [
    {
      id: "settings/auth-not-configured",
      label: "Account — no sign-in configured, the local link is the way in",
      render: () => (
        <Scenario routes={{ "/api/v1/me": ok(ME_AUTH_DISABLED) }}>
          <SettingsPage />
        </Scenario>
      ),
    },
    {
      id: "settings/signed-out",
      label: "Account — signed out, sign-in offered",
      render: () => (
        <Scenario routes={{ "/api/v1/me": ok(ME_SIGNED_OUT) }}>
          <SettingsPage />
        </Scenario>
      ),
    },
    {
      id: "settings/account",
      label: "Account — signed in",
      render: () => (
        <Scenario routes={{ "/api/v1/me": ok(ME_SIGNED_IN) }}>
          <SettingsPage />
        </Scenario>
      ),
    },
    {
      /*
        The zero-config instance's Admin, on the section where the dead end
        used to be. Mo, 2026-08-28: "this shouldn't be a dead end, there
        should be a button to set up GitHub OAuth sign in."

        This is the state where that button is honest. The anonymous state
        (`settings/auth-not-configured`) deliberately does NOT offer it — the
        manifest route refuses an anonymous caller — so the two states have to
        be looked at together to see that the flow has one entrance and it is
        behind a session.
      */
      id: "settings/local-operator-no-github",
      label: "Account — Admin on a zero-config instance, GitHub setup offered",
      render: () => (
        <Scenario routes={{ "/api/v1/me": ok(ME_LOCAL_OPERATOR) }}>
          <SettingsPage />
        </Scenario>
      ),
    },
    {
      id: "settings/signed-in-email-only-instance",
      label: "Signed in via invite/magic link, no GitHub App on this instance",
      render: () => (
        <Scenario
          routes={{ "/api/v1/me": ok(ME_SIGNED_IN_EMAIL_ONLY), "GET /api/v1/tokens": ok({ tokens: [] }) }}
        >
          <SettingsPage />
        </Scenario>
      ),
    },
    {
      id: "settings/tokens-loading",
      label: "Loading the token list",
      render: () => <TokensTabFixture routes={{ "/api/v1/me": ok(ME_SIGNED_IN), "GET /api/v1/tokens": PENDING }} />,
    },
    {
      id: "settings/tokens-load-error",
      label: "Couldn't load tokens",
      readyWhen: '[data-testid="settings-section-tokens"]',
      render: () => <TokensTabFixture routes={{ "/api/v1/me": ok(ME_SIGNED_IN), "GET /api/v1/tokens": fail(500) }} />,
    },
    {
      id: "settings/tokens-empty",
      label: "No tokens",
      readyWhen: '[data-testid="settings-section-tokens"]',
      render: () => <TokensTabFixture routes={{ "/api/v1/me": ok(ME_SIGNED_IN), "GET /api/v1/tokens": ok({ tokens: [] }) }} />,
    },
    {
      id: "settings/tokens-populated",
      label: "Populated — every row variant (expired, never-used, multi-scope)",
      readyWhen: '[data-testid="token-row-tok-ci"]',
      render: () => <TokensTabFixture routes={{
        "/api/v1/me": ok(ME_SIGNED_IN),
        "GET /api/v1/tokens": ok({ tokens: SAMPLE_TOKENS }),
      }} />,
    },
    {
      id: "settings/create-validation-errors",
      label: "Create dialog — every validation error at once",
      readyWhen: '[role="dialog"] .text-destructive',
      render: () => <CreateValidationErrorsFixture />,
    },
    {
      id: "settings/create-busy",
      label: "Create dialog — creating",
      readyWhen: "[data-busy]",
      render: () => <CreateActionFixture postResult={PENDING} />,
    },
    {
      id: "settings/create-failed",
      label: "Create dialog — create failed",
      readyWhen: '[role="dialog"] [data-slot="callout"]',
      render: () => (
        <CreateActionFixture
          postResult={fail(400, 'A token named "editor-macbook" already exists.')}
        />
      ),
    },
    {
      id: "settings/reveal-plaintext",
      label: "Show-once token reveal",
      readyWhen: '[role="dialog"] code.text-code',
      render: () => <RevealFixture withCopy={false} />,
    },
    {
      id: "settings/reveal-copied",
      label: "Show-once token reveal — after Copy",
      readyWhen: "[data-gallery-copy-done]",
      render: () => <RevealFixture withCopy />,
    },
    {
      id: "settings/revoke-confirm-open",
      label: "Revoke confirm dialog",
      readyWhen: '[role="dialog"]',
      render: () => <RevokeConfirmFixture />,
    },
    {
      id: "settings/revoke-busy",
      label: "Revoke confirm dialog — revoking",
      readyWhen: '[role="dialog"] button:disabled',
      render: () => <RevokeActionFixture deleteResult={PENDING} />,
    },
    {
      id: "settings/revoke-error",
      label: "Revoke: the token was already gone",
      readyWhen: '[data-testid="revoke-already-gone"]',
      render: () => <RevokeActionFixture deleteResult={fail(404, "Token already revoked.")} />,
    },
    {
      // The OTHER failure, and the reason 404 is handled separately: this one
      // is worth retrying, so it keeps the confirm and its Revoke button.
      id: "settings/revoke-failed-retryable",
      label: "Revoke: failed, worth retrying",
      readyWhen: '[role="dialog"] [data-slot="callout"]',
      render: () => <RevokeActionFixture deleteResult={fail(500, "Couldn't revoke that token. Try again.")} />,
    },
    {
      // viewer-membership: a non-admin (Viewer/Editor) sees only the Account
      // and Tokens tabs — the Members / Domain rules / Instance tabs are
      // omitted entirely by `SettingsNav`, and the panels self-gate too.
      id: "settings/non-admin-tokens-only",
      label: "Signed in as a non-admin — no admin tabs offered",
      render: () => (
        <Scenario
          routes={{ "/api/v1/me": ok(ME_SIGNED_IN_VIEWER), "GET /api/v1/tokens": ok({ tokens: [] }) }}
        >
          <SettingsPage />
        </Scenario>
      ),
    },
  ],
}

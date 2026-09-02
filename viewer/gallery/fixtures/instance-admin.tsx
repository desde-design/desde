"use client"

import { useEffect } from "react"
import { MembersPanel } from "../../app/settings/members-panel"
import { DomainRulesPanel } from "../../app/settings/domain-rules-panel"
import { GithubPanel } from "../../app/settings/github-panel"
import { InstanceSettingsPanel } from "../../app/settings/instance-settings-panel"
import { ME_SIGNED_IN } from "../harness/fixture-data"
import { PanelFrame, Scenario } from "../harness/scenario"
import { fail, NETWORK_ERROR, ok } from "@/components/gallery/fetch-override"
import {
  clickLikeUser,
  findByText,
  runDrivenInteraction,
  setNativeValue,
  waitForElement,
} from "@/components/gallery/dom-interaction"
import type { SurfaceEntry } from "@/components/gallery/types"

/**
 * The three admin-only settings panels (viewer-membership Task 8): Members
 * (Members/Invites tabs, role change, remove), Domain rules, and
 * Instance settings. All three self-gate on `useCurrentUser().user.role ===
 * "admin"` — `ME_SIGNED_IN`'s `SAMPLE_USER` is already `role: "admin"` (see
 * `fixture-data.ts`), so every state below reaches the signed-in-admin
 * branch without a per-fixture override. `PanelFrame width="wide"` matches
 * where these panels actually sit: the settings page's column, not a
 * dialog.
 */

const SAMPLE_ADMIN_MEMBER = {
  userId: "user-mo",
  email: "mo@example.com",
  displayName: "Mo Chang",
  avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  role: "admin",
  status: "active",
  createdAt: "2026-06-01T09:00:00.000Z",
}

const SAMPLE_EDITOR_MEMBER = {
  userId: "user-rin",
  email: "rin@example.com",
  displayName: "Rin Adeyemi",
  avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  role: "editor",
  status: "active",
  createdAt: "2026-06-14T13:20:00.000Z",
}

/**
 * An active `viewer`-role account (viewer-membership Task 12 review fix):
 * without one, `members-panel/populated` showed every role EXCEPT the one
 * that matters most for the access-dialog read-only branch — a signed-in,
 * active `viewer` who can read a project but never manage it.
 */
const SAMPLE_VIEWER_MEMBER = {
  userId: "user-dana",
  email: "dana@example.com",
  displayName: "Dana Whitfield",
  avatarUrl: "https://avatars.githubusercontent.com/u/3?v=4",
  role: "viewer",
  status: "active",
  createdAt: "2026-07-20T10:00:00.000Z",
}

/**
 * The server still returns removed users on `GET /instance/members` (the
 * audit trail), but the panel filters them out (Mo, 2026-08-31: a removed
 * member just disappears). Keeping one in the mock proves the filter: this
 * row must NOT render in the populated state.
 */
const SAMPLE_REMOVED_MEMBER = {
  userId: "user-sam",
  email: "sam@example.com",
  displayName: "Sam Okafor",
  avatarUrl: "https://avatars.githubusercontent.com/u/2?v=4",
  role: "viewer",
  status: "removed",
  createdAt: "2026-07-02T16:45:00.000Z",
}

/** Exactly one active admin (Mo) — this list is what makes the last-admin-guard fixture below honest. */
const SAMPLE_MEMBERS_LIST = [
  SAMPLE_ADMIN_MEMBER,
  SAMPLE_EDITOR_MEMBER,
  SAMPLE_VIEWER_MEMBER,
  SAMPLE_REMOVED_MEMBER,
]

const SAMPLE_INVITES = [
  {
    id: "inv-pending",
    email: "dana@example.com",
    role: "editor",
    createdByUserId: "user-mo",
    createdAt: "2026-08-15T10:00:00.000Z",
    expiresAt: "2026-08-22T10:00:00.000Z",
    usedAt: null,
    revokedAt: null,
    state: "pending",
  },
  {
    id: "inv-used",
    email: "kai@example.com",
    role: "viewer",
    createdByUserId: "user-mo",
    createdAt: "2026-07-20T10:00:00.000Z",
    expiresAt: "2026-07-27T10:00:00.000Z",
    usedAt: "2026-07-21T09:00:00.000Z",
    revokedAt: null,
    state: "used",
  },
  {
    id: "inv-revoked",
    email: "old-contractor@example.com",
    role: "viewer",
    createdByUserId: "user-mo",
    createdAt: "2026-06-01T10:00:00.000Z",
    expiresAt: "2026-06-08T10:00:00.000Z",
    usedAt: null,
    revokedAt: "2026-06-02T10:00:00.000Z",
    state: "revoked",
  },
  {
    id: "inv-expired",
    email: "someone@example.com",
    role: "viewer",
    createdByUserId: "user-mo",
    createdAt: "2026-05-01T10:00:00.000Z",
    expiresAt: "2026-05-08T10:00:00.000Z",
    usedAt: null,
    revokedAt: null,
    state: "expired",
  },
]

const SAMPLE_DOMAIN_RULES = [
  { domain: "acme.com", role: "editor", createdByUserId: "user-mo", createdAt: "2026-07-01T09:00:00.000Z" },
  {
    domain: "contractors.acme.com",
    role: "viewer",
    createdByUserId: "user-mo",
    createdAt: "2026-07-10T09:00:00.000Z",
  },
]

const MEMBERS_ROUTES = {
  "/api/v1/me": ok(ME_SIGNED_IN),
  "GET /api/v1/instance/members": ok({ members: SAMPLE_MEMBERS_LIST }),
  "GET /api/v1/instance/invites": ok({ invites: SAMPLE_INVITES }),
}

/**
 * Invites live on their own tab (2026-08-31), and the invite form is a
 * dialog behind the tab's Invite button (2026-08-28) — so `#invite-email`
 * exists only after two clicks. Both invite fixtures walk them.
 */
async function openInvitesTab(isCancelled: () => boolean): Promise<boolean> {
  const tab = await waitForElement(
    () => findByText<HTMLButtonElement>('[role="tab"]', /^invites$/i),
    { isCancelled },
  )
  if (isCancelled() || !tab) return false
  clickLikeUser(tab)
  return true
}

async function openInviteDialog(isCancelled: () => boolean): Promise<boolean> {
  if (!(await openInvitesTab(isCancelled))) return false
  const trigger = await waitForElement(
    () => document.querySelector<HTMLButtonElement>('[data-testid="invite-open"]'),
    { isCancelled },
  )
  if (isCancelled() || !trigger) return false
  clickLikeUser(trigger)
  return true
}

/** Just fronts the Invites tab, so the invite LIST states are visible without a dialog. */
function InvitesTabFixture() {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      await openInvitesTab(() => cancelled)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <PanelFrame width="wide">
      <Scenario routes={MEMBERS_ROUTES}>
        <MembersPanel />
      </Scenario>
    </PanelFrame>
  )
}

/** Types an email, clicks "Create invite", and lets the POST reveal a fresh one-time URL. */
function InviteCreatedFixture() {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      if (!(await openInviteDialog(() => cancelled))) return
      const emailInput = await waitForElement(() => document.querySelector<HTMLInputElement>("#invite-email"))
      if (cancelled || !emailInput) return
      setNativeValue(emailInput, "dana@example.com")

      const createButton = await waitForElement(() =>
        findByText<HTMLButtonElement>("button", /^create invite$/i),
      )
      if (cancelled || !createButton) return
      clickLikeUser(createButton)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <PanelFrame width="wide">
      <Scenario
        routes={{
          "/api/v1/me": ok(ME_SIGNED_IN),
          "GET /api/v1/instance/members": ok({ members: SAMPLE_MEMBERS_LIST }),
          "GET /api/v1/instance/invites": ok({ invites: [] }),
          "POST /api/v1/instance/invites": ok({
            invite: {
              id: "inv-new",
              email: "dana@example.com",
              role: "viewer",
              createdByUserId: "user-mo",
              createdAt: "2026-08-20T12:00:00.000Z",
              expiresAt: "2026-08-27T12:00:00.000Z",
              usedAt: null,
              revokedAt: null,
              state: "pending",
            },
            url: "http://localhost:3100/api/v1/auth/invite/dsi_abcdef0123456789",
          }),
        }}
      >
        <MembersPanel />
      </Scenario>
    </PanelFrame>
  )
}

/**
 * Same flow as `InviteCreatedFixture`, but the server actually sent the
 * email (SMTP configured, the send succeeded) — `emailed: true` on the
 * response. I4: the reveal box's headline sentence switches to naming the
 * send instead of the "copy this now, it's your only chance" warning, since
 * that warning is no longer quite true — the recipient already has it too.
 */
function InviteEmailedFixture() {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      if (!(await openInviteDialog(() => cancelled))) return
      const emailInput = await waitForElement(() => document.querySelector<HTMLInputElement>("#invite-email"))
      if (cancelled || !emailInput) return
      setNativeValue(emailInput, "dana@example.com")

      const createButton = await waitForElement(() =>
        findByText<HTMLButtonElement>("button", /^create invite$/i),
      )
      if (cancelled || !createButton) return
      clickLikeUser(createButton)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <PanelFrame width="wide">
      <Scenario
        routes={{
          "/api/v1/me": ok(ME_SIGNED_IN),
          "GET /api/v1/instance/members": ok({ members: SAMPLE_MEMBERS_LIST }),
          "GET /api/v1/instance/invites": ok({ invites: [] }),
          "POST /api/v1/instance/invites": ok({
            invite: {
              id: "inv-new-emailed",
              email: "dana@example.com",
              role: "viewer",
              createdByUserId: "user-mo",
              createdAt: "2026-08-20T12:00:00.000Z",
              expiresAt: "2026-08-27T12:00:00.000Z",
              usedAt: null,
              revokedAt: null,
              state: "pending",
            },
            url: "http://localhost:3100/api/v1/auth/invite/dsi_abcdef0123456789",
            emailed: true,
          }),
        }}
      >
        <MembersPanel />
      </Scenario>
    </PanelFrame>
  )
}

/**
 * Clicks "Sign-in link" on an active, non-self member row (X3) and lets the
 * POST reveal a fresh one-time URL — same reveal PATTERN as
 * `InviteCreatedFixture`, different copy ("signs in as NAME" / 24 hours).
 * `SAMPLE_USER.id` (the signed-in caller) is `user-mo`, so this targets
 * `user-rin` — the caller's OWN row deliberately carries no such button at
 * all, which is why this fixture cannot target Mo.
 */
function SignInLinkRevealedFixture() {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      const button = await waitForElement(() =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Sign-in link for Rin Adeyemi"]'),
      )
      if (cancelled || !button) return
      clickLikeUser(button)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <PanelFrame width="wide">
      <Scenario
        routes={{
          ...MEMBERS_ROUTES,
          "GET /api/v1/instance/invites": ok({ invites: [] }),
          "POST /api/v1/instance/members/user-rin/signin-link": ok({
            url: "http://localhost:3100/api/v1/auth/signin/dss_abcdef0123456789",
            expiresAt: "2026-08-22T09:00:00.000Z",
          }),
        }}
      >
        <MembersPanel />
      </Scenario>
    </PanelFrame>
  )
}

/** Clicks Remove on the instance's only active admin, which the server refuses with a 409. */
function LastAdminErrorFixture() {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      const removeButton = await waitForElement(() =>
        document.querySelector<HTMLButtonElement>('[aria-label="Remove Mo Chang"]'),
      )
      if (cancelled || !removeButton) return
      clickLikeUser(removeButton)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <PanelFrame width="wide">
      <Scenario
        routes={{
          ...MEMBERS_ROUTES,
          "GET /api/v1/instance/invites": ok({ invites: [] }),
          "DELETE /api/v1/instance/members": fail(409, "There must be at least one admin."),
        }}
      >
        <MembersPanel />
      </Scenario>
    </PanelFrame>
  )
}

export const MEMBERS_PANEL_SURFACE: SurfaceEntry = {
  id: "members-panel",
  title: "Settings — members",
  kind: "inline",
  sourceFile: "viewer/app/settings/members-panel.tsx",
  states: [
    {
      id: "members-panel/populated",
      label: "Members tab — an admin, an editor, a viewer (a removed member in the data proves the filter)",
      render: () => (
        <PanelFrame width="wide">
          <Scenario routes={MEMBERS_ROUTES}>
            <MembersPanel />
          </Scenario>
        </PanelFrame>
      ),
    },
    {
      id: "members-panel/invites-tab",
      label: "Invites tab — every invite state",
      /* Not `invite-open`: the Add-member trigger is now visible on BOTH
         tabs, so it can't prove the driver's tab switch landed. A delete
         button only renders with the invite rows. */
      readyWhen: 'button[aria-label^="Delete invite"]',
      render: () => <InvitesTabFixture />,
    },
    {
      id: "members-panel/invite-created",
      label: "Invite created — the one-time URL reveal",
      readyWhen: "input[readonly]",
      render: () => <InviteCreatedFixture />,
    },
    {
      id: "members-panel/invite-emailed",
      label: "Invite created and emailed — the reveal names the send",
      readyWhen: "input[readonly]",
      render: () => <InviteEmailedFixture />,
    },
    {
      id: "members-panel/signin-link-revealed",
      label: "Sign-in link minted for an existing member — the one-time URL reveal",
      readyWhen: "input[readonly]",
      render: () => <SignInLinkRevealedFixture />,
    },
    {
      id: "members-panel/last-admin-error",
      label: "Removing the last admin — the 409 as an error banner",
      readyWhen: '[data-slot="callout"]',
      render: () => <LastAdminErrorFixture />,
    },
  ],
}

export const DOMAIN_RULES_PANEL_SURFACE: SurfaceEntry = {
  id: "domain-rules-panel",
  title: "Settings — domain rules",
  kind: "inline",
  sourceFile: "viewer/app/settings/domain-rules-panel.tsx",
  states: [
    {
      id: "domain-rules-panel/populated",
      label: "Populated — two rules",
      render: () => (
        <PanelFrame width="wide">
          <Scenario
            routes={{
              "/api/v1/me": ok(ME_SIGNED_IN),
              "GET /api/v1/instance/domain-rules": ok({ domainRules: SAMPLE_DOMAIN_RULES }),
            }}
          >
            <DomainRulesPanel />
          </Scenario>
        </PanelFrame>
      ),
    },
  ],
}

/**
 * The exact sentence `setup-routes.ts`'s `requireOperator` sends a
 * signed-in-but-not-operator visitor — see that file's `OPERATOR_ONLY`
 * constant. Reproduced literally rather than paraphrased, since the whole
 * point of that state is checking that the real server copy reads calmly.
 * (Moved here from the deleted `/setup` fixture, 2026-08-26.)
 */
const OPERATOR_ONLY_MESSAGE = "Only an admin of this viewer can set up the GitHub App."

/** Same shape the wizard fixture mocks — see `project-repo-panel.tsx`'s copy. */
const SAMPLE_MANIFEST_RESPONSE = ok({
  manifest: {
    name: "Desde Viewer (viewer.example.dev)",
    url: "https://viewer.example.dev",
    redirect_url: "https://viewer.example.dev/api/v1/setup/github/callback",
    setup_url: "https://viewer.example.dev",
    public: false,
  },
  state: "gallery-fixture-state",
})

const APP_CONFIGURED_RESPONSE = ok({
  configured: true,
  appSlug: "desde-viewer-acme",
  installations: [],
})

export const GITHUB_PANEL_SURFACE: SurfaceEntry = {
  id: "github-panel",
  title: "Settings — GitHub",
  kind: "inline",
  sourceFile: "viewer/app/settings/github-panel.tsx",
  states: [
    {
      id: "github-panel/configured",
      label: "App configured — links at the App itself",
      render: () => (
        <PanelFrame width="wide">
          <Scenario
            routes={{
              "/api/v1/me": ok(ME_SIGNED_IN),
              "/api/v1/github/installations": APP_CONFIGURED_RESPONSE,
            }}
          >
            <GithubPanel />
          </Scenario>
        </PanelFrame>
      ),
    },
    {
      id: "github-panel/not-configured",
      label: "No App yet — the setup card, personal account preselected",
      render: () => (
        <PanelFrame width="wide">
          <Scenario
            routes={{
              "/api/v1/me": ok(ME_SIGNED_IN),
              "/api/v1/github/installations": ok({ configured: false, installations: [] }),
              "/api/v1/setup/github/manifest": SAMPLE_MANIFEST_RESPONSE,
            }}
          >
            <GithubPanel />
          </Scenario>
        </PanelFrame>
      ),
    },
    {
      id: "github-panel/not-configured-org",
      label: "Setup card with Organization picked — org field shown, Create disabled until it is filled",
      render: () => {
        runDrivenInteraction(async () => {
          const orgRadio = await waitForElement(() =>
            document.querySelector<HTMLInputElement>("#option-card-org"),
          )
          if (orgRadio) clickLikeUser(orgRadio)
        })
        return (
          <PanelFrame width="wide">
            <Scenario
              routes={{
                "/api/v1/me": ok(ME_SIGNED_IN),
                "/api/v1/github/installations": ok({ configured: false, installations: [] }),
                "/api/v1/setup/github/manifest": SAMPLE_MANIFEST_RESPONSE,
              }}
            >
              <GithubPanel />
            </Scenario>
          </PanelFrame>
        )
      },
    },
    {
      id: "github-panel/not-the-operator",
      label: "Refused by the server — the calm sentence, not a red banner",
      render: () => (
        <PanelFrame width="wide">
          <Scenario
            routes={{
              "/api/v1/me": ok(ME_SIGNED_IN),
              "/api/v1/github/installations": ok({ configured: false, installations: [] }),
              "/api/v1/setup/github/manifest": fail(403, OPERATOR_ONLY_MESSAGE),
            }}
          >
            <GithubPanel />
          </Scenario>
        </PanelFrame>
      ),
    },
    {
      id: "github-panel/manifest-request-failed",
      label: "The manifest request failed — a genuine error",
      render: () => (
        <PanelFrame width="wide">
          <Scenario
            routes={{
              "/api/v1/me": ok(ME_SIGNED_IN),
              "/api/v1/github/installations": ok({ configured: false, installations: [] }),
              "/api/v1/setup/github/manifest": NETWORK_ERROR,
            }}
          >
            <GithubPanel />
          </Scenario>
        </PanelFrame>
      ),
    },
    {
      id: "github-panel/load-failed",
      label: "Couldn't check the GitHub App",
      render: () => (
        <PanelFrame width="wide">
          <Scenario
            routes={{
              "/api/v1/me": ok(ME_SIGNED_IN),
              "/api/v1/github/installations": NETWORK_ERROR,
            }}
          >
            <GithubPanel />
          </Scenario>
        </PanelFrame>
      ),
    },
  ],
}


/*
  The three states mail can be in. They are the point of this surface now:
  before 2026-08-26 it was a read-only line naming environment variables, and
  the form replaced it.

  `hasPassword` with no password field anywhere is deliberate, not an
  omission — the server never returns the credential, so the UI can only ever
  know whether one exists.
*/
const MAIL_OFF = {
  configured: false,
  source: null,
  host: null,
  port: null,
  user: null,
  from: null,
  hasPassword: false,
}

const MAIL_STORED = {
  configured: true,
  source: "stored",
  host: "smtp.example.com",
  port: 587,
  user: "viewer@example.com",
  from: "reviews@example.com",
  hasPassword: true,
}

const MAIL_FROM_ENV = { ...MAIL_STORED, source: "env" }

export const INSTANCE_SETTINGS_PANEL_SURFACE: SurfaceEntry = {
  id: "instance-settings-panel",
  title: "Settings — instance settings",
  kind: "inline",
  sourceFile: "viewer/app/settings/instance-settings-panel.tsx",
  states: [
    {
      id: "instance-settings-panel/allow-public-links-on",
      label: "Allow public links on; mention emails not sending",
      render: () => (
        <PanelFrame width="wide">
          <Scenario
            routes={{
              "/api/v1/me": ok(ME_SIGNED_IN),
              "GET /api/v1/instance/settings": ok({
                allowPublicLinks: true,
                emailFrom: null,
                email: MAIL_OFF,
              }),
            }}
          >
            <InstanceSettingsPanel />
          </Scenario>
        </PanelFrame>
      ),
    },
    {
      // The case a form cannot serve: `VIEWER_SMTP_HOST` is set, `loadConfig`
      // ignores anything stored, and the server 409s a save. The fields show
      // what is in force, disabled, with no Save button to press.
      id: "instance-settings-panel/mail-set-in-environment",
      label: "Email server set in the environment, so not editable here",
      render: () => (
        <PanelFrame width="wide">
          <Scenario
            routes={{
              "/api/v1/me": ok(ME_SIGNED_IN),
              "GET /api/v1/instance/settings": ok({
                allowPublicLinks: true,
                emailFrom: "reviews@example.com",
                email: MAIL_FROM_ENV,
              }),
            }}
          >
            <InstanceSettingsPanel />
          </Scenario>
        </PanelFrame>
      ),
    },
    {
      id: "instance-settings-panel/allow-public-links-off",
      label: "Allow public links off; email server sending",
      render: () => (
        <PanelFrame width="wide">
          <Scenario
            routes={{
              "/api/v1/me": ok(ME_SIGNED_IN),
              "GET /api/v1/instance/settings": ok({
                allowPublicLinks: false,
                emailFrom: "reviews@example.com",
                email: MAIL_STORED,
              }),
            }}
          >
            <InstanceSettingsPanel />
          </Scenario>
        </PanelFrame>
      ),
    },
  ],
}

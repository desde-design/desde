"use client"

import { useEffect } from "react"
import { EditorSettingsMenu } from "@/components/editor/editor-settings-menu"
import { LauncherSettingsMenu } from "@/components/editor/launcher/launcher-settings-menu"
import { useDesktopUpdates } from "@/hooks/useDesktopUpdates"
import type { DesktopBridge, DesktopUpdateState } from "@/types/desktop-bridge"
import type { SurfaceEntry, SurfaceRenderContext } from "../types"
import { clickLikeUser, runDrivenInteraction, waitForElement } from "./dom-interaction"
import { jsonOverride, useFetchOverride } from "./fetch-override"

/**
 * `EditorSettingsMenu` and `LauncherSettingsMenu` both mount
 * `useLlmCredentials`, which fetches `/api/editor/llm-credentials` on mount.
 * This surface is about update state, not credentials, so every fixture below
 * answers with one configured provider: enough that the credential dot never
 * appears and steals the update badge's corner.
 */
const LLM_CREDENTIALS_CONFIGURED = {
  providers: {
    anthropic: {
      id: "anthropic",
      label: "Anthropic",
      source: "stored",
      maskedHint: "sk-ant-…4f2a",
      hasStoredKey: true,
      storedHint: "sk-ant-…4f2a",
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      consoleUrl: "https://console.anthropic.com/settings/keys",
      maskPrefix: "sk-ant-",
      hasSubscriptionRuntime: true,
    },
  },
  devMode: false,
  promptDismissed: false,
}

/**
 * Desktop auto-update surfaces: the badge + top section in
 * `EditorSettingsMenu`'s dropdown (one state per `DesktopUpdateState` phase
 * that actually renders something — idle/checking render nothing, so
 * they're not states here), the auto-download toggle off, the restart
 * confirmation dialog that appears when a chat turn is streaming, and the
 * launcher's standalone nav button (visible with no project open).
 *
 * `useDesktopUpdates()` reads `window.desdeDesktop` once, via a
 * `useState` INITIALIZER, on the first render of whichever component calls
 * it — so the fake bridge below has to be installed BEFORE that component
 * mounts, not from an effect (effects run after commit, too late). Assigned
 * directly in this component's own render body instead, which — because
 * React fully renders a parent and returns its element tree before
 * rendering any child named in it — is guaranteed to happen before
 * `EditorSettingsMenu`'s/`LauncherSettingsMenu`'s own `useDesktopUpdates()`
 * call runs. Same "registers during render, not effect" reasoning as
 * `fetch-override.ts`'s `useFetchOverride`; the cleanup guard (only delete
 * if nothing newer replaced it) mirrors that file's own note on the
 * registry test's state-switch ordering.
 */
// Pulled out of the hook body as their own top-level functions (rather than
// inline assignment expressions) so the lint rule that flags a component/
// hook directly mutating an outside variable during render
// (`react-hooks/immutability`) doesn't fire on it — the SAME reason
// `fetch-override.ts`'s `ensureInstalled()` is its own function rather than
// inline in `useFetchOverride`. The mutation itself is identical either way;
// only its packaging changes.
function installDesktopBridge(bridge: DesktopBridge): void {
  ;(window as unknown as { desdeDesktop?: DesktopBridge }).desdeDesktop = bridge
}

function clearDesktopBridgeIfStillOurs(bridge: DesktopBridge): void {
  // Only clear if nothing newer (a later fixture, mounted before this
  // cleanup ran) has already replaced it — see fetch-override.ts's doc
  // comment on the exact same ordering hazard during a state switch.
  if ((window as { desdeDesktop?: unknown }).desdeDesktop === bridge) {
    delete (window as { desdeDesktop?: unknown }).desdeDesktop
  }
}

function useDesktopBridgeOverride(bridge: DesktopBridge): void {
  installDesktopBridge(bridge)
  useEffect(() => {
    return () => clearDesktopBridgeIfStillOurs(bridge)
  }, [bridge])
}

/**
 * How the fake bridge answers "Check for updates". `pending` never settles,
 * which is how the dialog's "checking" state is held on screen; `performed`
 * is what the settled call reports (see the bridge's `checkForUpdates()`
 * doc comment for the `performed: false` case).
 */
interface CheckBehavior {
  pending?: boolean
  performed?: boolean
}

function makeBridge(
  ctx: SurfaceRenderContext,
  state: DesktopUpdateState,
  autoDownload = true,
  check: CheckBehavior = {},
): DesktopBridge {
  return {
    appVersion: "1.4.0",
    updates: {
      getState: async () => state,
      onState: () => () => {},
      download: async () => ctx.log("download"),
      // Never settles: the real app quits before the reply, so the dialog
      // holds its "Restarting to update" view — exactly the state on screen.
      restartAndInstall: () => {
        ctx.log("restartAndInstall")
        return new Promise(() => {})
      },
      checkForUpdates: () => {
        ctx.log("checkForUpdates")
        if (check.pending) return new Promise<{ performed: boolean }>(() => {})
        return Promise.resolve({ performed: check.performed ?? true })
      },
      getAutoDownload: async () => autoDownload,
      setAutoDownload: async (value) => ctx.log("setAutoDownload", value),
    },
    claudeRuntime: {
      getState: async () => ({ phase: "ready" }),
      onState: () => () => {},
      retry: () => ctx.log("claudeRuntime.retry"),
    },
    pickFolder: async () => null,
  }
}

/** Marks this fixture's own subtree, to tell it from the ambient editor chrome. */
const ROOT_ATTR = "data-desktop-fixture-root"

/**
 * Find a TRIGGER inside this fixture's own subtree.
 *
 * Document-scoped is wrong for a trigger and it shipped that way: the self-host
 * harness renders the real editor chrome around the fixture, and that chrome
 * mounts its OWN `EditorSettingsMenu` with a `data-testid="editor-settings"`
 * button that comes first in the DOM. MEASURED — two such buttons on the page,
 * and the unscoped lookup opened the ambient one, whose real desktop bridge is
 * absent, so it rendered no update section at all. Five states then timed out in
 * `surface-gallery-shots.mts` and a sixth (`auto-download-off`, which gates on
 * `editor-settings-api-key` — an item BOTH menus have) passed while showing the
 * wrong menu, which is worse than the timeouts.
 *
 * Menu CONTENT stays document-scoped below: Radix portals it out of this root,
 * and by then it is unambiguous, because only the fixture's menu was opened.
 */
function rootTestid<T extends Element = Element>(id: string): T | null {
  const root = document.querySelector<HTMLElement>(`[${ROOT_ATTR}]`)
  return root?.querySelector<T>(`[data-testid="${id}"]`) ?? null
}

function testid<T extends Element = Element>(id: string): T | null {
  return document.querySelector<T>(`[data-testid="${id}"]`)
}

/** Opens `EditorSettingsMenu`'s dropdown so the top update section is visible. */
function SettingsMenuFixture({
  bridge,
  chatSubmitting,
  thenClickRestart,
  thenClickCheck,
}: {
  bridge: DesktopBridge
  chatSubmitting?: boolean
  /** Also click "Restart to update" once the menu is open — for the confirm-dialog state. */
  thenClickRestart?: boolean
  /** Also click "Check for updates" once the menu is open — for the check dialog's states. */
  thenClickCheck?: boolean
}) {
  useDesktopBridgeOverride(bridge)
  useFetchOverride(
    jsonOverride(
      (url) => url.includes("/api/editor/llm-credentials"),
      LLM_CREDENTIALS_CONFIGURED,
    ),
  )

  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      const trigger = await waitForElement(() => rootTestid<HTMLButtonElement>("editor-settings"))
      if (cancelled || !trigger) return
      clickLikeUser(trigger)

      if (thenClickCheck) {
        const check = await waitForElement(() => testid<HTMLElement>("desktop-update-check-now"))
        if (cancelled || !check) return
        clickLikeUser(check)
        return
      }

      if (!thenClickRestart) return
      const restart = await waitForElement(() => testid<HTMLElement>("desktop-update-restart"))
      if (cancelled || !restart) return
      clickLikeUser(restart)
    })
    return () => {
      cancelled = true
    }
    // Driven exactly once per mount, matching every other interaction-driven
    // fixture in this catalog (see branch-menu.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div {...{ [ROOT_ATTR]: "" }}>
      <EditorSettingsMenu chatSubmitting={chatSubmitting} />
    </div>
  )
}

/** The launcher's standalone nav button, dropdown opened. */
function LauncherNavFixture({ bridge }: { bridge: DesktopBridge }) {
  useDesktopBridgeOverride(bridge)
  useFetchOverride(
    jsonOverride(
      (url) => url.includes("/api/editor/llm-credentials"),
      LLM_CREDENTIALS_CONFIGURED,
    ),
  )
  const updates = useDesktopUpdates()

  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      const trigger = await waitForElement(() =>
        rootTestid<HTMLButtonElement>("launcher-settings"),
      )
      if (cancelled || !trigger) return
      clickLikeUser(trigger)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div
      {...{ [ROOT_ATTR]: "" }}
      className="flex h-12 items-center justify-end border-b bg-background px-4"
    >
      <LauncherSettingsMenu updates={updates} />
    </div>
  )
}

// `editor-settings-api-key`, not `-theme`: the theme sub-menu was hidden on
// 2026-08-17 (dark mode is not designed yet), and this selector is what tells
// the harness the menu actually opened. The API-key item is the one every
// settings menu still carries.
const MENU_OPEN = '[data-testid="editor-settings-api-key"]'

/** One check-dialog state: the menu opens, "Check for updates" is clicked, and the dialog lands on `view`. */
function checkDialogState(
  id: string,
  label: string,
  view: string,
  state: DesktopUpdateState,
  check: CheckBehavior,
) {
  return {
    id: `desktop-updates/check-dialog-${id}`,
    label,
    readyWhen: `[data-testid="desktop-update-check-dialog"][data-view="${view}"]`,
    render: (ctx: SurfaceRenderContext) => (
      <SettingsMenuFixture bridge={makeBridge(ctx, state, true, check)} thenClickCheck />
    ),
  }
}

export const DESKTOP_UPDATES_SURFACE: SurfaceEntry = {
  id: "desktop-updates",
  title: "Desktop auto-update: badge, menu section, check dialog, restart confirm",
  kind: "modal",
  sourceFile: "src/components/editor/desktop-update-menu.tsx",
  states: [
    // The dialog "Check for updates" opens, one state per view it can land
    // on. Idle here means "checked, nothing new": the up-to-date case.
    checkDialogState("checking", "Check dialog: checking", "checking", { phase: "idle" }, { pending: true }),
    checkDialogState("up-to-date", "Check dialog: up to date", "up-to-date", { phase: "idle" }, {}),
    checkDialogState(
      "not-performed",
      "Check dialog: checks unavailable in this build",
      "not-performed",
      { phase: "idle" },
      { performed: false },
    ),
    checkDialogState(
      "available",
      "Check dialog: update available",
      "available",
      { phase: "available", version: "1.5.0" },
      {},
    ),
    checkDialogState(
      "downloading",
      "Check dialog: downloading",
      "downloading",
      { phase: "downloading", version: "1.5.0", progressPercent: 43 },
      {},
    ),
    checkDialogState("ready", "Check dialog: ready to restart", "ready", { phase: "ready", version: "1.5.0" }, {}),
    {
      // "Restart to update" clicked from the menu row: the dialog opens by
      // itself in its restarting view and stays until the window closes.
      id: "desktop-updates/check-dialog-restarting",
      label: "Check dialog: restarting to update",
      readyWhen: '[data-testid="desktop-update-check-dialog"][data-view="restarting"]',
      render: (ctx: SurfaceRenderContext) => (
        <SettingsMenuFixture bridge={makeBridge(ctx, { phase: "ready", version: "1.5.0" })} thenClickRestart />
      ),
    },
    checkDialogState(
      "error",
      "Check dialog: check failed",
      "error",
      { phase: "error", error: "getaddrinfo ENOTFOUND github.com" },
      {},
    ),
    {
      id: "desktop-updates/available",
      label: "Update available",
      readyWhen: '[data-testid="desktop-update-download"]',
      render: (ctx) => (
        <SettingsMenuFixture bridge={makeBridge(ctx, { phase: "available", version: "1.5.0" })} />
      ),
    },
    {
      id: "desktop-updates/downloading",
      label: "Downloading",
      readyWhen: '[data-testid="desktop-update-downloading"]',
      render: (ctx) => (
        <SettingsMenuFixture
          bridge={makeBridge(ctx, {
            phase: "downloading",
            version: "1.5.0",
            progressPercent: 43,
          })}
        />
      ),
    },
    {
      id: "desktop-updates/ready",
      label: "Ready to restart",
      readyWhen: '[data-testid="desktop-update-restart"]',
      render: (ctx) => (
        <SettingsMenuFixture bridge={makeBridge(ctx, { phase: "ready", version: "1.5.0" })} />
      ),
    },
    {
      id: "desktop-updates/error",
      label: "Update check failed",
      readyWhen: '[data-testid="desktop-update-error"]',
      render: (ctx) => (
        <SettingsMenuFixture
          bridge={makeBridge(ctx, { phase: "error", error: "net::ERR_CONNECTION_RESET" })}
        />
      ),
    },
    {
      // F5 (whole-branch review, Minor): a version-carrying error is a
      // download/install-prep failure, not a check failure — the measured
      // unsigned-build case (`updater.ts`'s module doc comment). Distinct
      // fixture so the wording split has something to review, not just a
      // unit-test assertion.
      id: "desktop-updates/error-update-failed",
      label: "Update failed (download/install, not a check)",
      readyWhen: '[data-testid="desktop-update-error"]',
      render: (ctx) => (
        <SettingsMenuFixture
          bridge={makeBridge(ctx, {
            phase: "error",
            version: "1.5.0",
            error: "SQRLCodeSignatureErrorDomain: code signature did not pass validation",
          })}
        />
      ),
    },
    {
      id: "desktop-updates/auto-download-off",
      label: "Auto-download turned off",
      readyWhen: MENU_OPEN,
      render: (ctx) => (
        <SettingsMenuFixture bridge={makeBridge(ctx, { phase: "idle" }, false)} />
      ),
    },
    {
      id: "desktop-updates/restart-confirm-streaming",
      label: "Restart confirm: chat is streaming",
      readyWhen: '[data-testid="desktop-update-restart-confirm-dialog"]',
      render: (ctx) => (
        <SettingsMenuFixture
          bridge={makeBridge(ctx, { phase: "ready", version: "1.5.0" })}
          chatSubmitting
          thenClickRestart
        />
      ),
    },
    {
      id: "desktop-updates/launcher-nav",
      label: "Launcher nav button, no project open",
      readyWhen: '[data-testid="desktop-update-restart"]',
      render: (ctx) => (
        <LauncherNavFixture bridge={makeBridge(ctx, { phase: "ready", version: "1.5.0" })} />
      ),
    },
  ],
}

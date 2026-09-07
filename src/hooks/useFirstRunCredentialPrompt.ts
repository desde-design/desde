"use client"

/**
 * Decides whether to show the first-run credential prompt.
 *
 * **Dismissal lives on the server, not in `localStorage`.** The editor's
 * origin is not stable: the launcher and the desktop app pick a free port per
 * project, and `localStorage` is scoped by origin including the port, so a
 * browser-side dismissal was forgotten every time a project reopened on a
 * different port. The credential store is machine-level and does not move.
 *
 * The dialog is deliberately DISMISSIBLE. Most of Editor works with no model
 * at all: the inspector, layers tree, deterministic applicators, comments,
 * Commit and Publish never touch an LLM. A blocking dialog would gate a
 * product that mostly works.
 */

import { useCallback, useState } from "react"
import { everyProviderUncredentialed, type LlmCredentialsStatus } from "./useLlmCredentials"

export interface FirstRunCredentialPrompt {
  shouldPrompt: boolean
  dismiss: () => void
}

export function useFirstRunCredentialPrompt(
  status: LlmCredentialsStatus | null,
  persistDismissal: () => Promise<unknown>,
): FirstRunCredentialPrompt {
  // Local echo so the dialog closes immediately, without waiting for the
  // round-trip. The server value is what survives a reload.
  const [dismissedLocally, setDismissedLocally] = useState(false)

  const dismiss = useCallback(() => {
    setDismissedLocally(true)
    // Fire and forget: a failed write means the prompt returns next launch,
    // which is the safe failure. It must never block closing the dialog.
    void persistDismissal()
  }, [persistDismissal])

  // `status === null` means the fetch has not resolved. Prompting then would
  // flash the dialog on every load for a fully configured user.
  //
  // The condition is EVERY provider, not one: a user with an OpenAI key and no
  // Anthropic key is configured, and asking them again would be the
  // single-provider assumption surviving into a multi-provider product.
  const shouldPrompt =
    status !== null &&
    everyProviderUncredentialed(status) &&
    !status.promptDismissed &&
    !dismissedLocally

  return { shouldPrompt, dismiss }
}

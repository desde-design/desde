/**
 * Surface-gallery fixture for the Anthropic credential dialog.
 *
 * Every reachable status gets a state, because the four `source` values drive
 * genuinely different chrome: `env` removes the input and both write buttons,
 * `stored` adds Remove, and dev mode changes the description while leaving key
 * management enabled (which is the pairing most likely to regress).
 *
 * The status comes through `useFetchOverride` rather than a hand-built object:
 * the fixture owns a real `useLlmCredentials` and lets the override answer its
 * mount fetch, so what renders here is what the product renders.
 */

import { LlmCredentialDialog } from "@/components/editor/llm-credential-dialog"
import { useLlmCredentials, type LlmCredentialsStatus } from "@/hooks/useLlmCredentials"
import type { SurfaceEntry } from "../types"
import { useFetchOverride } from "./fetch-override"

function CredentialDialogFixture({ status }: { status: LlmCredentialsStatus }) {
  useFetchOverride({
    match: (url) => url.includes("/api/editor/llm-credentials"),
    respond: () => ({ status: 200, body: status }),
  })
  // The dialog takes credential state from its caller, so the fixture owns
  // the hook. The override above is what the hook's mount fetch resolves to.
  const credentials = useLlmCredentials()
  return <LlmCredentialDialog open onOpenChange={() => {}} credentials={credentials} />
}

/** Every state settles on the dialog title, which renders for all of them. */
const READY_WHEN = "[data-slot='dialog-content']"

/** Fills the fields every state shares, so each case names only its own. */
function state(
  id: string,
  label: string,
  status: Omit<LlmCredentialsStatus, "hasStoredKey" | "promptDismissed"> &
    Partial<Pick<LlmCredentialsStatus, "hasStoredKey" | "promptDismissed">>,
) {
  const full: LlmCredentialsStatus = {
    hasStoredKey: status.storedHint !== undefined,
    promptDismissed: false,
    ...status,
  }
  return {
    id: `llm-credentials/${id}`,
    label,
    readyWhen: READY_WHEN,
    render: () => <CredentialDialogFixture status={full} />,
  }
}

export const LLM_CREDENTIALS_SURFACE: SurfaceEntry = {
  id: "llm-credentials",
  title: "Anthropic API key: first run, settings, dev mode",
  kind: "modal",
  sourceFile: "src/components/editor/llm-credential-dialog.tsx",
  states: [
    state("none", "No credential (first run)", { source: "none", devMode: false }),
    state("stored", "Stored key", {
      source: "stored",
      maskedHint: "sk-ant-…4f2a",
      storedHint: "sk-ant-…4f2a",
      devMode: false,
    }),
    state("env", "Set by environment variable", {
      source: "env",
      maskedHint: "sk-ant-…4f2a",
      devMode: false,
    }),
    state("subscription", "Claude subscription", {
      source: "subscription",
      devMode: false,
    }),
    state("dev-mode", "Dev mode on, no key", {
      source: "subscription",
      devMode: true,
    }),
    state("dev-mode-with-key", "Dev mode on, key stored", {
      source: "subscription",
      storedHint: "sk-ant-…4f2a",
      devMode: true,
    }),
  ],
}

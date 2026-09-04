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
import {
  useLlmCredentials,
  type LlmCredentialsStatus,
  type ProviderCredentialStatus,
} from "@/hooks/useLlmCredentials"
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

/** Fields every Anthropic fixture state shares. */
const ANTHROPIC_BASE = {
  id: "anthropic",
  label: "Anthropic",
  apiKeyEnvVar: "ANTHROPIC_API_KEY",
  consoleUrl: "https://console.anthropic.com/settings/keys",
  maskPrefix: "sk-ant-",
  hasSubscriptionRuntime: true,
} as const

/**
 * Fills the fields every state shares, so each case names only its own. The
 * dialog reads Anthropic's row out of the map today (Task 7 adds tabs), so
 * every fixture state builds the map shape with a single `anthropic` entry.
 */
function state(
  id: string,
  label: string,
  anthropic: Omit<ProviderCredentialStatus, "hasStoredKey" | keyof typeof ANTHROPIC_BASE> &
    Partial<Pick<ProviderCredentialStatus, "hasStoredKey">>,
  overrides: Partial<Pick<LlmCredentialsStatus, "devMode" | "promptDismissed">> = {},
) {
  const providerStatus: ProviderCredentialStatus = {
    ...ANTHROPIC_BASE,
    hasStoredKey: anthropic.storedHint !== undefined,
    ...anthropic,
  }
  const full: LlmCredentialsStatus = {
    providers: { anthropic: providerStatus },
    devMode: false,
    promptDismissed: false,
    ...overrides,
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
    state("none", "No credential (first run)", { source: "none" }),
    state(
      "stored",
      "Stored key",
      { source: "stored", maskedHint: "sk-ant-…4f2a", storedHint: "sk-ant-…4f2a" },
    ),
    state(
      "env",
      "Set by environment variable",
      { source: "env", maskedHint: "sk-ant-…4f2a" },
    ),
    state("subscription", "Claude subscription", { source: "subscription" }),
    state(
      "dev-mode",
      "Dev mode on, no key",
      { source: "subscription" },
      { devMode: true },
    ),
    state(
      "dev-mode-with-key",
      "Dev mode on, key stored",
      { source: "subscription", storedHint: "sk-ant-…4f2a" },
      { devMode: true },
    ),
  ],
}

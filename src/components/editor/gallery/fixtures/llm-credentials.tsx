/**
 * Surface-gallery fixture for the AI provider credential dialog.
 *
 * One tab per provider (Task 7), so the fixture states cover the
 * combinations that render differently: both providers unconfigured, one
 * provider stored while the other is not, both stored, one provider
 * environment-managed while the other is stored, a provider with a base URL
 * set, and dev mode on while a non-Anthropic tab has a key stored (the
 * pairing most likely to regress, because dev mode must not disable the
 * other tab).
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

/** Fields every OpenAI fixture state shares. */
const OPENAI_BASE = {
  id: "openai",
  label: "OpenAI",
  apiKeyEnvVar: "OPENAI_API_KEY",
  baseUrlEnvVar: "OPENAI_BASE_URL",
  consoleUrl: "https://platform.openai.com/api-keys",
  maskPrefix: "sk-",
  hasSubscriptionRuntime: false,
} as const

type PartialAnthropic = Omit<
  ProviderCredentialStatus,
  "hasStoredKey" | keyof typeof ANTHROPIC_BASE
> &
  Partial<Pick<ProviderCredentialStatus, "hasStoredKey">>
type PartialOpenAI = Omit<
  ProviderCredentialStatus,
  "hasStoredKey" | keyof typeof OPENAI_BASE
> &
  Partial<Pick<ProviderCredentialStatus, "hasStoredKey">>

function anthropicProvider(partial: PartialAnthropic): ProviderCredentialStatus {
  return {
    ...ANTHROPIC_BASE,
    hasStoredKey: partial.storedHint !== undefined,
    ...partial,
  }
}

function openaiProvider(partial: PartialOpenAI): ProviderCredentialStatus {
  return {
    ...OPENAI_BASE,
    hasStoredKey: partial.storedHint !== undefined,
    ...partial,
  }
}

/**
 * Fills the fields every state shares, so each case names only what makes it
 * different. Both providers default to unconfigured, so a case that cares
 * about only one tab need not restate the other.
 */
function state(
  id: string,
  label: string,
  providers: {
    anthropic?: PartialAnthropic
    openai?: PartialOpenAI
  },
  overrides: Partial<Pick<LlmCredentialsStatus, "devMode" | "promptDismissed">> = {},
) {
  const full: LlmCredentialsStatus = {
    providers: {
      anthropic: anthropicProvider(providers.anthropic ?? { source: "none" }),
      openai: openaiProvider(providers.openai ?? { source: "none" }),
    },
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
  title: "AI provider keys: first run, settings, dev mode",
  kind: "modal",
  sourceFile: "src/components/editor/llm-credential-dialog.tsx",
  states: [
    state("none", "No credential, either provider (first run)", {}),
    state("anthropic-stored", "Anthropic stored, OpenAI unset", {
      anthropic: { source: "stored", maskedHint: "sk-ant-…4f2a", storedHint: "sk-ant-…4f2a" },
    }),
    state("both-stored", "Both providers stored", {
      anthropic: { source: "stored", maskedHint: "sk-ant-…4f2a", storedHint: "sk-ant-…4f2a" },
      openai: { source: "stored", maskedHint: "sk-…9a11", storedHint: "sk-…9a11" },
    }),
    state("openai-env", "OpenAI set by environment variable, Anthropic stored", {
      anthropic: { source: "stored", maskedHint: "sk-ant-…4f2a", storedHint: "sk-ant-…4f2a" },
      openai: { source: "env", maskedHint: "sk-…9a11" },
    }),
    state("openai-base-url", "OpenAI with a base URL set", {
      openai: {
        source: "stored",
        maskedHint: "sk-…9a11",
        storedHint: "sk-…9a11",
        baseUrl: "https://my-proxy.internal/v1",
      },
    }),
    state(
      "dev-mode-openai-key",
      "Dev mode on, OpenAI key stored",
      {
        anthropic: { source: "subscription" },
        openai: { source: "stored", maskedHint: "sk-…9a11", storedHint: "sk-…9a11" },
      },
      { devMode: true },
    ),
  ],
}

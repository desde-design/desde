/**
 * Which provider the NON-CHAT lanes run on for this project.
 *
 * The six lanes (`apply-llm-patch`, `repair-edit`, `iteration-data-llm`,
 * `verification/translate-goal`, `hints/llm-generate-hints`, and
 * `design-systems-handler`'s hint generation) run outside any chat session, so
 * the model picker's per-session choice does not apply to them. They get a
 * project-level answer instead, resolved once per request.
 *
 * The provider id comes from the SAME `resolveDefaultProviderId` the catalog
 * and the picker use, so the lanes cannot end up on a different provider than
 * the one the rest of the product calls the default.
 */
import {
  isCredentialedFromEnv,
  resolveDefaultProviderId,
} from "../../../src/editor/llm-providers/provider-registry.js"
import { configForProvider, type LLMConfig } from "../../../src/editor/llm-providers/registry.js"
import type { ProjectConfig } from "./project-config.js"

export function resolveLlmConfig(
  projectConfig: Pick<ProjectConfig, "llm"> | undefined,
  env: NodeJS.ProcessEnv,
): LLMConfig {
  const configured = projectConfig?.llm
  const providerId = resolveDefaultProviderId({
    env,
    ...(configured?.defaultProvider ? { configuredDefault: configured.defaultProvider } : {}),
    isCredentialed: (d) => isCredentialedFromEnv(d, env),
  })
  const base = configForProvider(providerId, env)
  // Overrides are looked up by the RESOLVED id, not by the configured default:
  // naming an uncredentialed provider must not drag its model override onto
  // whichever provider actually answers.
  const overrides = configured?.providers?.[base.provider]
  return {
    ...base,
    model: overrides?.model ?? base.model,
    apiKeyEnv: overrides?.apiKeyEnv ?? base.apiKeyEnv,
    baseUrl: overrides?.baseUrl ?? base.baseUrl,
  }
}

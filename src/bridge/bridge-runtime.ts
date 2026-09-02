/**
 * Desde Bridge — late-bound runtime dependencies
 *
 * The extracted manager classes (flow recorder/player, screenshot generator,
 * pin/overlay managers) used to call a few functions that close over the bridge
 * IIFE — the shell message channel (`sendToShell`) and the inspector's full
 * element reader (`inspectElement`). Those can't move out of `comment-bridge.ts`
 * cheaply, so instead they're injected here once at init via
 * `configureBridgeRuntime(...)`, and the manager modules import these live
 * bindings. esbuild preserves the live binding across the bundle, so a manager
 * that calls `sendToShell(...)` resolves to the real channel after configure
 * runs (which `comment-bridge.ts` does before instantiating any manager).
 */

import type { Attribution } from "./bridge-types"

type SendToShell = (message: Record<string, unknown>) => void
type InspectElement = (el: Element) => Record<string, unknown>
type AttributeElement = (el: Element) => Attribution | undefined

export let sendToShell: SendToShell = () => {}
export let inspectElement: InspectElement = () => ({})
export let attributeElement: AttributeElement = () => undefined

export function configureBridgeRuntime(deps: {
  sendToShell: SendToShell
  inspectElement: InspectElement
  attributeElement: AttributeElement
}): void {
  sendToShell = deps.sendToShell
  inspectElement = deps.inspectElement
  attributeElement = deps.attributeElement
}

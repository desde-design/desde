/**
 * Re-export of the shared driven-interaction helpers — see
 * `@/components/gallery/dom-interaction`. They moved up a level when the
 * Viewer gained a catalog of its own; this file stays so the fixtures beside
 * it keep their existing import path.
 */
export {
  clickLikeUser,
  findButtonByText,
  findByText,
  runDrivenInteraction,
  setNativeValue,
  waitForElement,
  type WaitForElementOptions,
} from "@/components/gallery/dom-interaction"

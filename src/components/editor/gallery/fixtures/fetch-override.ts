/**
 * Re-export of the shared `window.fetch` router — see
 * `@/components/gallery/fetch-override`, which carries the full explanation of
 * why it is a router rather than per-fixture save/restore. It moved up a level
 * when the Viewer gained a catalog of its own; this file stays so the fixtures
 * beside it keep their existing import path.
 */
export {
  NETWORK_ERROR,
  PENDING,
  fail,
  jsonOverride,
  ok,
  routeTable,
  useFetchOverride,
  type FetchOverrideResult,
} from "@/components/gallery/fetch-override"

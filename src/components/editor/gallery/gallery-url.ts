/**
 * Re-export of the shared `?gallery=…&theme=…` parser — see
 * `@/components/gallery/gallery-url`. Kept here so `editor-cli/self-host`'s
 * entry keeps its existing import path.
 */
export { parseGalleryParams, type GalleryParams } from "@/components/gallery/gallery-url"

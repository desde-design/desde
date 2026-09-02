export interface GalleryParams {
  /**
   * `null` when gallery mode is off entirely. `""` means gallery mode is on
   * with nothing selected yet — the distinction is what keeps the Editor's
   * self-host harness inert for every normal boot. (The Viewer's gallery is a
   * dedicated entry point, so there gallery mode is always on and only the
   * selection varies.)
   */
  stateId: string | null
  theme: "light" | "dark"
}

export function parseGalleryParams(search: string): GalleryParams {
  const params = new URLSearchParams(search)
  const raw = params.get("gallery")
  return {
    stateId: raw,
    theme: params.get("theme") === "dark" ? "dark" : "light",
  }
}

/**
 * Portraits for the three seeded reviewers (`demo-comments.ts`): cats.
 *
 * The product draws cats for its empty states and loaders, so the demo's
 * fictional reviewers are cats too (Mo, 2026-09-03). Drawn rather than
 * photographed for the same reason as before: these people do not exist, and
 * a stock photo would put a real face on a made-up name.
 *
 * Each is a small flat SVG embedded as a data URI, so it needs no host and no
 * serving: the pin renders INSIDE the prototype's origin, where the CSP
 * allows `img-src data:` and nothing else the shell could offer, and the rail
 * renders in the shell. Base64 keeps every URI well under the API's
 * 2,048-character cap on `author.photoURL` (`comments-routes.ts`), so the same
 * authors survive a sync from the Editor to a viewer.
 *
 * Drawn to read at 24px, which is the size the rail shows: a strong
 * silhouette, ears that break the circle, and eyes big enough to survive the
 * downscale. Detail finer than a whisker is wasted there.
 */

const OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><clipPath id="c"><circle cx="32" cy="32" r="32"/></clipPath><g clip-path="url(#c)">'
const CLOSE = "</g></svg>"

/** Ears, head, muzzle: the shape every cat below shares. */
function face(opts: {
  bg: string
  fur: string
  furDark: string
  inner: string
  muzzle: string
  eye: string
  extra?: string
}): string {
  const { bg, fur, furDark, inner, muzzle, eye, extra = "" } = opts
  return (
    OPEN +
    `<rect width="64" height="64" fill="${bg}"/>` +
    // Ears, then the head over their base.
    `<path d="M13 30 15 9l17 10z" fill="${fur}"/><path d="M51 30 49 9 32 19z" fill="${fur}"/>` +
    `<path d="M17.5 26 18.5 15l9.5 5.5z" fill="${inner}"/><path d="M46.5 26 45.5 15 36 20.5z" fill="${inner}"/>` +
    `<ellipse cx="32" cy="34" rx="20" ry="18" fill="${fur}"/>` +
    extra +
    // Muzzle, nose, mouth.
    `<ellipse cx="32" cy="41" rx="10.5" ry="7.5" fill="${muzzle}"/>` +
    `<path d="M28.8 38.2h6.4L32 41.6z" fill="${furDark}"/>` +
    `<path d="M32 41.6v2.6M32 44.2q-2.6 2-4.6 0M32 44.2q2.6 2 4.6 0" stroke="${furDark}" stroke-width="1.1" fill="none" stroke-linecap="round"/>` +
    // Eyes: a dark almond with a highlight, which is what survives at 24px.
    `<ellipse cx="24" cy="31" rx="3.6" ry="4.2" fill="${eye}"/><ellipse cx="40" cy="31" rx="3.6" ry="4.2" fill="${eye}"/>` +
    `<circle cx="25.2" cy="29.6" r="1.2" fill="#fff"/><circle cx="41.2" cy="29.6" r="1.2" fill="#fff"/>` +
    // Whiskers.
    `<path d="M21 40.5 12 38.5M21 43 12.5 43.5M43 40.5 52 38.5M43 43 51.5 43.5" stroke="${furDark}" stroke-width="1" fill="none" stroke-linecap="round" opacity=".65"/>` +
    CLOSE
  )
}

/** Priya Raman: a ginger tabby, with the forehead stripes. */
const PRIYA = face({
  bg: "#F6DCC8",
  fur: "#D98441",
  furDark: "#8A4A1E",
  inner: "#F2B8A0",
  muzzle: "#F0C9A5",
  eye: "#3B2412",
  extra:
    '<path d="M26 21.5 24.5 27M32 20.5 32 26.5M38 21.5 39.5 27" stroke="#B4652C" stroke-width="1.6" fill="none" stroke-linecap="round"/>',
})

/** Ana Whitfield: a grey cat with a white blaze. */
const ANA = face({
  bg: "#DDE6E4",
  fur: "#8C949B",
  furDark: "#4A5158",
  inner: "#E3C3C0",
  muzzle: "#EDEFF0",
  eye: "#2E3439",
  extra: '<path d="M32 17q5 9 3.5 18h-7Q27 26 32 17z" fill="#EDEFF0"/>',
})

/** Tomas Iversen: a tuxedo cat, white bib and muzzle. */
const TOMAS = face({
  bg: "#D8E3F0",
  fur: "#33383E",
  furDark: "#15181C",
  inner: "#C99A93",
  muzzle: "#F4F5F6",
  eye: "#2A2E33",
  // The blaze alone. A chest bib was tried and the circle clipped it into a
  // white box under the chin.
  extra: '<path d="M32 22q6 9 5 22H27q-1-13 5-22z" fill="#F4F5F6"/>',
})

function dataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`
}

export const DEMO_AVATARS = {
  priya: dataUri(PRIYA),
  ana: dataUri(ANA),
  tomas: dataUri(TOMAS),
} as const

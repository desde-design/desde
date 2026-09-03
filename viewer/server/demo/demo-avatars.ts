/**
 * Portraits for the three seeded reviewers (`demo-comments.ts`).
 *
 * They are drawn, not photographed: these people do not exist, and a stock
 * photo would put a real face on a fictional name. Each is a small flat SVG,
 * embedded as a data URI so it needs no host and no serving: the pin renders
 * INSIDE the prototype's origin, where the CSP allows `img-src data:` and
 * nothing else the shell could offer, and the rail renders in the shell.
 * Base64 keeps every URI well under the API's 2,048-character cap on
 * `author.photoURL` (`comments-routes.ts`), so the same authors survive a
 * sync from the Editor to a viewer.
 *
 * Mo (2026-09-02): "put some profile pics instead of the initial in the
 * comment pin and comment content".
 */

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><clipPath id="c"><circle cx="32" cy="32" r="32"/></clipPath><g clip-path="url(#c)">'
const SVG_CLOSE = "</g></svg>"

/** Priya Raman: long dark hair, coral shirt. */
const PRIYA =
  SVG_OPEN +
  '<rect width="64" height="64" fill="#F4D3C4"/>' +
  '<path d="M16 27c0-13 7-20 16-20s16 7 16 20v24H16z" fill="#2B1B12"/>' +
  '<path d="M9 64c0-12 10-18 23-18s23 6 23 18z" fill="#C8553D"/>' +
  '<rect x="27" y="35" width="10" height="10" rx="4" fill="#8D5A3B"/>' +
  '<ellipse cx="32" cy="27" rx="11.5" ry="13" fill="#A9714B"/>' +
  '<path d="M20.5 25c1-9 5.5-13 11.5-13s10.5 4 11.5 13c-3-4.5-7-6.5-11.5-6.5S23.5 20.5 20.5 25z" fill="#2B1B12"/>' +
  '<circle cx="27.5" cy="27.5" r="1.4" fill="#2B1B12"/><circle cx="36.5" cy="27.5" r="1.4" fill="#2B1B12"/>' +
  '<path d="M28.5 33.5q3.5 2.6 7 0" stroke="#7A4A2E" stroke-width="1.3" fill="none" stroke-linecap="round"/>' +
  SVG_CLOSE

/** Ana Whitfield: auburn bob, round glasses, mustard top. */
const ANA =
  SVG_OPEN +
  '<rect width="64" height="64" fill="#DCE8D5"/>' +
  '<path d="M9 64c0-12 10-18 23-18s23 6 23 18z" fill="#D9A441"/>' +
  '<rect x="27" y="35" width="10" height="10" rx="4" fill="#D9A97F"/>' +
  '<path d="M18 30c0-14 6-21 14-21s14 7 14 21v9H18z" fill="#B5562D"/>' +
  '<ellipse cx="32" cy="28" rx="11.5" ry="13" fill="#F1C9A5"/>' +
  '<path d="M20.5 27c0-10 5-15 11.5-15s11.5 5 11.5 15c-2.5-5.5-6.5-8-11.5-8s-9 2.5-11.5 8z" fill="#B5562D"/>' +
  '<circle cx="27" cy="28.5" r="3.6" stroke="#3B2A1A" stroke-width="1.3" fill="none"/><circle cx="37" cy="28.5" r="3.6" stroke="#3B2A1A" stroke-width="1.3" fill="none"/><path d="M30.6 28.5h2.8" stroke="#3B2A1A" stroke-width="1.3"/>' +
  '<circle cx="27" cy="28.7" r="1.2" fill="#3B2A1A"/><circle cx="37" cy="28.7" r="1.2" fill="#3B2A1A"/>' +
  '<path d="M28.5 34.5q3.5 2.4 7 0" stroke="#B9785A" stroke-width="1.3" fill="none" stroke-linecap="round"/>' +
  SVG_CLOSE

/** Tomas Iversen: short fair hair, beard, navy shirt. */
const TOMAS =
  SVG_OPEN +
  '<rect width="64" height="64" fill="#D6E4F2"/>' +
  '<path d="M9 64c0-12 10-18 23-18s23 6 23 18z" fill="#2F4A6B"/>' +
  '<rect x="27" y="35" width="10" height="10" rx="4" fill="#C9955F"/>' +
  '<ellipse cx="32" cy="27.5" rx="11.5" ry="13" fill="#E8B48C"/>' +
  '<path d="M21 34c1 6 5 9 11 9s10-3 11-9c-3 3-7 4.5-11 4.5S24 37 21 34z" fill="#7A5C33"/>' +
  '<path d="M20.5 24c0-8.5 5-12.5 11.5-12.5S43.5 15.5 43.5 24c-2.5-4-6.5-5.5-11.5-5.5S23 20 20.5 24z" fill="#8A6A3B"/>' +
  '<circle cx="27.5" cy="27.5" r="1.4" fill="#2B1B12"/><circle cx="36.5" cy="27.5" r="1.4" fill="#2B1B12"/>' +
  '<path d="M29 33.2q3 2 6 0" stroke="#5E4426" stroke-width="1.3" fill="none" stroke-linecap="round"/>' +
  SVG_CLOSE

function dataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`
}

export const DEMO_AVATARS = {
  priya: dataUri(PRIYA),
  ana: dataUri(ANA),
  tomas: dataUri(TOMAS),
} as const

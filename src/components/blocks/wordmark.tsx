import { cn } from "@/lib/utils"

/**
 * The product wordmark — "Desde", as outlines.
 *
 * ## Why this is a path and not a text node
 *
 * It used to be the string "Desde" in `font-display`, which was Chillax, the
 * ONLY self-hosted face in the product. That made a 55KB variable font file a
 * dependency of five glyphs, in two copies (here and in the website's own
 * tree, kept identical by hand), inside every packaged desktop build.
 *
 * It was also a licence problem the moment the repository went public on
 * 2026-09-01. The ITF Free Font License permits self-hosting the file for our
 * own sites (Section 01) but forbids providing the Font Software to third
 * parties (Section 02) — and a public repo hands the `.woff2` to everyone who
 * clones it. The same licence explicitly carves out what this file is:
 * "Derivative Work does not include any logo ... created through the normal
 * use of the Font Software."
 *
 * So the glyphs are shipped as geometry and the font is gone. No `@font-face`,
 * no FOUT on the one element that IS the brand, and the mark renders the same
 * in a context with no CSS at all.
 *
 * ## Regenerating it
 *
 * `tasks/scripts/extract-wordmark-outlines.py` (needs `fonttools`, `brotli`
 * and `uharfbuzz`). It instantiates the variable axis at wght 500, shapes the
 * word with HarfBuzz so the font's own GPOS kerning is applied rather than
 * guessed, and draws the outlines at the positions HarfBuzz reports. Do not
 * hand-edit the path.
 *
 * ## Sizing
 *
 * The `viewBox` is tight to the INK, so the box carries no invisible padding.
 * Height is `0.727em`, which is the ink height in em units, so the mark still
 * scales with whatever type step the caller sets — `text-2xl` here, exactly as
 * the text node did. MEASURED against the live font at 19px: the rendered ink
 * is identical, and the box is 2.35px narrower because a text node also
 * carries the font's side bearings.
 *
 * `currentColor`, so `text-primary` keeps doing what it did. That token only
 * resolves teal under `[data-theme="teal"]`, which the host document must set.
 */
const DESDE_PATH =
  "M692.35 -337.75Q692.35 -259.37 664.66 -196.84Q636.98 -134.31 587.64 -90.31Q538.29 -46.31 472.16 -23.16Q406.04 0 328.47 0H100.59V-670.2H333.27Q440.84 -670.2 521.63 -628.73Q602.41 -587.25 647.38 -512.63Q692.35 -438 692.35 -337.75ZM587.46 -337.75Q587.46 -409.34 555.16 -462.78Q522.87 -516.22 465.71 -545.96Q408.55 -575.69 333.27 -575.69H202.54V-92.93H328.47Q383.2 -92.93 430.11 -109.74Q477.02 -126.54 512.53 -157.97Q548.04 -189.39 567.75 -234.96Q587.46 -280.53 587.46 -337.75Z M1017.7 11.25Q943.88 11.25 884.84 -22.25Q825.8 -55.75 792.05 -114.19Q758.3 -172.63 758.3 -247.76Q758.3 -318.39 789.39 -376.68Q820.49 -434.96 876.37 -469.59Q932.25 -504.21 1005.76 -504.21Q1080.21 -504.21 1133.78 -471.65Q1187.35 -439.08 1216.51 -383.67Q1245.66 -328.25 1245.66 -259.88V-220.37H834.66L853.48 -259.92Q850.05 -208.08 870.07 -166.79Q890.09 -125.51 928.16 -101.37Q966.23 -77.23 1017.08 -77.23Q1062.69 -77.23 1100.48 -96.95Q1138.28 -116.66 1160.2 -157.33L1236.43 -117.84Q1203.74 -54.7 1146.89 -21.73Q1090.04 11.25 1017.7 11.25ZM858.31 -283.86H1146.97Q1145.02 -323.25 1126.29 -352.91Q1107.55 -382.57 1076.45 -398.99Q1045.35 -415.42 1005.14 -415.42Q964.23 -415.42 932.82 -397.96Q901.41 -380.51 882.51 -350.67Q863.62 -320.82 858.31 -283.86Z M1515.33 11.2Q1446.8 11.2 1395.61 -16.09Q1344.41 -43.37 1315.84 -97.63L1391.62 -139.74Q1411.11 -103.39 1440.69 -87.96Q1470.27 -72.52 1511.14 -72.52Q1539.75 -72.52 1561.88 -80.3Q1584.02 -88.07 1596.89 -102.81Q1609.75 -117.55 1609.75 -139.27Q1609.75 -165.25 1589.38 -178.09Q1569 -190.92 1537.29 -198.32Q1505.57 -205.73 1469.51 -213.57Q1433.45 -221.41 1401.74 -236.04Q1370.02 -250.67 1349.65 -277.77Q1329.28 -304.86 1329.28 -351.49Q1329.28 -394.37 1352.72 -427.73Q1376.16 -461.08 1417.45 -480.3Q1458.75 -499.53 1511.65 -499.53Q1557.92 -499.53 1593.4 -486.65Q1628.88 -473.76 1654.66 -451.54Q1680.45 -429.31 1695.82 -400.63L1620.04 -357.51Q1604.49 -390.12 1576.16 -402.96Q1547.82 -415.81 1513.59 -415.81Q1490.98 -415.81 1471.68 -408.19Q1452.39 -400.57 1440.34 -386.84Q1428.29 -373.1 1428.29 -353.43Q1428.29 -328.82 1448.66 -315.68Q1469.03 -302.53 1500.75 -294.78Q1532.47 -287.04 1568.52 -279.04Q1604.58 -271.04 1636.3 -256.41Q1668.02 -241.78 1688.39 -214.66Q1708.76 -187.53 1708.76 -141.21Q1708.76 -94.7 1682.22 -60.51Q1655.68 -26.31 1611.55 -7.56Q1567.41 11.2 1515.33 11.2Z M2032.88 12.25Q1959 12.25 1900.09 -22.72Q1841.18 -57.69 1806.74 -115.97Q1772.3 -174.25 1772.3 -244.2Q1772.3 -318.7 1805.3 -376.99Q1838.3 -435.27 1896.24 -468.62Q1954.18 -501.96 2027.69 -501.96Q2086.98 -501.96 2136.5 -474.44Q2186.02 -446.92 2216.11 -401.09Q2246.2 -355.27 2246.2 -301.17L2194.46 -327.25L2195.14 -714.9H2294.16V-244.2Q2294.16 -171.63 2259.68 -113.34Q2225.21 -55.06 2166.3 -21.4Q2107.39 12.25 2032.88 12.25ZM2032.88 -81.25Q2079.04 -81.25 2115.83 -103.51Q2152.61 -125.78 2173.88 -162.88Q2195.14 -199.98 2195.14 -244.51Q2195.14 -289.04 2173.88 -326.48Q2152.61 -363.93 2115.83 -386.19Q2079.04 -408.46 2032.88 -408.46Q1987.04 -408.46 1950.44 -386.19Q1913.84 -363.93 1892.57 -326.48Q1871.31 -289.04 1871.31 -244.51Q1871.31 -199.98 1892.57 -162.88Q1913.84 -125.78 1950.44 -103.51Q1987.04 -81.25 2032.88 -81.25Z M2639.7 11.25Q2565.88 11.25 2506.84 -22.25Q2447.8 -55.75 2414.05 -114.19Q2380.3 -172.63 2380.3 -247.76Q2380.3 -318.39 2411.39 -376.68Q2442.49 -434.96 2498.37 -469.59Q2554.25 -504.21 2627.76 -504.21Q2702.21 -504.21 2755.78 -471.65Q2809.35 -439.08 2838.51 -383.67Q2867.66 -328.25 2867.66 -259.88V-220.37H2456.66L2475.48 -259.92Q2472.05 -208.08 2492.07 -166.79Q2512.09 -125.51 2550.16 -101.37Q2588.23 -77.23 2639.08 -77.23Q2684.69 -77.23 2722.48 -96.95Q2760.28 -116.66 2782.2 -157.33L2858.43 -117.84Q2825.74 -54.7 2768.89 -21.73Q2712.04 11.25 2639.7 11.25ZM2480.31 -283.86H2768.97Q2767.02 -323.25 2748.29 -352.91Q2729.55 -382.57 2698.45 -398.99Q2667.35 -415.42 2627.14 -415.42Q2586.23 -415.42 2554.82 -397.96Q2523.41 -380.51 2504.51 -350.67Q2485.62 -320.82 2480.31 -283.86Z"

/** Ink height in em, from the generator's reported viewBox. */
const INK_EM = 0.727

export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn("text-2xl text-primary select-none", className)}
      role="img"
      aria-label="Desde"
    >
      <svg
        viewBox="100.59 -714.9 2767.07 727.16"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        focusable="false"
        style={{ height: `${INK_EM}em`, width: "auto", display: "block" }}
      >
        <path d={DESDE_PATH} fill="currentColor" />
      </svg>
    </span>
  )
}

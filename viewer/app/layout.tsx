import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Desde Viewer",
  description: "Host, view and comment on prototypes.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    /*
     * `data-theme="teal"` is REQUIRED, not decoration. The theme tokens live
     * in the repo-root `src/styles/globals.css`, and the brand teal is only
     * defined inside the `[data-theme="teal"]` block. Bare `:root` carries a
     * near-black stone `--primary` (oklch(0.216 0.006 56.043)) — so without
     * this attribute every primary button, link and accent in the viewer
     * renders near-black instead of teal (oklch(0.575 0.135 190)).
     *
     * This was missing until 2026-08-19 and had been invisible because the
     * surface gallery sets it in its own `index.html`: the instrument used to
     * review these screens was showing a teal product that the shipped one
     * was not. Matches `editor-cli/ui-src/index.html`, which hard-codes the
     * same attribute for the same reason.
     */
    <html lang="en" data-theme="teal">
      <head>
        {/*
          The three families the theme tokens name LITERALLY —
          `--font-sans: "DM Sans"`, `--font-mono: "Fira Code"`,
          `--font-display: "Playfair Display"`. Nothing loaded them in the
          shipped viewer until 2026-08-19, so every screen rendered in the
          system fallback while the gallery (whose `index.html` does load
          them) showed the real type.

          A `<link>` rather than `next/font`, deliberately. `next/font`
          self-hosts, which is better, but it generates its own obfuscated
          family names — those would not match the literal names the shared
          token file uses, so adopting it means re-mapping the font tokens in
          a viewer-only override and keeping two definitions of the type
          system in sync. Matching `editor-cli/ui-src/index.html` and
          `viewer/gallery/index.html` byte-for-byte is worth more here than
          self-hosting; revisit if the viewer ever needs to run without
          outbound network access.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/*
          `no-page-custom-font` fires on the premise that a font linked from a
          page "will only load for a single page." That premise is a Pages
          Router one — it is about `pages/*.js` versus `pages/_document.js`.
          This file is the App Router ROOT layout, which wraps every route in
          the app, so it is the App Router's `_document` and the warning's
          stated consequence cannot occur. The rule has no App Router branch.
        */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=Fira+Code:wght@300..700&family=Playfair+Display:ital,wght@0,400..900;1,400..900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-background text-foreground min-h-screen antialiased">
        {children}
      </body>
    </html>
  )
}

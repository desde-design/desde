import type { AnchorHTMLAttributes, ReactNode } from "react"

/**
 * Stands in for `next/link` inside the gallery (aliased in `vite.config.ts`).
 *
 * Three viewer files import it, all for ordinary in-app navigation
 * (`app/settings/page.tsx`, `app/review/[slug]/not-found.tsx`,
 * `app/review/[slug]/review-shell.tsx`). The gallery has no router, so a real
 * `next/link` would drag Next's whole client runtime in to render an anchor.
 *
 * Navigation is suppressed rather than followed: a click that left the page
 * would drop the picker and the selected surface. The href is still rendered,
 * so the link's own appearance — colour, underline, hover — is reviewable,
 * which is the only reason this element is on screen.
 */
type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string
  children?: ReactNode
}

export default function Link({ href, children, onClick, ...rest }: LinkProps) {
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault()
        onClick?.(event)
      }}
      {...rest}
    >
      {children}
    </a>
  )
}

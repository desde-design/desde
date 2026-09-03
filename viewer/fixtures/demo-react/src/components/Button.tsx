import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react"

/**
 * The demo's one real component, and the reason it exists.
 *
 * A prototype made of bare `<button className="button button--primary">`
 * elements gives an editor nothing to reason about beyond classes. A
 * component with a typed `variant` prop is the thing Desde's grounding is
 * FOR: the union below is what the Editor enumerates into a dropdown, and
 * changing it writes `variant="secondary"` into this file rather than a
 * class override (Mo, 2026-09-02: "make the view all workspaces link a
 * button that we can change to different variants, primary, secondary").
 *
 * Plain TypeScript, no cva: the Editor's local-react adapter reads the union
 * from the type, and the fixture stays dependency-free (the viewer's CSP
 * forbids anything fetched at runtime anyway).
 *
 * REST PROPS ARE SPREAD ONTO THE ROOT ELEMENT, and that is load-bearing. The
 * Editor stamps every JSX callsite with a source position and reads it back
 * off the rendered DOM to work out which component an element belongs to.
 * A component that swallows unknown props drops that stamp on the floor: the
 * first cut of this file did, and the Editor attributed a click on the button
 * to a bare `<a>` with no variants to offer. Design-system components spread
 * their rest props for the same reason (data attributes, aria, test ids), so
 * this is the convention, not a Desde-specific hook.
 *
 * Renders an <a> when given `href`, so a navigation that looks like a button
 * keeps a real URL for cmd-click and "open in new tab".
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"
export type ButtonSize = "sm" | "md" | "lg"

export interface ButtonProps extends Omit<ComponentPropsWithoutRef<"button">, "type" | "onClick" | "children"> {
  variant?: ButtonVariant
  size?: ButtonSize
  href?: string
  type?: "button" | "submit"
  disabled?: boolean
  onClick?: (event: MouseEvent<HTMLElement>) => void
  children: ReactNode
}

export function Button({
  variant = "primary",
  size = "md",
  href,
  type = "button",
  disabled,
  onClick,
  children,
  className: extraClassName,
  ...rest
}: ButtonProps) {
  // A caller's className is ADDED to the variant classes, never a
  // replacement: spreading it after `className` would silently strip the
  // variant and size styling (review finding, 2026-09-02).
  const className = ["button", `button--${variant}`, `button--${size}`, extraClassName].filter(Boolean).join(" ")
  if (href) {
    // An <a> has no disabled attribute, so a disabled link has to refuse the
    // click itself, leave the tab order, and say so to assistive tech.
    return (
      <a
        {...(rest as ComponentPropsWithoutRef<"a">)}
        className={className}
        href={href}
        onClick={disabled ? (event) => event.preventDefault() : onClick}
        // After the spread, so a caller's tabIndex or aria-disabled cannot
        // contradict a disabled link (review finding, 2026-09-03).
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : undefined}
      >
        {children}
      </a>
    )
  }
  return (
    <button className={className} type={type} disabled={disabled} onClick={onClick} {...rest}>
      {children}
    </button>
  )
}

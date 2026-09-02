/**
 * Unit coverage for LocalReactManifestSource: extracts component name + props
 * from first-party .tsx and attaches inferred rendering hints.
 */
import { describe, it, expect } from "vitest"
import { LocalReactManifestSource } from "./index"

function source(files: Record<string, string>): LocalReactManifestSource {
  return new LocalReactManifestSource({
    componentFiles: Object.keys(files),
    readFile: (p) => files[p],
  })
}

describe("LocalReactManifestSource", () => {
  it("extracts a function component with destructured props + inferred hints", async () => {
    const src = source({
      "src/Card.tsx": `export function Card({ title, step }: { title: string; step: string }) {
        return (
          <div className="card">
            <h2 className="header-title">{title}</h2>
            <div className="step">{step}</div>
          </div>
        )
      }`,
    })
    const m = await src.getComponent("Card")
    expect(m).not.toBeNull()
    expect(m!.framework).toBe("react")
    expect(m!.props.map((p) => p.name).sort()).toEqual(["step", "title"])
    expect(m!.rendering).toContainEqual({
      kind: "dom",
      source: { kind: "prop", name: "title" },
      domTarget: { selector: "h2.header-title", field: "textContent" },
      editability: "literal",
    })
  })

  it("handles an arrow-const component", async () => {
    const src = source({
      "src/Label.tsx": `export const Label = ({ text }: { text: string }) => <span className="lbl">{text}</span>`,
    })
    const m = await src.getComponent("Label")
    expect(m).not.toBeNull()
    const h = m!.rendering?.[0]
    expect(h?.kind).toBe("dom")
    if (h?.kind === "dom") expect(h.domTarget.selector).toBe(":root")
  })

  it("handles export default function", async () => {
    const src = source({
      "src/App.tsx": `export default function App({ heading }: { heading: string }) {
        return <h1 className="title">{heading}</h1>
      }`,
    })
    const m = await src.getComponent("App")
    expect(m).not.toBeNull()
    expect(m!.rendering?.[0]?.source).toEqual({ kind: "prop", name: "heading" })
  })

  it("scopes hints per component in a multi-component file (no cross-attribution)", async () => {
    const src = source({
      "src/Two.tsx": `export function A({ a }: { a: string }) { return <p className="pa">{a}</p> }
        export function B({ b }: { b: string }) { return <p className="pb">{b}</p> }`,
    })
    const a = await src.getComponent("A")
    const b = await src.getComponent("B")
    const ha = a!.rendering?.[0]
    expect(ha?.kind).toBe("dom")
    if (ha?.kind === "dom") expect(ha.domTarget.selector).toBe(":root")
    expect(b!.rendering?.[0]?.source).toEqual({ kind: "prop", name: "b" })
    // A's hints never reference B's prop and vice-versa.
    expect(a!.rendering?.some((h) => h.source.name === "b")).toBe(false)
  })

  it("extracts props (no hints) for a typed non-destructured param", async () => {
    const src = source({
      "src/Plain.tsx": `export function Plain(props: { title: string }) { return <div className="x">{props.title}</div> }`,
    })
    const m = await src.getComponent("Plain")
    expect(m).not.toBeNull()
    // Props now come from the type, not the (absent) destructuring pattern.
    expect(m!.props.map((p) => p.name)).toEqual(["title"])
    expect(m!.props[0].control.kind).toBe("text")
    // No hints: `{props.title}` is a member-access expr, not inferable.
    expect(m!.rendering).toBeUndefined()
  })

  describe("prop type → control inference", () => {
    it("infers controls from an inline type literal", async () => {
      const src = source({
        "src/Btn.tsx": `export function Btn({ variant, size, disabled, onClick }: {
          variant: 'primary' | 'secondary' | 'danger'
          size?: number
          disabled?: boolean
          onClick: () => void
        }) { return <button className="b" onClick={onClick}>{variant}</button> }`,
      })
      const m = await src.getComponent("Btn")
      expect(m).not.toBeNull()
      const byName = Object.fromEntries(m!.props.map((p) => [p.name, p]))
      expect(byName.variant.control).toEqual({
        kind: "finite-choice",
        valueType: "'primary' | 'secondary' | 'danger'",
        options: [
          { value: "primary", label: "primary" },
          { value: "secondary", label: "secondary" },
          { value: "danger", label: "danger" },
        ],
      })
      expect(byName.variant.required).toBe(true)
      expect(byName.size.control.kind).toBe("number")
      expect(byName.size.required).toBe(false)
      expect(byName.disabled.control.kind).toBe("boolean")
      expect(byName.onClick.control.kind).toBe("event")
    })

    it("resolves a named interface in the same file", async () => {
      const src = source({
        "src/Card.tsx": `interface CardProps {
          title: string
          tone: 'info' | 'warn'
        }
        export function Card({ title, tone }: CardProps) {
          return <div className="c"><h2 className="t">{title}</h2><span>{tone}</span></div>
        }`,
      })
      const m = await src.getComponent("Card")
      const byName = Object.fromEntries(m!.props.map((p) => [p.name, p]))
      expect(byName.title.control.kind).toBe("text")
      expect(byName.tone.control.kind).toBe("finite-choice")
    })

    it("resolves a type alias and merges an intersection", async () => {
      const src = source({
        "src/Mix.tsx": `type Base = { id: string }
        type Extra = { count: number }
        export function Mix({ id, count }: Base & Extra) {
          return <div className="m">{id}{count}</div>
        }`,
      })
      const m = await src.getComponent("Mix")
      const byName = Object.fromEntries(m!.props.map((p) => [p.name, p]))
      expect(byName.id.control.kind).toBe("text")
      expect(byName.count.control.kind).toBe("number")
    })

    it("treats children / ReactNode props as slots", async () => {
      const src = source({
        "src/Box.tsx": `import type { ReactNode } from 'react'
        export function Box({ children, footer }: { children: ReactNode; footer: ReactNode }) {
          return <div className="box">{children}{footer}</div>
        }`,
      })
      const m = await src.getComponent("Box")
      const byName = Object.fromEntries(m!.props.map((p) => [p.name, p]))
      expect(byName.children.control.kind).toBe("slot")
      expect(byName.footer.control.kind).toBe("slot")
    })

    it("includes props inherited via interface extends", async () => {
      const src = source({
        "src/Ext.tsx": `interface Base { id: string }
        interface Props extends Base { label: string; tone: 'a' | 'b' }
        export function Ext({ id, label, tone }: Props) {
          return <div className="e">{label}</div>
        }`,
      })
      const m = await src.getComponent("Ext")
      const byName = Object.fromEntries(m!.props.map((p) => [p.name, p]))
      expect(Object.keys(byName).sort()).toEqual(["id", "label", "tone"])
      expect(byName.id.control.kind).toBe("text")
      expect(byName.tone.control.kind).toBe("finite-choice")
    })

    it("resolves an interface that extends a same-file type alias", async () => {
      const src = source({
        "src/Ext.tsx": `type Base = { id: string }
        interface Props extends Base { label: string }
        export function Ext(props: Props) {
          return <div className="e">{props.label}</div>
        }`,
      })
      const m = await src.getComponent("Ext")
      const byName = Object.fromEntries(m!.props.map((p) => [p.name, p]))
      // props: Props (non-destructured) — alias-inherited id must NOT vanish.
      expect(Object.keys(byName).sort()).toEqual(["id", "label"])
      expect(byName.id.control.kind).toBe("text")
      expect(byName.label.control.kind).toBe("text")
    })

    it("surfaces method-signature callbacks as event props", async () => {
      const src = source({
        "src/Btn.tsx": `interface Props { onClick(): void; label: string }
        export function Btn({ onClick, label }: Props) {
          return <button className="b" onClick={onClick}>{label}</button>
        }`,
      })
      const m = await src.getComponent("Btn")
      const byName = Object.fromEntries(m!.props.map((p) => [p.name, p]))
      expect(byName.onClick.control.kind).toBe("event")
      expect(byName.label.control.kind).toBe("text")
    })

    it("keeps a destructured name the type couldn't surface (cross-file extends)", async () => {
      const src = source({
        "src/Mixed.tsx": `import type { HTMLProps } from './html'
        interface Props extends HTMLProps { label: string }
        export function Mixed({ label, className }: Props) {
          return <div className={className}>{label}</div>
        }`,
      })
      const m = await src.getComponent("Mixed")
      const byName = Object.fromEntries(m!.props.map((p) => [p.name, p]))
      // label resolves from the local interface; className is inherited from the
      // unresolvable cross-file HTMLProps but is still surfaced (unknown).
      expect(byName.label.control.kind).toBe("text")
      expect(byName.className.control.kind).toBe("unknown")
    })

    it("falls back to unknown controls for an untyped destructured param", async () => {
      const src = source({
        "src/Loose.tsx": `export function Loose({ title }) { return <div className="l">{title}</div> }`,
      })
      const m = await src.getComponent("Loose")
      expect(m!.props.map((p) => p.name)).toEqual(["title"])
      expect(m!.props[0].control.kind).toBe("unknown")
    })

    it("degrades a cross-file imported type to unknown (no resolution)", async () => {
      const src = source({
        "src/Ext.tsx": `import type { ExtProps } from './types'
        export function Ext({ a }: ExtProps) { return <div className="e">{a}</div> }`,
      })
      const m = await src.getComponent("Ext")
      // The type ref can't resolve cross-file → no member list → destructured
      // names fallback with unknown control.
      expect(m!.props.map((p) => p.name)).toEqual(["a"])
      expect(m!.props[0].control.kind).toBe("unknown")
    })
  })

  describe("cva variant axes", () => {
    const BUTTON = `import { cva, type VariantProps } from "class-variance-authority"
      const buttonVariants = cva("base", {
        variants: {
          variant: { default: "a", destructive: "b", outline: "c" },
          size: { default: "d", sm: "e", "icon-lg": "f" },
        },
        defaultVariants: { variant: "default", size: "default" },
      })
      export function Button({ className, variant, size, asChild = false, ...props }:
        React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
        return <button className={className} {...props} />
      }`

    it("turns a cva axis into a finite-choice control with its real options", async () => {
      const m = await source({ "src/button.tsx": BUTTON }).getComponent("Button")
      const byName = Object.fromEntries(m!.props.map((p) => [p.name, p]))
      expect(byName.variant.control).toEqual({
        kind: "finite-choice",
        valueType: '"default" | "destructive" | "outline"',
        options: [
          { value: "default", label: "default" },
          { value: "destructive", label: "destructive" },
          { value: "outline", label: "outline" },
        ],
      })
      // A string-literal key survives verbatim — `icon-lg` is not an identifier.
      expect(byName.size.control.options?.map((o) => o.value)).toEqual([
        "default",
        "sm",
        "icon-lg",
      ])
      // cva axes are always optional; `defaultVariants` supplies the default.
      expect(byName.variant.required).toBe(false)
      expect(byName.variant.defaultValue).toEqual({ value: "default", source: "documentation" })
      // The unresolvable `React.ComponentProps<'button'>` base is skipped, not fatal.
      expect(byName.asChild.control.kind).toBe("boolean")
    })

    it("mirrors the axes onto extensions.variants", async () => {
      const m = await source({ "src/button.tsx": BUTTON }).getComponent("Button")
      expect(m!.extensions?.variants?.map((v) => v.name)).toEqual(["variant", "size"])
      expect(m!.extensions?.variants?.[0].defaultValue).toBe("default")
    })

    it("degrades an axis with a spread to unknown rather than a PARTIAL option set", async () => {
      // A partial finite-choice is worse than none: the picker would present
      // the readable survivors as the complete set and overwrite a valid
      // existing value living in the spread it could not see.
      const SRC = `import { cva, type VariantProps } from "class-variance-authority"
        const shared = { ghost: "g", link: "l" }
        const v = cva("base", {
          variants: {
            variant: { ...shared, primary: "p" },
            size: { sm: "a", lg: "b" },
          },
        })
        export function Thing({ variant, size }: VariantProps<typeof v>) {
          return <div />
        }`
      const m = await source({ "src/thing.tsx": SRC }).getComponent("Thing")
      const byName = Object.fromEntries(m!.props.map((p) => [p.name, p]))
      // The unreadable axis must NOT claim `primary` is the only option.
      expect(byName.variant.control.options ?? []).not.toContainEqual({
        value: "primary",
        label: "primary",
      })
      expect(byName.variant.control.kind).not.toBe("finite-choice")
      // The fully-readable sibling axis is unaffected.
      expect(byName.size.control.options?.map((o) => o.value)).toEqual(["sm", "lg"])
    })

    it("degrades an axis with a computed key the same way", async () => {
      const SRC = `import { cva, type VariantProps } from "class-variance-authority"
        const KEY = "dynamic"
        const v = cva("base", {
          variants: { variant: { [KEY]: "x", primary: "p" } },
        })
        export function Thing({ variant }: VariantProps<typeof v>) {
          return <div />
        }`
      const m = await source({ "src/thing.tsx": SRC }).getComponent("Thing")
      const byName = Object.fromEntries(m!.props.map((p) => [p.name, p]))
      expect(byName.variant.control.kind).not.toBe("finite-choice")
    })

    it("resolves cva through an interface extends clause", async () => {
      const m = await source({
        "src/b.tsx": `import { cva, type VariantProps } from "class-variance-authority"
          const v = cva("x", { variants: { tone: { info: "a", warn: "b" } } })
          export interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof v> {
            label: string
          }
          export function Chip({ label, tone }: Props) { return <span className="c">{label}</span> }`,
      }).getComponent("Chip")
      const byName = Object.fromEntries(m!.props.map((p) => [p.name, p]))
      expect(byName.label.control.kind).toBe("text")
      expect(byName.tone.control.options?.map((o) => o.value)).toEqual(["info", "warn"])
    })

    it("resolves an indexed access into a cva config", async () => {
      const m = await source({
        "src/t.tsx": `import { cva, VariantProps } from "class-variance-authority"
          const textVariants = cva("", { variants: { color: { default: "a", error: "b" } } })
          type TextVariantProps = VariantProps<typeof textVariants>
          export function Text({ color }: { color?: TextVariantProps["color"] }) {
            return <span className="t" />
          }`,
      }).getComponent("Text")
      expect(m!.props[0].control.options?.map((o) => o.value)).toEqual(["default", "error"])
    })

    it("treats a true/false axis as a boolean control", async () => {
      const m = await source({
        "src/x.tsx": `import { cva, type VariantProps } from "class-variance-authority"
          const v = cva("x", { variants: { inset: { true: "a", false: "b" } }, defaultVariants: { inset: false } })
          export function Row({ inset }: VariantProps<typeof v>) { return <div className="r" /> }`,
      }).getComponent("Row")
      expect(m!.props[0].control.kind).toBe("boolean")
      expect(m!.props[0].defaultValue).toEqual({ value: false, source: "documentation" })
    })

    it("keeps an explicitly declared prop type over the inferred axis", async () => {
      const m = await source({
        "src/x.tsx": `import { cva, type VariantProps } from "class-variance-authority"
          const v = cva("x", { variants: { variant: { a: "1", b: "2", c: "3" } } })
          export function W({ variant }: VariantProps<typeof v> & { variant?: 'a' | 'b' }) {
            return <div className="w" />
          }`,
      }).getComponent("W")
      expect(m!.props[0].control.options?.map((o) => o.value)).toEqual(["a", "b"])
    })

    it("resolves a cva config declared in ANOTHER scanned file", async () => {
      const src = source({
        // Deliberately listed BEFORE its dependency, to prove pass 2 closes
        // forward references.
        "src/toggle-group.tsx": `import { type VariantProps } from "class-variance-authority"
          import { toggleVariants } from "./toggle"
          export function ToggleGroup({ className, variant, size }:
            React.ComponentProps<"div"> & VariantProps<typeof toggleVariants>) {
            return <div className={className} />
          }`,
        "src/toggle.tsx": `import { cva } from "class-variance-authority"
          export const toggleVariants = cva("t", {
            variants: { variant: { default: "a", outline: "b" }, size: { sm: "c", lg: "d" } },
          })`,
      })
      const m = await src.getComponent("ToggleGroup")
      const byName = Object.fromEntries(m!.props.map((p) => [p.name, p]))
      expect(byName.variant.control.options?.map((o) => o.value)).toEqual(["default", "outline"])
      expect(byName.size.control.options?.map((o) => o.value)).toEqual(["sm", "lg"])
    })

    it("leaves an unresolvable variants reference as an unknown control", async () => {
      const m = await source({
        "src/x.tsx": `import { type VariantProps } from "class-variance-authority"
          import { missingVariants } from "somewhere"
          export function X({ variant }: VariantProps<typeof missingVariants>) {
            return <div className="x" />
          }`,
      }).getComponent("X")
      // No props type resolved and nothing destructured beyond `variant`.
      expect(m!.props.map((p) => p.name)).toEqual(["variant"])
      expect(m!.props[0].control.kind).toBe("unknown")
    })
  })

  describe("wrapped components (forwardRef / memo)", () => {
    it("extracts a forwardRef component from its explicit type argument", async () => {
      const m = await source({
        "src/button.tsx": `import { cva, type VariantProps } from "class-variance-authority"
          import { forwardRef } from "react"
          const buttonVariants = cva("b", { variants: { variant: { default: "a", ghost: "b" } } })
          export interface ButtonProps
            extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
            asChild?: boolean
          }
          const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, asChild = false, ...props }, ref) => {
            return <button ref={ref} className={className} {...props} />
          })
          export { Button }`,
      }).getComponent("Button")
      expect(m).not.toBeNull()
      const byName = Object.fromEntries(m!.props.map((p) => [p.name, p]))
      expect(byName.asChild.control.kind).toBe("boolean")
      expect(byName.variant.control.options?.map((o) => o.value)).toEqual(["default", "ghost"])
    })

    it("falls back to the render function's own param annotation", async () => {
      const m = await source({
        "src/l.tsx": `import * as React from "react"
          export const Label = React.forwardRef(({ text }: { text: string }, ref) => (
            <span ref={ref} className="lbl">{text}</span>
          ))`,
      }).getComponent("Label")
      expect(m!.props.map((p) => p.name)).toEqual(["text"])
      expect(m!.props[0].control.kind).toBe("text")
      // Hints still come from the render function's own JSX.
      expect(m!.rendering?.[0]?.source).toEqual({ kind: "prop", name: "text" })
    })

    it("peels memo(forwardRef(…))", async () => {
      const m = await source({
        "src/r.tsx": `import { memo, forwardRef } from "react"
          export const Row = memo(forwardRef(({ title }: { title: string }, ref) => (
            <div ref={ref} className="row">{title}</div>
          )))`,
      }).getComponent("Row")
      expect(m!.props.map((p) => p.name)).toEqual(["title"])
    })

    it("ignores a Capitalized const initialized by a non-wrapper call", async () => {
      const src = source({
        "src/x.tsx": `export const Theme = createTheme({ palette: { mode: "dark" } })`,
      })
      expect(await src.listComponents()).toEqual([])
    })
  })

  describe("cross-component prop forwarding", () => {
    const BUTTON = `import { cva, type VariantProps } from "class-variance-authority"
      const buttonVariants = cva("b", {
        variants: { variant: { default: "a", ghost: "b" }, size: { sm: "c", lg: "d" } },
      })
      export function Button({ className, variant, size }:
        React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
        return <button className={className} />
      }`

    it("inherits a Picked subset of another component's props", async () => {
      const m = await source({
        "src/pagination.tsx": `import { Button } from "./button"
          type LinkProps = { isActive?: boolean } & Pick<React.ComponentProps<typeof Button>, "size">
          export function PaginationLink({ isActive, size = "sm" }: LinkProps) {
            return <a className="pl" />
          }`,
        "src/button.tsx": BUTTON,
      }).getComponent("PaginationLink")
      const byName = Object.fromEntries(m!.props.map((p) => [p.name, p]))
      expect(byName.isActive.control.kind).toBe("boolean")
      expect(byName.size.control.options?.map((o) => o.value)).toEqual(["sm", "lg"])
      // `variant` was NOT picked, so it must not leak in.
      expect(byName.variant).toBeUndefined()
    })

    it("inherits the full prop set for a bare ComponentProps forward", async () => {
      const m = await source({
        "src/a.tsx": `import { Button } from "./button"
          export function IconButton(props: React.ComponentProps<typeof Button>) {
            return <Button {...props} />
          }`,
        "src/button.tsx": BUTTON,
      }).getComponent("IconButton")
      expect(m!.props.map((p) => p.name).sort()).toEqual(["className", "size", "variant"])
    })

    it("honours Omit", async () => {
      const m = await source({
        "src/a.tsx": `import { Button } from "./button"
          export function Plain(props: Omit<React.ComponentProps<typeof Button>, "variant">) {
            return <Button {...props} />
          }`,
        "src/button.tsx": BUTTON,
      }).getComponent("Plain")
      expect(m!.props.map((p) => p.name)).not.toContain("variant")
      expect(m!.props.map((p) => p.name)).toContain("size")
    })

    it("does not forward an intrinsic element or a namespaced library component", async () => {
      const m = await source({
        "src/a.tsx": `import * as RadixDialog from "radix"
          export function Shell(props: React.ComponentProps<"div"> & React.ComponentProps<typeof RadixDialog.Root>) {
            return <div className="s" />
          }`,
      }).getComponent("Shell")
      expect(m!.props).toEqual([])
    })

    it("terminates on a forwarding cycle", async () => {
      const src = source({
        "src/a.tsx": `import { B } from "./b"
          export function A(props: React.ComponentProps<typeof B> & { a?: string }) { return <div className="a" /> }`,
        "src/b.tsx": `import { A } from "./a"
          export function B(props: React.ComponentProps<typeof A> & { b?: string }) { return <div className="b" /> }`,
      })
      const a = await src.getComponent("A")
      const b = await src.getComponent("B")
      expect(a!.props.map((p) => p.name)).toContain("a")
      expect(b!.props.map((p) => p.name)).toContain("b")
    })
  })

  it("resolves a same-file alias to a literal union as a finite choice", async () => {
    const m = await source({
      "src/h.tsx": `type HeadingTag = "h1" | "h2" | "h3"
        export function Title({ as }: { as?: HeadingTag }) { return <h1 className="t" /> }`,
    }).getComponent("Title")
    expect(m!.props[0].control.kind).toBe("finite-choice")
    expect(m!.props[0].control.options?.map((o) => o.value)).toEqual(["h1", "h2", "h3"])
    // The displayed type stays what the author wrote.
    expect(m!.props[0].control.valueType).toBe("HeadingTag")
  })

  it("lists all components in a file", async () => {
    const src = source({
      "src/Two.tsx": `export function A({ a }: { a: string }) { return <p className="pa">{a}</p> }
        export function B({ b }: { b: string }) { return <p className="pb">{b}</p> }`,
    })
    const all = await src.listComponents()
    expect(all.map((m) => m.name).sort()).toEqual(["A", "B"])
  })
})

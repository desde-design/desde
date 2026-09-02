/**
 * Tests for the inspector "From:" provenance row (Layer 2).
 *
 * `@/components/ui/popover` is swapped for a faithful inline version (content
 * always rendered) — Radix Popover doesn't open under jsdom's fireEvent (it
 * needs real pointer-capture semantics) and this repo doesn't have
 * `@testing-library/user-event` installed. Same approach as
 * model-picker-chip.test.tsx's DropdownMenu mock; what's under test is our
 * summary/chain content, not Radix's open behavior.
 */
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { StyleOrigin } from '@/types/bridge'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

const { StyleOriginRow } = await import(
  './style-origin-row',
)

const tokenOrigin: StyleOrigin = {
  property: 'background-color',
  computedValue: 'rgb(247, 247, 247)',
  winningRule: {
    selector: '.acme-empty-state',
    stylesheet: { href: 'http://x/node_modules/@acme/design-system/style.css', package: '@acme/design-system' },
    declaration: 'background-color: var(--acme-color-background-disabled)',
    specificity: [0, 1, 0],
  },
  varChain: [
    {
      name: '--acme-color-background-disabled',
      value: '#f7f7f7',
      definedAt: { selector: ':root', stylesheet: { href: 'http://x/tokens.css' } },
    },
  ],
}

describe('StyleOriginRow', () => {
  it('renders nothing when there is no origin', () => {
    const { container } = render(<StyleOriginRow origin={undefined} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the origin has no winning rule and no inline override', () => {
    const { container } = render(
      <StyleOriginRow
        origin={{ property: 'color', computedValue: 'rgb(0,0,0)', winningRule: null, varChain: [] }}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('summarizes a token-driven origin as token · selector · package', () => {
    render(<StyleOriginRow origin={tokenOrigin} />)
    const from = screen.getByTestId('style-origin-from')
    expect(from.textContent).toContain('--acme-color-background-disabled')
    expect(from.textContent).toContain('.acme-empty-state')
    expect(from.textContent).toContain('@acme/design-system')
  })

  it('summarizes an inline override distinctly', () => {
    render(
      <StyleOriginRow
        origin={{
          property: 'color',
          computedValue: 'rgb(255,0,0)',
          winningRule: null,
          varChain: [],
          inline: { value: 'red', important: true },
        }}
      />,
    )
    expect(screen.getByTestId('style-origin-from').textContent).toContain('inline style !important')
  })

  // N1: the resting rule and the live computed value can disagree, because
  // clicking an element to inspect it puts the cursor on it. The row must
  // EXPLAIN that pairing rather than present it as a contradiction.
  describe('transientRuleApplies', () => {
    const hovered: StyleOrigin = {
      ...tokenOrigin,
      computedValue: 'rgb(0, 48, 204)',
      transientRuleApplies: { pseudoClass: ':hover' },
    }

    it('flags on the collapsed line that the shown rule is the resting one', () => {
      render(<StyleOriginRow origin={hovered} />)
      const from = screen.getByTestId('style-origin-from').textContent!
      expect(from).toContain('.acme-empty-state')
      expect(from).toContain(':hover')
      expect(from).toContain('at rest')
    })

    it('explains the discrepancy in the chain, and labels the live sample as live', () => {
      render(<StyleOriginRow origin={hovered} />)
      const note = screen.getByTestId('style-origin-transient')
      expect(note.textContent).toContain(':hover')
      expect(note.textContent).toContain('currently applies')
      expect(note.textContent).toContain('at rest')
      expect(screen.getByText(/Computed \(live, :hover\)/)).toBeTruthy()
    })

    it('renders a transient-ONLY property instead of degrading to nothing', () => {
      // `a.nav-item-link` live: winningRule null beside a real opaque colour,
      // which previously rendered no row at all — a colour from nothing.
      render(
        <StyleOriginRow
          origin={{
            property: 'background-color',
            computedValue: 'rgb(224, 228, 234)',
            winningRule: null,
            varChain: [],
            transientRuleApplies: { pseudoClass: ':hover' },
          }}
        />,
      )
      expect(screen.getByTestId('style-origin-from').textContent).toContain('not set (only :hover)')
      expect(screen.getByTestId('style-origin-transient').textContent).toContain(
        'No rule declares this property at rest',
      )
    })

    it('omits the explanation entirely when the flag is absent', () => {
      render(<StyleOriginRow origin={tokenOrigin} />)
      expect(screen.getByTestId('style-origin-from').textContent).not.toContain('at rest')
      expect(screen.queryByTestId('style-origin-transient')).toBeNull()
      expect(screen.getByText(/Computed:/)).toBeTruthy()
    })
  })
})

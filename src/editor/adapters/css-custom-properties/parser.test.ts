import { describe, expect, it } from 'vitest'
import { parseCustomProperties } from './parser'

describe('parseCustomProperties', () => {
  it('parses two props in a :root block, one with a trailing /** … */ description', () => {
    const css = `
      :root {
        --color-primary: #ff0000;
        --color-secondary: #00ff00; /** Secondary brand color. */
      }
    `
    const result = parseCustomProperties(css)
    expect(result).toHaveLength(2)

    const primary = result.find((t) => t.name === '--color-primary')
    expect(primary).toEqual({
      name: '--color-primary',
      value: '#ff0000',
      block: 'root',
    })

    const secondary = result.find((t) => t.name === '--color-secondary')
    expect(secondary).toEqual({
      name: '--color-secondary',
      value: '#00ff00',
      description: 'Secondary brand color.',
      block: 'root',
    })
  })

  it('parses @theme blocks with block "theme"', () => {
    const css = `
      @theme {
        --color-brand: oklch(0.6 0.2 250);
      }
    `
    const result = parseCustomProperties(css)
    expect(result).toEqual([
      {
        name: '--color-brand',
        value: 'oklch(0.6 0.2 250)',
        block: 'theme',
      },
    ])
  })

  it('tolerates a :root block nested inside @media', () => {
    const css = `
      @media (prefers-color-scheme: dark) {
        :root {
          --x: 1px;
        }
      }
    `
    const result = parseCustomProperties(css)
    expect(result).toEqual([
      {
        name: '--x',
        value: '1px',
        block: 'root',
      },
    ])
  })

  it('does NOT parse custom properties declared in a component scope', () => {
    const css = `
      .card {
        --local: red;
      }
    `
    const result = parseCustomProperties(css)
    expect(result).toEqual([])
  })

  it('does NOT parse var() usage', () => {
    const css = `
      :root {
        --color-brand: blue;
      }
      body {
        color: var(--color-brand);
      }
    `
    const result = parseCustomProperties(css)
    expect(result).toEqual([
      {
        name: '--color-brand',
        value: 'blue',
        block: 'root',
      },
    ])
  })

  it('parses html.dark { … } with block "html"', () => {
    const css = `
      html.dark {
        --bg: #000;
      }
    `
    const result = parseCustomProperties(css)
    expect(result).toEqual([
      {
        name: '--bg',
        value: '#000',
        block: 'html',
      },
    ])
  })

  it('tolerates :root nested inside @layer and @supports wrappers', () => {
    const css = `
      @layer base {
        @supports (color: oklch(0 0 0)) {
          :root {
            --y: 2px;
          }
        }
      }
    `
    const result = parseCustomProperties(css)
    expect(result).toEqual([
      {
        name: '--y',
        value: '2px',
        block: 'root',
      },
    ])
  })

  it('ignores declarations in an unrelated block even when a theme block follows', () => {
    const css = `
      .btn {
        --btn-color: red;
      }
      @theme {
        --color-accent: purple;
      }
    `
    const result = parseCustomProperties(css)
    expect(result).toEqual([
      {
        name: '--color-accent',
        value: 'purple',
        block: 'theme',
      },
    ])
  })

  it('collects declarations before AND after a nested @media block inside :root (plus the nested one, transparently)', () => {
    const css = `
      :root {
        --a: red;
        @media (min-width:600px){
          --b: blue;
        }
        --c: green;
      }
    `
    const result = parseCustomProperties(css)
    expect(result).toHaveLength(3)
    expect(result.find((t) => t.name === '--a')).toEqual({
      name: '--a',
      value: 'red',
      block: 'root',
    })
    expect(result.find((t) => t.name === '--b')).toEqual({
      name: '--b',
      value: 'blue',
      block: 'root',
    })
    expect(result.find((t) => t.name === '--c')).toEqual({
      name: '--c',
      value: 'green',
      block: 'root',
    })
  })

  it('does not leak a commented-out declaration into the token set or a neighboring description', () => {
    const css = `
      :root {
        --a: red;

        /* --old-bg: #eee; */

        --c: green;
      }
    `
    const result = parseCustomProperties(css)
    expect(result).toEqual([
      { name: '--a', value: 'red', block: 'root' },
      { name: '--c', value: 'green', block: 'root' },
    ])
  })

  it('handles multiple selectors sharing one :root, html rule', () => {
    const css = `
      :root, html {
        --shared: 1rem;
      }
    `
    const result = parseCustomProperties(css)
    expect(result).toEqual([
      {
        name: '--shared',
        value: '1rem',
        block: 'root',
      },
    ])
  })
})

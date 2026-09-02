import { STAMP_MARKER } from './stamper-files.js'
import type { AttachHost } from './types.js'

/**
 * Decide whether a config already references our stamper, and whether it does
 * so correctly.
 *
 * The check is textual on purpose. Parsing the config is not an option — these
 * files are TypeScript with framework-specific globals (`defineNuxtConfig`),
 * they import from the user's own tree, and *executing* one to inspect the
 * resolved object would run arbitrary code before the user has asked us to do
 * anything. A substring is a weaker signal, and it is weak in the safe
 * direction: a miss reprints a block the user can ignore, whereas a false
 * "already wired" leaves them with a prototype that boots and then refuses
 * every edit.
 */

export interface WiredMatch {
  marker: string
  warnings: string[]
}

/**
 * Ordered most-specific first. Only strings that cannot plausibly mean
 * anything else — an incidental mention of "desde" in a comment is
 * deliberately NOT a match.
 */
const MARKERS: readonly string[] = [
  // Our own generated block, whichever lane.
  STAMP_MARKER,
  // The Vite plugin names, if someone wired the source directly.
  '@desde/editor-source-tag-plugin',
  '@desde/editor-jsx-source-tag-plugin',
  // Hand-wired imports of the exported factories (what the spike did).
  'jsxSourceTagPlugin',
  'sourceTagPlugin',
]

/**
 * Blank out `//` and block comments, preserving offsets and newlines.
 *
 * COMMENTS ONLY — string literals are deliberately left intact, because a
 * genuine wiring puts the marker INSIDE a string: the generated Next block
 * imports `'./.desde/stamp/next-loader.cjs'`, and a Vite config imports
 * the plugin by a quoted specifier. Stripping strings would blind the check to
 * every real wiring it exists to find.
 *
 * The residual is a marker inside a string that is not a wiring (say
 * `const docs = "see .desde/stamp/"`), which stays a false positive. That
 * is accepted: distinguishing it needs a real parse, and the failure mode of
 * the OPPOSITE error — stripping strings, matching nothing, and refusing a
 * correctly-wired project on every boot — is worse and far more likely.
 */
function blankComments(text: string): string {
  // A small context stack, because the three literal kinds do not nest the
  // same way. Notably a template literal's `${...}` is CODE, so a comment
  // inside one is a real comment and must be blanked — treating the whole
  // backtick region as opaque leaves `${/* .desde/stamp/ */ x}` matchable
  // and yields a false "already wired", which is the dangerous direction.
  type Ctx =
    | { kind: "code" }
    | { kind: "quote"; q: string }
    | { kind: "template" }
    // Depth counts braces so the interpolation ends at its OWN `}`.
    | { kind: "interp"; depth: number }

  const stack: Ctx[] = [{ kind: "code" }]
  const top = (): Ctx => stack[stack.length - 1]
  let out = ""
  let i = 0

  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    const ctx = top()

    if (ctx.kind === "quote") {
      out += c
      if (c === "\\") {
        out += next ?? ""
        i += 2
        continue
      }
      if (c === ctx.q) stack.pop()
      i += 1
      continue
    }

    if (ctx.kind === "template") {
      if (c === "\\") {
        out += c + (next ?? "")
        i += 2
        continue
      }
      if (c === "$" && next === "{") {
        out += "${"
        stack.push({ kind: "interp", depth: 0 })
        i += 2
        continue
      }
      out += c
      if (c === "`") stack.pop()
      i += 1
      continue
    }

    // code or interp — both obey normal code rules.
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " "
        i += 1
      }
      continue
    }
    if (c === "/" && next === "*") {
      const close = text.indexOf("*/", i + 2)
      const stop = close === -1 ? text.length : close + 2
      for (; i < stop; i += 1) out += text[i] === "\n" ? "\n" : " "
      continue
    }
    if (c === '"' || c === "'") {
      stack.push({ kind: "quote", q: c })
      out += c
      i += 1
      continue
    }
    if (c === "`") {
      stack.push({ kind: "template" })
      out += c
      i += 1
      continue
    }
    if (ctx.kind === "interp") {
      if (c === "{") ctx.depth += 1
      else if (c === "}") {
        if (ctx.depth === 0) {
          stack.pop()
          out += c
          i += 1
          continue
        }
        ctx.depth -= 1
      }
    }
    out += c
    i += 1
  }
  return out
}

export function detectWired(configText: string, host: AttachHost): WiredMatch | null {
  // Match against comment-free text. A commented-out block is the shape a user
  // produces while debugging, and treating it as wired would boot them with no
  // stamper at all — inspect-only, every edit refused, no warning. That is the
  // precise failure the gate exists to prevent, so it must not be self-inflicted.
  const searchable = blankComments(configText)
  const marker = MARKERS.find((m) => searchable.includes(m))
  if (!marker) return null
  return {
    marker,
    // Warning scans read the comment-free text too: a commented-out
    // PHASE_DEVELOPMENT_SERVER would otherwise suppress the production-leak
    // warning on a config that is gated on nothing.
    warnings: host === 'next' ? nextWarnings(searchable) : viteWarnings(searchable, marker),
  }
}

function nextWarnings(text: string): string[] {
  const warnings: string[] = []

  // MEASURED: a `*.tsx` rule alone leaves .jsx files unstamped. The app still
  // boots and the elements are still inspectable, so the only symptom is that
  // edits to those files are refused.
  const hasJsxRule = /["'`]\*\.jsx["'`]/.test(text)
  const hasTsxRule = /["'`]\*\.tsx["'`]/.test(text)
  if (hasTsxRule && !hasJsxRule) {
    warnings.push(
      "turbopack.rules has a '*.tsx' entry but no '*.jsx' entry. Every .jsx file will be unstamped and the Editor will refuse to edit it. Add: '*.jsx': { loaders: [<same loader>] }",
    )
  }

  // MEASURED: the loader runs during `next build` too, and a stamped build
  // ships internal file paths to end users (34 attributes in the prerendered
  // HTML). NODE_ENV does not close it — it is ambient.
  const hasPhaseGate = text.includes('PHASE_DEVELOPMENT_SERVER') || text.includes('phase-development-server')
  if (!hasPhaseGate) {
    const gatedOnNodeEnv = text.includes('NODE_ENV')
    warnings.push(
      gatedOnNodeEnv
        ? 'The stamping loader is gated on NODE_ENV, not on the Next phase. NODE_ENV is ambient: a build run with NODE_ENV=development will stamp the production output and ship data-desde-src source paths to end users. Gate on PHASE_DEVELOPMENT_SERVER instead.'
        : 'No PHASE_DEVELOPMENT_SERVER gate found. This loader also runs during `next build` and will ship data-desde-src source paths to end users.',
    )
  }

  if (!text.includes('allowedDevOrigins')) {
    warnings.push(
      'No allowedDevOrigins entry. Next 16 dev answers 403 to /_next/* requests carrying an Origin header from an unrecognised host, and attach mode serves the app through a proxy origin.',
    )
  }

  return warnings
}

function viteWarnings(text: string, marker: string): string[] {
  // Our own bundle sets `apply: 'serve'` itself, so a config that imports it
  // needs nothing further. A hand-wired plugin has no such guarantee.
  if (marker === STAMP_MARKER) return []
  if (text.includes('apply')) return []
  return [
    "The stamper appears to be wired by hand and the config does not mention `apply`. A Vite plugin without `apply: 'serve'` also runs during a production build, which stamps the output with data-desde-src source paths.",
  ]
}

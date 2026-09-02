#!/usr/bin/env node
/**
 * Vue icon-preview render subprocess. Invoked by the parent editor
 * process with cwd set to the prototype repo so module resolution
 * picks up the prototype's installed `vue` and the target icon
 * package. Reads `{ packageName, iconExports: string[] }` from stdin,
 * dynamic-imports the package, renders each requested export via
 * Vue's server renderer, extracts the inner `<svg>` from the rendered
 * HTML, and writes `{ previews: { [name]: svgMarkup } }` to stdout.
 * Per-icon failures are recorded as `null` previews with a `failures`
 * map; the batch never aborts on a single bad icon.
 *
 * Hand-written ESM (not TypeScript) so it runs under plain `node`
 * with no transpile step.
 */

import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'

/** Read all of stdin and parse as JSON. */
async function readStdinJson() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(raw)
}

/** Extract the first <svg>…</svg> from a rendered HTML string. */
function extractSvg(html) {
  const match = html.match(/<svg[\s\S]*?<\/svg>/)
  return match ? match[0] : null
}

/** Write to stdout and wait for the buffer to drain before resolving. */
function writeAndDrain(payload) {
  return new Promise((resolve, reject) => {
    const ok = process.stdout.write(payload, (err) => {
      if (err) reject(err)
      else if (ok) resolve()
    })
    if (!ok) process.stdout.once('drain', resolve)
  })
}

async function main() {
  const { packageName, iconExports } = await readStdinJson()
  if (typeof packageName !== 'string' || !Array.isArray(iconExports)) {
    process.stderr.write('render-vue: malformed stdin payload\n')
    process.exitCode = 2
    return
  }

  const previews = {}
  const failures = {}

  let mod
  try {
    mod = await import(packageName)
  } catch (err) {
    const msg = `package import failed: ${err && err.message ? err.message : String(err)}`
    for (const name of iconExports) failures[name] = msg
    await writeAndDrain(JSON.stringify({ previews, failures }))
    return
  }

  for (const name of iconExports) {
    const Component = mod[name]
    if (!Component) {
      failures[name] = 'export not found on package'
      continue
    }
    try {
      const app = createSSRApp({
        render: () => h(Component, { color: 'currentColor', decorative: true }),
      })
      const html = await renderToString(app)
      const svg = extractSvg(html)
      if (!svg) {
        failures[name] = 'rendered output contained no <svg>'
        continue
      }
      previews[name] = svg
    } catch (err) {
      failures[name] = err && err.message ? err.message : String(err)
    }
  }

  await writeAndDrain(JSON.stringify({ previews, failures }))
}

main().catch((err) => {
  process.stderr.write(`render-vue: ${err && err.stack ? err.stack : err && err.message ? err.message : String(err)}\n`)
  process.exitCode = 1
})

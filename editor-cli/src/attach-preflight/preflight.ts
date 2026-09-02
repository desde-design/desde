import { promises as fs } from 'node:fs'
import { candidateConfigPaths, locateConfigFile } from './config-file.js'
import { detectWired } from './detect-wired.js'
import {
  generateNextBlock,
  generateNextFullConfig,
  generateViteBlock,
  generateViteFullConfig,
  proxyHostname,
} from './generate-block.js'
import { nextLoaderFiles, vitePluginFiles } from './stamper-files.js'
import type {
  RequiredStamperFile,
  StampingPreflightRequest,
  StampingPreflightResult,
} from './types.js'

/**
 * The stamping preflight.
 *
 * Reads the prototype's host config and reports one of three things: it is
 * already wired (with any warnings about *how*), it needs a specific block in
 * a specific file, or there is no config to modify and we will not invent one.
 *
 * This module returns a value. It does not print, exit, or write — the CLI
 * decides what to do with the result, which keeps the whole decision testable
 * without spawning a process.
 */
export async function runStampingPreflight(
  req: StampingPreflightRequest,
): Promise<StampingPreflightResult> {
  const { prototypeRoot, host, framework } = req

  const location = await locateConfigFile(prototypeRoot, host)
  if (!location) {
    const searched = candidateConfigPaths(prototypeRoot, host)
    return {
      status: 'no-config-file',
      host,
      framework,
      searched,
      message:
        `No vite.config.{js,mjs,ts,cjs,mts,cts} at ${prototypeRoot}. Attach mode stamps source ` +
        `by adding a plugin to the config your own dev server loads, and a ${host} project ` +
        `without a root Vite config is not a shape we can wire. Create one that keeps your ` +
        `framework's own plugin, then run attach again.`,
    }
  }

  const requiredStamperFiles: RequiredStamperFile[] =
    host === 'next' ? nextLoaderFiles() : vitePluginFiles(framework)

  if (location.exists) {
    const text = await fs.readFile(location.path, 'utf8')
    const wired = detectWired(text, host)
    if (wired) {
      return {
        status: 'already-wired',
        host,
        framework,
        configFile: location.path,
        configFileRelative: location.relative,
        marker: wired.marker,
        warnings: wired.warnings,
      }
    }
  }

  const block = location.exists
    ? buildBlock(req, location.syntax, location.typed, location.relative)
    : buildFullConfig(req, location.syntax, location.typed, location.relative)

  return {
    status: 'needs-config',
    host,
    framework,
    configFile: location.path,
    configFileRelative: location.relative,
    configFileExists: location.exists,
    block,
    steps: buildSteps(req, location.exists, location.relative, requiredStamperFiles),
    requiredStamperFiles,
  }
}

function buildBlock(
  req: StampingPreflightRequest,
  syntax: 'esm' | 'cjs',
  typed: boolean,
  configFileRelative: string,
): string {
  if (req.host === 'next') {
    return generateNextBlock({ syntax, typed, allowedDevHostnames: hostnamesFor(req) })
  }
  return generateViteBlock({ host: req.host, framework: req.framework, syntax, configFileRelative })
}

function buildFullConfig(
  req: StampingPreflightRequest,
  syntax: 'esm' | 'cjs',
  typed: boolean,
  configFileRelative: string,
): string {
  if (req.host === 'next') {
    return generateNextFullConfig({ syntax, typed, allowedDevHostnames: hostnamesFor(req) })
  }
  if (req.host !== 'nuxt' && req.host !== 'astro') {
    // Unreachable: `canCreateConfig` refuses the root-vite hosts, so
    // `locateConfigFile` returns null for them and this path is never taken.
    // Kept as a hard stop rather than a silent wrong config.
    throw new Error(`Cannot synthesize a config for host "${req.host}"`)
  }
  return generateViteFullConfig({
    host: req.host,
    framework: req.framework,
    syntax,
    configFileRelative,
  })
}

/**
 * `127.0.0.1` is the fallback rather than `localhost` because the CLI binds
 * the proxy to the loopback address, and Next already allows `localhost` and
 * `**.localhost` by default — so the entry that is NOT covered for free is the
 * numeric one.
 */
function hostnamesFor(req: StampingPreflightRequest): string[] {
  const fromOrigin = req.proxyOrigin ? proxyHostname(req.proxyOrigin) : null
  return fromOrigin ? [fromOrigin] : ['127.0.0.1']
}

function buildSteps(
  req: StampingPreflightRequest,
  configExists: boolean,
  configFileRelative: string,
  files: RequiredStamperFile[],
): string[] {
  const steps: string[] = []
  const written = files.map((f) => f.path).join(', ')

  if (configExists) {
    if (req.host === 'next') {
      steps.push(`Paste the block below into ${configFileRelative}, above your config object.`)
      steps.push(
        'Wrap the export: `export default nextConfig` becomes `export default withDesde(nextConfig)` (or `module.exports = withDesde(nextConfig)` in a CommonJS config).',
      )
    } else {
      steps.push(`Apply the two edits below to ${configFileRelative}.`)
    }
  } else {
    steps.push(`Create ${configFileRelative} with the contents below.`)
  }

  steps.push('Restart your dev server. Config changes are not hot-reloaded.')
  steps.push(
    `The stamper itself lives at ${written}, written by the Editor CLI. If you commit the config change, commit that directory too: it is only ignored locally (.git/info/exclude), so a teammate who pulls the config without it gets a dev server that fails to resolve the import.`,
  )
  return steps
}

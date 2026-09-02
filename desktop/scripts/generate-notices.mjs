#!/usr/bin/env node
// Aggregated third-party notices — the single rolled-up document Desde ships
// at Contents/Resources/THIRD-PARTY-NOTICES.txt, naming every third-party
// production dependency actually distributed inside the packaged app and
// carrying each one's full license (and, where one exists, NOTICE) text.
//
// ── Why this exists ──────────────────────────────────────────────────────
//
// Per-package LICENSE files already ship inside the app — node_modules
// itself ships, both under Resources/server/node_modules (the CLI payload)
// and inside app.asar/node_modules (electron-updater's own tree) — so
// per-package attribution was never literally ABSENT. But scattered across
// ~170 packages' worth of directories is not the same as reviewable: there
// was no single document a user (or a compliance reviewer) could open to see
// "what's in this app." This script produces that document.
//
// ── Two trees, same shape as the license audit that motivated this file ───
//
// 1. The CLI payload's production dependencies (`payloadDir` — the staged
//    tree that becomes Resources/server, see electron-builder.config.mjs's
//    own extraResources doc comment).
// 2. This package's OWN production dependency (`desktopRoot` —
//    electron-updater and its transitive tree, bundled into app.asar).
//
// `production: true` + `excludePrivatePackages: true` on both scans is what
// keeps devDependencies (electron, electron-builder, typescript, vitest,
// this very tool) and the two `private: true` package.json manifests
// themselves (`@desde/editor-cli`, `@desde/desktop`) out of a
// notices file that should only ever list what's actually distributed.
//
// ── The one dependency that isn't open source ──────────────────────────
//
// `@anthropic-ai/claude-agent-sdk` and its platform binary package
// (`@anthropic-ai/claude-agent-sdk-<platform>`, which is how the bundled
// ~198MB `claude` binary reaches the payload) declare
// `"license": "SEE LICENSE IN LICENSE.md"` — license-checker reports this as
// a "Custom: LICENSE.md" string, not a real SPDX identifier. Rather than
// silently folding that into the same "License: <whatever the tool found>"
// treatment every other entry gets (which would make proprietary,
// all-rights-reserved software read as just another OSS dependency),
// `isProprietaryLicenseString` below flags any non-SPDX "Custom:"/"UNKNOWN"
// license generically, and the renderer prints an explicit "NOT AN OPEN
// SOURCE LICENSE" banner for it — honest about what it is without singling
// out Anthropic by package name (the same generic check would catch any
// future custom-licensed dependency too, open- or closed-source).
//
// ── Kept pure where it matters ───────────────────────────────────────────
//
// `renderNoticesDocument` / `renderPackageEntry` / `mergePackageInfo` /
// `isProprietaryLicenseString` / `isSafeAttributionFile` take already-read
// data and do no I/O — same split `notarize-dmg.mjs` uses (a testable pure
// core, an impure orchestrator around it) so `__tests__/generate-notices.test.ts`
// can exercise the actual formatting/merging/safety logic against synthetic
// fixtures without needing a real npm tree on disk.
//
// `isSafeAttributionFile` is defense in depth, not the primary safeguard:
// license-checker only ever resolves `licenseFile`/`noticeFile` to
// LICENSE*/NOTICE*/COPYING*/README*-shaped files it found inside an
// installed package directory — it has no code path that would return a
// `.env` file. But the task this script was written for is explicit that a
// generated notices file must never be able to embed a secret, so this
// checks anyway: any resolved path whose basename starts with "." (which no
// legitimate license/notice file name ever does) is refused rather than
// read.
import { readFile } from "node:fs/promises"
import { basename } from "node:path"
// Named import, not default: license-checker-rseidelsohn is a plain ESM
// module (`"type": "module"` in its own package.json) with only named
// exports — no `export default`.
import { init as initLicenseChecker } from "license-checker-rseidelsohn"

const SEPARATOR = "-".repeat(80)

const DOCUMENT_HEADER = `Desde — Third-Party Notices
============================

Desde is licensed under the GNU Affero General Public License v3.0 (or
later). See the accompanying LICENSE file for the full license text.

This document lists the third-party, open-source production dependencies
distributed inside the Desde application: the packages Desde's editor
payload and desktop shell actually ship at runtime, not development-only
tooling (build tools, test runners, type checkers) that never leaves the
build machine.

Electron's own bundled components — Chromium, Node.js, V8, and ffmpeg — are
licensed separately by their own upstream projects and are covered by the
accompanying ELECTRON-LICENSE.txt and LICENSES.chromium.html files, also
shipped inside this application (see the app's Help menu, or
Contents/Resources on macOS).

One entry below is not an open-source dependency and is called out
explicitly rather than folded in silently: Anthropic's \`claude\` CLI binary,
bundled as a spawned subprocess via @anthropic-ai/claude-agent-sdk and its
platform package. It is Anthropic's proprietary software, distributed under
Anthropic's own terms — see that entry below for the exact notice and a link
to those terms.

Generated at packaging time by desktop/scripts/generate-notices.mjs.`

/**
 * True when a license string reported by license-checker is not a real
 * SPDX identifier — a "Custom: <file>" reference (license-checker's own
 * convention when a package.json's "license" field points at a file instead
 * of naming a standard license) or an outright "UNKNOWN"/unset value. This
 * is a generic classifier, not an Anthropic-specific one: any dependency
 * that ships this shape of license field gets the same "not an open source
 * license" treatment.
 */
export function isProprietaryLicenseString(licenseString) {
  if (!licenseString) return true
  return /^custom:/i.test(licenseString) || /unknown/i.test(licenseString)
}

/**
 * Refuses any resolved attribution file path whose basename starts with a
 * dot. See the module doc comment's "Kept pure where it matters" section for
 * why this exists even though license-checker itself never produces such a
 * path in practice.
 */
export function isSafeAttributionFile(filePath) {
  if (!filePath) return false
  return !basename(filePath).startsWith(".")
}

/** Later maps win on a `name@version` collision — callers pass payload first, desktop-asar second, matching neither tree's own priority claim over the other (they're genuinely separate copies, see electron-builder.config.mjs's own doc comment on `debug`/`ms` appearing in both). */
export function mergePackageInfo(...packageMaps) {
  const merged = new Map()
  for (const map of packageMaps) {
    for (const [key, info] of Object.entries(map)) {
      merged.set(key, info)
    }
  }
  return merged
}

/**
 * Renders one `name@version` entry. `licenseText`/`noticeText` are the
 * already-read file contents (or `null` when none was found/safe to read) —
 * this function does no I/O itself.
 */
export function renderPackageEntry(key, info, { licenseText, noticeText } = {}) {
  const lines = [key]
  const proprietary = isProprietaryLicenseString(info.licenses)
  if (proprietary) {
    // Deliberately no hand-copied paraphrase of what a "Custom:" license
    // says — that would be a second, driftable source of truth for
    // something a legal notice should state exactly once. The package's own
    // actual license file, embedded verbatim below via `licenseText`, is
    // that one source (for @anthropic-ai/claude-agent-sdk* specifically,
    // its LICENSE.md already reads "© Anthropic PBC. All rights reserved.
    // Use is subject to the Legal Agreements outlined here: …" — exactly
    // the honest disclosure this banner exists to surface, without this
    // script needing to know that's what it says).
    lines.push("License: PROPRIETARY — NOT AN OPEN SOURCE LICENSE (see full text below)")
  } else {
    lines.push(`License: ${info.licenses ?? "UNKNOWN"}`)
  }
  if (info.repository) lines.push(`Repository: ${info.repository}`)
  if (info.publisher) lines.push(`Publisher: ${info.publisher}`)
  if (licenseText) {
    lines.push("")
    lines.push(licenseText.trim())
  } else if (proprietary) {
    lines.push("")
    lines.push("(no license file found for this package — see the package's own metadata)")
  }
  if (noticeText) {
    lines.push("")
    lines.push("--- NOTICE ---")
    lines.push(noticeText.trim())
  }
  return lines.join("\n")
}

/**
 * `entries`: `{ key, info: { licenses, repository, publisher }, licenseText, noticeText }[]`.
 * Sorted by `key` so the output is stable and diffable across regenerations
 * regardless of scan order.
 */
export function renderNoticesDocument(entries) {
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key))
  const body = sorted.map((entry) => renderPackageEntry(entry.key, entry.info, entry))
  return [DOCUMENT_HEADER, ...body].join(`\n\n${SEPARATOR}\n\n`) + "\n"
}

/** Reads an attribution file's contents, refusing anything {@link isSafeAttributionFile} rejects. Never throws — a missing/unreadable file just contributes no text, same as one license-checker never found. */
export async function readAttributionFile(filePath, readFileFn = (p) => readFile(p, "utf8")) {
  if (!isSafeAttributionFile(filePath)) return null
  try {
    return await readFileFn(filePath)
  } catch {
    return null
  }
}

/** The impure half: asks license-checker-rseidelsohn to walk `startDir`'s real installed tree. */
function scanProductionDependencies(startDir) {
  return new Promise((resolvePromise, reject) => {
    initLicenseChecker({ start: startDir, production: true, excludePrivatePackages: true }, (err, packages) => {
      if (err) reject(err)
      else resolvePromise(packages)
    })
  })
}

/**
 * The full pipeline: scan both trees, merge, read each entry's license/notice
 * file, render. This is the one function electron-builder.config.mjs calls.
 */
export async function generateThirdPartyNotices({ payloadDir, desktopRoot }) {
  const [payloadPackages, desktopPackages] = await Promise.all([
    scanProductionDependencies(payloadDir),
    scanProductionDependencies(desktopRoot),
  ])
  const merged = mergePackageInfo(payloadPackages, desktopPackages)

  const entries = await Promise.all(
    [...merged.entries()].map(async ([key, info]) => {
      const [licenseText, noticeText] = await Promise.all([
        readAttributionFile(info.licenseFile),
        readAttributionFile(info.noticeFile),
      ])
      return {
        key,
        info: { licenses: info.licenses, repository: info.repository, publisher: info.publisher },
        licenseText,
        noticeText,
      }
    }),
  )
  return renderNoticesDocument(entries)
}

// CLI: `node generate-notices.mjs <payloadDir> <desktopRoot> [outFile]` —
// prints to stdout, or writes to outFile when given. Useful for ad-hoc
// inspection without invoking the full electron-builder config.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [payloadDir, desktopRoot, outFile] = process.argv.slice(2)
  if (!payloadDir || !desktopRoot) {
    console.error("usage: node generate-notices.mjs <payloadDir> <desktopRoot> [outFile]")
    process.exit(1)
  }
  const doc = await generateThirdPartyNotices({ payloadDir, desktopRoot })
  if (outFile) {
    const { writeFile } = await import("node:fs/promises")
    await writeFile(outFile, doc, "utf8")
    console.error(`wrote ${doc.length} bytes to ${outFile}`)
  } else {
    process.stdout.write(doc)
  }
}

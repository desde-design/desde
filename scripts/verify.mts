/**
 * scripts/verify.mts
 *
 * One-command end-to-end verification harness for the Desde Composer
 * worktree. Runs five stages: typecheck → lint → unit-tests →
 * editor-cli-tests → browser-smoke (boots the supervised Vite stack,
 * calls runSmoke, tears down). Writes durable artifacts under
 * .verify-artifacts/ and prints a summary table.
 *
 * Baseline-diffing: each baselined stage compares its failure signatures
 * against scripts/verify-baseline.json so only NEW regressions cause
 * a red build. browser-smoke is not baselined — it must always pass.
 *
 * Run via:
 *   npm run verify                        # all 5 stages
 *   npm run verify -- --no-browser
 *   npm run verify -- --smoke-only
 *   npm run verify -- --routes /,/ai-gateway/test-id/models/create
 *   npm run verify -- --update-baseline   # regenerate baseline from current state
 *
 * Node 25 + tsx notes:
 *   - Run with local tsx binary (npm run verify), NOT node --import tsx.
 *   - Default-import the smoke-runner (compositor is "type":"module" ESM
 *     compiled to CJS by tsx), then destructure at runtime.
 *   - scripts/ is excluded from tsconfig; this file is tsx-only.
 */

import { execSync, spawn, type ChildProcess } from "node:child_process"
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// ── Root paths (self-locating so the harness survives a move/merge) ────────────

// This file is <root>/scripts/verify.mts → one level up is the repo root.
const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EDITOR_CLI_DIR = path.join(WORKTREE_ROOT, "editor-cli")
const SMOKE_RUNNER_PATH = path.join(EDITOR_CLI_DIR, "src", "smoke", "smoke-runner.ts")
// The test prototype (ai-gateway-prototype) is gitignored — it lives in the
// primary checkout, not in a worktree. Prefer an in-repo copy, fall back to the
// sibling primary checkout, allow an explicit override via VERIFY_PROTOTYPE.
// The browser smoke boots the Editor against a real Vite prototype. The
// maintainer keeps one as a gitignored sibling checkout; a public clone has
// none, and must not fail `npm run verify` for lack of it. `VERIFY_PROTOTYPE`
// names one explicitly; otherwise the sibling is used if present; otherwise
// the stage is SKIPPED (ok, with a message), not failed.
const TEST_PROTOTYPE =
  process.env.VERIFY_PROTOTYPE ||
  (existsSync(path.join(WORKTREE_ROOT, "ai-gateway-prototype"))
    ? path.join(WORKTREE_ROOT, "ai-gateway-prototype")
    : null)
const ARTIFACTS_DIR = path.join(WORKTREE_ROOT, ".verify-artifacts")
const SMOKE_ARTIFACTS_DIR = path.join(ARTIFACTS_DIR, "smoke")
const SYSTEM_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const BASELINE_PATH = path.join(WORKTREE_ROOT, "scripts", "verify-baseline.json")

// Ports — pick numbers unlikely to conflict; the CLI may fall back
// if busy, and we parse the actual URL from stdout.
const SHELL_PORT = 4399
const VITE_PORT = 5399

// ── CLI flags ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const SMOKE_ONLY = argv.includes("--smoke-only")
const NO_BROWSER = argv.includes("--no-browser") && !SMOKE_ONLY
const UPDATE_BASELINE = argv.includes("--update-baseline")
const routesFlagIdx = argv.indexOf("--routes")
const SMOKE_ROUTES: string[] =
  routesFlagIdx !== -1 && argv[routesFlagIdx + 1]
    ? argv[routesFlagIdx + 1].split(",").map((r) => r.trim())
    : ["/", "/ai-gateway/test-id/models/create"]

// ── Artifact dir setup ───────────────────────────────────────────────────────

mkdirSync(ARTIFACTS_DIR, { recursive: true })
mkdirSync(SMOKE_ARTIFACTS_DIR, { recursive: true })

// ── Types ─────────────────────────────────────────────────────────────────────

interface StageResult {
  stage: string
  ok: boolean
  durationMs: number
  logPath: string | null
  detail?: string
  /** Failure signatures extracted from this run */
  signatures?: string[]
  /** Diffing stats vs baseline (populated after baseline comparison) */
  diff?: {
    new: string[]
    stillPresent: string[]
    fixed: string[]
  }
}

type BaselinedStageName = "typecheck" | "lint" | "unit-tests" | "editor-cli-tests"

interface BaselineFile {
  generatedAt: string
  stages: Record<BaselinedStageName, string[]>
}

// ── Logging helper ────────────────────────────────────────────────────────────

function logPath(stage: string): string {
  return path.join(ARTIFACTS_DIR, `${stage}.log`)
}

// ── Relative-path helper (for stable signatures) ──────────────────────────────

function toRelPath(absPath: string): string {
  if (absPath.startsWith(WORKTREE_ROOT + "/")) {
    return absPath.slice(WORKTREE_ROOT.length + 1)
  }
  return absPath
}

// ── Normalise arbitrary text: replace runs of digits with '#' ─────────────────

function normaliseDigits(s: string): string {
  return s.replace(/\d+/g, "#")
}

// ── Signature extractors ───────────────────────────────────────────────────────

/**
 * Typecheck: parse tsc output for "error TS####" lines.
 * Signature: <relpath>:TS####:<msg-with-digits-normalised>
 * Drop line:col.
 *
 * tsc output line format:
 *   path/to/file.ts(LINE,COL): error TS####: message text
 */
function extractTypecheckSignatures(output: string): string[] {
  const sigs = new Set<string>()
  // Match: <path>(<line>,<col>): error TS<code>: <message>
  const re = /^(.+?)\(\d+,\d+\): error (TS\d+): (.+)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(output)) !== null) {
    const relPath = toRelPath(m[1].trim())
    const tsCode = m[2]
    const msg = normaliseDigits(m[3].trim())
    sigs.add(`${relPath}:${tsCode}:${msg}`)
  }
  return Array.from(sigs).sort()
}

/**
 * Lint: parse eslint output, extract ONLY severity=error lines.
 * Signature: <relpath>:<ruleId>
 * Drop line:col.
 *
 * eslint output (default formatter) has:
 *   /abs/path/file.ts
 *     LINE:COL  error  message  rule-id
 *     LINE:COL  warning  message  rule-id
 *
 * We also handle the compact formatter:
 *   /abs/path/file.ts: line LINE, col COL, Error - message (rule-id)
 */
function extractLintSignatures(output: string): string[] {
  const sigs = new Set<string>()

  let currentFile = ""
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim()

    // Detect file header (absolute path, no leading spaces in original)
    if (rawLine.match(/^\//) && !line.includes("  error  ") && !line.includes("  warning  ")) {
      // Could be a file path line — strip trailing colon (compact format)
      const candidate = line.replace(/:$/, "")
      if (!candidate.includes("  ")) {
        currentFile = candidate
        continue
      }
    }

    // Default formatter: "  LINE:COL  error  message  rule-id"
    const defaultMatch = line.match(/^\d+:\d+\s+error\s+.+?\s+(\S+)$/)
    if (defaultMatch && currentFile) {
      const relPath = toRelPath(currentFile)
      const ruleId = defaultMatch[1]
      sigs.add(`${relPath}:${ruleId}`)
      continue
    }

    // Compact formatter: "/path: line L, col C, Error - msg (rule-id)"
    const compactMatch = line.match(/^(.+?):\s+line \d+, col \d+, Error - .+\((.+?)\)$/)
    if (compactMatch) {
      const relPath = toRelPath(compactMatch[1])
      const ruleId = compactMatch[2]
      sigs.add(`${relPath}:${ruleId}`)
    }
  }

  return Array.from(sigs).sort()
}

/**
 * Lint via eslint's JSON formatter — robust rule ids.
 * Signature: <relpath>:<ruleId>, for BOTH errors (severity 2) and warnings
 * (severity 1).
 *
 * Warnings used to be dropped here, which meant `npm run verify` was blind to
 * them by construction while `npm run lint` printed them and enforced nothing
 * — so the warning count only ever went up. It reached 34. The 2026-08-08
 * audit pass drove it to 0 and found a real bug on the way (a stale
 * closure read in `handleSaveAll` that could report "saved!" with nothing
 * written), which had been sitting indistinguishable from noise.
 *
 * A tolerated floor is where the next one hides. `eslint.config.mjs` already
 * says as much about its own `_`-prefix rule; the gate just never agreed.
 * Counting warnings here is what makes `--max-warnings 0` in the lint script
 * actually load-bearing, since this stage's pass/fail is decided by baseline
 * signature diffing, NOT by the command's exit code.
 *
 * The text formatter is fragile: messages without a rule id (e.g. the
 * react-compiler `Error: …cascading renders` diagnostics) make a
 * last-token scrape capture a message word as the "rule", which then
 * never matches the baseline → false "new" failures. The JSON formatter
 * carries the real `ruleId`, so the signature is stable run-to-run.
 */
function extractLintSignaturesFromJson(
  jsonPath: string,
  fallbackOutput: string,
  warnLines: string[],
): string[] {
  const sigs = new Set<string>()
  try {
    if (existsSync(jsonPath)) {
      const data = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
        filePath: string
        messages: Array<{ ruleId: string | null; severity: number }>
      }>
      for (const file of data) {
        const rel = toRelPath(file.filePath)
        for (const m of file.messages) {
          if (m.severity >= 1) sigs.add(`${rel}:${m.ruleId ?? "no-rule"}`)
        }
      }
      return Array.from(sigs).sort()
    }
  } catch (err) {
    warnLines.push(`[baseline] Warning: lint JSON parse failed for ${jsonPath}: ${String(err)}`)
  }
  warnLines.push(`[baseline] Warning: lint JSON not found at ${jsonPath}; using text scraping.`)
  return extractLintSignatures(fallbackOutput)
}

/**
 * Vitest JSON: parse the --reporter=json output for failed tests.
 * Signature: <relpath>::<ancestor chain> > <test title>
 * Falls back to scraping text output if JSON is missing/corrupt.
 */
function extractVitestSignaturesFromJson(
  jsonPath: string,
  fallbackOutput: string,
  warnLines: string[],
): string[] {
  const sigs = new Set<string>()

  try {
    if (existsSync(jsonPath)) {
      const raw = readFileSync(jsonPath, "utf8")
      const data = JSON.parse(raw) as {
        testResults: Array<{
          name: string
          assertionResults: Array<{
            status: string
            ancestorTitles: string[]
            title: string
          }>
        }>
      }
      for (const suite of data.testResults) {
        const relPath = toRelPath(suite.name)
        for (const test of suite.assertionResults) {
          if (test.status === "failed") {
            const chain = [...test.ancestorTitles, test.title].join(" > ")
            sigs.add(`${relPath}::${chain}`)
          }
        }
      }
      return Array.from(sigs).sort()
    }
  } catch (err) {
    warnLines.push(`[baseline] Warning: JSON parse failed for ${jsonPath}: ${String(err)}`)
    warnLines.push(`[baseline] Falling back to text scraping for this stage.`)
  }

  // Fallback: scrape text output for FAIL / × lines
  warnLines.push(`[baseline] Warning: JSON file not found at ${jsonPath}; using text scraping.`)
  const lines = fallbackOutput.split("\n")
  for (const line of lines) {
    // vitest text: " × test name" or " FAIL src/path.ts > test name"
    const failMatch = line.match(/[×✕]\s+(.+)/)
    if (failMatch) {
      sigs.add(normaliseDigits(failMatch[1].trim()))
    }
  }
  return Array.from(sigs).sort()
}

// ── Run a shell command, tee output to a log file ────────────────────────────

function runStage(
  stage: string,
  command: string,
  cwd: string,
): StageResult {
  const lp = logPath(stage)
  const start = Date.now()
  let ok = false
  let detail: string | undefined
  let output = ""

  // Header in log
  const header = `=== ${stage} ===\nCommand: ${command}\nCwd: ${cwd}\nStarted: ${new Date().toISOString()}\n\n`
  writeFileSync(lp, header, "utf8")

  try {
    output = execSync(command, {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    })
    writeFileSync(lp, header + output, "utf8")
    ok = true
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    const combined = [e.stdout ?? "", e.stderr ?? "", e.message ?? ""].join("\n")
    output = combined
    writeFileSync(lp, header + combined, "utf8")
    detail = (e.message ?? "command failed").split("\n")[0]
    ok = false
  }

  return { stage, ok, durationMs: Date.now() - start, logPath: lp, detail, _rawOutput: output } as StageResult & { _rawOutput: string }
}

// ── Baseline file I/O ─────────────────────────────────────────────────────────

function loadBaseline(): BaselineFile | null {
  if (!existsSync(BASELINE_PATH)) return null
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile
  } catch {
    return null
  }
}

function saveBaseline(stages: Record<BaselinedStageName, string[]>): void {
  const data: BaselineFile = {
    generatedAt: new Date().toISOString(),
    stages,
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + "\n", "utf8")
}

// ── Signature extraction per stage ───────────────────────────────────────────

/**
 * Run a baselined stage and extract its failure signatures.
 * For unit-tests and editor-cli-tests we inject --reporter=json so we get
 * a stable machine-readable list of failing test IDs.
 */
function runBaselinedStage(
  stage: BaselinedStageName,
  baseCommand: string,
  cwd: string,
  warnLines: string[],
): StageResult & { signatures: string[] } {
  let command = baseCommand
  let jsonOutputPath: string | null = null

  if (stage === "lint") {
    jsonOutputPath = path.join(ARTIFACTS_DIR, "lint.json")
    // eslint JSON formatter → stable rule ids (see extractLintSignaturesFromJson).
    command = `${baseCommand} -- --format json --output-file ${jsonOutputPath}`
  } else if (stage === "unit-tests") {
    jsonOutputPath = path.join(ARTIFACTS_DIR, "unit-tests.json")
    // Inject JSON reporter alongside default so we get the machine-readable output
    command = `${baseCommand} -- --reporter=json --outputFile=${jsonOutputPath}`
  } else if (stage === "editor-cli-tests") {
    jsonOutputPath = path.join(ARTIFACTS_DIR, "editor-cli-tests.json")
    command = `${baseCommand} --reporter=json --outputFile=${jsonOutputPath}`
  }

  const result = runStage(stage, command, cwd) as StageResult & { _rawOutput: string }
  const rawOutput = result._rawOutput ?? ""
  delete (result as { _rawOutput?: string })._rawOutput

  let signatures: string[]
  if (stage === "typecheck") {
    signatures = extractTypecheckSignatures(rawOutput)
  } else if (stage === "lint") {
    signatures = extractLintSignaturesFromJson(jsonOutputPath!, rawOutput, warnLines)
  } else {
    // unit-tests or editor-cli-tests
    signatures = extractVitestSignaturesFromJson(jsonOutputPath!, rawOutput, warnLines)
  }

  return { ...result, signatures }
}

// ── Diff signatures against baseline ─────────────────────────────────────────

function diffSignatures(
  current: string[],
  baseline: string[],
): { new: string[]; stillPresent: string[]; fixed: string[] } {
  const baseSet = new Set(baseline)
  const currSet = new Set(current)
  return {
    new: current.filter((s) => !baseSet.has(s)),
    stillPresent: current.filter((s) => baseSet.has(s)),
    fixed: baseline.filter((s) => !currSet.has(s)),
  }
}

// ── Browser-smoke stage ───────────────────────────────────────────────────────

async function runBrowserSmoke(): Promise<StageResult> {
  const stage = "browser-smoke"
  const lp = logPath(stage)
  const bootLp = logPath("boot")
  const start = Date.now()

  const log = (msg: string) => {
    process.stdout.write(msg + "\n")
    try {
      const ws = createWriteStream(lp, { flags: "a" })
      ws.write(msg + "\n")
      ws.close()
    } catch {}
  }

  // Write log headers
  writeFileSync(lp, `=== browser-smoke ===\nStarted: ${new Date().toISOString()}\n\n`, "utf8")

  if (!TEST_PROTOTYPE) {
    const detail =
      "SKIPPED: no prototype to boot against. Set VERIFY_PROTOTYPE=<path to a Vite prototype repo> " +
      "to run the browser smoke; every other stage ran."
    log(detail)
    appendFileSync(lp, detail + "\n", "utf8")
    return { stage, ok: true, durationMs: Date.now() - start, logPath: lp, detail }
  }  writeFileSync(bootLp, `=== boot ===\nStarted: ${new Date().toISOString()}\n\n`, "utf8")

  // Branch mode (the mode under test) edits the working tree in place and
  // requires the prototype to be a git repo — its preflight refuses a
  // non-repo root. Fail early with an actionable message rather than a
  // cryptic CLI boot error. The smoke never writes, so a git repo here is
  // only a boot requirement, not a mutation risk.
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: TEST_PROTOTYPE,
      stdio: "ignore",
    })
  } catch {
    const detail =
      `TEST_PROTOTYPE is not a git repository: ${TEST_PROTOTYPE}. ` +
      `Branch mode needs one — run \`git init\` there (or point VERIFY_PROTOTYPE at a git repo).`
    log(`SKIP/FAIL: ${detail}`)
    return { stage, ok: false, durationMs: Date.now() - start, logPath: lp, detail }
  }

  // Kill any stray CLI processes from prior runs
  try {
    execSync(`pkill -f "cli.ts ${TEST_PROTOTYPE}"`, { stdio: "ignore" })
    await sleep(500)
  } catch {
    // None running — that's fine
  }

  let cli: ChildProcess | null = null

  try {
    log(`Booting editor-cli against ${TEST_PROTOTYPE}`)
    log(`Ports: shell=${SHELL_PORT} vite=${VITE_PORT}`)

    // Boot the CLI as a child process from the WORKTREE's editor-cli dir
    // so the worktree's code is under test.
    cli = spawn(
      "npx",
      [
        "tsx",
        path.join(EDITOR_CLI_DIR, "src", "cli.ts"),
        TEST_PROTOTYPE,
        "--no-open",
        "--shell-port",
        String(SHELL_PORT),
        "--vite-port",
        String(VITE_PORT),
      ],
      {
        cwd: EDITOR_CLI_DIR,
        stdio: "pipe",
        // Branch mode — the interactive default (tasks/branches-vs-worktree.md
        // Phase 5) — is what the smoke now exercises. Branch mode edits the
        // working tree in place and needs a git repo; the git-repo guard
        // above ensures TEST_PROTOTYPE is one before we boot. The smoke
        // itself is read-only (navigate + assert the bridge injected + no
        // console errors — no edit/session POSTs), so booting branch mode in
        // place against the prototype leaves its working tree untouched.
        // EDITOR_WORKTREE_MODE is intentionally NOT set — passing the parent
        // env through keeps any explicit override the caller set, but the
        // default path under test is branch mode.
        env: { ...process.env },
      },
    )

    // Capture all CLI output and parse the actual vite URL
    let viteUrl: string | null = null
    const bootLog = createWriteStream(bootLp, { flags: "a" })
    const stdoutLines: string[] = []

    cli.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString()
      bootLog.write(`[stdout] ${text}`)
      stdoutLines.push(text)

      // Parse "▸ Vite running at http://127.0.0.1:<PORT>"
      const match = text.match(/▸ Vite running at (http:\/\/[\w.:]+)/)
      if (match && !viteUrl) {
        viteUrl = match[1]
        log(`Parsed Vite URL from stdout: ${viteUrl}`)
      }
    })

    cli.stderr?.on("data", (chunk: Buffer) => {
      bootLog.write(`[stderr] ${chunk.toString()}`)
    })

    cli.on("error", (err) => {
      bootLog.write(`[error] ${err.message}\n`)
    })

    // Wait for the vite URL to appear in stdout AND be reachable
    log("Waiting for Vite to be ready (up to 60s)...")
    const viteReadyUrl = await waitForViteReady(cli, stdoutLines, bootLog, 60_000)

    if (!viteReadyUrl) {
      throw new Error(
        "Vite URL never appeared in CLI stdout or never became reachable within 60s. " +
        "Check boot.log for details."
      )
    }

    viteUrl = viteReadyUrl
    log(`Vite ready at ${viteUrl}`)
    log(`Running smoke against routes: ${SMOKE_ROUTES.join(", ")}`)

    // Import runSmoke from the worktree's smoke-runner. editor-cli is
    // "type":"module" so a named import resolves to real exports; we still
    // tolerate a default-wrapped shape per the editor-testing skill's
    // Node-25 + tsx gotcha note.
    type RunSmoke = typeof import("../editor-cli/src/smoke/smoke-runner.ts").runSmoke
    const smokeModule = (await import(SMOKE_RUNNER_PATH)) as {
      runSmoke?: RunSmoke
      default?: { runSmoke?: RunSmoke }
    }
    const runSmoke = smokeModule.runSmoke ?? smokeModule.default?.runSmoke

    if (typeof runSmoke !== "function") {
      throw new Error("Could not resolve runSmoke from smoke-runner.ts")
    }

    const smokeReport = await runSmoke({
      baseUrl: viteUrl,
      routes: SMOKE_ROUTES,
      expectBridge: true,
      screenshot: true,
      artifactsDir: SMOKE_ARTIFACTS_DIR,
      chromeExecutablePath: SYSTEM_CHROME,
      timeoutMs: 30_000,
      // Ignore noisy-but-benign patterns the prototype emits in dev mode
      ignoreConsolePatterns: [
        "[vite]",
        "vue-devtools",
        "download the vue devtools",
      ],
    })

    // Write the smoke report JSON path to the stage log
    const reportJsonPath = path.join(SMOKE_ARTIFACTS_DIR, "report.json")
    log(`Smoke report written to ${reportJsonPath}`)
    log(`Smoke ok: ${smokeReport.ok}`)

    for (const r of smokeReport.routes) {
      const status = r.ok ? "PASS" : "FAIL"
      log(`  ${status} ${r.route} (${r.durationMs}ms) bridge=${r.bridgeVersion ?? "none"}`)
      if (!r.ok) {
        if (r.error) log(`    error: ${r.error}`)
        if (r.consoleErrors.length) log(`    console errors: ${r.consoleErrors.slice(0, 3).join("; ")}`)
        if (r.pageErrors.length) log(`    page errors: ${r.pageErrors.slice(0, 3).join("; ")}`)
        if (r.failedRequests.filter(req => req.critical).length) {
          log(`    critical network failures: ${r.failedRequests.filter(req => req.critical).map(req => req.url).slice(0, 3).join("; ")}`)
        }
        if (r.bridgeOk === false) log(`    bridge: DID NOT INIT`)
      }
    }

    return {
      stage,
      ok: smokeReport.ok,
      durationMs: Date.now() - start,
      logPath: lp,
      detail: smokeReport.ok
        ? undefined
        : `${smokeReport.routes.filter((r) => !r.ok).length}/${smokeReport.routes.length} routes failed`,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`FATAL: ${msg}`)
    return { stage, ok: false, durationMs: Date.now() - start, logPath: lp, detail: msg }
  } finally {
    // Teardown — always kill the CLI child process
    if (cli) {
      log("Tearing down CLI child process...")
      cli.kill("SIGTERM")
      await sleep(1500)
      if (cli.exitCode === null) {
        log("CLI still running after 1.5s — sending SIGKILL")
        cli.kill("SIGKILL")
      }
    }
  }
}

// ── Wait for Vite to be ready ─────────────────────────────────────────────────

async function waitForViteReady(
  cli: ChildProcess,
  stdoutLines: string[],
  bootLog: ReturnType<typeof createWriteStream>,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  let viteUrl: string | null = null

  while (Date.now() < deadline) {
    // Check if CLI exited unexpectedly
    if (cli.exitCode !== null) {
      bootLog.write(`[waitForViteReady] CLI exited with code ${cli.exitCode}\n`)
      return null
    }

    // Look for the vite URL in accumulated stdout
    for (const line of stdoutLines) {
      const match = line.match(/▸ Vite running at (http:\/\/[\w.:]+)/)
      if (match) {
        viteUrl = match[1]
        break
      }
    }

    if (viteUrl) {
      // URL seen — now wait for it to actually respond
      try {
        const res = await fetch(`${viteUrl}/`, { signal: AbortSignal.timeout(3000) })
        if (res.ok || res.status < 500) {
          return viteUrl
        }
      } catch {
        // Not ready yet — keep polling
      }
    }

    await sleep(250)
  }

  return viteUrl // may be null if we never saw the line
}

// ── Sleep helper ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Summary table printer ─────────────────────────────────────────────────────

function printSummary(results: StageResult[], warnLines: string[]): void {
  const COL_STAGE = 24
  const COL_RESULT = 6
  const COL_DURATION = 10
  const COL_BASELINE = 30
  const LINE = "─".repeat(COL_STAGE + COL_RESULT + COL_DURATION + COL_BASELINE + 10)

  // Print any baseline warnings first
  if (warnLines.length > 0) {
    console.log()
    for (const w of warnLines) {
      console.log(w)
    }
  }

  console.log("\n" + LINE)
  console.log(
    padR("Stage", COL_STAGE) + " │ " +
    padR("Result", COL_RESULT) + " │ " +
    padR("Duration", COL_DURATION) + " │ " +
    padR("Baseline diff", COL_BASELINE)
  )
  console.log(LINE)

  for (const r of results) {
    const resultStr = r.ok ? "PASS" : "FAIL"
    const durStr = `${(r.durationMs / 1000).toFixed(1)}s`
    let baselineStr = ""
    if (r.diff) {
      const parts = [`${r.diff.new.length} new / ${r.diff.stillPresent.length} baselined`]
      if (r.diff.fixed.length > 0) parts.push(`${r.diff.fixed.length} fixed`)
      baselineStr = parts.join(", ")
    } else if (r.stage === "browser-smoke") {
      baselineStr = "(not baselined)"
    }

    console.log(
      padR(r.stage, COL_STAGE) + " │ " +
      padR(resultStr, COL_RESULT) + " │ " +
      padR(durStr, COL_DURATION) + " │ " +
      padR(baselineStr, COL_BASELINE)
    )
    if (!r.ok) {
      if (r.diff && r.diff.new.length > 0) {
        console.log(`  NEW failures (not in baseline):`)
        for (const sig of r.diff.new) {
          console.log(`    ${sig}`)
        }
      } else if (!r.diff && r.detail) {
        console.log(`  Reason: ${r.detail}`)
      }
      if (r.logPath) {
        console.log(`  Log:    ${r.logPath}`)
      }
    }
  }

  console.log(LINE)

  const allOk = results.every((r) => r.ok)
  const verdict = allOk ? "ALL STAGES PASSED" : "ONE OR MORE STAGES FAILED"
  console.log(`\n${verdict}\n`)
}

function padR(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length)
}

// ── --update-baseline mode ────────────────────────────────────────────────────

async function runUpdateBaseline(): Promise<void> {
  console.log("[verify] --update-baseline: running all 4 baselined stages...\n")

  const warnLines: string[] = []
  const stages: Array<{ name: BaselinedStageName; command: string; cwd: string }> = [
    { name: "typecheck", command: "npm run typecheck", cwd: WORKTREE_ROOT },
    { name: "lint", command: "npm run lint", cwd: WORKTREE_ROOT },
    { name: "unit-tests", command: "npm run test", cwd: WORKTREE_ROOT },
    { name: "editor-cli-tests", command: "npx vitest run", cwd: EDITOR_CLI_DIR },
  ]

  const newBaseline: Record<BaselinedStageName, string[]> = {
    typecheck: [],
    lint: [],
    "unit-tests": [],
    "editor-cli-tests": [],
  }

  for (const { name, command, cwd } of stages) {
    console.log(`[verify] Baselining ${name}...`)
    const result = runBaselinedStage(name, command, cwd, warnLines)
    newBaseline[name] = result.signatures
    console.log(`  → ${result.signatures.length} failure signatures captured`)
  }

  saveBaseline(newBaseline)

  console.log(`\n[verify] Baseline written to ${BASELINE_PATH}`)
  console.log("\nPer-stage counts:")
  for (const [stage, sigs] of Object.entries(newBaseline)) {
    console.log(`  ${stage}: ${sigs.length} signatures`)
  }

  if (warnLines.length > 0) {
    console.log("\nWarnings:")
    for (const w of warnLines) console.log(`  ${w}`)
  }

  console.log("\nBaseline updated. Run `npm run verify` to confirm GREEN.\n")
  process.exit(0)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // --update-baseline is a special mode — runs stages, writes file, exits
  if (UPDATE_BASELINE) {
    await runUpdateBaseline()
    return // unreachable (runUpdateBaseline exits), but satisfies TypeScript
  }

  // Load baseline (may be null)
  const baseline = loadBaseline()
  const warnLines: string[] = []

  if (!baseline && !SMOKE_ONLY) {
    warnLines.push(
      "WARNING: No baseline file found at scripts/verify-baseline.json.",
      "         All pre-existing failures will appear as NEW regressions.",
      "         Run `npm run verify -- --update-baseline` on a known-good state to create it.",
    )
  }

  const results: StageResult[] = []

  if (!SMOKE_ONLY) {
    // Stage 1: typecheck
    console.log("[verify] Running typecheck...")
    const tc = runBaselinedStage("typecheck", "npm run typecheck", WORKTREE_ROOT, warnLines)
    tc.diff = diffSignatures(tc.signatures, baseline?.stages.typecheck ?? [])
    tc.ok = tc.diff.new.length === 0
    results.push(tc)

    // Stage 2: lint
    console.log("[verify] Running lint...")
    const lint = runBaselinedStage("lint", "npm run lint", WORKTREE_ROOT, warnLines)
    lint.diff = diffSignatures(lint.signatures, baseline?.stages.lint ?? [])
    lint.ok = lint.diff.new.length === 0
    results.push(lint)

    // Stage 3: unit-tests (root vitest)
    console.log("[verify] Running unit tests...")
    const ut = runBaselinedStage("unit-tests", "npm run test", WORKTREE_ROOT, warnLines)
    ut.diff = diffSignatures(ut.signatures, baseline?.stages["unit-tests"] ?? [])
    ut.ok = ut.diff.new.length === 0
    results.push(ut)

    // Stage 4: editor-cli tests
    console.log("[verify] Running editor-cli tests...")
    const ct = runBaselinedStage("editor-cli-tests", "npx vitest run", EDITOR_CLI_DIR, warnLines)
    ct.diff = diffSignatures(ct.signatures, baseline?.stages["editor-cli-tests"] ?? [])
    ct.ok = ct.diff.new.length === 0
    results.push(ct)

    // Stage 4b: knip dead-code gate (share-readiness Phase 1). Strict subset
    // only — unused FILES, unused/unlisted DEPENDENCIES, and binaries must
    // stay at zero (config in knip.json). Unused EXPORTS are intentionally
    // excluded: that burndown belongs to the per-area audit phases; run
    // `npx knip` manually for the full report.
    console.log("[verify] Running knip (dead files + deps)...")
    results.push(
      runStage(
        "knip",
        "npx knip --no-progress --no-config-hints --include files,dependencies,unlisted,binaries",
        WORKTREE_ROOT,
      ),
    )

    // Stage 4c: BRIDGE_VERSION bump gate. Not baselined — there is no such
    // thing as a tolerable failure here, and the fix is one line.
    //
    // Distinct from `bridge-bundle-version.test.ts`, which catches "source
    // edited, bundle not rebuilt" by byte-comparing a fresh esbuild. This
    // catches the OTHER staleness: rebuilt correctly but the version string
    // left alone. The bundle is then perfectly self-consistent, so nothing
    // else notices — while every client holding the old immutable URL keeps
    // running the old bridge. It happened on 2026-08-08 and was found by eye
    // during an E2E run, which is not a control.
    console.log("[verify] Checking BRIDGE_VERSION was bumped...")
    results.push(
      runStage("bridge-version", "npx tsx scripts/check-bridge-version.mts", WORKTREE_ROOT),
      // scripts/ is excluded from tsconfig (tsx-only), so nothing type-checks
      // these files and a syntax error surfaces only when the script RUNS.
      // MEASURED 2026-09-01: an `await` in a non-async function shipped to the
      // public repo in build-desktop-app.mts and broke `npm run package:desktop`
      // on first use. esbuild's transform is the cheapest thing that catches
      // it, and it runs in well under a second.
      runStage(
        "scripts-transform",
        "npx esbuild scripts/*.mts --format=esm --log-level=error --outdir=.verify-artifacts/scripts-transform",
        WORKTREE_ROOT,
      ),
    )
  }

  if (!NO_BROWSER) {
    // Stage 5: browser-smoke (not baselined — must always pass)
    console.log("[verify] Running browser smoke...")
    results.push(await runBrowserSmoke())
  }

  // Write top-level verify-report.json
  const verifyReport = {
    ok: results.every((r) => r.ok),
    generatedAt: new Date().toISOString(),
    stages: results.map(({ stage, ok, durationMs, logPath, diff }) => ({
      stage,
      ok,
      durationMs,
      logPath,
      ...(diff
        ? {
            new: diff.new,
            stillPresent: diff.stillPresent,
            fixed: diff.fixed,
          }
        : {}),
    })),
  }
  const verifyReportPath = path.join(ARTIFACTS_DIR, "verify-report.json")
  writeFileSync(verifyReportPath, JSON.stringify(verifyReport, null, 2), "utf8")
  console.log(`\n[verify] Report written to ${verifyReportPath}`)

  printSummary(results, warnLines)

  const allOk = results.every((r) => r.ok)
  process.exit(allOk ? 0 : 1)
}

main().catch((err) => {
  console.error("[verify] Fatal error:", err)
  process.exit(1)
})

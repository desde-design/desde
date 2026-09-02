/**
 * The two pieces of the boot-failure relay that are pure: the bounded stderr
 * accumulator, and the block it turns into.
 *
 * The relay's other half — actually piping the child's stderr instead of
 * inheriting it — is not unit-testable without spawning a real editor, and was
 * verified by MEASUREMENT instead: a live launcher against an Astro repo whose
 * dependencies were never installed showed the child's full message in the
 * modal (it had shown `editor exited before it was ready (code 4)`), and the
 * launcher's own terminal still received the same bytes, so tee'ing did not
 * silence it.
 */

import { describe, expect, it } from "vitest"
import {
  EditorBootFailure,
  bootFailureBlock,
  createStderrTail,
} from "../editor-boot-failure.js"
import type { LauncherSupportedHost } from "../../../../src/types/launcher.js"

const SUPPORTED: LauncherSupportedHost[] = [{ id: "vite", label: "Vite" }]

describe("createStderrTail", () => {
  it("accumulates across chunks", () => {
    const tail = createStderrTail()
    // Chunk boundaries belong to the pipe, not the writer — the same lesson the
    // ready-line reader was fixed for.
    tail.append("This project declares Astro ")
    tail.append("but astro is not installed.")
    expect(tail.text()).toBe("This project declares Astro but astro is not installed.")
  })

  it("keeps the TAIL, not the head, once over the limit", () => {
    const tail = createStderrTail(20)
    tail.append("noise ".repeat(40))
    tail.append("THE REAL FAILURE")
    // The typed refusals print immediately before exiting, so the last bytes
    // are the explanation and the earlier ones are boot warnings.
    expect(tail.text()).toContain("THE REAL FAILURE")
    expect(tail.text().length).toBeLessThanOrEqual(20)
  })

  it("keeps a single oversized chunk's own tail rather than dropping it", () => {
    const tail = createStderrTail(10)
    tail.append("0123456789ABCDEF")
    expect(tail.text()).toBe("6789ABCDEF")
  })

  it("is empty for a child that said nothing", () => {
    expect(createStderrTail().text()).toBe("")
  })
})

describe("EditorBootFailure", () => {
  it("keeps the exact message this path has always rejected with", () => {
    // Load-bearing: the `reason` field older clients read keeps its meaning,
    // and the silent-death fallback still reads correctly.
    expect(new EditorBootFailure(4, "detail").message).toBe(
      "editor exited before it was ready (code 4)",
    )
    expect(new EditorBootFailure(null, "").message).toBe(
      "editor exited before it was ready (code null)",
    )
  })
})

describe("bootFailureBlock", () => {
  it("relays the child's words verbatim as the cause", () => {
    const said = "This project declares Astro but astro is not installed.\n\n  1. npx astro dev"
    const block = bootFailureBlock(new EditorBootFailure(4, said), "/repo", SUPPORTED)

    expect(block.code).toBe("boot-failed")
    // Verbatim, including its own formatting — no parsing, no re-phrasing.
    expect(block.cause).toBe(said)
    expect(block.supported).toEqual(SUPPORTED)
    // The contract says remediation is never empty.
    expect(block.remediation.length).toBeGreaterThan(0)
    expect(block.remediation.join(" ")).toContain("/repo")
  })
})

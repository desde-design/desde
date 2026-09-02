"use client"

import { Callout } from "@/components/blocks"
import { cn } from "@/lib/utils"
import type { LauncherOpenBlock } from "@/types/launcher"

/**
 * "This folder cannot be opened", rendered in full.
 *
 * The content is not invented here: `summary`, `cause` and `remediation` are
 * the CLI's own `HostFailure` fields, which have always been written for a
 * person to read and were being thrown away at a process boundary. The one
 * thing this component adds is the answer the failure itself cannot give:
 * **what IS supported**, taken from the host registry plus this project's own
 * config, so it cannot drift as hosts are switched on.
 *
 * ## Three simplifications, all Mo, 2026-08-17
 *
 * **No box inside the box.** The `boot-failed` cause used to render in its own
 * bordered, tinted panel headed "What Editor printed while starting it". A
 * card inside a banner is two nested containers for one message.
 *
 * That panel was solving something real, and dropping it gives that back: the
 * child process's message carries its own numbered steps ("1. In another
 * terminal: npx astro dev") and the remediation list below also starts at 1,
 * so two ordered lists stack with nothing between them. The gap and the
 * separator carry it now instead of a border. If that turns out to be too
 * little, the fix is to renumber, not to re-nest.
 *
 * **No small text.** Everything inside is `text-base`. The cause and the
 * remediation steps were `text-xs`, which made the explanation of a failure
 * the smallest thing on screen. Small type is for a hint under an input.
 *
 * **No dormant-host list.** A second list under the badges used to name every
 * built-but-switched-off host with a note about what it costs. A refusal
 * screen exists to say what you CAN do; cataloguing near-misses is the
 * opposite. `LauncherSupportedHost` no longer carries `enabled` or `note`, so
 * this is structural rather than a hidden branch.
 *
 * Nothing here names the product. See docs/design.md § "The product is not a
 * character in its own copy".
 */
export function OpenBlockNotice({
  block,
  className,
}: {
  block: LauncherOpenBlock
  className?: string
}) {
  return (
    <Callout
      tone="destructive"
      size="lg"
      role="alert"
      data-testid="launcher-open-block"
      className={cn("flex flex-col gap-3", className)}
    >
      <div className="flex flex-col gap-2">
        <p className="font-medium">{block.summary}</p>
        {block.cause ? (
          <p className="whitespace-pre-line text-foreground">{block.cause}</p>
        ) : null}
      </div>

      {/* May be empty now: when the honest answer is "your framework is not on
          the list", the list below IS the answer and a numbered step would
          only restate it in imperative mood. */}
      {block.remediation.length > 0 ? (
        <ol className="ml-4 flex list-decimal flex-col gap-1 text-foreground marker:text-muted-foreground">
          {block.remediation.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}

      {/*
        A sentence, not a divider and a row of chips.

        The chips were `Badge variant="outline"`, which is `text-2xs` (10px,
        the sans FLOOR) on `bg-input/20` with a `border-border` outline. On a
        destructive-tinted ground both the fill and the border wash out, so the
        one piece of actionable content in the banner was also the smallest and
        faintest thing in it. Overriding Badge here would have been four
        bespoke classes deep, which the 80% rule says means the component is
        wrong for the job.

        Four framework names are not a taxonomy that needs chip affordances,
        they are a list. `text-base text-foreground` in a plain sentence reads
        at body size with full contrast and needs no engineering. The `Eyebrow`
        went with it: "Supported:" inline says the same thing without a second
        typographic register, and the horizontal rule was separating two things
        that are one thought.
      */}
      {block.supported.length > 0 ? (
        <p className="text-foreground">
          <span className="text-muted-foreground">Supported: </span>
          {block.supported.map((host) => host.label).join(", ")}
        </p>
      ) : (
        <p className="text-foreground">
          No frameworks are switched on for this project.
        </p>
      )}
    </Callout>
  )
}

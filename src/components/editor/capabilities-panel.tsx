"use client"

/**
 * Extensions panel — see what the agent can reach, and turn things on.
 *
 * Every row shows the honest activation story rather than implying a click is
 * enough: a capability needing a secret is "enabled" the moment we write the
 * config, but inert until the user exports the variable and restarts. We name
 * the variable and never offer a field for its value — taking a credential
 * through this UI is the thing we are deliberately not doing.
 */

import { useState, type ReactNode } from "react"
import { Check, CircleAlert, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Callout, EmptyState, Eyebrow } from "@/components/blocks"
import { Figma, Globe, Puzzle } from "lucide-react"

/**
 * The glyph for each extension.
 *
 * Mapped here, not in `capability-catalog.ts`: that module is framework- and
 * React-neutral by the repo's own rule, and an icon component is neither.
 * `Puzzle` is the fallback so a catalog entry added without a glyph still
 * renders a card with the same geometry rather than a ragged one.
 */
const CAPABILITY_ICON: Record<string, typeof Figma> = {
  figma: Figma,
  "web-search": Globe,
}
import { cn } from "@/lib/utils"
import { EDITOR_BLOCK_SECRET_READS } from "@/lib/editor-feature-flags"
import { useEditorCapabilities, type CapabilityRow } from "@/hooks/useEditorCapabilities"
import { ExtensionKeyDialog } from "./extension-key-dialog"

export function CapabilitiesPanel({
  open,
  className,
}: {
  /** Drives the fetch — the dialog mounts this only while it is showing. */
  open: boolean
  className?: string
}) {
  const state = useEditorCapabilities(open)
  /**
   * Which extension's key form is open, by capability id.
   *
   * The row is re-read out of `state.capabilities` on every render rather
   * than snapshotted here, so a save refreshing the list updates the dialog
   * that is still on screen instead of showing what was true when it opened.
   */
  const [keyDialogId, setKeyDialogId] = useState<string | null>(null)
  const keyRow = state.capabilities?.find((c) => c.id === keyDialogId) ?? null

  // One problems region instead of three independently-conditional banners
  // (config error, action error, warnings) that could all render at once and
  // put three tinted boxes above the thing the panel is for.
  //
  // The tones are NOT collapsed, because they mean different things: a
  // destructive problem means nothing is loaded, a warning means loaded with
  // caveats. Each message keeps its own colour, and the container escalates to
  // destructive whenever any blocking problem is present, so a blocking failure
  // can never render inside a merely-warning-coloured box.
  const problems: { tone: "destructive" | "warning"; key: string; body: ReactNode }[] = [
    ...(state.configError
      ? [
          {
            tone: "destructive" as const,
            key: "config",
            // Three sentences in the order a stuck reader needs them:
            // what is broken FOR THEM, then the technical cause, then the
            // move that fixes it. It used to open on ".mcp.json couldn't be
            // read", which is a file most people here never wrote and a
            // symptom rather than a consequence, and it never said what to
            // do — so the reader learned a filename and stayed stuck.
            //
            // `configError` already names the file and the parse position, so
            // this does not repeat either. It supplies only the two things the
            // raw error cannot: the consequence, and the way out.
            body: (
              <>
                <span className="font-medium">No extensions can be turned on.</span>{" "}
                {state.configError} Fix that file, or delete it and turn the
                extensions below back on here.
              </>
            ),
          },
        ]
      : []),
    ...(state.error
      ? [{ tone: "destructive" as const, key: "action", body: state.error }]
      : []),
    ...state.warnings.map((warning) => ({
      tone: "warning" as const,
      key: `warn:${warning}`,
      body: warning,
    })),
  ]
  const hasBlocking = problems.some((p) => p.tone === "destructive")

  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid="capabilities-panel">
      {problems.length > 0 ? (
        <Callout
          tone={hasBlocking ? "destructive" : "warning"}
          role={hasBlocking ? "alert" : "status"}
        >
          <ul className="flex flex-col gap-0.5">
            {problems.map((p) => (
              <li
                key={p.key}
                className={
                  p.tone === "destructive" ? "text-destructive" : "text-warning"
                }
              >
                {p.body}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      {state.capabilities === null ? (
        <div className="flex flex-col gap-1.5">
          {[0, 1].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
      ) : state.capabilities.length === 0 ? (
        <EmptyState
          size="sm"
          title="No capabilities available"
          description="Nothing is curated for this build."
        />
      ) : (
        <div className="flex flex-col gap-1">
          {state.capabilities.map((capability) => (
            <CapabilityRowItem
              key={capability.id}
              capability={capability}
              busy={state.busyId === capability.id}
              onEnable={() => void state.enable(capability.id)}
              onAddKey={() => setKeyDialogId(capability.id)}
            />
          ))}

          {state.unknownExtensions.length > 0 ? (
            <section className="mt-2 flex flex-col gap-1.5 border-t pt-3">
              <Eyebrow size="sm">Also in your .mcp.json</Eyebrow>
              <p className="text-xs text-muted-foreground">
                Declared by hand. Shown so this panel reflects the file, not
                just what we curate. Edit them there.
              </p>
              <div className="flex flex-wrap gap-1">
                {state.unknownExtensions.map((id) => (
                  <Badge key={id} variant="secondary">
                    {id}
                  </Badge>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}

      {/*
        Reported, never offered. Turning this on stops the agent reading
        credentials, which is a decision to make deliberately in a config file
        rather than from a button in a panel. Rendered only when it is ON,
        because that is the state the project chose and the one a reader would
        not otherwise guess; a row saying "off" every time would be noise.
        Outside the list branches above so it still shows while the catalog is
        loading or empty.
      */}
      {EDITOR_BLOCK_SECRET_READS ? (
        <section className="mt-2 flex flex-col gap-1.5 border-t pt-3">
          <div className="flex items-center gap-1.5">
            <Eyebrow size="sm">Secret files</Eyebrow>
            <Badge variant="secondary">Blocked</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            The agent cannot read files that hold credentials in this
            prototype, such as <code className="text-code">.env</code> and
            private keys. Set{" "}
            <code className="text-code">editor.blockSecretReads</code> to false
            in <code className="text-code">.desde/config.json</code> to let it
            read them again.
          </p>
        </section>
      ) : null}

      {/*
        Mounted once, outside the list, keyed by id. Rendering one per row
        would put a Dialog inside every card and make the panel's DOM depend
        on how many extensions happen to exist.
      */}
      {keyRow?.requiresEnv ? (
        <ExtensionKeyDialog
          open
          onOpenChange={(next) => {
            if (!next) setKeyDialogId(null)
          }}
          label={keyRow.label}
          name={keyRow.requiresEnv}
          stored={keyRow.secretStored}
          fromEnvironment={keyRow.secretFromEnvironment}
          onSave={state.saveSecret}
        />
      ) : null}
    </div>
  )
}

function CapabilityRowItem({
  capability,
  busy,
  onEnable,
  onAddKey,
}: {
  capability: CapabilityRow
  busy: boolean
  onEnable: () => void
  onAddKey: () => void
}) {
  // Enabled but the variable it needs isn't exported: config is written, the
  // loader skips it, nothing works. That state has to read differently from
  // plain "on" or the user is left debugging silence.
  const blocked = capability.enabled && !capability.envReady
  const Icon = CAPABILITY_ICON[capability.id] ?? Puzzle

  return (
    // A CARD per extension, matching the OptionCard geometry (rounded-lg,
    // border, p-3). They were `ListRow`s, which reads as a dense list of
    // things to pick between; these are independent switches, and each one
    // owns a title, a description, a state and sometimes setup instructions.
    // Not an OptionCard itself — nothing here is mutually exclusive, and its
    // radio would say the opposite.
    <div
      // `items-center`, not `items-start`: the icon and the action sit
      // opposite a two-line block, and top-aligning the button left it
      // hanging off the title with the description running past underneath.
      className="flex w-full items-center gap-3 rounded-lg border p-3 text-left"
      data-testid={`capability-row-${capability.id}`}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="text-base font-medium text-foreground">{capability.label}</span>
          {capability.enabled && !blocked ? (
            <Check className="h-3 w-3 text-success" aria-label="Enabled" />
          ) : null}
          {blocked ? (
            <CircleAlert className="h-3 w-3 text-warning-strong" aria-label="Needs setup" />
          ) : null}
        </div>
        <span className="text-sm text-muted-foreground">{capability.summary}</span>

        {/*
          A standing fact about the capability, not a reading of whichever
          model is picked right now. The model changes per message and this
          panel never sees that choice, so a row cannot honestly say "on for
          this turn". Without the line, a row read "Active" while a turn on an
          OpenAI model had no such tools at all.
        */}
        {capability.claudeModelsOnly ? (
          <span className="mt-1 text-sm text-muted-foreground">
            Only available with Claude models.
          </span>
        ) : null}

        {/*
          A button, not instructions. This block used to read "Enabled, but
          FIGMA_API_KEY isn't set in this shell", print `export FIGMA_API_KEY=…`
          and say to restart — three things a reader who never opens a terminal
          cannot do, about a variable they have no reason to know exists (Mo,
          2026-08-18). The variable did not go away; it moved behind a form,
          and the key takes effect on the next message rather than a restart.
        */}
        {blocked && capability.requiresEnv ? (
          <span className="mt-1 text-sm text-warning-strong">
            Turned on, but it still needs an API key.
          </span>
        ) : null}

        {/*
          The "Also needs FIGMA_API_KEY exported in your shell" second line is
          gone. It duplicated the setup instructions that appear the moment the
          extension IS enabled, on a card that had not been enabled yet, so it
          front-loaded a requirement before the user had chosen to care.
        */}
      </div>

      {blocked && capability.requiresEnv ? (
        // Declared, but the loader skips it. The action IS the remedy, so the
        // card offers it rather than labelling the state and leaving the user
        // to work out where to go.
        <Button
          variant="outline"
          size="xs"
          className="shrink-0"
          disabled={busy}
          onClick={onAddKey}
          data-testid={`capability-key-${capability.id}`}
        >
          Add API key
        </Button>
      ) : blocked ? (
        <span className="shrink-0 text-sm text-warning-strong">Needs setup</span>
      ) : capability.enabled ? (
        <span className="shrink-0 text-sm text-muted-foreground">
          {capability.activation === "cli-restart" ? "After restart" : "Active"}
        </span>
      ) : !capability.enableable ? (
        // No button: turning this on is a config edit we deliberately do not
        // automate. A button here would post to the MCP-only route and fail.
        <span className="shrink-0 text-sm text-muted-foreground">
          Set in config
        </span>
      ) : (
        <Button
          // `outline`, not the filled primary. Enabling an extension is not
          // the page's main action — the dialog's own Close is — and a row of
          // teal buttons down a list reads as a list of things you are
          // supposed to press.
          variant="outline"
          size="xs"
          disabled={busy}
          onClick={onEnable}
          data-testid={`capability-enable-${capability.id}`}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          Enable
        </Button>
      )}
    </div>
  )
}

import { toast } from "sonner"
import {
  RESOLUTION_FAILURE_TITLE,
  RESOLUTION_FAILURE_FALLBACK,
} from "@/hooks/resolution-failure-notice"
import {
  OVERRIDE_PREVIEW_FAILURE_TITLE,
  OVERRIDE_PREVIEW_FAILURE_CONSEQUENCE,
} from "@/hooks/override-preview-notice"
import {
  CLAUDE_RUNTIME_DOWNLOADING_TITLE,
  CLAUDE_RUNTIME_DOWNLOADING_DESCRIPTION,
  CLAUDE_RUNTIME_ERROR_TITLE,
  CLAUDE_RUNTIME_ERROR_FALLBACK_DESCRIPTION,
} from "@/hooks/claude-runtime-notice"
import { buildSessionCompletionToasts } from "@/components/editor/session-completion-toasts"
import type { SurfaceEntry, SurfaceState } from "../types"

/**
 * Editor's toasts, deduped by shape.
 *
 * **Every string below is the product's, not invented.** Where the real call
 * site interpolates (`Merged into ${defaultName}.`), the fixture substitutes a
 * plausible value and keeps the surrounding copy verbatim; where it imports a
 * constant (`RESOLUTION_FAILURE_TITLE`), the fixture imports the same one, so
 * a reworded product string changes the screenshot instead of silently
 * disagreeing with it. That matters more here than anywhere else in the
 * catalog: toast copy IS the design, and a paraphrase would have a designer
 * editing words the product never says.
 *
 * ~60 call sites collapse to the states below. The dedupe rule is by SHAPE,
 * not by string: `pinned.success("Saved", { description })` and
 * `pinned.success("Project link copied")` are different surfaces (one has a
 * description, one doesn't); two success toasts that differ only in which
 * branch name got interpolated are the same surface.
 *
 * Ordered failures first. The success confirmations are one-liners with almost
 * no design surface; the failures are why this catalog exists.
 */

/**
 * Every toast in this module goes through `pinned`, never `toast.*` directly.
 *
 * `duration: Infinity` is a hard requirement, not a preference — an
 * auto-dismissing toast may be gone by the time the screenshot is taken, and
 * the result is a blank tile that reads as a broken fixture rather than a
 * timing bug. Routing through one wrapper makes forgetting it impossible,
 * which is worth more than a test that greps for the option. `GalleryOverlay`
 * dismisses them on state change so they don't accumulate across the sheet.
 */
type ToastOptions = Parameters<typeof toast.error>[1]

const pinned = {
  error: (message: string, options?: ToastOptions) =>
    toast.error(message, { ...options, duration: Infinity }),
  warning: (message: string, options?: ToastOptions) =>
    toast.warning(message, { ...options, duration: Infinity }),
  success: (message: string, options?: ToastOptions) =>
    toast.success(message, { ...options, duration: Infinity }),
  info: (message: string, options?: ToastOptions) =>
    toast.info(message, { ...options, duration: Infinity }),
  /**
   * `toast.loading` and the bare `toast(…)` are the two shapes the catalog was
   * missing entirely, and they are not decoration: `loading` is the only toast
   * with a spinner, and the bare neutral one is the most FREQUENT toast in the
   * product — every save status goes through it (`BannerToasts`), with no icon
   * and no colour to lean on.
   */
  loading: (message: string, options?: ToastOptions) =>
    toast.loading(message, { ...options, duration: Infinity }),
  /**
   * `toast.message`, not the bare `toast(…)`. They render the identical
   * neutral toast — `message` is sonner's named form of the default call — and
   * both are in the product (`editor-surface` calls `toast.message`,
   * `BannerToasts` calls `toast(…)`). The named one is used here because the
   * pinned-open assertion in `registry.test.tsx` spies on toast's METHODS, and
   * a bare callable has no property to spy on: routing through `message` keeps
   * this shape under the same guarantee as every other one.
   */
  neutral: (message: string, options?: ToastOptions) =>
    toast.message(message, { ...options, duration: Infinity }),
}

/**
 * Fire a background-session completion toast through the product's own copy
 * builder.
 *
 * These three used to hardcode their descriptions, and they drifted: the
 * gallery kept showing `"<prompt>: <reason>"` after the product had moved to a
 * quoted prompt and a never-silent reason. The transition is the only thing a
 * fixture should choose here — the wording is the product's.
 */
function firePinnedSessionToast(
  transition: Parameters<typeof buildSessionCompletionToasts>[0][number],
) {
  for (const built of buildSessionCompletionToasts([transition])) {
    pinned[built.level](built.title, { description: built.description })
  }
}

/** Build a toast state. `fire` is the whole fixture — toasts render no node. */
function t(
  slug: string,
  label: string,
  fire: () => void,
  readyWhen = "[data-sonner-toast]",
): SurfaceState {
  return { id: `toasts/${slug}`, label, fire, readyWhen }
}

export const TOASTS_SURFACE: SurfaceEntry = {
  id: "toasts",
  title: "Toasts",
  kind: "toast",
  sourceFile: "src/components/ui/sonner.tsx",
  states: [
    // ---------------------------------------------------------------- errors
    t("save-failed", "Save failed, with a reason", () =>
      pinned.error("Save failed", {
        description: "src/pages/Settings.vue was modified on disk since it was read.",
      }),
    ),
    t("edit-unmapped", "Edit couldn't be mapped to source", () =>
      pinned.warning(RESOLUTION_FAILURE_TITLE, {
        description: RESOLUTION_FAILURE_FALLBACK,
      }),
    ),
    t("preview-not-shown", "Change not shown in the preview", () =>
      pinned.warning(OVERRIDE_PREVIEW_FAILURE_TITLE, {
        // The consequence sentence is mandatory in the producer
        // (`${reason} ${OVERRIDE_PREVIEW_FAILURE_CONSEQUENCE}`) and is the
        // whole point of the toast: without it the tile reads "your edit was
        // lost", which is the opposite of what happened.
        description: `The selector no longer resolves to an element. ${OVERRIDE_PREVIEW_FAILURE_CONSEQUENCE}`,
      }),
    ),
    t("edit-didnt-take", "Edit didn't take effect (verification failed)", () =>
      pinned.warning("Edit didn't take effect", {
        description: 'It still shows false, not true. This value is calculated in code, so it has to change where it is calculated. Ask chat to make this change instead.',
      }),
    ),
    t("may-not-take-effect", "This may not take effect (inspector warning)", () =>
      // `singleScopeWarning` only surfaces reasons in WARNING_WORTHY_REASONS —
      // `important` and `outranked`. The `library` reason is deliberately
      // EXCLUDED because warning on it was a documented live false alarm, so a
      // fixture describing a library rule here would resurrect a warning the
      // codebase decided to remove. This is the `important` text verbatim.
      pinned.warning("This may not take effect", {
        description:
          'The current value is set with !important, so a change on just this element may be ignored. Choosing "This page" or "The token" is more likely to work.',
      }),
    ),
    t("undo-refused-with-action", "Undo refused, with a Discard step action", () =>
      pinned.error("The undo step no longer matches the file on disk.", {
        action: {
          label: "Discard step",
          onClick: () => {
            /* The gallery does not run the real discard. */
          },
        },
      }),
    ),
    t("bridge-connection-failed", "Bridge connection failed", () =>
      pinned.error("Can't connect to your prototype", {
        description: "Reload the prototype, or check that the dev server is still running.",
      }),
    ),
    t("vscode-refused", "Open in VS Code refused", () =>
      pinned.error("Open in VS Code refused", {
        description: "Suspicious path: ../../etc/hosts",
      }),
    ),
    t("smoke-failed-to-run", "Smoke test failed to run", () =>
      pinned.error("Smoke test failed to run", {
        description: "browserType.launch: Executable doesn't exist at …/chromium-1187/chrome-mac/Chromium",
      }),
    ),
    t("chat-not-ready", "Chat isn't ready yet", () => pinned.error("Chat isn't ready yet.")),
    t("push-failed", "Push failed", () =>
      pinned.error("Updates were rejected because the remote contains work you don't have locally."),
    ),
    t("branch-switch-failed", "Couldn't switch branch", () =>
      pinned.error(
        "Couldn't switch branch: your local changes to src/App.vue would be overwritten.",
      ),
    ),
    t("chat-session-failed", "A background chat session failed", () =>
      firePinnedSessionToast({
        sessionId: "s1",
        preview: "Make the pricing cards use the brand accent",
        toStatus: "failed",
        statusReason: "the model returned no edits",
      }),
    ),
    // The reported case: a failure the server gave no reason for. The
    // description used to be the prompt and nothing else, which read as the
    // product's own message about what went wrong.
    t("chat-session-failed-no-reason", "A chat session failed, reason unknown", () =>
      firePinnedSessionToast({
        sessionId: "s1",
        preview: "Move the chevron to the right",
        toStatus: "failed",
      }),
    ),
    t("capture-failed", "Screenshot capture failed", () =>
      pinned.error("Screenshot capture failed: html2canvas could not reach the iframe document."),
    ),
    t("copy-failed", "Couldn't copy to clipboard", () =>
      pinned.error("Couldn't copy to clipboard"),
    ),
    t("runtime-setup-failed", "AI chat setup failed, with a Retry", () =>
      // The richest error shape in the product: title, description AND an
      // action. Nothing else combines all three, and this is the toast a user
      // meets on first run when the runtime download fails — the point at which
      // the product is least able to explain itself any other way.
      pinned.error(CLAUDE_RUNTIME_ERROR_TITLE, {
        description: CLAUDE_RUNTIME_ERROR_FALLBACK_DESCRIPTION,
        action: {
          label: "Retry",
          onClick: () => {
            /* The gallery does not re-run the real install. */
          },
        },
      }),
    ),

    // -------------------------------------------------------------- warnings
    t("smoke-routes-failed", "Smoke test: some routes failed", () =>
      pinned.warning("Smoke test: 2/7 routes failed"),
    ),
    t("saved-autocommit-failed", "Saved, but auto-commit failed", () =>
      pinned.warning("Saved (auto-commit failed)", {
        description: "src/pages/Settings.vue: nothing to commit, working tree clean",
      }),
    ),
    t("merged-push-failed", "Merged locally, push failed", () =>
      pinned.warning(
        "Merged into main locally, but the push failed: could not read Username for 'https://github.com'",
      ),
    ),
    t("chat-rate-limited", "Chat session rate-limited", () =>
      firePinnedSessionToast({
        sessionId: "s1",
        preview: "Make the pricing cards use the brand accent",
        toStatus: "failed",
        failureKind: "rate-limited",
        retryAfterSeconds: 240,
      }),
    ),
    t("flow-no-screenshots", "Flow produced no screenshots", () =>
      pinned.error("The flow produced no screenshots (the steps may not resolve)."),
    ),

    // --------------------------------------------------------------- success
    t("saved", "Saved", () =>
      pinned.success("Saved", { description: "src/pages/Settings.vue" }),
    ),
    t("committed", "Committed working-tree changes", () =>
      pinned.success("Committed all working-tree changes."),
    ),
    t("pushed", "Pushed to GitHub", () =>
      pinned.success("Pushed feat/pricing-page to GitHub."),
    ),
    t("merged-and-pushed", "Merged and pushed", () =>
      pinned.success("Merged into main and pushed to GitHub."),
    ),
    t("published", "Published to the default branch", () =>
      pinned.success("Published to main."),
    ),
    t("connected-to-viewer", "Connected to a viewer project", () =>
      pinned.success("Connected to AI Gateway"),
    ),
    t("smoke-passed", "Smoke test passed", () =>
      pinned.success("Smoke test passed: 7/7 routes"),
    ),
    t("chat-session-done", "Chat session done", () =>
      firePinnedSessionToast({
        sessionId: "s1",
        preview: "Make the pricing cards use the brand accent",
        toStatus: "idle",
      }),
    ),
    t("link-copied", "Project link copied", () => pinned.success("Project link copied")),

    // -------------------------------------------------------------- progress
    t("runtime-downloading", "Setting up AI chat (spinner, one-time)", () =>
      pinned.loading(CLAUDE_RUNTIME_DOWNLOADING_TITLE, {
        description: CLAUDE_RUNTIME_DOWNLOADING_DESCRIPTION,
      }),
    ),
    t("bridge-connecting", "Connecting to the prototype bridge", () =>
      // Pinned here, transient in the product: it is dismissed by id the moment
      // the bridge answers. Its failure sibling (`bridge-connection-failed`
      // above) is already `duration: Infinity` for real.
      pinned.loading("Connecting to prototype bridge…"),
    ),

    // --------------------------------------------------------------- neutral
    t("save-status", "Save status (the plain, iconless toast)", () =>
      // `BannerToasts` fires the save status through a bare `toast(…)`, so it
      // gets neither icon nor colour. It is also the toast a user sees most
      // often, which makes it the one most worth looking at deliberately.
      pinned.neutral("Saved 2 DOM mutation(s)."),
    ),
    t("sent-to-chat", "Sent this edit to chat", () =>
      pinned.neutral("Sent this edit to chat", {
        description: "The assistant will read the file and apply it.",
      }),
    ),
    t("new-chat-for-action", "Started a new chat for this action", () =>
      pinned.neutral("Started a new chat for this action", {
        description: "Your previous chat keeps running in its own tab.",
      }),
    ),

    // ------------------------------------------------------------------ info
    t("pr-already-open", "A pull request is already open, with View", () =>
      pinned.info("Pull request #42 is already open for this branch.", {
        action: {
          label: "View",
          onClick: () => {
            /* The gallery does not open the real pull request. */
          },
        },
      }),
    ),
    t("up-to-date", "Already has the latest", () =>
      pinned.info("feat/pricing-page already has the latest from GitHub."),
    ),
    t("comments-paused", "Comments paused (the longest info copy)", () =>
      // Three lines of prose in a surface designed for one. Deliberately in the
      // catalog: the toast is where copy this long is least likely to have been
      // looked at, and it is the shape most at risk of being unreadable.
      pinned.info(
        "Can't tell where comments should be saved, so they're paused rather than saved to the wrong place. Reload to retry.",
      ),
    ),
    t("update-check-not-performed", "No update check was performed", () =>
      pinned.info("No update check was performed", {
        description: "Update checks aren't available in this copy of the app.",
      }),
    ),
    t("editing-component", "Editing <component> (persistent, with Exit)", () =>
      // The producer (banner-toasts.tsx) passes NO description and an `Exit`
      // action — that button is the only way out of component-edit mode, so a
      // description-only version would misrepresent the surface's whole point.
      // It is also already `duration: Infinity` in the product, making this the
      // one toast whose pinning is not a gallery artifact.
      pinned.info("Editing PricingCard", {
        action: { label: "Exit", onClick: () => {} },
      }),
    ),

    // ------------------------------------------------------------- stacked
    t("stacked", "Several at once: the stacking behaviour", () => {
      pinned.error("Save failed", {
        description: "src/pages/Settings.vue was modified on disk since it was read.",
      })
      pinned.warning("Smoke test: 2/7 routes failed")
      pinned.success("Committed all working-tree changes.")
    }),
  ],
}

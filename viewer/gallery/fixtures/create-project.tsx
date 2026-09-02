import { useEffect } from "react"
import type { SurfaceEntry, SurfaceRenderContext } from "@/components/gallery/types"
import {
  clickLikeUser,
  runDrivenInteraction,
  setNativeValue,
  waitForElement,
} from "@/components/gallery/dom-interaction"
import {
  NETWORK_ERROR,
  ok,
  fail,
  PENDING,
  type FetchOverrideResult,
} from "@/components/gallery/fetch-override"
import { CreateProjectDialog } from "@/../viewer/app/create-project-dialog"
import { Scenario } from "../harness/scenario"
import { ME_SIGNED_IN } from "../harness/fixture-data"

/**
 * `VIEWER_PUBLIC_URL` for the URL preview under the slug field. A real
 * origin rather than a placeholder, because the preview line is one of the
 * things this screen exists to get right and `https://example.com` renders a
 * different width from a real host.
 */
const PUBLIC_URL = "https://review.acme.dev"

const CREATED = ok({ id: "proj-new", slug: "checkout-redesign", name: "Checkout redesign" })

function Fixture({
  ctx,
  routes,
}: {
  ctx: SurfaceRenderContext
  routes?: Record<string, FetchOverrideResult>
}) {
  return (
    <Scenario routes={{ "/api/v1/me": ok(ME_SIGNED_IN), ...routes }}>
      <CreateProjectDialog
        open
        onOpenChange={(next) => ctx.log("onOpenChange", next)}
        publicUrl={PUBLIC_URL}
        onCreated={(project) => ctx.log("onCreated", project.slug)}
      />
    </Scenario>
  )
}

/** Scopes every query to the dialog, so the picker rail can never be hit. */
function inDialog<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(`[role="dialog"] ${selector}`)
}

async function typeName(value: string, cancelled: () => boolean): Promise<void> {
  const input = await waitForElement(() => inDialog<HTMLInputElement>('[data-testid="new-project-name"]'))
  if (!input || cancelled()) return
  setNativeValue(input, value)
}

async function typeSlug(value: string, cancelled: () => boolean): Promise<void> {
  const input = await waitForElement(() => inDialog<HTMLInputElement>('[data-testid="new-project-slug"]'))
  if (!input || cancelled()) return
  setNativeValue(input, value)
}

async function submit(cancelled: () => boolean): Promise<void> {
  const button = await waitForElement(() =>
    inDialog<HTMLButtonElement>('[data-testid="new-project-submit"]:not(:disabled)'),
  )
  if (!button || cancelled()) return
  clickLikeUser(button)
}

/** Fills the name (which derives the slug) and stops there. */
function FilledFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(() => typeName("Checkout redesign", () => cancelled))
    return () => {
      cancelled = true
    }
  }, [])
  return <Fixture ctx={ctx} />
}

/** Fills the name, then overwrites the slug with something the rule rejects. */
function InvalidSlugFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      await typeName("Checkout redesign", () => cancelled)
      await typeSlug("Checkout Redesign!", () => cancelled)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return <Fixture ctx={ctx} />
}

/** Fills and submits; the POST answer decides which state you land on. */
function SubmittedFixture({
  ctx,
  post,
}: {
  ctx: SurfaceRenderContext
  post: FetchOverrideResult
}) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      await typeName("Checkout redesign", () => cancelled)
      await submit(() => cancelled)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return <Fixture ctx={ctx} routes={{ "POST /api/v1/projects": post }} />
}

export const CREATE_PROJECT_SURFACE: SurfaceEntry = {
  id: "create-project",
  title: "Add project dialog",
  kind: "modal",
  sourceFile: "viewer/app/create-project-dialog.tsx",
  states: [
    {
      id: "create-project/empty",
      label: "Empty — Add disabled until both fields are valid",
      render: (ctx) => <Fixture ctx={ctx} />,
    },
    {
      id: "create-project/slug-derived",
      label: "Name typed — slug derived, URL previewed",
      // The preview line only exists once a slug does, so it is the honest
      // signal that the derivation actually ran.
      readyWhen: '[role="dialog"] [data-testid="new-project-slug"][value]',
      render: (ctx) => <FilledFixture ctx={ctx} />,
    },
    {
      id: "create-project/invalid-slug",
      label: "Slug edited to something the rule rejects",
      readyWhen: '[role="dialog"] .text-destructive',
      render: (ctx) => <InvalidSlugFixture ctx={ctx} />,
    },
    {
      id: "create-project/submitting",
      label: "Submitting — the POST has not answered",
      readyWhen: '[role="dialog"] [data-testid="new-project-submit"]:disabled',
      render: (ctx) => <SubmittedFixture ctx={ctx} post={PENDING} />,
    },
    {
      id: "create-project/slug-taken",
      label: "409 — that slug is already in use",
      readyWhen: '[role="dialog"] [data-testid="new-project-error"]',
      render: (ctx) => (
        <SubmittedFixture ctx={ctx} post={fail(409, "A project with that slug already exists")} />
      ),
    },
    {
      id: "create-project/refused",
      label: "403 — the credential can't create projects",
      readyWhen: '[role="dialog"] [data-testid="new-project-error"]',
      render: (ctx) => (
        <SubmittedFixture ctx={ctx} post={fail(403, "A write-scoped token is required")} />
      ),
    },
    {
      id: "create-project/network-error",
      label: "The server could not be reached",
      readyWhen: '[role="dialog"] [data-testid="new-project-error"]',
      render: (ctx) => <SubmittedFixture ctx={ctx} post={NETWORK_ERROR} />,
    },
    {
      id: "create-project/created",
      label: "201 — handed off to the repo-connect wizard (see the call log)",
      readyWhen: '[role="dialog"]',
      render: (ctx) => <SubmittedFixture ctx={ctx} post={CREATED} />,
    },
  ],
}

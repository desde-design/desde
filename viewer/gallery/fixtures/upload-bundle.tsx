"use client"

import { useEffect } from "react"
import { UploadBundleDialog } from "../../app/upload-bundle-dialog"
import { SAMPLE_PROJECT } from "../harness/fixture-data"
import { Scenario } from "../harness/scenario"
import {
  clickLikeUser,
  runDrivenInteraction,
  waitForElement,
} from "@/components/gallery/dom-interaction"
import { fail, PENDING, type FetchOverrideResult } from "@/components/gallery/fetch-override"
import type { SurfaceEntry, SurfaceRenderContext } from "@/components/gallery/types"

/**
 * Upload a build without connecting a repository (the Deployments tab's
 * "Upload a build" button).
 *
 * The dialog has no prop for a preselected file — `file` is `useState`
 * inside it, reached only by a real file-input `change` event, same as
 * `create-project.tsx` reaches its slug-validation states by really typing.
 * `chooseFile` fakes that event: jsdom's `HTMLInputElement.files` has no
 * public setter, so it's overwritten with `Object.defineProperty` (the same
 * technique Testing Library's own docs use for file inputs) and then a real
 * `change` event is dispatched so the component's own `onChange` handler
 * runs unmodified.
 *
 * `upload-bundle-submit` and `upload-bundle-error` are `data-testid` hooks
 * added to the dialog for exactly this: the given dialog code has no text
 * that CSS can select on (`readyWhen` is a `querySelector` string, so it
 * can't match "the button labeled Upload" the way `findButtonByText` can
 * for driving a click). `data-uploading` is a second hook on the same
 * button because "disabled, no file" (initial) and "disabled, uploading"
 * are two different states behind the identical `:disabled` selector.
 */

const PROJECT_ID = SAMPLE_PROJECT.id
const DEPLOYMENTS_PATH = `/api/v1/projects/${PROJECT_ID}/deployments`

function inDialog<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(`[role="dialog"] ${selector}`)
}

/** Sized so the "150 KB" readout under the drop zone is a clean number. */
function sampleTarball(): File {
  return new File([new Uint8Array(153_600)], "build.tar.gz", { type: "application/gzip" })
}

async function chooseFile(cancelled: () => boolean): Promise<void> {
  const input = await waitForElement(() => inDialog<HTMLInputElement>('input[type="file"]'))
  if (!input || cancelled()) return
  Object.defineProperty(input, "files", { value: [sampleTarball()], configurable: true })
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

async function submitUpload(cancelled: () => boolean): Promise<void> {
  const button = await waitForElement(() =>
    inDialog<HTMLButtonElement>('[data-testid="upload-bundle-submit"]:not(:disabled)'),
  )
  if (!button || cancelled()) return
  clickLikeUser(button)
}

function Fixture({
  ctx,
  post,
}: {
  ctx: SurfaceRenderContext
  /** The POST route's answer. Omitted for states that never submit. */
  post?: FetchOverrideResult
}) {
  return (
    <Scenario routes={post ? { [`POST ${DEPLOYMENTS_PATH}`]: post } : {}}>
      <UploadBundleDialog
        open
        onOpenChange={(next) => ctx.log("onOpenChange", next)}
        projectId={PROJECT_ID}
        onUploaded={() => ctx.log("onUploaded")}
      />
    </Scenario>
  )
}

/** Picks a file and stops there — Upload is enabled, nothing has posted yet. */
function FileChosenFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(() => chooseFile(() => cancelled))
    return () => {
      cancelled = true
    }
  }, [])
  return <Fixture ctx={ctx} />
}

/** Picks a file, submits, and the POST is left unanswered. */
function UploadingFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      await chooseFile(() => cancelled)
      await submitUpload(() => cancelled)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return <Fixture ctx={ctx} post={PENDING} />
}

/** Picks a file, submits, and the server rejects the bundle. */
function ErrorFixture({ ctx }: { ctx: SurfaceRenderContext }) {
  useEffect(() => {
    let cancelled = false
    runDrivenInteraction(async () => {
      await chooseFile(() => cancelled)
      await submitUpload(() => cancelled)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return (
    <Fixture
      ctx={ctx}
      post={fail(400, "The uploaded archive has no index.html at its root.")}
    />
  )
}

export const UPLOAD_BUNDLE_SURFACE: SurfaceEntry = {
  id: "upload-bundle",
  title: "Upload a build dialog",
  kind: "modal",
  sourceFile: "viewer/app/upload-bundle-dialog.tsx",
  states: [
    {
      id: "upload-bundle/empty",
      label: "Empty — Upload disabled until a file is chosen",
      render: (ctx) => <Fixture ctx={ctx} />,
    },
    {
      id: "upload-bundle/file-chosen",
      label: "File chosen — ready to upload",
      readyWhen: '[role="dialog"] [data-testid="upload-bundle-submit"]:not(:disabled)',
      render: (ctx) => <FileChosenFixture ctx={ctx} />,
    },
    {
      id: "upload-bundle/uploading",
      label: "Uploading — the POST has not answered",
      readyWhen: '[role="dialog"] [data-testid="upload-bundle-submit"][data-uploading="true"]',
      render: (ctx) => <UploadingFixture ctx={ctx} />,
    },
    {
      id: "upload-bundle/error",
      label: "400 — the bundle has no index.html at its root",
      readyWhen: '[role="dialog"] [data-testid="upload-bundle-error"]',
      render: (ctx) => <ErrorFixture ctx={ctx} />,
    },
  ],
}

"use client"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ProjectRepoPanel } from "./project-repo-panel"
import { UploadBundlePanel } from "./upload-bundle-dialog"

/**
 * Step two of the Add-project flow: where the project's content comes
 * from. Tabs, GitHub first and preselected (Mo, 2026-08-29). Upload is what
 * makes a project possible on a deployment with no GitHub App at all —
 * before the tabs, the flow dead-ended there, and uploading was only
 * reachable from the review screen's Deployments tab.
 *
 * Its own component, not markup inside `projects-list.tsx`, so the surface
 * gallery renders the SAME body the product shows — the first cut lived
 * inline in the host and the gallery's wizard states silently lost the tabs
 * (Mo, 2026-08-29: "I don't see the tabs").
 */
export interface AddPrototypeSourceProps {
  projectId: string
  /** Closes the hosting dialog — the wizard's Cancel and the upload tab's. */
  onClose: () => void
  /** The URL that reopens this dialog, for the GitHub flow's return legs. */
  returnPath: string
  /** Called once an upload returns 2xx; the host closes and refreshes. */
  onUploaded: () => void
  /** See `ProjectRepoPanelProps.onSetUpGithub` — the host's App-setup step. */
  onSetUpGithub?: () => void
}

export function AddPrototypeSource({
  projectId,
  onClose,
  returnPath,
  onUploaded,
  onSetUpGithub,
}: AddPrototypeSourceProps) {
  return (
    <Tabs defaultValue="github">
      {/* Full width, the two triggers splitting it (Mo, 2026-08-29) — the
          trigger primitive is already `flex-1`, so the list's width is the
          only thing to say. */}
      <TabsList className="w-full">
        <TabsTrigger value="github">GitHub repo</TabsTrigger>
        <TabsTrigger value="upload">Upload</TabsTrigger>
      </TabsList>
      <TabsContent value="github" className="pt-2">
        <ProjectRepoPanel
          projectId={projectId}
          onClose={onClose}
          returnPath={returnPath}
          onSetUpGithub={onSetUpGithub}
        />
      </TabsContent>
      <TabsContent value="upload" className="pt-2">
        <UploadBundlePanel projectId={projectId} onCancel={onClose} onUploaded={onUploaded} />
      </TabsContent>
    </Tabs>
  )
}

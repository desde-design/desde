"use client"

import DashboardPage from "../../app/page"
import {
  ME_AUTH_DISABLED,
  ME_SIGNED_IN,
  ME_SIGNED_OUT,
  SAMPLE_PROJECTS,
  SAMPLE_USER,
} from "../harness/fixture-data"
import { Scenario } from "../harness/scenario"
import { setGalleryConfig } from "../harness/shims/server-config"
import { NETWORK_ERROR, PENDING, ok } from "@/components/gallery/fetch-override"
import type { SurfaceEntry } from "@/components/gallery/types"

/**
 * The dashboard — the first screen a signed-in user sees.
 *
 * `app/page.tsx` is a Server Component, but a synchronous one, so the real
 * module renders here rather than a hand-copied header. Its own JSX (the
 * wordmark, the title, the account menu, the list) is therefore what is under
 * review, and it cannot drift from the shipped page.
 *
 * The page reads `loadConfig()` for `serveDomain`/`publicUrl`, which decide
 * where each row's "Open" link points. That is a real state axis, not
 * decoration: with a serve domain configured a prototype opens on its OWN
 * origin, and with none it opens under `/p/{slug}/` on the viewer's origin.
 * The row prints the URL it will use, so the two states look different.
 */

const PROJECTS = ok({ projects: SAMPLE_PROJECTS, publicLinksEnabled: true })

/**
 * A signed-in VIEWER (X4) — read authority only. `canManageProjects`
 * (`app/instance-role.ts`) is `false` for this role, so `ProjectsList`
 * hides both "Add project" buttons and the create dialog's trigger; the
 * server independently refuses `POST /projects` regardless of what the
 * client shows.
 */
const ME_SIGNED_IN_VIEWER = {
  ...ME_SIGNED_IN,
  user: { ...SAMPLE_USER, role: "viewer" as const },
}

export const DASHBOARD_SURFACE: SurfaceEntry = {
  id: "dashboard",
  title: "Dashboard",
  kind: "page",
  sourceFile: "viewer/app/page.tsx",
  states: [
    {
      id: "dashboard/populated",
      label: "Populated — every row variant",
      render: () => {
        setGalleryConfig({})
        return (
          <Scenario routes={{ "/api/v1/projects": PROJECTS, "/api/v1/me": ok(ME_SIGNED_IN) }}>
            <DashboardPage />
          </Scenario>
        )
      },
    },
    {
      id: "dashboard/loading",
      label: "Loading the project list",
      render: () => {
        setGalleryConfig({})
        return (
          <Scenario routes={{ "/api/v1/projects": PENDING, "/api/v1/me": ok(ME_SIGNED_IN) }}>
            <DashboardPage />
          </Scenario>
        )
      },
    },
    {
      id: "dashboard/empty",
      label: "No projects",
      render: () => {
        setGalleryConfig({})
        return (
          <Scenario
            routes={{ "/api/v1/projects": ok({ projects: [] }), "/api/v1/me": ok(ME_SIGNED_IN) }}
          >
            <DashboardPage />
          </Scenario>
        )
      },
    },
    {
      id: "dashboard/load-error",
      label: "Couldn't load projects",
      render: () => {
        setGalleryConfig({})
        return (
          <Scenario
            routes={{ "/api/v1/projects": NETWORK_ERROR, "/api/v1/me": ok(ME_SIGNED_IN) }}
          >
            <DashboardPage />
          </Scenario>
        )
      },
    },
    {
      id: "dashboard/subdomain-serving",
      label: "Serve domain configured — rows link to an isolated origin",
      render: () => {
        setGalleryConfig({
          serveDomain: "proto.example.dev",
          publicUrl: "https://viewer.example.dev",
        })
        return (
          <Scenario routes={{ "/api/v1/projects": PROJECTS, "/api/v1/me": ok(ME_SIGNED_IN) }}>
            <DashboardPage />
          </Scenario>
        )
      },
    },
    {
      id: "dashboard/viewer-role",
      label: "Signed in as a Viewer — no 'Add project' button, server still enforces",
      render: () => {
        setGalleryConfig({})
        return (
          <Scenario routes={{ "/api/v1/projects": PROJECTS, "/api/v1/me": ok(ME_SIGNED_IN_VIEWER) }}>
            <DashboardPage />
          </Scenario>
        )
      },
    },
    {
      id: "dashboard/signed-out",
      label: "Signed out — sign-in offered",
      render: () => {
        setGalleryConfig({})
        return (
          <Scenario routes={{ "/api/v1/projects": PROJECTS, "/api/v1/me": ok(ME_SIGNED_OUT) }}>
            <DashboardPage />
          </Scenario>
        )
      },
    },
    {
      id: "dashboard/auth-disabled",
      label: "Sign-in not configured — the corner keeps its settings link",
      render: () => {
        setGalleryConfig({})
        return (
          <Scenario
            routes={{ "/api/v1/projects": PROJECTS, "/api/v1/me": ok(ME_AUTH_DISABLED) }}
          >
            <DashboardPage />
          </Scenario>
        )
      },
    },
  ],
}

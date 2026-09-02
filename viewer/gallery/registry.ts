import type { SurfaceEntry, SurfaceState } from "@/components/gallery/types"
import { findStateInRegistry } from "@/components/gallery/types"
import { DASHBOARD_SURFACE } from "./fixtures/dashboard"
import { CREATE_PROJECT_SURFACE } from "./fixtures/create-project"
import { REVIEW_SHELL_SURFACE } from "./fixtures/review-shell"
import { REVIEW_NEVER_DEPLOYED_SURFACE } from "./fixtures/review-never-deployed"
import { REVIEW_NOT_FOUND_SURFACE } from "./fixtures/review-not-found"
import { SETTINGS_SURFACE } from "./fixtures/settings"
import { DENIED_SURFACE } from "./fixtures/denied"
import { SIGNIN_SURFACE } from "./fixtures/signin"
import { PROJECT_ACCESS_SURFACE } from "./fixtures/project-access"
import { PROJECT_REPO_PANEL_SURFACE } from "./fixtures/project-repo-panel"
import { ACCOUNT_MENU_SURFACE } from "./fixtures/account-menu"
import { BUILD_PANEL_SURFACE } from "./fixtures/build-panel"
import { PROJECT_LOADER_SURFACE } from "./fixtures/project-loader"
import { UPLOAD_BUNDLE_SURFACE } from "./fixtures/upload-bundle"
import {
  MEMBERS_PANEL_SURFACE,
  DOMAIN_RULES_PANEL_SURFACE,
  GITHUB_PANEL_SURFACE,
  INSTANCE_SETTINGS_PANEL_SURFACE,
} from "./fixtures/instance-admin"

/**
 * The Viewer catalog. One entry per surface, one addressable state per
 * distinct rendering.
 *
 * Ordered the way someone walks the product rather than alphabetically: the
 * screens a person actually lands on first, then the dialogs those screens
 * open, then the panels that live inside them.
 */
export const SURFACE_REGISTRY: readonly SurfaceEntry[] = [
  // Screens.
  DASHBOARD_SURFACE,
  REVIEW_SHELL_SURFACE,
  SETTINGS_SURFACE,
  REVIEW_NEVER_DEPLOYED_SURFACE,
  REVIEW_NOT_FOUND_SURFACE,
  DENIED_SURFACE,
  SIGNIN_SURFACE,
  // Dialogs the dashboard opens.
  CREATE_PROJECT_SURFACE,
  // Dialogs the review screen opens.
  PROJECT_ACCESS_SURFACE,
  PROJECT_REPO_PANEL_SURFACE,
  // Panels that live inside a screen or a dialog.
  ACCOUNT_MENU_SURFACE,
  BUILD_PANEL_SURFACE,
  MEMBERS_PANEL_SURFACE,
  DOMAIN_RULES_PANEL_SURFACE,
  GITHUB_PANEL_SURFACE,
  INSTANCE_SETTINGS_PANEL_SURFACE,
  PROJECT_LOADER_SURFACE,
  // Dialogs the build panel opens.
  UPLOAD_BUNDLE_SURFACE,
]

export function findSurfaceState(
  id: string,
): { entry: SurfaceEntry; state: SurfaceState } | null {
  return findStateInRegistry(SURFACE_REGISTRY, id)
}

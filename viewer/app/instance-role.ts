/**
 * The app-side copy of the server's `InstanceRole`
 * (`viewer/server/storage/types.ts`) — declared here rather than imported,
 * the same convention every wire shape in `app/` already follows: server-only
 * code isn't reachable from app code via the `@/*` alias (that alias points
 * at the repo-root `src/`), so app code keeps its own small mirror of the
 * wire shape it actually receives.
 *
 * ONE shared copy, not three. `use-current-user.ts`, `members-panel.tsx` and
 * `domain-rules-panel.tsx` each used to declare their own identical
 * `type InstanceRole = "admin" | "editor" | "viewer"` plus an `isInstanceRole`
 * guard — three places a fourth role could be added to two of them and
 * silently forgotten in the third. Consolidated here (Fix wave M1 review) so
 * they cannot drift apart.
 */
export type InstanceRole = "admin" | "editor" | "viewer"

export function isInstanceRole(v: unknown): v is InstanceRole {
  return v === "admin" || v === "editor" || v === "viewer"
}

/**
 * May a caller holding this role create and manage projects?
 *
 * The client-side mirror of the server's `hasProjectManageAuthority`
 * (`viewer/server/auth/authorize.ts`) — admin or editor, never `viewer`, and
 * never anything derived from a `ProjectMember` row (an access-LIST entry
 * decides readability of an `invited` project, never authority).
 *
 * ONE copy, not four (Fix wave M2 review). `projects-list.tsx`,
 * `review-shell.tsx` and `project-repo-panel.tsx` each carried their own
 * `user?.role === "admin" || user?.role === "editor"`. That expression is a
 * SECURITY rule's UI mirror, and four hand-written copies is four places a
 * fourth role has to be remembered — with the failure being silent in both
 * directions (a control that never appears, or one that appears and 403s).
 *
 * Takes the role rather than the user, and accepts `null`/`undefined` for
 * "not signed in yet, or still loading", so a call site never has to spell
 * out the optional chain. Both of those cases answer `false`, which is the
 * safe direction: the server enforces this independently, so a hidden control
 * is a cosmetic loss while a shown one is a broken click.
 */
export function canManageProjects(role: InstanceRole | null | undefined): boolean {
  return role === "admin" || role === "editor"
}

/**
 * May a caller holding this role manage the INSTANCE itself?
 *
 * Admin only, and distinct from `canManageProjects` above, which admits an
 * editor. The two are easy to conflate and the difference is load-bearing:
 * CLAUDE.md reserves instance management for Admins, and `SettingsNav`'s
 * `ADMIN_SECTIONS` (GitHub, members, domain rules, instance settings) is the
 * surface that enforces it.
 *
 * Added because a banner offered "Set up authentication" to every signed-in
 * reader, linking to `?section=github`. That section does not exist for an
 * editor or a viewer, so the link went nowhere for them: the same dead end
 * the banner's own gating had just been narrowed to remove, moved one role
 * along. Anything that OFFERS an instance-level action belongs behind this,
 * not behind `canManageProjects`.
 */
export function canAdministerInstance(role: InstanceRole | null | undefined): boolean {
  return role === "admin"
}

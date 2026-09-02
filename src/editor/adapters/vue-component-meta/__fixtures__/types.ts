/**
 * Shared types imported by SFC fixtures. This is the case
 * `LocalVueManifestSource` can't resolve (it stringifies the type
 * reference); `vue-component-meta` follows the import via the TS
 * checker and surfaces the real shape.
 */
export interface OrgSummary {
  name: string
  memberCount: number
}

export type Variant = 'default' | 'compact' | 'danger'

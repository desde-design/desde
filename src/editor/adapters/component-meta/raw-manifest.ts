/**
 * Types for raw `vue-component-meta` JSON output. This
 * is a serializable subset of vue-component-meta's `ComponentMeta` —
 * the function methods (`getDeclarations`, `getTypeObject`) and TS Type
 * refs (`rawType`) are stripped during JSON serialization, so the input
 * to normalization is a flat data shape with no callable methods.
 */

import type { Declaration, PropertyMetaSchema } from 'vue-component-meta'

export type RawTag = { name: string; text?: string }

export interface RawPropertyMeta {
  name: string
  description: string
  type: string
  default?: string
  global: boolean
  required: boolean
  tags: RawTag[]
  schema: PropertyMetaSchema
  declarations: Declaration[]
}

export interface RawSlotMeta {
  name: string
  description: string
  type: string
  tags: RawTag[]
  schema: PropertyMetaSchema
  declarations: Declaration[]
}

export interface RawEventMeta {
  name: string
  description: string
  type: string
  signature: string
  tags: RawTag[]
  schema: PropertyMetaSchema[]
  declarations: Declaration[]
}

export interface RawExposeMeta {
  name: string
  description: string
  type: string
  tags: RawTag[]
  schema: PropertyMetaSchema
  declarations: Declaration[]
}

export interface RawComponentMeta {
  name?: string
  description?: string
  /** vue-component-meta's TypeMeta enum: 0 = Unknown, 1 = Class, 2 = Function. */
  type: number
  props: RawPropertyMeta[]
  events: RawEventMeta[]
  slots: RawSlotMeta[]
  exposed: RawExposeMeta[]
}

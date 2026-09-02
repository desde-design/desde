<template>
  <article class="card">
    <h2>{{ org.name }}</h2>
    <p>{{ org.memberCount }} members</p>
    <p v-if="description">{{ description }}</p>
  </article>
</template>

<script setup lang="ts">
import type { OrgSummary, Variant } from './types'

defineOptions({ name: 'WithImportedType' })

withDefaults(
  defineProps<{
    /** Organization to display */
    org: OrgSummary
    /** Optional description shown below the title */
    description?: string
    /** Visual emphasis */
    variant?: Variant
    /** Card disabled state */
    disabled?: boolean
  }>(),
  {
    description: '',
    variant: 'default',
    disabled: false,
  },
)
</script>

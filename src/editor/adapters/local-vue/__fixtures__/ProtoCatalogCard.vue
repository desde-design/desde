<template>
  <div class="card">
    <h2>{{ title }}</h2>
    <p v-if="description">{{ description }}</p>
  </div>
</template>

<script setup lang="ts">
export interface CardMetric {
  title: string
  value: string
}

const props = withDefaults(defineProps<{
  /** Card title (entity name) */
  title: string
  /** Optional description shown below the title */
  description?: string
  /** Visual emphasis */
  variant?: 'plain' | 'highlighted' | 'danger'
  /** Number of items in this card */
  count?: number
  /** Whether the card is disabled */
  disabled?: boolean
  /** Metric items displayed in the analytics section */
  metrics: CardMetric[]
}>(), {
  description: '',
  variant: 'plain',
  count: 0,
  disabled: false,
})
</script>

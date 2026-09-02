<template>
  <div>{{ label }}</div>
</template>

<script setup lang="ts">
defineProps<{
  /** The visible label */
  label: string
  /** Optional flag */
  active?: boolean
}>()
</script>

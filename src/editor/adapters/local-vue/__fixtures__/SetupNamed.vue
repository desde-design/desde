<template>
  <div>{{ x }}</div>
</template>

<script setup lang="ts">
defineOptions({ name: 'CustomNamedComponent' })

defineProps<{
  /** A required label */
  x: string
}>()
</script>

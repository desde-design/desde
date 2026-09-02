<template>
  <div>{{ name }}</div>
</template>

<script setup lang="ts">
// Runtime-form props (Vue's other syntax). V1 of LocalVueManifestSource
// only handles type-form `defineProps<{...}>()`. This file should be
// skipped (returns null), not crashed on.
defineProps({
  name: {
    type: String,
    default: 'world',
  },
})
</script>

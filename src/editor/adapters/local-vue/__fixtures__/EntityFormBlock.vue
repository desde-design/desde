<template>
  <div
    class="acme-ui-entity-form-block"
    :class="{
      'stepped': step !== undefined || slots.step,
    }"
  >
    <header class="header">
      <div
        v-if="step !== undefined || slots.step"
        class="step"
      >
        <slot name="step">
          {{ step }}
        </slot>
      </div>
      <div class="header-content">
        <h2 class="header-title">
          <slot name="title">
            {{ title }}
          </slot>
        </h2>
        <div
          v-if="description || slots.description"
          class="header-description"
        >
          <slot name="description">
            {{ description }}
          </slot>
        </div>
      </div>
      <div
        v-if="slots.extra"
        class="header-extra"
      >
        <slot name="extra" />
      </div>
    </header>
    <div class="content">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
const { step = undefined, title = '', description = '' } = defineProps<{
  step?: number
  title?: string
  description?: string
}>()

const slots = defineSlots<{
  default?: () => any
  step?: () => any
  title?: () => any
  description?: () => any
  extra?: () => any
}>()
</script>

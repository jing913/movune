<script setup lang="ts">
import type { PrimitiveProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { Primitive } from 'reka-ui'
import { cn } from '@/lib/utils'

interface Props extends PrimitiveProps {
  class?: HTMLAttributes['class']
}

const props = withDefaults(defineProps<Props>(), {
  as: 'section',
})
</script>

<template>
  <Primitive
    data-slot="information-surface"
    :as="as"
    :as-child="asChild"
    :class="cn('rounded-lg border border-border bg-surface shadow-none', props.class)"
  >
    <slot />
  </Primitive>
</template>

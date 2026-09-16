<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { Check, ChevronDown } from '@lucide/vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

defineProps<{
  options: ReadonlyArray<{ value: string; label: string }>
  label: string
  prefix?: string
  disabled?: boolean
  class?: HTMLAttributes['class']
}>()

const modelValue = defineModel<string>({ required: true })
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <button
        type="button"
        :disabled="disabled"
        :aria-label="label"
        :class="
          cn(
            'inline-flex min-h-11 items-center justify-between gap-3 rounded-md border border-control bg-transparent px-4 text-sm font-semibold text-foreground shadow-none transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50',
            $props.class,
          )
        "
      >
        <span class="text-foreground">{{ prefix ?? '排序' }}</span>
        <span class="ml-auto truncate font-normal">
          {{ options.find((option) => option.value === modelValue)?.label }}
        </span>
        <ChevronDown class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      align="end"
      :side-offset="8"
      class="min-w-[var(--reka-dropdown-menu-trigger-width)] rounded-md border-border bg-popover p-1.5 shadow-md"
    >
      <DropdownMenuRadioGroup v-model="modelValue">
        <DropdownMenuRadioItem
          v-for="option in options"
          :key="option.value"
          :value="option.value"
          class="min-h-10 cursor-pointer rounded-md py-2 pl-9 pr-3 text-foreground focus:bg-surface data-[state=checked]:font-semibold data-[state=checked]:text-accent-caramel"
        >
          <template #indicator-icon>
            <Check class="size-4" aria-hidden="true" />
          </template>
          {{ option.label }}
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

withDefaults(
  defineProps<{
    open: boolean
    title: string
    description: string
    confirmLabel: string
    cancelLabel?: string
    busy?: boolean
    destructive?: boolean
    error?: string
  }>(),
  { cancelLabel: '取消' },
)
const emit = defineEmits<{ 'update:open': [value: boolean]; confirm: [] }>()
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent :show-close-button="!busy">
      <DialogHeader
        ><DialogTitle>{{ title }}</DialogTitle
        ><DialogDescription>{{ description }}</DialogDescription></DialogHeader
      >
      <p
        v-if="error"
        class="rounded-md border border-destructive p-3 text-sm text-destructive"
        role="alert"
      >
        {{ error }}
      </p>
      <DialogFooter class="gap-2 sm:gap-0">
        <button
          type="button"
          class="min-h-11 rounded-md border border-control px-4 font-semibold"
          :disabled="busy"
          @click="emit('update:open', false)"
        >
          {{ cancelLabel }}
        </button>
        <button
          type="button"
          class="min-h-11 rounded-md px-4 font-semibold text-primary-foreground disabled:opacity-60"
          :class="destructive ? 'bg-destructive' : 'bg-primary-cta'"
          :disabled="busy"
          @click="emit('confirm')"
        >
          {{ busy ? '處理中…' : confirmLabel }}
        </button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

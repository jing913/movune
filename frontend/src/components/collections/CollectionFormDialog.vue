<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { CollectionMetadataInput, CollectionVisibility } from '@/services/collections'

const props = withDefaults(
  defineProps<{
    open: boolean
    mode?: 'create' | 'edit'
    initialName?: string
    initialDescription?: string
    initialVisibility?: CollectionVisibility
    saving?: boolean
    error?: string
  }>(),
  {
    mode: 'create',
    initialName: '',
    initialDescription: '',
    initialVisibility: 'private',
    saving: false,
    error: '',
  },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  submit: [input: CollectionMetadataInput]
}>()

const name = ref('')
const description = ref('')
const visibility = ref<CollectionVisibility>('private')
const validationError = ref('')

watch(
  () => props.open,
  (open) => {
    if (!open) return
    name.value = props.initialName
    description.value = props.initialDescription
    visibility.value = props.initialVisibility
    validationError.value = ''
  },
  { immediate: true },
)

function submit() {
  const trimmedName = name.value.trim()
  if (!trimmedName) {
    validationError.value = '請輸入收藏清單名稱。'
    return
  }
  validationError.value = ''
  emit('submit', {
    name: trimmedName,
    description: description.value.trim(),
    visibility: visibility.value,
  })
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{{ mode === 'create' ? '建立收藏清單' : '編輯收藏清單' }}</DialogTitle>
        <DialogDescription>
          收藏清單與「我的收藏」分開管理，不會影響 Favorite 或 Movie DNA。
        </DialogDescription>
      </DialogHeader>
      <form class="grid gap-5" @submit.prevent="submit">
        <label class="grid gap-2 text-sm font-semibold">
          名稱
          <input
            v-model="name"
            type="text"
            required
            autofocus
            class="min-h-11 rounded-md border border-control bg-card px-4 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          />
        </label>
        <label class="grid gap-2 text-sm font-semibold">
          描述（選填）
          <textarea
            v-model="description"
            rows="4"
            class="resize-y rounded-md border border-control bg-card px-4 py-3 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          ></textarea>
        </label>
        <fieldset class="grid gap-2">
          <legend class="text-sm font-semibold">可見性</legend>
          <label class="flex min-h-11 items-center gap-3 rounded-md border border-control px-4">
            <input v-model="visibility" type="radio" value="private" />
            <span
              ><strong class="block">私人</strong
              ><small class="text-muted-foreground">只有你能查看與管理</small></span
            >
          </label>
          <label class="flex min-h-11 items-center gap-3 rounded-md border border-control px-4">
            <input v-model="visibility" type="radio" value="public" />
            <span
              ><strong class="block">公開</strong
              ><small class="text-muted-foreground">知道連結的訪客可以查看</small></span
            >
          </label>
        </fieldset>
        <p v-if="validationError || error" class="text-sm text-destructive" role="alert">
          {{ validationError || error }}
        </p>
        <DialogFooter>
          <button
            type="button"
            class="min-h-11 rounded-md border border-control px-5 font-semibold"
            :disabled="saving"
            @click="emit('update:open', false)"
          >
            取消
          </button>
          <button
            type="submit"
            class="min-h-11 rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-60"
            :disabled="saving"
            :aria-busy="saving"
          >
            {{ saving ? '儲存中…' : mode === 'create' ? '建立清單' : '儲存變更' }}
          </button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

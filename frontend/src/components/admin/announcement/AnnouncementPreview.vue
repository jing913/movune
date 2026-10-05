<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import AnnouncementRichText from '@/components/announcement/AnnouncementRichText.vue'
import type { AnnouncementAdminFormState } from './AnnouncementAdminForm.vue'

defineProps<{
  open: boolean
  form: AnnouncementAdminFormState
  importantUpdate?: boolean
  updateNote?: string
  completionTime?: string
}>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const categoryLabels = {
  platform_announcement: '平台公告',
  feature_update: '功能更新',
  system_maintenance: '系統維護',
} as const
const maintenanceStatusLabels = {
  scheduled: '排程中',
  in_progress: '維護中',
  completed: '已完成',
} as const
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
      <DialogHeader
        ><DialogTitle>預覽</DialogTitle
        ><DialogDescription
          >目前本機編輯內容的預覽；關閉不會儲存或發布。</DialogDescription
        ></DialogHeader
      >
      <article class="mt-2 rounded-xl border border-border bg-background p-5 sm:p-8">
        <p class="text-sm font-semibold text-accent-caramel">
          {{ categoryLabels[form.category]
          }}<span v-if="form.priority === 'important'" class="ml-2 rounded-full border px-2 py-0.5"
            >重要</span
          >
        </p>
        <h1 class="mt-3 break-words text-3xl font-bold">{{ form.title || '未命名草稿' }}</h1>
        <section
          v-if="importantUpdate && updateNote?.trim()"
          class="mt-6 rounded-lg border border-accent-caramel p-4"
        >
          <h2 class="font-bold">重要更新</h2>
          <p class="mt-2 whitespace-pre-wrap">{{ updateNote.trim() }}</p>
        </section>
        <section
          v-if="form.category === 'system_maintenance'"
          class="mt-6 rounded-lg border border-border p-4 text-sm"
        >
          <h2 class="font-bold">維護資訊</h2>
          <p class="mt-2">維護狀態：{{ maintenanceStatusLabels[form.maintenanceStatus] }}</p>
          <p class="mt-2">
            維護時間：{{ form.maintenanceStartsAt || '未填寫' }} –
            {{ form.maintenanceEndsAt || '未填寫' }}
          </p>
          <p class="mt-1">影響範圍：{{ form.affectedAreas || '未填寫' }}</p>
          <p class="mt-1">預期影響：{{ form.expectedImpact || '未填寫' }}</p>
          <p v-if="completionTime || form.maintenanceActualCompletionTime" class="mt-1">
            實際完成時間：{{ completionTime || form.maintenanceActualCompletionTime }}
          </p>
        </section>
        <AnnouncementRichText v-if="form.body" :document="form.body" class="mt-7" />
        <p v-else class="mt-7 text-muted-foreground">尚未填寫公告內容。</p>
      </article>
    </DialogContent>
  </Dialog>
</template>

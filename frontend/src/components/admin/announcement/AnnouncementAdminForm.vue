<script setup lang="ts">
import { computed } from 'vue'
import AnnouncementBodyEditor from './AnnouncementBodyEditor.vue'
import type {
  AnnouncementCategory,
  AnnouncementPriority,
  AnnouncementRichTextDocument,
} from '@/services/announcements'

export type AnnouncementAdminFormState = {
  category: AnnouncementCategory
  priority: AnnouncementPriority
  title: string
  body?: AnnouncementRichTextDocument
  maintenanceStatus: 'scheduled' | 'in_progress' | 'completed'
  maintenanceStartsAt: string
  maintenanceEndsAt: string
  affectedAreas: string
  expectedImpact: string
  maintenanceActualCompletionTime: string
}

export type AnnouncementAdminFieldErrorKey =
  | 'category'
  | 'priority'
  | 'title'
  | 'body'
  | 'maintenanceStartsAt'
  | 'maintenanceEndsAt'
  | 'affectedAreas'
  | 'expectedImpact'
  | 'maintenanceActualCompletionTime'

export type AnnouncementAdminFieldErrors = Partial<Record<AnnouncementAdminFieldErrorKey, string>>

const props = defineProps<{
  modelValue: AnnouncementAdminFormState
  disabled?: boolean
  requiresComplete?: boolean
  lockMaintenanceLifecycle?: boolean
  errors?: AnnouncementAdminFieldErrors
}>()
const emit = defineEmits<{ 'update:modelValue': [value: AnnouncementAdminFormState] }>()

function field<K extends keyof AnnouncementAdminFormState>(key: K) {
  return computed({
    get: () => props.modelValue[key],
    set: (value) => emit('update:modelValue', { ...props.modelValue, [key]: value }),
  })
}

const category = field('category')
const priority = field('priority')
const title = field('title')
const body = field('body')
const maintenanceStatus = field('maintenanceStatus')
const maintenanceStartsAt = field('maintenanceStartsAt')
const maintenanceEndsAt = field('maintenanceEndsAt')
const affectedAreas = field('affectedAreas')
const expectedImpact = field('expectedImpact')
const maintenanceActualCompletionTime = field('maintenanceActualCompletionTime')
</script>

<template>
  <form class="space-y-7" @submit.prevent>
    <fieldset
      class="grid gap-5 rounded-xl border border-border bg-card p-5 sm:grid-cols-2 sm:p-6"
      :disabled="disabled"
    >
      <legend class="px-2 text-lg font-bold">基本資料</legend>
      <label class="text-sm font-semibold"
        >分類
        <select
          v-model="category"
          class="mt-2 min-h-11 w-full rounded-md border border-control bg-background px-3"
          :aria-invalid="errors?.category ? 'true' : undefined"
          :aria-describedby="errors?.category ? 'announcement-category-error' : undefined"
        >
          <option value="platform_announcement">平台公告</option>
          <option value="feature_update">功能更新</option>
          <option value="system_maintenance">系統維護</option>
        </select>
        <span
          v-if="errors?.category"
          id="announcement-category-error"
          class="mt-1 block text-sm text-destructive"
          role="alert"
          >{{ errors.category }}</span
        >
      </label>
      <label class="text-sm font-semibold"
        >優先層級
        <select
          v-model="priority"
          class="mt-2 min-h-11 w-full rounded-md border border-control bg-background px-3"
          :aria-invalid="errors?.priority ? 'true' : undefined"
          :aria-describedby="errors?.priority ? 'announcement-priority-error' : undefined"
        >
          <option value="normal">一般</option>
          <option value="important">重要</option>
        </select>
        <span
          v-if="errors?.priority"
          id="announcement-priority-error"
          class="mt-1 block text-sm text-destructive"
          role="alert"
          >{{ errors.priority }}</span
        >
      </label>
      <label class="text-sm font-semibold sm:col-span-2"
        >標題
        <input
          v-model="title"
          type="text"
          :required="requiresComplete"
          class="mt-2 min-h-11 w-full rounded-md border border-control bg-background px-3"
          :aria-invalid="errors?.title ? 'true' : undefined"
          :aria-describedby="errors?.title ? 'announcement-title-error' : undefined"
        />
        <span
          v-if="errors?.title"
          id="announcement-title-error"
          class="mt-1 block text-sm text-destructive"
          role="alert"
          >{{ errors.title }}</span
        >
      </label>
    </fieldset>

    <fieldset
      v-if="category === 'system_maintenance'"
      class="grid gap-5 rounded-xl border border-border bg-card p-5 sm:grid-cols-2 sm:p-6"
      :disabled="disabled"
    >
      <legend class="px-2 text-lg font-bold">維護資訊</legend>
      <div>
        <p class="text-sm font-semibold">維護狀態</p>
        <p class="mt-2 min-h-11 rounded-md border border-border bg-secondary px-3 py-2">
          {{
            maintenanceStatus === 'scheduled'
              ? '預定維護'
              : maintenanceStatus === 'in_progress'
                ? '維護中'
                : '已完成'
          }}
        </p>
      </div>
      <span class="hidden sm:block"></span>
      <label class="text-sm font-semibold"
        >開始時間<input
          v-model="maintenanceStartsAt"
          type="datetime-local"
          :required="requiresComplete"
          class="mt-2 min-h-11 w-full rounded-md border border-control bg-background px-3"
          :aria-invalid="errors?.maintenanceStartsAt ? 'true' : undefined"
          :aria-describedby="
            errors?.maintenanceStartsAt ? 'announcement-maintenance-start-error' : undefined
          "
        /><span
          v-if="errors?.maintenanceStartsAt"
          id="announcement-maintenance-start-error"
          class="mt-1 block text-sm text-destructive"
          role="alert"
          >{{ errors.maintenanceStartsAt }}</span
        ></label
      >
      <label class="text-sm font-semibold"
        >結束時間<input
          v-model="maintenanceEndsAt"
          type="datetime-local"
          :required="requiresComplete"
          class="mt-2 min-h-11 w-full rounded-md border border-control bg-background px-3"
          :aria-invalid="errors?.maintenanceEndsAt ? 'true' : undefined"
          :aria-describedby="
            errors?.maintenanceEndsAt ? 'announcement-maintenance-end-error' : undefined
          "
        /><span
          v-if="errors?.maintenanceEndsAt"
          id="announcement-maintenance-end-error"
          class="mt-1 block text-sm text-destructive"
          role="alert"
          >{{ errors.maintenanceEndsAt }}</span
        ></label
      >
      <label class="text-sm font-semibold sm:col-span-2"
        >影響範圍（以逗號分隔）<input
          v-model="affectedAreas"
          type="text"
          :required="requiresComplete"
          class="mt-2 min-h-11 w-full rounded-md border border-control bg-background px-3"
          :aria-invalid="errors?.affectedAreas ? 'true' : undefined"
          :aria-describedby="
            errors?.affectedAreas ? 'announcement-affected-areas-error' : undefined
          "
        /><span
          v-if="errors?.affectedAreas"
          id="announcement-affected-areas-error"
          class="mt-1 block text-sm text-destructive"
          role="alert"
          >{{ errors.affectedAreas }}</span
        ></label
      >
      <label class="text-sm font-semibold sm:col-span-2"
        >預期影響<textarea
          v-model="expectedImpact"
          rows="3"
          :required="requiresComplete"
          class="mt-2 w-full rounded-md border border-control bg-background px-3 py-2"
          :aria-invalid="errors?.expectedImpact ? 'true' : undefined"
          :aria-describedby="
            errors?.expectedImpact ? 'announcement-expected-impact-error' : undefined
          "
        ></textarea>
        <span
          v-if="errors?.expectedImpact"
          id="announcement-expected-impact-error"
          class="mt-1 block text-sm text-destructive"
          role="alert"
          >{{ errors.expectedImpact }}</span
        >
      </label>
      <label v-if="maintenanceStatus === 'completed'" class="text-sm font-semibold sm:col-span-2"
        >實際完成時間<input
          v-model="maintenanceActualCompletionTime"
          type="datetime-local"
          :disabled="lockMaintenanceLifecycle"
          class="mt-2 min-h-11 w-full rounded-md border border-control bg-background px-3"
          :aria-invalid="errors?.maintenanceActualCompletionTime ? 'true' : undefined"
          :aria-describedby="
            errors?.maintenanceActualCompletionTime
              ? 'announcement-maintenance-completion-error'
              : undefined
          "
        /><span
          v-if="errors?.maintenanceActualCompletionTime"
          id="announcement-maintenance-completion-error"
          class="mt-1 block text-sm text-destructive"
          role="alert"
          >{{ errors.maintenanceActualCompletionTime }}</span
        ></label
      >
    </fieldset>

    <div class="rounded-xl border border-border bg-card p-5 sm:p-6">
      <AnnouncementBodyEditor v-model="body" :disabled="disabled" :error="errors?.body" />
    </div>
  </form>
</template>

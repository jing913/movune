<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { isAxiosError } from 'axios'
import AnnouncementAdminForm, {
  type AnnouncementAdminFieldErrors,
  type AnnouncementAdminFormState,
} from '@/components/admin/announcement/AnnouncementAdminForm.vue'
import AnnouncementPreview from '@/components/admin/announcement/AnnouncementPreview.vue'
import AnnouncementActionDialog from '@/components/admin/announcement/AnnouncementActionDialog.vue'
import {
  createAnnouncementDraft,
  deleteAnnouncementDraft,
  editPublishedAnnouncement,
  getAdminAnnouncement,
  publishAnnouncement,
  restoreAnnouncement,
  saveAnnouncementDraft,
  transitionAnnouncementMaintenance,
  withdrawAnnouncement,
  type AnnouncementAdminDetail,
  type AnnouncementAdminMaintenance,
} from '@/services/adminAnnouncements'

type ConfirmAction = 'publish' | 'withdraw' | 'restore' | 'delete' | null

const route = useRoute()
const router = useRouter()
const record = ref<AnnouncementAdminDetail | null>(null)
const loading = ref(false)
const loadState = ref<'ready' | 'error' | 'not-found' | 'forbidden'>('ready')
const busy = ref(false)
const operationError = ref('')
const successMessage = ref('')
const conflict = ref(false)
const previewOpen = ref(false)
const confirmAction = ref<ConfirmAction>(null)
const unsavedOpen = ref(false)
const importantUpdate = ref(false)
const updateNote = ref('')
const completionTime = ref('')
const fieldErrors = ref<
  AnnouncementAdminFieldErrors & { updateNote?: string; completionTime?: string }
>({})
let leaveResolver: ((allowed: boolean) => void) | null = null
let allowLeave = false
let requestVersion = 0

const defaultForm = (): AnnouncementAdminFormState => ({
  category: 'platform_announcement',
  priority: 'normal',
  title: '',
  body: undefined,
  maintenanceStatus: 'scheduled',
  maintenanceStartsAt: '',
  maintenanceEndsAt: '',
  affectedAreas: '',
  expectedImpact: '',
  maintenanceActualCompletionTime: '',
})
const form = ref<AnnouncementAdminFormState>(defaultForm())
const isNew = computed(() => route.name === 'announcement-admin-new')
const currentContentSnapshot = () => JSON.stringify(form.value)
const cleanContentSnapshot = ref(currentContentSnapshot())
const contentDirty = computed(() => currentContentSnapshot() !== cleanContentSnapshot.value)
const actionInputDirty = computed(
  () => importantUpdate.value || updateNote.value !== '' || completionTime.value !== '',
)
const navigationDirty = computed(() => contentDirty.value || actionInputDirty.value)

function localDate(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.valueOf() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function canonicalDate(value: string) {
  const date = new Date(value)
  if (!value || !Number.isFinite(date.valueOf())) throw new Error('請填寫有效的日期與時間。')
  return date.toISOString()
}

function applyRecord(next: AnnouncementAdminDetail) {
  record.value = next
  form.value = {
    category: next.category,
    priority: next.priority,
    title: next.title ?? '',
    body: next.body,
    maintenanceStatus: next.maintenance?.status ?? 'scheduled',
    maintenanceStartsAt: localDate(next.maintenance?.startsAt),
    maintenanceEndsAt: localDate(next.maintenance?.endsAt),
    affectedAreas: next.maintenance?.affectedAreas?.join('、') ?? '',
    expectedImpact: next.maintenance?.expectedImpact ?? '',
    maintenanceActualCompletionTime: localDate(next.maintenance?.actualCompletionTime),
  }
  importantUpdate.value = false
  updateNote.value = ''
  completionTime.value = ''
  cleanContentSnapshot.value = currentContentSnapshot()
  fieldErrors.value = {}
  conflict.value = false
  operationError.value = ''
}

function problemCode(error: unknown) {
  if (
    !isAxiosError(error) ||
    typeof error.response?.data !== 'object' ||
    error.response.data === null
  )
    return null
  const value = error.response.data as { error?: { code?: unknown } }
  return typeof value.error?.code === 'string' ? value.error.code : null
}

const backendFieldMap: Record<string, keyof AnnouncementAdminFieldErrors> = {
  category: 'category',
  priority: 'priority',
  title: 'title',
  body: 'body',
  'maintenance.startsAt': 'maintenanceStartsAt',
  'maintenance.endsAt': 'maintenanceEndsAt',
  'maintenance.affectedAreas': 'affectedAreas',
  'maintenance.expectedImpact': 'expectedImpact',
  'maintenance.actualCompletionTime': 'maintenanceActualCompletionTime',
}

const fieldErrorMessages: Record<keyof AnnouncementAdminFieldErrors, string> = {
  category: '請選擇有效的公告分類。',
  priority: '請選擇有效的優先級。',
  title: '請填寫有效且前後無空白的標題。',
  body: '公告內容格式不正確，請檢查後重試。',
  maintenanceStartsAt: '請填寫有效的維護開始時間。',
  maintenanceEndsAt: '請填寫有效的維護結束時間。',
  affectedAreas: '請填寫至少一個有效的受影響區域。',
  expectedImpact: '請填寫有效的預期影響。',
  maintenanceActualCompletionTime: '請填寫有效的實際完成時間。',
}

function applyBackendFieldErrors(error: unknown) {
  if (
    !isAxiosError(error) ||
    typeof error.response?.data !== 'object' ||
    error.response.data === null
  )
    return
  const data = error.response.data as {
    error?: { details?: { issues?: Array<{ field?: unknown }> } }
  }
  const mapped: AnnouncementAdminFieldErrors = {}
  for (const issue of data.error?.details?.issues ?? []) {
    if (typeof issue.field !== 'string') continue
    const key = backendFieldMap[issue.field]
    if (key) mapped[key] = fieldErrorMessages[key]
  }
  fieldErrors.value = mapped
}

function handleError(error: unknown) {
  const code = problemCode(error)
  if (code === 'ANNOUNCEMENT_REVISION_CONFLICT') {
    conflict.value = true
    operationError.value = '此公告已在其他地方被更新。請重新載入最新版本後再繼續編輯。'
  } else if (code === 'ANNOUNCEMENT_STATE_CONFLICT') {
    conflict.value = true
    operationError.value = '公告狀態已在其他地方變更。請重新載入最新版本後再繼續。'
  } else if (isAxiosError(error) && error.response?.status === 403) {
    operationError.value = '你沒有執行此公告操作的權限。'
  } else if (isAxiosError(error) && error.response?.status === 404) {
    operationError.value = '找不到此公告，可能已被移除。'
  } else if (isAxiosError(error) && error.response?.status === 401) {
    operationError.value = '登入狀態已失效，請重新登入。'
  } else if (isAxiosError(error) && error.response?.status === 400) {
    applyBackendFieldErrors(error)
    operationError.value = '公告內容未通過驗證，請檢查必填欄位與格式。'
  } else {
    operationError.value = '操作失敗，請稍後再試。'
  }
}

async function loadRecord() {
  if (isNew.value) {
    record.value = null
    form.value = defaultForm()
    importantUpdate.value = false
    updateNote.value = ''
    completionTime.value = ''
    cleanContentSnapshot.value = currentContentSnapshot()
    fieldErrors.value = {}
    loadState.value = 'ready'
    return
  }
  const id = String(route.params.announcementId ?? '')
  const version = ++requestVersion
  loading.value = true
  loadState.value = 'ready'
  try {
    const next = await getAdminAnnouncement(id)
    if (version === requestVersion) applyRecord(next)
  } catch (error) {
    if (version !== requestVersion) return
    loadState.value =
      isAxiosError(error) && error.response?.status === 404
        ? 'not-found'
        : isAxiosError(error) && error.response?.status === 403
          ? 'forbidden'
          : 'error'
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

function maintenance(requireComplete: boolean): AnnouncementAdminMaintenance | undefined {
  if (form.value.category !== 'system_maintenance') return undefined
  const areas = form.value.affectedAreas
    .split(/[、,]/)
    .map((value) => value.trim())
    .filter(Boolean)
  if (
    requireComplete &&
    (!form.value.maintenanceStartsAt ||
      !form.value.maintenanceEndsAt ||
      areas.length === 0 ||
      !form.value.expectedImpact.trim())
  ) {
    throw new Error('系統維護公告必須填寫完整的維護時間、影響範圍與預期影響。')
  }
  return {
    status: form.value.maintenanceStatus,
    ...(form.value.maintenanceStartsAt
      ? { startsAt: canonicalDate(form.value.maintenanceStartsAt) }
      : {}),
    ...(form.value.maintenanceEndsAt
      ? { endsAt: canonicalDate(form.value.maintenanceEndsAt) }
      : {}),
    ...(areas.length ? { affectedAreas: areas } : {}),
    ...(form.value.expectedImpact.trim()
      ? { expectedImpact: form.value.expectedImpact.trim() }
      : {}),
    ...(form.value.maintenanceStatus === 'completed' && form.value.maintenanceActualCompletionTime
      ? { actualCompletionTime: canonicalDate(form.value.maintenanceActualCompletionTime) }
      : {}),
  }
}

async function runMutation(operation: () => Promise<AnnouncementAdminDetail>, message: string) {
  busy.value = true
  operationError.value = ''
  successMessage.value = ''
  fieldErrors.value = {}
  try {
    const next = await operation()
    applyRecord(next)
    successMessage.value = message
    return true
  } catch (error) {
    if (error instanceof Error && !isAxiosError(error)) operationError.value = error.message
    else handleError(error)
    return false
  } finally {
    busy.value = false
  }
}

async function createDraft() {
  if (busy.value) return
  const ok = await runMutation(
    () => createAnnouncementDraft({ category: form.value.category, priority: form.value.priority }),
    '草稿已建立。',
  )
  if (ok && record.value)
    await router.replace({
      name: 'announcement-admin-editor',
      params: { announcementId: record.value.id },
    })
}

async function saveDraft() {
  if (!record.value || busy.value) return
  const title = form.value.title.trim()
  await runMutation(
    () =>
      saveAnnouncementDraft(record.value!.id, {
        expectedRevision: record.value!.revision,
        category: form.value.category,
        priority: form.value.priority,
        ...(title ? { title } : {}),
        ...(form.value.body ? { body: form.value.body } : {}),
        ...(form.value.category === 'system_maintenance'
          ? { maintenance: maintenance(false)! }
          : {}),
      }),
    '草稿已儲存。',
  )
}

async function savePublished() {
  if (!record.value || busy.value) return
  if (!form.value.title.trim() || !form.value.body) {
    fieldErrors.value = {
      ...(!form.value.title.trim() ? { title: '請填寫公告標題。' } : {}),
      ...(!form.value.body ? { body: '請填寫公告內容。' } : {}),
    }
    operationError.value = '發布中的公告必須包含標題與內容。'
    return
  }
  if (importantUpdate.value && !updateNote.value.trim()) {
    fieldErrors.value = { updateNote: '請填寫重要更新說明。' }
    operationError.value = '重要更新必須填寫更新說明。'
    return
  }
  const ok = await runMutation(
    () =>
      editPublishedAnnouncement(record.value!.id, {
        expectedRevision: record.value!.revision,
        editIntent: importantUpdate.value ? 'important_update' : 'general_correction',
        category: form.value.category,
        priority: form.value.priority,
        title: form.value.title.trim(),
        body: form.value.body!,
        ...(form.value.category === 'system_maintenance'
          ? { maintenance: maintenance(true)! }
          : {}),
        ...(importantUpdate.value ? { updateNote: updateNote.value.trim() } : {}),
      }),
    importantUpdate.value ? '重要更新已發布。' : '公告修正已儲存。',
  )
  if (ok) updateNote.value = ''
}

const actionCopy = computed(
  () =>
    ({
      publish: {
        title: '發布公告？',
        description: '發布後公告將對外公開。',
        confirmLabel: '確認發布',
      },
      withdraw: {
        title: '下架公告？',
        description: '公告內容將停止公開，但可稍後恢復。',
        confirmLabel: '確認下架',
      },
      restore: {
        title: '恢復發布？',
        description: '此公告將以原有身分重新公開。',
        confirmLabel: '確認恢復',
      },
      delete: {
        title: '刪除草稿？',
        description: '草稿刪除後無法復原。',
        confirmLabel: '確認刪除',
      },
    })[confirmAction.value ?? 'publish'],
)

async function confirmLifecycleAction() {
  if (!record.value || !confirmAction.value || busy.value) return
  const current = confirmAction.value
  if (current === 'delete') {
    busy.value = true
    try {
      await deleteAnnouncementDraft(record.value.id, record.value.revision)
      allowLeave = true
      confirmAction.value = null
      await router.push({ name: 'announcement-admin-list' })
    } catch (error) {
      handleError(error)
    } finally {
      busy.value = false
    }
    return
  }
  const operations = {
    publish: publishAnnouncement,
    withdraw: withdrawAnnouncement,
    restore: restoreAnnouncement,
  }
  const labels = { publish: '公告已發布。', withdraw: '公告已下架。', restore: '公告已恢復發布。' }
  const ok = await runMutation(
    () => operations[current](record.value!.id, record.value!.revision),
    labels[current],
  )
  if (ok) confirmAction.value = null
}

async function transitionMaintenance(status: 'in_progress' | 'completed') {
  if (!record.value || busy.value) return
  if (contentDirty.value) {
    operationError.value = '請先儲存公告內容，再變更維護狀態。'
    return
  }
  const parsedCompletionTime = new Date(completionTime.value)
  if (
    status === 'completed' &&
    (!completionTime.value || !Number.isFinite(parsedCompletionTime.valueOf()))
  ) {
    fieldErrors.value = { completionTime: '請填寫有效的實際完成時間。' }
    operationError.value = '完成維護前必須填寫實際完成時間。'
    return
  }
  const ok = await runMutation(
    () =>
      transitionAnnouncementMaintenance(record.value!.id, {
        expectedRevision: record.value!.revision,
        status,
        ...(status === 'completed'
          ? { actualCompletionTime: canonicalDate(completionTime.value) }
          : {}),
      }),
    status === 'completed' ? '維護已標記為完成。' : '維護已開始。',
  )
  if (ok) completionTime.value = ''
}

async function reloadLatest() {
  await loadRecord()
}

function resolveUnsaved(allowed: boolean) {
  unsavedOpen.value = false
  if (allowed) allowLeave = true
  leaveResolver?.(allowed)
  leaveResolver = null
}

function protectUnsavedNavigation() {
  if (!navigationDirty.value || allowLeave) return true
  unsavedOpen.value = true
  return new Promise<boolean>((resolve) => {
    leaveResolver = resolve
  })
}

onBeforeRouteLeave(protectUnsavedNavigation)
onBeforeRouteUpdate(protectUnsavedNavigation)

watch(() => [route.name, route.params.announcementId], loadRecord, { immediate: true })
watch(confirmAction, (value) => {
  if (!value) return
  operationError.value = ''
  conflict.value = false
})
watch(
  form,
  () => {
    fieldErrors.value = {
      ...(fieldErrors.value.updateNote ? { updateNote: fieldErrors.value.updateNote } : {}),
      ...(fieldErrors.value.completionTime
        ? { completionTime: fieldErrors.value.completionTime }
        : {}),
    }
  },
  { deep: true },
)
watch([importantUpdate, updateNote], () => {
  if (!fieldErrors.value.updateNote) return
  const next = { ...fieldErrors.value }
  delete next.updateNote
  fieldErrors.value = next
})
watch(completionTime, () => {
  if (!fieldErrors.value.completionTime) return
  const next = { ...fieldErrors.value }
  delete next.completionTime
  fieldErrors.value = next
})
onBeforeUnmount(() => {
  requestVersion += 1
  leaveResolver?.(false)
})
</script>

<template>
  <main class="page-shell pb-20 pt-8 sm:pt-12">
    <RouterLink
      :to="{ name: 'announcement-admin-list' }"
      class="rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring"
      >← 返回公告管理</RouterLink
    >
    <div v-if="loading" class="mt-8 rounded-xl border border-border p-12 text-center" role="status">
      公告載入中…
    </div>
    <section
      v-else-if="loadState === 'not-found'"
      class="mt-8 rounded-xl border border-border p-12 text-center"
    >
      <h1 class="text-3xl font-bold">找不到此公告</h1>
    </section>
    <section
      v-else-if="loadState === 'forbidden'"
      class="mt-8 rounded-xl border border-destructive p-12 text-center"
      role="alert"
    >
      <h1 class="text-3xl font-bold">無權限查看此公告</h1>
      <RouterLink
        :to="{ name: 'announcement-admin-list' }"
        class="mt-5 inline-flex min-h-11 items-center rounded-md border border-control px-4"
      >
        返回公告管理
      </RouterLink>
    </section>
    <section
      v-else-if="loadState === 'error'"
      class="mt-8 rounded-xl border border-border p-12 text-center"
      role="alert"
    >
      <h1 class="text-3xl font-bold">公告載入失敗</h1>
      <button
        type="button"
        class="mt-5 min-h-11 rounded-md border border-control px-4"
        @click="loadRecord"
      >
        重新載入
      </button>
    </section>
    <template v-else>
      <header class="mt-6">
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-accent-caramel">
          Announcement Admin
        </p>
        <h1 class="mt-2 text-3xl font-bold sm:text-4xl">
          {{ isNew ? '建立公告' : form.title || '未命名草稿' }}
        </h1>
        <p v-if="record" class="mt-2 text-sm text-muted-foreground">
          狀態：{{ record.publicationStatus }} · 修訂版 {{ record.revision }}
        </p>
      </header>
      <div
        v-if="operationError"
        class="mt-6 rounded-lg border border-destructive p-4 text-destructive"
        role="alert"
      >
        <p>{{ operationError }}</p>
        <button
          v-if="conflict"
          type="button"
          class="mt-3 min-h-11 rounded-md border border-destructive px-4 font-semibold"
          @click="reloadLatest"
        >
          重新載入最新版本
        </button>
      </div>
      <p v-if="successMessage" class="mt-6 rounded-lg border border-border p-4" role="status">
        {{ successMessage }}
      </p>
      <div
        v-if="record?.governanceStatus !== 'normal'"
        class="mt-6 rounded-lg border border-destructive p-4"
        role="alert"
      >
        此公告受治理限制，無法在此工作區編輯。
      </div>

      <fieldset
        v-if="isNew"
        class="mt-8 grid gap-5 rounded-xl border border-border bg-card p-5 sm:grid-cols-2 sm:p-6"
        :disabled="busy"
      >
        <legend class="px-2 text-lg font-bold">建立草稿</legend>
        <label class="text-sm font-semibold"
          >分類<select
            v-model="form.category"
            class="mt-2 min-h-11 w-full rounded-md border border-control bg-background px-3"
          >
            <option value="platform_announcement">平台公告</option>
            <option value="feature_update">功能更新</option>
            <option value="system_maintenance">系統維護</option>
          </select></label
        >
        <label class="text-sm font-semibold"
          >優先層級<select
            v-model="form.priority"
            class="mt-2 min-h-11 w-full rounded-md border border-control bg-background px-3"
          >
            <option value="normal">一般</option>
            <option value="important">重要</option>
          </select></label
        >
      </fieldset>
      <div v-else class="mt-8">
        <AnnouncementAdminForm
          v-model="form"
          :errors="fieldErrors"
          :disabled="
            busy ||
            record?.governanceStatus !== 'normal' ||
            record?.publicationStatus === 'withdrawn'
          "
          :requires-complete="record?.publicationStatus === 'published'"
          :lock-maintenance-lifecycle="record?.publicationStatus === 'published'"
        />
      </div>

      <section
        class="sticky bottom-0 z-20 mt-8 rounded-xl border border-border bg-background/95 p-4 shadow-lg backdrop-blur sm:p-5"
        aria-label="公告操作"
      >
        <div class="flex flex-wrap items-center gap-3">
          <button
            v-if="isNew"
            type="button"
            class="min-h-11 rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground disabled:opacity-60"
            :disabled="busy"
            @click="createDraft"
          >
            {{ busy ? '建立中…' : '建立後開始編輯' }}
          </button>
          <template v-else-if="record?.governanceStatus === 'normal'">
            <button
              v-if="record.publicationStatus === 'draft'"
              type="button"
              class="min-h-11 rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground"
              :disabled="busy"
              @click="saveDraft"
            >
              儲存草稿
            </button>
            <button
              type="button"
              class="min-h-11 rounded-md border border-control px-5 font-semibold"
              :disabled="busy"
              @click="previewOpen = true"
            >
              預覽
            </button>
            <template v-if="record.publicationStatus === 'draft'"
              ><button
                type="button"
                class="min-h-11 rounded-md border border-accent-caramel px-5 font-semibold"
                :disabled="busy || contentDirty"
                @click="confirmAction = 'publish'"
              >
                發布</button
              ><button
                type="button"
                class="min-h-11 rounded-md border border-destructive px-5 font-semibold text-destructive"
                :disabled="busy"
                @click="confirmAction = 'delete'"
              >
                刪除草稿
              </button></template
            >
            <template v-else-if="record.publicationStatus === 'published'"
              ><label class="flex min-h-11 items-center gap-2"
                ><input v-model="importantUpdate" type="checkbox" />重要更新</label
              ><input
                v-if="importantUpdate"
                v-model="updateNote"
                class="min-h-11 min-w-0 flex-1 rounded-md border border-control bg-background px-3"
                placeholder="更新說明（必填）"
                aria-label="重要更新說明"
                :aria-invalid="fieldErrors.updateNote ? 'true' : undefined"
                :aria-describedby="
                  fieldErrors.updateNote ? 'announcement-update-note-error' : undefined
                "
              /><span
                v-if="fieldErrors.updateNote"
                id="announcement-update-note-error"
                class="text-sm text-destructive"
                role="alert"
                >{{ fieldErrors.updateNote }}</span
              ><button
                type="button"
                class="min-h-11 rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground"
                :disabled="busy"
                @click="savePublished"
              >
                {{ importantUpdate ? '發布重要更新' : '儲存一般修正' }}</button
              ><button
                type="button"
                class="min-h-11 rounded-md border border-control px-5 font-semibold"
                :disabled="busy || navigationDirty"
                @click="confirmAction = 'withdraw'"
              >
                下架
              </button></template
            >
            <button
              v-else-if="record.publicationStatus === 'withdrawn'"
              type="button"
              class="min-h-11 rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground"
              :disabled="busy"
              @click="confirmAction = 'restore'"
            >
              恢復發布
            </button>
          </template>
        </div>
        <div
          v-if="
            record?.publicationStatus === 'published' &&
            record.category === 'system_maintenance' &&
            record.maintenance?.status !== 'completed'
          "
          class="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4"
        >
          <button
            v-if="record.maintenance?.status === 'scheduled'"
            type="button"
            class="min-h-11 rounded-md border border-control px-4"
            :disabled="busy || navigationDirty"
            @click="transitionMaintenance('in_progress')"
          >
            開始維護
          </button>
          <label class="min-w-56 flex-1 text-sm font-semibold"
            >實際完成時間<input
              v-model="completionTime"
              type="datetime-local"
              class="mt-1 min-h-11 w-full rounded-md border border-control bg-background px-3"
              :aria-invalid="fieldErrors.completionTime ? 'true' : undefined"
              :aria-describedby="
                fieldErrors.completionTime ? 'announcement-completion-time-error' : undefined
              "
            /><span
              v-if="fieldErrors.completionTime"
              id="announcement-completion-time-error"
              class="mt-1 block text-sm text-destructive"
              role="alert"
              >{{ fieldErrors.completionTime }}</span
            ></label
          >
          <button
            type="button"
            class="min-h-11 rounded-md border border-control px-4"
            :disabled="busy || contentDirty"
            @click="transitionMaintenance('completed')"
          >
            完成維護
          </button>
        </div>
      </section>
    </template>

    <AnnouncementPreview
      v-model:open="previewOpen"
      :form="form"
      :important-update="importantUpdate"
      :update-note="updateNote"
      :completion-time="completionTime"
    />
    <AnnouncementActionDialog
      v-if="confirmAction"
      :open="true"
      :title="actionCopy.title"
      :description="actionCopy.description"
      :confirm-label="actionCopy.confirmLabel"
      :busy="busy"
      :error="operationError"
      :destructive="confirmAction === 'delete'"
      @update:open="
        (open) => {
          if (!open && !busy) confirmAction = null
        }
      "
      @confirm="confirmLifecycleAction"
    />
    <AnnouncementActionDialog
      :open="unsavedOpen"
      title="尚有未儲存的變更"
      description="離開後變更不保留"
      confirm-label="捨棄並離開"
      cancel-label="繼續編輯"
      destructive
      @update:open="
        (open) => {
          if (!open) resolveUnsaved(false)
        }
      "
      @confirm="resolveUnsaved(true)"
    />
  </main>
</template>

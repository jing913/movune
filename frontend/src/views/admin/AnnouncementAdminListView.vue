<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { isAxiosError } from 'axios'
import {
  listAdminAnnouncements,
  type AnnouncementAdminListItem,
} from '@/services/adminAnnouncements'

const announcements = ref<AnnouncementAdminListItem[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const initialError = ref(false)
const initialErrorMessage = ref('')
const moreLoading = ref(false)
const moreError = ref(false)
let requestVersion = 0

const categoryLabels = {
  platform_announcement: '平台公告',
  feature_update: '功能更新',
  system_maintenance: '系統維護',
} as const
const publicationLabels = { draft: '草稿', published: '已發布', withdrawn: '已下架' } as const
const formatter = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  dateStyle: 'medium',
  timeStyle: 'short',
})
const formatDate = (value: string) => formatter.format(new Date(value))

async function loadInitial() {
  const version = ++requestVersion
  loading.value = true
  initialError.value = false
  initialErrorMessage.value = ''
  moreError.value = false
  try {
    const response = await listAdminAnnouncements({ limit: 20 })
    if (version !== requestVersion) return
    announcements.value = response.announcements
    nextCursor.value = response.nextCursor
  } catch (error) {
    if (version === requestVersion) {
      initialError.value = true
      initialErrorMessage.value =
        isAxiosError(error) && error.response?.status === 403
          ? '你沒有查看公告管理列表的權限。'
          : '公告管理列表載入失敗。'
    }
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

async function loadMore() {
  if (!nextCursor.value || moreLoading.value) return
  const version = requestVersion
  moreLoading.value = true
  moreError.value = false
  try {
    const response = await listAdminAnnouncements({ cursor: nextCursor.value, limit: 20 })
    if (version !== requestVersion) return
    announcements.value = [...announcements.value, ...response.announcements]
    nextCursor.value = response.nextCursor
  } catch {
    if (version === requestVersion) moreError.value = true
  } finally {
    if (version === requestVersion) moreLoading.value = false
  }
}

onMounted(loadInitial)
onBeforeUnmount(() => {
  requestVersion += 1
})
</script>

<template>
  <main class="page-shell pb-16 pt-8 sm:pt-12">
    <header class="flex flex-wrap items-end justify-between gap-5">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-accent-caramel">
          Administration
        </p>
        <h1 class="mt-2 text-3xl font-bold sm:text-4xl">公告管理</h1>
        <p class="mt-3 text-muted-foreground">管理草稿、發布內容與公告生命週期。</p>
      </div>
      <RouterLink
        :to="{ name: 'announcement-admin-new' }"
        class="inline-flex min-h-11 items-center rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground"
        >建立公告</RouterLink
      >
    </header>

    <section class="mt-8" aria-labelledby="admin-list-heading">
      <h2 id="admin-list-heading" class="sr-only">公告管理列表</h2>
      <div v-if="loading" role="status" class="rounded-xl border border-border p-10 text-center">
        公告載入中…
      </div>
      <div
        v-else-if="initialError"
        role="alert"
        class="rounded-xl border border-border p-10 text-center"
      >
        <p class="font-bold">{{ initialErrorMessage }}</p>
        <button
          type="button"
          class="mt-4 min-h-11 rounded-md border border-control px-4"
          @click="loadInitial"
        >
          重新載入
        </button>
      </div>
      <div
        v-else-if="announcements.length === 0"
        role="status"
        class="rounded-xl border border-border p-10 text-center"
      >
        目前沒有可管理的公告。
      </div>
      <template v-else>
        <ol class="grid gap-4">
          <li v-for="item in announcements" :key="item.id">
            <RouterLink
              :to="{ name: 'announcement-admin-editor', params: { announcementId: item.id } }"
              class="block rounded-xl border border-border bg-card p-5 transition-colors hover:border-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring sm:p-6"
            >
              <div class="flex flex-wrap items-center gap-2 text-sm">
                <span class="font-semibold text-accent-caramel">{{
                  categoryLabels[item.category]
                }}</span
                ><span class="rounded-full border border-border px-2 py-0.5">{{
                  publicationLabels[item.publicationStatus]
                }}</span
                ><span
                  v-if="item.priority === 'important'"
                  class="rounded-full border border-accent-caramel px-2 py-0.5"
                  >重要</span
                ><span
                  v-if="item.governanceStatus !== 'normal'"
                  class="rounded-full border border-destructive px-2 py-0.5 text-destructive"
                  >受治理限制</span
                >
              </div>
              <h3 class="mt-3 break-words text-xl font-bold">{{ item.title || '未命名草稿' }}</h3>
              <p class="mt-3 text-sm text-muted-foreground">
                最後更新：{{ formatDate(item.updatedAt) }} · 修訂版 {{ item.revision }}
              </p>
            </RouterLink>
          </li>
        </ol>
        <div v-if="nextCursor || moreError" class="mt-7 text-center">
          <p v-if="moreError" role="alert" class="mb-3 text-sm text-destructive">
            更多公告載入失敗，已保留目前內容。
          </p>
          <button
            v-if="nextCursor"
            type="button"
            class="min-h-11 rounded-md border border-control px-5 disabled:opacity-60"
            :disabled="moreLoading"
            @click="loadMore"
          >
            {{ moreLoading ? '載入中…' : moreError ? '重新載入更多' : '載入更多' }}
          </button>
        </div>
      </template>
    </section>
  </main>
</template>

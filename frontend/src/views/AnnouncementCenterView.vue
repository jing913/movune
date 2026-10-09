<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  listAnnouncements,
  type AnnouncementCategory,
  type AnnouncementMaintenanceStatus,
  type AnnouncementPublicListItem,
} from '@/services/announcements'

type CategoryFilter = AnnouncementCategory | 'all'

const categoryOptions: ReadonlyArray<{ value: CategoryFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'platform_announcement', label: '平台公告' },
  { value: 'feature_update', label: '功能更新' },
  { value: 'system_maintenance', label: '系統維護' },
]

const categoryLabels: Record<AnnouncementCategory, string> = {
  platform_announcement: '平台公告',
  feature_update: '功能更新',
  system_maintenance: '系統維護',
}

const maintenanceStatusLabels: Record<AnnouncementMaintenanceStatus, string> = {
  scheduled: '預定維護',
  in_progress: '維護中',
  completed: '已完成',
}

const selectedCategory = ref<CategoryFilter>('all')
const announcements = ref<AnnouncementPublicListItem[]>([])
const nextCursor = ref<string | null>(null)
const initialLoading = ref(false)
const initialError = ref(false)
const loadMoreLoading = ref(false)
const loadMoreError = ref(false)
let requestVersion = 0

const publishedDateFormatter = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
})

function formatPublishedDate(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return ''
  const parts = Object.fromEntries(
    publishedDateFormatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )
  return parts.year && parts.month && parts.day
    ? `${parts.year} 年 ${parts.month} 月 ${parts.day} 日`
    : ''
}

function formatHistoricalDate(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return ''
  const parts = Object.fromEntries(
    publishedDateFormatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )
  return parts.year && parts.month && parts.day
    ? `${parts.year}/${parts.month.padStart(2, '0')}/${parts.day.padStart(2, '0')}`
    : ''
}

function currentCategoryParameter() {
  return selectedCategory.value === 'all' ? undefined : selectedCategory.value
}

async function loadFirstPage() {
  const version = ++requestVersion
  announcements.value = []
  nextCursor.value = null
  initialError.value = false
  loadMoreError.value = false
  initialLoading.value = true

  try {
    const response = await listAnnouncements({
      category: currentCategoryParameter(),
      limit: 12,
    })
    if (version !== requestVersion) return
    announcements.value = response.announcements
    nextCursor.value = response.nextCursor
  } catch {
    if (version !== requestVersion) return
    initialError.value = true
  } finally {
    if (version === requestVersion) initialLoading.value = false
  }
}

function selectCategory(category: CategoryFilter) {
  if (category === selectedCategory.value) return
  selectedCategory.value = category
  void loadFirstPage()
}

async function loadMore() {
  const cursor = nextCursor.value
  if (!cursor || loadMoreLoading.value) return

  const version = requestVersion
  loadMoreLoading.value = true
  loadMoreError.value = false
  try {
    const response = await listAnnouncements({
      category: currentCategoryParameter(),
      cursor,
      limit: 12,
    })
    if (version !== requestVersion) return
    announcements.value = [...announcements.value, ...response.announcements]
    nextCursor.value = response.nextCursor
  } catch {
    if (version !== requestVersion) return
    loadMoreError.value = true
  } finally {
    if (version === requestVersion) loadMoreLoading.value = false
  }
}

onMounted(loadFirstPage)
onBeforeUnmount(() => {
  requestVersion += 1
})
</script>

<template>
  <main class="page-shell pb-16 pt-8 sm:pt-12">
    <header class="max-w-3xl">
      <p
        class="font-display-en text-xs font-semibold uppercase tracking-[0.2em] text-accent-caramel"
      >
        Announcements
      </p>
      <h1 class="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">公告中心</h1>
      <p class="mt-3 leading-7 text-muted-foreground">
        查看 Movune 的平台消息、功能更新與系統維護資訊。
      </p>
    </header>

    <div class="mt-8 flex flex-wrap gap-2" aria-label="公告分類">
      <button
        v-for="option in categoryOptions"
        :key="option.value"
        type="button"
        class="min-h-11 rounded-full border px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        :class="
          selectedCategory === option.value
            ? 'border-accent-caramel bg-accent-caramel-soft text-foreground'
            : 'border-control text-muted-foreground hover:border-accent-caramel hover:text-foreground'
        "
        :aria-pressed="selectedCategory === option.value"
        @click="selectCategory(option.value)"
      >
        {{ option.label }}
        <span v-if="selectedCategory === option.value" class="sr-only">（已選取）</span>
      </button>
    </div>

    <section class="mt-8" aria-labelledby="announcement-list-heading">
      <h2 id="announcement-list-heading" class="sr-only">公告列表</h2>

      <div v-if="initialLoading" role="status" aria-label="公告載入中">
        <span class="sr-only">公告載入中</span>
        <div class="grid gap-4" aria-hidden="true">
          <div
            v-for="index in 4"
            :key="index"
            class="animate-pulse rounded-xl border border-border bg-card p-5 sm:p-6"
          >
            <div class="h-4 w-24 rounded bg-secondary"></div>
            <div class="mt-4 h-7 w-3/4 rounded bg-secondary"></div>
            <div class="mt-4 h-4 w-40 rounded bg-secondary"></div>
          </div>
        </div>
      </div>

      <div
        v-else-if="initialError"
        class="rounded-xl border border-border bg-card px-6 py-14 text-center"
        role="alert"
      >
        <p class="text-xl font-bold">公告載入失敗</p>
        <button
          type="button"
          class="mt-5 min-h-11 rounded-md border border-control px-5 font-semibold hover:border-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          @click="loadFirstPage"
        >
          重新載入
        </button>
      </div>

      <div
        v-else-if="announcements.length === 0"
        class="rounded-xl border border-border bg-card px-6 py-14 text-center"
        role="status"
      >
        <p class="text-lg font-semibold">
          {{ selectedCategory === 'all' ? '目前沒有公告' : '此分類目前沒有公告' }}
        </p>
      </div>

      <template v-else>
        <ol class="grid gap-4">
          <li v-for="announcement in announcements" :key="announcement.id">
            <article
              class="min-w-0 rounded-xl border border-border bg-card p-5 shadow-[0_12px_36px_rgba(0,0,0,0.12)] sm:p-6"
            >
              <div class="flex flex-wrap items-center gap-2 text-sm">
                <span class="font-semibold text-accent-caramel">
                  {{ categoryLabels[announcement.category] }}
                </span>
                <span
                  v-if="announcement.priority === 'important'"
                  class="rounded-full border border-accent-caramel/50 bg-accent-caramel-soft px-2.5 py-0.5 text-xs font-semibold text-foreground"
                >
                  重要
                </span>
                <span
                  v-if="announcement.category === 'system_maintenance' && announcement.maintenance"
                  class="rounded-full border border-border px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
                >
                  {{ maintenanceStatusLabels[announcement.maintenance.status] }}
                </span>
              </div>
              <h3 class="mt-3 text-xl font-bold leading-snug tracking-tight sm:text-2xl">
                <RouterLink
                  :to="{
                    name: 'announcement-detail',
                    params: { announcementId: announcement.id },
                  }"
                  class="break-words rounded-sm hover:text-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  {{ announcement.title }}
                </RouterLink>
              </h3>
              <p class="mt-3 text-sm text-muted-foreground">
                <template v-if="announcement.effectiveAt">
                  上線於 {{ formatHistoricalDate(announcement.effectiveAt) }}
                </template>
                <template v-else
                  >發布於 {{ formatPublishedDate(announcement.publishedAt) }}</template
                >
              </p>
            </article>
          </li>
        </ol>

        <div v-if="nextCursor || loadMoreError" class="mt-8 text-center">
          <p v-if="loadMoreError" class="mb-3 text-sm text-destructive" role="alert">
            更多公告載入失敗，已保留目前內容。
          </p>
          <button
            v-if="nextCursor"
            type="button"
            class="min-h-11 rounded-md border border-control px-6 font-semibold hover:border-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-wait disabled:opacity-60"
            :disabled="loadMoreLoading"
            :aria-busy="loadMoreLoading"
            @click="loadMore"
          >
            {{ loadMoreLoading ? '載入中…' : loadMoreError ? '重新載入更多' : '載入更多' }}
          </button>
        </div>
      </template>
    </section>
  </main>
</template>

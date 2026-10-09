<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { isAxiosError } from 'axios'
import AnnouncementRichText from '@/components/announcement/AnnouncementRichText.vue'
import {
  getAnnouncement,
  type AnnouncementAvailableDetail,
  type AnnouncementCategory,
  type AnnouncementMaintenanceStatus,
  type AnnouncementPublicDetail,
} from '@/services/announcements'

const route = useRoute()
const announcement = ref<AnnouncementPublicDetail | null>(null)
const loading = ref(false)
const notFound = ref(false)
const loadError = ref(false)
let requestVersion = 0

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

const announcementId = computed(() => {
  const value = route.params.announcementId
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
})

const taipeiPartsFormatter = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

type TaipeiParts = Readonly<{
  year: string
  month: string
  day: string
  hour: string
  minute: string
}>

function getTaipeiParts(value: string): TaipeiParts | null {
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return null
  const parts = Object.fromEntries(
    taipeiPartsFormatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  )
  if (!parts.year || !parts.month || !parts.day || !parts.hour || !parts.minute) return null
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  }
}

function formatTaipeiDate(value: string) {
  const parts = getTaipeiParts(value)
  return parts ? `${parts.year} 年 ${parts.month} 月 ${parts.day} 日` : ''
}

function formatHistoricalDate(value: string) {
  const parts = getTaipeiParts(value)
  return parts ? `${parts.year}/${parts.month.padStart(2, '0')}/${parts.day.padStart(2, '0')}` : ''
}

function formatTaipeiDateTime(value: string) {
  const parts = getTaipeiParts(value)
  return parts
    ? `${parts.year} 年 ${parts.month} 月 ${parts.day} 日 ${parts.hour}:${parts.minute}`
    : ''
}

function formatMaintenanceWindow(startsAt: string, endsAt: string) {
  const start = getTaipeiParts(startsAt)
  const end = getTaipeiParts(endsAt)
  if (!start || !end) return ''
  const startDate = `${start.year} 年 ${start.month} 月 ${start.day} 日`
  const endDate = `${end.year} 年 ${end.month} 月 ${end.day} 日`
  const sameDay = start.year === end.year && start.month === end.month && start.day === end.day
  return sameDay
    ? `${startDate} ${start.hour}:${start.minute}–${end.hour}:${end.minute}（台灣時間）`
    : `${startDate} ${start.hour}:${start.minute} – ${endDate} ${end.hour}:${end.minute}（台灣時間）`
}

function isNotFoundError(error: unknown) {
  if (!isAxiosError(error) || error.response?.status !== 404) return false
  const data = error.response.data
  return (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof data.error === 'object' &&
    data.error !== null &&
    'code' in data.error &&
    data.error.code === 'ANNOUNCEMENT_NOT_FOUND'
  )
}

async function loadAnnouncement() {
  const version = ++requestVersion
  announcement.value = null
  notFound.value = false
  loadError.value = false
  loading.value = true
  try {
    const response = await getAnnouncement(announcementId.value)
    if (version !== requestVersion) return
    announcement.value = response
  } catch (error) {
    if (version !== requestVersion) return
    if (isNotFoundError(error)) notFound.value = true
    else loadError.value = true
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

function availableDetail(value: AnnouncementPublicDetail): value is AnnouncementAvailableDetail {
  return value.availability === 'available'
}

watch(announcementId, loadAnnouncement, { immediate: true })
onBeforeUnmount(() => {
  requestVersion += 1
})
</script>

<template>
  <main class="page-shell pb-16 pt-8 sm:pt-12">
    <nav class="mb-7 flex items-center gap-2 text-sm text-muted-foreground" aria-label="麵包屑">
      <RouterLink
        :to="{ name: 'announcement-center' }"
        class="rounded-sm hover:text-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        公告中心
      </RouterLink>
      <span aria-hidden="true">/</span>
      <span aria-current="page">公告內容</span>
    </nav>

    <div v-if="loading" role="status" aria-label="公告內容載入中">
      <span class="sr-only">公告內容載入中</span>
      <div class="mx-auto max-w-4xl animate-pulse" aria-hidden="true">
        <div class="h-4 w-24 rounded bg-secondary"></div>
        <div class="mt-5 h-10 w-4/5 rounded bg-secondary"></div>
        <div class="mt-4 h-4 w-44 rounded bg-secondary"></div>
        <div class="mt-10 space-y-4">
          <div class="h-4 rounded bg-secondary"></div>
          <div class="h-4 rounded bg-secondary"></div>
          <div class="h-4 w-2/3 rounded bg-secondary"></div>
        </div>
      </div>
    </div>

    <section
      v-else-if="notFound"
      class="mx-auto max-w-3xl rounded-xl border border-border bg-card px-6 py-16 text-center"
    >
      <h1 class="text-3xl font-bold tracking-tight">找不到此公告</h1>
      <RouterLink
        :to="{ name: 'announcement-center' }"
        class="mt-6 inline-flex min-h-11 items-center rounded-md border border-control px-5 font-semibold hover:border-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        返回公告中心
      </RouterLink>
    </section>

    <section
      v-else-if="loadError"
      class="mx-auto max-w-3xl rounded-xl border border-border bg-card px-6 py-16 text-center"
      role="alert"
    >
      <h1 class="text-3xl font-bold tracking-tight">公告載入失敗</h1>
      <button
        type="button"
        class="mt-6 min-h-11 rounded-md border border-control px-5 font-semibold hover:border-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        @click="loadAnnouncement"
      >
        重新載入
      </button>
    </section>

    <section
      v-else-if="announcement?.availability === 'withdrawn'"
      class="mx-auto max-w-3xl rounded-xl border border-border bg-card px-6 py-16 text-center"
    >
      <h1 class="text-3xl font-bold tracking-tight">此公告已下架</h1>
      <p class="mt-4 text-muted-foreground">此公告目前已不再公開提供內容。</p>
      <RouterLink
        :to="{ name: 'announcement-center' }"
        class="mt-6 inline-flex min-h-11 items-center rounded-md border border-control px-5 font-semibold hover:border-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        返回公告中心
      </RouterLink>
    </section>

    <section
      v-else-if="announcement?.availability === 'removed'"
      class="mx-auto max-w-3xl rounded-xl border border-border bg-card px-6 py-16 text-center"
    >
      <h1 class="text-3xl font-bold tracking-tight">此公告已無法查看</h1>
      <p class="mt-4 text-muted-foreground">此公告目前無法提供內容。</p>
      <RouterLink
        :to="{ name: 'announcement-center' }"
        class="mt-6 inline-flex min-h-11 items-center rounded-md border border-control px-5 font-semibold hover:border-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        返回公告中心
      </RouterLink>
    </section>

    <article v-else-if="announcement && availableDetail(announcement)" class="mx-auto max-w-4xl">
      <header class="border-b border-border pb-8">
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
        </div>
        <h1 class="mt-4 break-words text-3xl font-bold leading-tight tracking-tight sm:text-5xl">
          {{ announcement.title }}
        </h1>
        <p class="mt-4 text-sm text-muted-foreground">
          <template v-if="announcement.effectiveAt">
            上線於 {{ formatHistoricalDate(announcement.effectiveAt) }}
          </template>
          <template v-else>發布於 {{ formatTaipeiDate(announcement.publishedAt) }}</template>
        </p>
      </header>

      <aside
        v-if="announcement.importantUpdate"
        class="mt-8 rounded-xl border border-accent-caramel/40 bg-accent-caramel-soft p-5 sm:p-6"
        aria-labelledby="important-update-heading"
      >
        <h2 id="important-update-heading" class="text-lg font-bold">重要更新</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          更新時間 {{ formatTaipeiDateTime(announcement.importantUpdate.at) }}
        </p>
        <p class="mt-3 whitespace-pre-wrap break-words leading-7">
          {{ announcement.importantUpdate.note }}
        </p>
      </aside>

      <section
        v-if="announcement.category === 'system_maintenance' && announcement.maintenance"
        class="mt-8 rounded-xl border border-border bg-card p-5 sm:p-6"
        aria-labelledby="maintenance-heading"
      >
        <h2 id="maintenance-heading" class="text-xl font-bold">維護資訊</h2>
        <dl class="mt-5 grid gap-5 sm:grid-cols-2">
          <div>
            <dt class="text-sm font-semibold text-muted-foreground">維護狀態</dt>
            <dd class="mt-1 font-medium">
              {{ maintenanceStatusLabels[announcement.maintenance.status] }}
            </dd>
          </div>
          <div>
            <dt class="text-sm font-semibold text-muted-foreground">維護時間</dt>
            <dd class="mt-1 break-words font-medium">
              {{
                formatMaintenanceWindow(
                  announcement.maintenance.startsAt,
                  announcement.maintenance.endsAt,
                )
              }}
            </dd>
          </div>
          <div>
            <dt class="text-sm font-semibold text-muted-foreground">影響範圍</dt>
            <dd class="mt-1 break-words font-medium">
              {{ announcement.maintenance.affectedAreas.join('、') }}
            </dd>
          </div>
          <div>
            <dt class="text-sm font-semibold text-muted-foreground">預期影響</dt>
            <dd class="mt-1 whitespace-pre-wrap break-words font-medium">
              {{ announcement.maintenance.expectedImpact }}
            </dd>
          </div>
          <div
            v-if="
              announcement.maintenance.status === 'completed' &&
              announcement.maintenance.actualCompletionTime
            "
            class="sm:col-span-2"
          >
            <dt class="text-sm font-semibold text-muted-foreground">實際完成時間</dt>
            <dd class="mt-1 font-medium">
              {{ formatTaipeiDateTime(announcement.maintenance.actualCompletionTime) }}（台灣時間）
            </dd>
          </div>
        </dl>
      </section>

      <section class="mt-9" aria-label="公告內容">
        <AnnouncementRichText :document="announcement.body" />
      </section>
    </article>
  </main>
</template>

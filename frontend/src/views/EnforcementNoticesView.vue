<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getMyEnforcementNotices, type MemberEnforcementNotice } from '@/services/users'
import { useUserStore } from '@/stores/user'

const userStore = useUserStore()
const notices = ref<MemberEnforcementNotice[]>([])
const loading = ref(true)
const failed = ref(false)

const formatTime = (value: string) =>
  new Intl.DateTimeFormat('zh-TW', { dateStyle: 'long', timeStyle: 'short' }).format(
    new Date(value),
  )

onMounted(async () => {
  try {
    if (!userStore.accessToken) throw new Error('Authentication is required')
    notices.value = await getMyEnforcementNotices(userStore.accessToken)
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <main class="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6" aria-labelledby="notices-title">
    <header>
      <p class="text-sm font-semibold text-primary">帳戶治理紀錄</p>
      <h1 id="notices-title" class="mt-2 text-3xl font-bold text-foreground">正式警告</h1>
      <p class="mt-3 text-muted-foreground">正式警告是治理紀錄，不會暫停或限制你的日常帳戶功能。</p>
    </header>

    <p v-if="loading" class="mt-8 text-muted-foreground" role="status">正在載入治理紀錄…</p>
    <p
      v-else-if="failed"
      class="mt-8 rounded-lg border border-destructive/40 p-4 text-destructive"
      role="alert"
    >
      暫時無法載入治理紀錄，請稍後再試。
    </p>
    <p
      v-else-if="notices.length === 0"
      class="mt-8 rounded-lg border border-border p-5 text-muted-foreground"
    >
      目前沒有正式警告紀錄。
    </p>
    <ol v-else class="mt-8 space-y-4">
      <li
        v-for="notice in notices"
        :key="notice.id"
        class="rounded-xl border border-border bg-surface-raised p-5"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="font-semibold text-foreground">正式警告</h2>
            <span
              v-if="notice.status !== 'recorded'"
              class="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800"
            >
              已撤銷
            </span>
          </div>
          <time :datetime="notice.recordedAt" class="text-sm text-muted-foreground">
            {{ formatTime(notice.recordedAt) }}
          </time>
        </div>
        <p class="mt-4 whitespace-pre-wrap text-foreground">{{ notice.reason }}</p>
        <div
          v-if="notice.status !== 'recorded' && notice.reversedAt"
          class="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-950"
        >
          <p class="font-semibold">此正式警告已撤銷</p>
          <p class="mt-1 text-sm">
            撤銷時間：<time :datetime="notice.reversedAt">{{ formatTime(notice.reversedAt) }}</time>
          </p>
          <p class="mt-2 whitespace-pre-wrap">
            {{
              notice.status === 'reversed' && notice.reversalReason
                ? notice.reversalReason
                : '此正式警告已由管理員撤銷。'
            }}
          </p>
        </div>
        <p class="mt-4 text-sm text-muted-foreground">
          治理依據：{{ notice.guideline.title }}・{{ notice.guideline.ruleId }}（版本
          {{ notice.guideline.version }}）
        </p>
      </li>
    </ol>
  </main>
</template>

<script setup lang="ts">
import axios from 'axios'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { Flag } from '@lucide/vue'
import {
  listAdminReports,
  type AdminReportQueueItem,
  type AdminReportReason,
  type AdminReportSourceType,
  type ReportIdentityValue,
} from '@/services/adminReports'

const route = useRoute()
const router = useRouter()
const reports = ref<AdminReportQueueItem[]>([])
const pagination = ref({ limit: 20, hasMore: false, nextCursor: null as string | null })
const state = ref<'loading' | 'ready' | 'forbidden' | 'invalid-query' | 'error'>('loading')
let requestVersion = 0

const cursor = computed(() => (typeof route.query.cursor === 'string' ? route.query.cursor : ''))
const detailQuery = computed(() => ({ from: route.fullPath }))

async function loadReports() {
  const version = ++requestVersion
  state.value = 'loading'
  reports.value = []
  pagination.value = { limit: 20, hasMore: false, nextCursor: null }
  try {
    const response = await listAdminReports({
      ...(cursor.value ? { cursor: cursor.value } : {}),
      limit: 20,
    })
    if (version !== requestVersion) return
    reports.value = response.reports
    pagination.value = response.pagination
    state.value = 'ready'
  } catch (error) {
    if (version !== requestVersion) return
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    state.value =
      status === 401 || status === 403 ? 'forbidden' : status === 400 ? 'invalid-query' : 'error'
  }
}

function loadNextPage() {
  if (!pagination.value.hasMore || !pagination.value.nextCursor) return
  void router.push({ name: 'report-admin-list', query: { cursor: pagination.value.nextCursor } })
}

const identityLabel = (identity: ReportIdentityValue, prefix = '') =>
  identity.status === 'available' ? `${prefix}${identity.value}` : '資料已不可用'
const reasonLabel = (reason: AdminReportReason) =>
  ({
    harassment_or_uncomfortable: '騷擾或令人不適',
    spam_or_suspicious: '垃圾內容或可疑行為',
    other: '其他',
  })[reason]
const sourceTypeLabel = (sourceType: AdminReportSourceType) =>
  ({
    public_profile: '公開個人檔案',
    direct_conversation: '私人對話',
    direct_message: '特定私人訊息',
  })[sourceType]
const submittedAtLabel = (value: string) =>
  new Intl.DateTimeFormat('zh-TW', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Taipei',
  }).format(new Date(value))

watch(() => route.fullPath, loadReports, { immediate: true })
onBeforeUnmount(() => {
  requestVersion += 1
})
</script>

<template>
  <section aria-labelledby="report-list-title">
    <div>
      <p class="text-sm font-semibold text-amber-700">Review Center · Reports</p>
      <h2 id="report-list-title" class="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
        檢舉
      </h2>
      <p class="mt-2 text-sm text-slate-600">依提交時間由新到舊檢視唯讀檢舉資料。</p>
    </div>

    <div class="mt-6" aria-live="polite" :aria-busy="state === 'loading'">
      <div
        v-if="state === 'loading'"
        class="rounded-xl border border-slate-200 bg-white p-10 text-center"
      >
        <p class="font-medium text-slate-700">正在載入檢舉…</p>
      </div>
      <div
        v-else-if="state !== 'ready'"
        role="alert"
        class="rounded-xl border border-red-200 bg-red-50 p-5 text-red-800"
      >
        <p class="font-semibold">
          {{
            state === 'forbidden'
              ? '無法檢視檢舉'
              : state === 'invalid-query'
                ? '列表位置無效'
                : '無法載入檢舉'
          }}
        </p>
        <p class="mt-1 text-sm">
          {{
            state === 'forbidden'
              ? '登入狀態已失效，或你目前沒有檢視檢舉的權限。'
              : state === 'invalid-query'
                ? '請返回檢舉列表起始頁。'
                : '目前無法載入檢舉資料，請稍後再試。'
          }}
        </p>
        <RouterLink
          v-if="state === 'invalid-query'"
          :to="{ name: 'report-admin-list' }"
          class="mt-4 inline-flex min-h-11 items-center rounded-lg border border-red-300 bg-white px-4 font-semibold hover:bg-red-100"
        >
          返回起始頁
        </RouterLink>
        <button
          v-else-if="state === 'error'"
          type="button"
          class="mt-4 min-h-11 rounded-lg border border-red-300 bg-white px-4 font-semibold hover:bg-red-100"
          @click="loadReports"
        >
          重新載入
        </button>
      </div>
      <div
        v-else-if="reports.length === 0"
        class="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center"
      >
        <Flag class="mx-auto size-8 text-slate-400" aria-hidden="true" />
        <p class="mt-3 font-semibold">目前沒有檢舉</p>
      </div>
      <template v-else>
        <div
          class="hidden overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm md:block"
        >
          <table class="w-full table-fixed text-left text-sm">
            <thead class="bg-slate-100 text-xs tracking-wide text-slate-600 uppercase">
              <tr>
                <th scope="col" class="w-[18%] px-4 py-3">檢舉識別碼</th>
                <th scope="col" class="w-[17%] px-4 py-3">原因</th>
                <th scope="col" class="w-[15%] px-4 py-3">來源類型</th>
                <th scope="col" class="w-[18%] px-4 py-3">被檢舉會員顯示名稱</th>
                <th scope="col" class="w-[16%] px-4 py-3">被檢舉會員帳號</th>
                <th scope="col" class="w-[16%] px-4 py-3">提交時間</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200">
              <tr v-for="report in reports" :key="report.id" class="hover:bg-slate-50">
                <td class="px-4 py-4 align-top">
                  <RouterLink
                    :to="{
                      name: 'report-admin-detail',
                      params: { reportId: report.id },
                      query: detailQuery,
                    }"
                    class="break-all font-mono font-semibold text-amber-800 hover:underline"
                    >{{ report.id }}</RouterLink
                  >
                </td>
                <td class="px-4 py-4 align-top">{{ reasonLabel(report.reason) }}</td>
                <td class="px-4 py-4 align-top">{{ sourceTypeLabel(report.sourceType) }}</td>
                <td class="break-words px-4 py-4 align-top">
                  {{ identityLabel(report.reportedMemberDisplayName) }}
                </td>
                <td class="break-all px-4 py-4 align-top">
                  {{ identityLabel(report.reportedMemberAccount, '@') }}
                </td>
                <td class="px-4 py-4 align-top text-slate-600">
                  {{ submittedAtLabel(report.submittedAt) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="grid min-w-0 gap-3 md:hidden">
          <article
            v-for="report in reports"
            :key="report.id"
            class="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <dl class="grid min-w-0 gap-3 text-sm">
              <div class="min-w-0">
                <dt class="text-slate-500">檢舉識別碼</dt>
                <dd class="mt-1 break-all font-mono font-semibold">{{ report.id }}</dd>
              </div>
              <div class="grid min-w-0 grid-cols-2 gap-3">
                <div class="min-w-0">
                  <dt class="text-slate-500">原因</dt>
                  <dd class="mt-1 break-words font-medium">{{ reasonLabel(report.reason) }}</dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-slate-500">來源類型</dt>
                  <dd class="mt-1 break-words font-medium">
                    {{ sourceTypeLabel(report.sourceType) }}
                  </dd>
                </div>
              </div>
              <div class="min-w-0">
                <dt class="text-slate-500">被檢舉會員顯示名稱</dt>
                <dd class="mt-1 break-words font-medium">
                  {{ identityLabel(report.reportedMemberDisplayName) }}
                </dd>
              </div>
              <div class="min-w-0">
                <dt class="text-slate-500">被檢舉會員帳號</dt>
                <dd class="mt-1 break-all font-medium">
                  {{ identityLabel(report.reportedMemberAccount, '@') }}
                </dd>
              </div>
              <div>
                <dt class="text-slate-500">提交時間</dt>
                <dd class="mt-1 font-medium">{{ submittedAtLabel(report.submittedAt) }}</dd>
              </div>
            </dl>
            <RouterLink
              :to="{
                name: 'report-admin-detail',
                params: { reportId: report.id },
                query: detailQuery,
              }"
              class="mt-4 inline-flex min-h-11 w-full min-w-0 items-center justify-center rounded-lg bg-slate-950 px-4 font-semibold text-white"
              >查看檢舉</RouterLink
            >
          </article>
        </div>

        <div class="mt-5 flex justify-end">
          <button
            v-if="pagination.hasMore"
            type="button"
            class="min-h-11 rounded-lg bg-slate-950 px-5 font-semibold text-white hover:bg-slate-800"
            @click="loadNextPage"
          >
            下一頁
          </button>
          <p v-else class="text-sm text-slate-500">已顯示目前可用的全部檢舉。</p>
        </div>
      </template>
    </div>
  </section>
</template>

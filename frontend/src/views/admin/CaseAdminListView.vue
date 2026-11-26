<script setup lang="ts">
import axios from 'axios'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ClipboardCheck } from '@lucide/vue'
import {
  ADMIN_CASE_STATES,
  isAdminCaseState,
  listAdminCases,
  type AdminCaseQueueItem,
  type AdminCaseState,
} from '@/services/adminCases'
import type {
  AdminReportReason,
  AdminReportSourceType,
  ReportIdentityValue,
} from '@/services/adminReports'

const route = useRoute()
const router = useRouter()
const cases = ref<AdminCaseQueueItem[]>([])
const pagination = ref({ limit: 20, hasMore: false, nextCursor: null as string | null })
const state = ref<
  'loading' | 'ready' | 'unauthenticated' | 'forbidden' | 'invalid-query' | 'error'
>('loading')
let requestVersion = 0

const selectedState = computed(() =>
  typeof route.query.state === 'string' && isAdminCaseState(route.query.state)
    ? route.query.state
    : '',
)
const detailQuery = computed(() => ({ from: route.fullPath }))

const hasValidRouteQuery = () => {
  const keys = Object.keys(route.query)
  if (keys.some((key) => key !== 'cursor' && key !== 'state')) return false
  if (
    route.query.cursor !== undefined &&
    (typeof route.query.cursor !== 'string' || route.query.cursor.length === 0)
  ) {
    return false
  }
  return (
    route.query.state === undefined ||
    (typeof route.query.state === 'string' && isAdminCaseState(route.query.state))
  )
}

async function loadCases() {
  const version = ++requestVersion
  cases.value = []
  pagination.value = { limit: 20, hasMore: false, nextCursor: null }
  if (!hasValidRouteQuery()) {
    state.value = 'invalid-query'
    return
  }
  state.value = 'loading'
  try {
    const response = await listAdminCases({
      ...(typeof route.query.cursor === 'string' ? { cursor: route.query.cursor } : {}),
      ...(selectedState.value ? { state: selectedState.value } : {}),
      limit: 20,
    })
    if (version !== requestVersion) return
    cases.value = response.cases
    pagination.value = response.pagination
    state.value = 'ready'
  } catch (error) {
    if (version !== requestVersion) return
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    state.value =
      status === 401
        ? 'unauthenticated'
        : status === 403
          ? 'forbidden'
          : status === 400 ||
              (error instanceof Error && error.message === 'ADMIN_CASE_QUERY_INVALID')
            ? 'invalid-query'
            : 'error'
  }
}

function changeState(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  void router.push({
    name: 'case-admin-list',
    query: isAdminCaseState(value) ? { state: value } : {},
  })
}

function loadNextPage() {
  if (!pagination.value.hasMore || !pagination.value.nextCursor) return
  void router.push({
    name: 'case-admin-list',
    query: {
      ...(selectedState.value ? { state: selectedState.value } : {}),
      cursor: pagination.value.nextCursor,
    },
  })
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
const caseStateLabel = (caseState: AdminCaseState) =>
  ({ needs_review: '待審核', under_review: '審核中', review_completed: '審核完成' })[caseState]
const submittedAtLabel = (value: string) =>
  new Intl.DateTimeFormat('zh-TW', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Taipei',
  }).format(new Date(value))

watch(() => route.fullPath, loadCases, { immediate: true })
onBeforeUnmount(() => {
  requestVersion += 1
})
</script>

<template>
  <section aria-labelledby="case-list-title">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p class="text-sm font-semibold text-amber-700">Review Center · Cases</p>
        <h2 id="case-list-title" class="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
          案件
        </h2>
        <p class="mt-2 text-sm text-slate-600">由後端依提交時間由新到舊排列案件。</p>
      </div>
      <label class="grid gap-1 text-sm font-semibold text-slate-700">
        案件狀態
        <select
          :value="selectedState"
          class="min-h-11 rounded-lg border border-slate-400 bg-white px-3 font-normal"
          @change="changeState"
        >
          <option value="">全部狀態</option>
          <option v-for="caseState in ADMIN_CASE_STATES" :key="caseState" :value="caseState">
            {{ caseStateLabel(caseState) }}
          </option>
        </select>
      </label>
    </div>

    <div class="mt-6" aria-live="polite" :aria-busy="state === 'loading'">
      <div
        v-if="state === 'loading'"
        class="rounded-xl border border-slate-200 bg-white p-10 text-center"
      >
        <p class="font-medium text-slate-700">正在載入案件…</p>
      </div>
      <div
        v-else-if="state !== 'ready'"
        role="alert"
        class="rounded-xl border border-red-200 bg-red-50 p-5 text-red-800"
      >
        <p class="font-semibold">
          {{
            state === 'unauthenticated'
              ? '登入狀態已失效'
              : state === 'forbidden'
                ? '沒有案件審核權限'
                : state === 'invalid-query'
                  ? '列表條件或位置無效'
                  : '無法載入案件'
          }}
        </p>
        <p class="mt-1 text-sm">
          {{
            state === 'invalid-query'
              ? '請返回案件列表起始頁重新選擇篩選條件。'
              : state === 'error'
                ? '目前無法安全取得案件資料，請稍後再試。'
                : '請重新登入，或由管理員確認你的案件審核權限。'
          }}
        </p>
        <RouterLink
          v-if="state === 'invalid-query'"
          :to="{ name: 'case-admin-list' }"
          class="mt-4 inline-flex min-h-11 items-center rounded-lg border border-red-300 bg-white px-4 font-semibold hover:bg-red-100"
        >
          返回起始頁
        </RouterLink>
        <button
          v-else-if="state === 'error'"
          type="button"
          class="mt-4 min-h-11 rounded-lg border border-red-300 bg-white px-4 font-semibold hover:bg-red-100"
          @click="loadCases"
        >
          重新載入
        </button>
      </div>
      <div
        v-else-if="cases.length === 0"
        class="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center"
      >
        <ClipboardCheck class="mx-auto size-8 text-slate-400" aria-hidden="true" />
        <p class="mt-3 font-semibold">此篩選條件目前沒有案件</p>
      </div>
      <template v-else>
        <div
          class="hidden overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm md:block"
        >
          <table class="w-full table-fixed text-left text-sm">
            <thead class="bg-slate-100 text-xs tracking-wide text-slate-600 uppercase">
              <tr>
                <th scope="col" class="w-[22%] px-4 py-3">檢舉／案件識別碼</th>
                <th scope="col" class="w-[14%] px-4 py-3">案件狀態</th>
                <th scope="col" class="w-[16%] px-4 py-3">原因</th>
                <th scope="col" class="w-[14%] px-4 py-3">來源類型</th>
                <th scope="col" class="w-[18%] px-4 py-3">被檢舉會員</th>
                <th scope="col" class="w-[16%] px-4 py-3">提交時間</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200">
              <tr v-for="item in cases" :key="item.report.id" class="hover:bg-slate-50">
                <td class="px-4 py-4 align-top">
                  <RouterLink
                    :to="{
                      name: 'case-admin-detail',
                      params: { reportId: item.report.id },
                      query: detailQuery,
                    }"
                    class="break-all font-mono font-semibold text-amber-800 hover:underline"
                    >{{ item.report.id }}</RouterLink
                  >
                  <p class="mt-1 break-all font-mono text-xs text-slate-500">
                    {{ item.case.id ?? '尚未建立案件紀錄' }}
                  </p>
                </td>
                <td class="px-4 py-4 align-top font-semibold">
                  {{ caseStateLabel(item.case.state) }}
                </td>
                <td class="px-4 py-4 align-top">{{ reasonLabel(item.report.reason) }}</td>
                <td class="px-4 py-4 align-top">
                  {{ sourceTypeLabel(item.report.sourceType) }}
                </td>
                <td class="min-w-0 px-4 py-4 align-top">
                  <p class="break-words font-medium">
                    {{ identityLabel(item.report.reportedMemberDisplayName) }}
                  </p>
                  <p class="break-all text-slate-500">
                    {{ identityLabel(item.report.reportedMemberAccount, '@') }}
                  </p>
                </td>
                <td class="px-4 py-4 align-top text-slate-600">
                  {{ submittedAtLabel(item.report.submittedAt) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="grid min-w-0 gap-3 md:hidden">
          <article
            v-for="item in cases"
            :key="item.report.id"
            class="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <dl class="grid min-w-0 gap-3 text-sm">
              <div>
                <dt class="text-slate-500">案件狀態</dt>
                <dd class="mt-1 font-bold">{{ caseStateLabel(item.case.state) }}</dd>
              </div>
              <div class="min-w-0">
                <dt class="text-slate-500">檢舉識別碼</dt>
                <dd class="mt-1 break-all font-mono font-semibold">{{ item.report.id }}</dd>
              </div>
              <div class="min-w-0">
                <dt class="text-slate-500">案件識別碼</dt>
                <dd class="mt-1 break-all font-mono">
                  {{ item.case.id ?? '尚未建立案件紀錄' }}
                </dd>
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <dt class="text-slate-500">原因</dt>
                  <dd class="mt-1 break-words font-medium">
                    {{ reasonLabel(item.report.reason) }}
                  </dd>
                </div>
                <div>
                  <dt class="text-slate-500">來源類型</dt>
                  <dd class="mt-1 break-words font-medium">
                    {{ sourceTypeLabel(item.report.sourceType) }}
                  </dd>
                </div>
              </div>
              <div class="min-w-0">
                <dt class="text-slate-500">被檢舉會員</dt>
                <dd class="mt-1 break-words font-medium">
                  {{ identityLabel(item.report.reportedMemberDisplayName) }}
                </dd>
                <dd class="break-all text-slate-500">
                  {{ identityLabel(item.report.reportedMemberAccount, '@') }}
                </dd>
              </div>
              <div>
                <dt class="text-slate-500">提交時間</dt>
                <dd class="mt-1 font-medium">{{ submittedAtLabel(item.report.submittedAt) }}</dd>
              </div>
            </dl>
            <RouterLink
              :to="{
                name: 'case-admin-detail',
                params: { reportId: item.report.id },
                query: detailQuery,
              }"
              class="mt-4 inline-flex min-h-11 w-full min-w-0 items-center justify-center rounded-lg bg-slate-950 px-4 font-semibold text-white"
              >查看案件</RouterLink
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
          <p v-else class="text-sm text-slate-500">已顯示此篩選條件目前可用的全部案件。</p>
        </div>
      </template>
    </div>
  </section>
</template>

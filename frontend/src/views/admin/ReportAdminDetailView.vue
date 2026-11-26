<script setup lang="ts">
import axios from 'axios'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ArrowLeft, Eye } from '@lucide/vue'
import {
  getAdminReport,
  getAdminReportEvidence,
  isAdminReportId,
  type AdminReportAccountStatus,
  type AdminReportDetail,
  type AdminReportEvidence,
  type AdminReportReason,
  type AdminReportSourceType,
  type ReportIdentityValue,
} from '@/services/adminReports'

const route = useRoute()
const detail = ref<AdminReportDetail | null>(null)
const detailState = ref<'loading' | 'ready' | 'malformed' | 'not-found' | 'forbidden' | 'error'>(
  'loading',
)
const evidence = ref<AdminReportEvidence | null>(null)
const evidenceState = ref<
  'idle' | 'loading' | 'ready' | 'forbidden' | 'audit-unconfirmed' | 'unavailable' | 'error'
>('idle')
let detailRequestVersion = 0
let evidenceRequestVersion = 0
let detailAbortController: AbortController | null = null
let evidenceAbortController: AbortController | null = null

const reportId = computed(() =>
  typeof route.params.reportId === 'string' ? route.params.reportId : '',
)
const returnTarget = computed(() => {
  const from = typeof route.query.from === 'string' ? route.query.from : ''
  return from === '/admin/reports' || from.startsWith('/admin/reports?') ? from : '/admin/reports'
})

function clearEvidence() {
  evidenceAbortController?.abort()
  evidenceAbortController = null
  evidenceRequestVersion += 1
  evidence.value = null
  evidenceState.value = 'idle'
}

async function loadDetail() {
  const version = ++detailRequestVersion
  detailAbortController?.abort()
  detailAbortController = new AbortController()
  clearEvidence()
  detail.value = null
  if (!isAdminReportId(reportId.value)) {
    detailState.value = 'malformed'
    return
  }
  detailState.value = 'loading'
  try {
    const response = await getAdminReport(reportId.value, detailAbortController.signal)
    if (version !== detailRequestVersion) return
    detail.value = response
    detailState.value = 'ready'
  } catch (error) {
    if (version !== detailRequestVersion || axios.isCancel(error)) return
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    detailState.value =
      status === 400
        ? 'malformed'
        : status === 404
          ? 'not-found'
          : status === 401 || status === 403
            ? 'forbidden'
            : 'error'
  }
}

async function revealEvidence() {
  if (evidenceState.value === 'loading' || !isAdminReportId(reportId.value)) return
  const requestedReportId = reportId.value
  const version = ++evidenceRequestVersion
  evidenceAbortController?.abort()
  evidenceAbortController = new AbortController()
  evidence.value = null
  evidenceState.value = 'loading'
  try {
    const response = await getAdminReportEvidence(requestedReportId, evidenceAbortController.signal)
    if (version !== evidenceRequestVersion || reportId.value !== requestedReportId) return
    evidence.value = response
    evidenceState.value = 'ready'
  } catch (error) {
    if (version !== evidenceRequestVersion || axios.isCancel(error)) return
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    const code =
      axios.isAxiosError(error) &&
      typeof error.response?.data === 'object' &&
      error.response?.data !== null
        ? (error.response.data as { code?: unknown }).code
        : undefined
    evidenceState.value =
      status === 401 || status === 403
        ? 'forbidden'
        : status === 503 && code === 'REPORT_EVIDENCE_AUDIT_UNCONFIRMED'
          ? 'audit-unconfirmed'
          : status === 404 || status === 400 || status === 500
            ? 'unavailable'
            : 'error'
  }
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
const accountStatusLabel = (status: AdminReportAccountStatus) =>
  ({ active: '啟用中', suspended: '暫停中', deactivated: '已停用' })[status]
const dateTimeLabel = (value: string) =>
  new Intl.DateTimeFormat('zh-TW', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Asia/Taipei',
  }).format(new Date(value))

watch(reportId, loadDetail, { immediate: true })
onBeforeUnmount(() => {
  detailRequestVersion += 1
  detailAbortController?.abort()
  clearEvidence()
})
</script>

<template>
  <section aria-labelledby="report-detail-title">
    <RouterLink
      :to="returnTarget"
      class="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 font-semibold text-slate-700 hover:bg-slate-200"
      ><ArrowLeft class="size-4" aria-hidden="true" />返回檢舉列表</RouterLink
    >

    <div
      v-if="detailState === 'loading'"
      class="mt-5 rounded-xl border border-slate-200 bg-white p-10 text-center"
      aria-live="polite"
    >
      <p class="font-medium text-slate-700">正在載入檢舉資料…</p>
    </div>
    <div
      v-else-if="detailState !== 'ready' || !detail"
      role="alert"
      class="mt-5 rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm"
    >
      <h2 id="report-detail-title" class="text-xl font-bold">
        {{
          detailState === 'not-found'
            ? '找不到檢舉'
            : detailState === 'forbidden'
              ? '無法檢視檢舉'
              : detailState === 'malformed'
                ? '檢舉識別碼無效'
                : '資料載入失敗'
        }}
      </h2>
      <p class="mt-2 text-sm text-slate-600">
        {{
          detailState === 'not-found'
            ? '此檢舉不存在或已無法取得。'
            : detailState === 'forbidden'
              ? '登入狀態已失效，或你目前沒有檢視檢舉的權限。'
              : detailState === 'malformed'
                ? '請從檢舉列表重新選擇檢舉。'
                : '目前無法載入檢舉資料，請稍後再試。'
        }}
      </p>
      <button
        v-if="detailState === 'error'"
        type="button"
        class="mt-4 min-h-11 rounded-lg bg-slate-950 px-4 font-semibold text-white"
        @click="loadDetail"
      >
        重新載入
      </button>
    </div>

    <template v-else>
      <header class="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <p class="text-sm font-semibold text-amber-700">Report Detail</p>
        <h2 id="report-detail-title" class="mt-1 text-2xl font-bold sm:text-3xl">檢舉詳情</h2>
        <p class="mt-2 break-all font-mono text-sm text-slate-600">{{ detail.report.id }}</p>
      </header>

      <div class="mt-5 grid gap-5 xl:grid-cols-2">
        <section
          class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"
          aria-labelledby="report-data-title"
        >
          <h3 id="report-data-title" class="text-lg font-bold">檢舉資料</h3>
          <dl class="mt-4 grid gap-5 sm:grid-cols-2">
            <div>
              <dt class="text-sm text-slate-500">原因</dt>
              <dd class="mt-1 font-semibold">{{ reasonLabel(detail.report.reason) }}</dd>
            </div>
            <div>
              <dt class="text-sm text-slate-500">來源類型</dt>
              <dd class="mt-1 font-semibold">{{ sourceTypeLabel(detail.report.sourceType) }}</dd>
            </div>
            <div>
              <dt class="text-sm text-slate-500">提交時間</dt>
              <dd class="mt-1 font-semibold">{{ dateTimeLabel(detail.report.submittedAt) }}</dd>
            </div>
            <div v-if="detail.report.description !== undefined" class="min-w-0 sm:col-span-2">
              <dt class="text-sm text-slate-500">說明</dt>
              <dd class="mt-1 break-words whitespace-pre-wrap">
                {{ detail.report.description || '未提供' }}
              </dd>
            </div>
          </dl>
        </section>

        <section
          class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"
          aria-labelledby="reported-member-title"
        >
          <h3 id="reported-member-title" class="text-lg font-bold">被檢舉會員</h3>
          <div class="mt-4 flex min-w-0 items-center gap-3">
            <img
              v-if="detail.reportedMember.avatar"
              :src="detail.reportedMember.avatar"
              alt=""
              class="size-12 shrink-0 rounded-full bg-slate-200 object-cover"
            />
            <span
              v-else
              class="flex size-12 shrink-0 items-center justify-center rounded-full bg-amber-100 font-bold text-amber-900"
              aria-hidden="true"
              >?</span
            >
            <div class="min-w-0">
              <p class="break-words font-semibold">
                {{ identityLabel(detail.reportedMember.displayName) }}
              </p>
              <p class="break-all text-sm text-slate-500">
                {{ identityLabel(detail.reportedMember.account, '@') }}
              </p>
            </div>
          </div>
          <dl class="mt-5">
            <dt class="text-sm text-slate-500">有效帳號狀態</dt>
            <dd class="mt-1 font-semibold">
              {{
                detail.reportedMember.effectiveAccountStatus.status === 'available'
                  ? accountStatusLabel(detail.reportedMember.effectiveAccountStatus.value)
                  : '目前無法確認'
              }}
            </dd>
          </dl>
        </section>

        <section
          class="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"
          aria-labelledby="reporter-title"
        >
          <h3 id="reporter-title" class="text-lg font-bold">檢舉人</h3>
          <dl class="mt-4 grid gap-5 sm:grid-cols-2">
            <div>
              <dt class="text-sm text-slate-500">顯示名稱</dt>
              <dd class="mt-1 break-words font-semibold">
                {{ identityLabel(detail.reporter.displayName) }}
              </dd>
            </div>
            <div>
              <dt class="text-sm text-slate-500">帳號</dt>
              <dd class="mt-1 break-all font-semibold">
                {{ identityLabel(detail.reporter.account, '@') }}
              </dd>
            </div>
          </dl>
        </section>

        <section
          class="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"
          aria-labelledby="report-evidence-title"
        >
          <h3 id="report-evidence-title" class="text-lg font-bold">提交的特定訊息證據</h3>
          <p class="mt-2 text-sm text-slate-600">
            受保護的證據不會隨詳情自動載入。僅在你明確要求後，系統才會嘗試存取本檢舉提交時保存的特定訊息快照。
          </p>

          <button
            v-if="evidenceState !== 'ready'"
            type="button"
            :disabled="evidenceState === 'loading'"
            class="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg bg-slate-950 px-4 font-semibold text-white hover:bg-slate-800 disabled:cursor-wait disabled:opacity-60"
            @click="revealEvidence"
          >
            <Eye class="size-4" aria-hidden="true" />{{
              evidenceState === 'loading' ? '正在要求存取…' : '查看檢舉證據'
            }}
          </button>

          <div class="mt-4" aria-live="polite">
            <article
              v-if="evidenceState === 'ready' && evidence"
              class="min-w-0 rounded-lg border border-amber-200 bg-amber-50 p-4"
            >
              <p class="text-sm font-semibold text-amber-900">本檢舉提交時保存的特定訊息</p>
              <dl class="mt-3 grid min-w-0 gap-3 text-sm">
                <div>
                  <dt class="text-amber-800">訊息識別碼</dt>
                  <dd class="mt-1 break-all font-mono">{{ evidence.messageId }}</dd>
                </div>
                <div>
                  <dt class="text-amber-800">傳送時間</dt>
                  <dd class="mt-1">{{ dateTimeLabel(evidence.sentAt) }}</dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-amber-800">訊息內容</dt>
                  <dd class="mt-1 break-words whitespace-pre-wrap" v-text="evidence.content"></dd>
                </div>
              </dl>
            </article>
            <p
              v-else-if="evidenceState === 'forbidden'"
              role="alert"
              class="rounded-lg bg-red-50 p-4 text-sm text-red-800"
            >
              登入狀態已失效，或你目前沒有存取此證據的權限。未顯示任何證據。
            </p>
            <p
              v-else-if="evidenceState === 'audit-unconfirmed'"
              role="alert"
              class="rounded-lg bg-amber-50 p-4 text-sm text-amber-900"
            >
              目前無法安全存取受保護的證據。未顯示任何內容；如需再次嘗試，請重新按下查看按鈕。
            </p>
            <p
              v-else-if="evidenceState === 'unavailable'"
              role="alert"
              class="rounded-lg bg-slate-100 p-4 text-sm text-slate-700"
            >
              此檢舉沒有可用的特定訊息快照。系統不會改為讀取對話內容。
            </p>
            <p
              v-else-if="evidenceState === 'error'"
              role="alert"
              class="rounded-lg bg-red-50 p-4 text-sm text-red-800"
            >
              目前無法存取受保護的證據。未顯示任何內容，也不會自動重試。
            </p>
          </div>
        </section>
      </div>
    </template>
  </section>
</template>

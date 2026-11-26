<script setup lang="ts">
import axios from 'axios'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ArrowLeft, RefreshCw } from '@lucide/vue'
import {
  ADMIN_CASE_CONCLUSIONS,
  adminCaseCommandCoordinator,
  canConfirmAdminCaseEnforcement,
  createAdminCaseOperationId,
  getAdminCase,
  isAdminCaseRequestCurrent,
  isAdminCaseReportId,
  listAdminEnforcementGuidelines,
  type AdminCaseCommand,
  type AdminCaseCommandExecutionResult,
  type AdminCaseConclusion,
  type AdminCaseDetail,
  type CreateAdminCaseEnforcementInput,
  type AdminCaseEnforcementDecisionType,
  type AdminEnforcementGuideline,
} from '@/services/adminCases'
import type {
  AdminReportAccountStatus,
  AdminReportReason,
  AdminReportSourceType,
  ReportIdentityValue,
} from '@/services/adminReports'
import { useUserStore } from '@/stores/user'

const route = useRoute()
const userStore = useUserStore()
const detail = ref<AdminCaseDetail | null>(null)
const detailState = ref<
  'loading' | 'ready' | 'malformed' | 'not-found' | 'unauthenticated' | 'forbidden' | 'error'
>('loading')
const actionState = ref<
  'idle' | 'submitting' | 'refreshing' | 'success' | 'uncertain' | 'blocked' | 'error'
>('idle')
const actionMessage = ref('')
const actionAnnouncement = ref<HTMLElement | null>(null)
const conclusion = ref<AdminCaseConclusion>('violation_confirmed')
const rationale = ref('')
const enforcementReason = ref('')
const enforcementDecisionType = ref<AdminCaseEnforcementDecisionType>('no_action')
const enforcementGuidelines = ref<AdminEnforcementGuideline[]>([])
const enforcementGuidelineState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const selectedGuidelineRuleId = ref('')
const enforcementState = ref<'idle' | 'confirming' | 'submitting' | 'success' | 'error'>('idle')
const enforcementMessage = ref('')
const pendingEnforcementCommand = ref<CreateAdminCaseEnforcementInput | null>(null)
let detailRequestVersion = 0
let mutationRequestVersion = 0
let detailAbortController: AbortController | null = null

const reportId = computed(() =>
  typeof route.params.reportId === 'string' ? route.params.reportId : '',
)
const actorId = computed(() => userStore.currentUser?._id ?? '')
const canReviewCases = computed(() => userStore.currentUser?.capabilities.reviewCases === true)
const canEnforceMembers = computed(
  () => userStore.currentUser?.capabilities.enforceMembers === true,
)
const isEnforcementBusy = computed(
  () => enforcementState.value === 'submitting' || actionState.value === 'submitting',
)
const formalWarningCompatible = computed(
  () => detail.value?.decision?.conclusion === 'violation_confirmed',
)
const selectedGuideline = computed(
  () =>
    enforcementGuidelines.value.find(
      (guideline) => guideline.guidelineRuleId === selectedGuidelineRuleId.value,
    ) ?? null,
)
const returnTarget = computed(() => {
  const from = typeof route.query.from === 'string' ? route.query.from : ''
  return from === '/admin/cases' || from.startsWith('/admin/cases?') ? from : '/admin/cases'
})
const isActionBusy = computed(
  () => actionState.value === 'submitting' || actionState.value === 'refreshing',
)
const isMutationBlocked = computed(
  () => isActionBusy.value || actionState.value === 'uncertain' || actionState.value === 'blocked',
)
const canRetryUncertain = computed(
  () =>
    actionState.value === 'uncertain' &&
    adminCaseCommandCoordinator.inspect(actorId.value, reportId.value).canRetry,
)

async function announce(message: string) {
  actionMessage.value = message
  await nextTick()
  actionAnnouncement.value?.focus({ preventScroll: true })
}

function resetLocalActionState() {
  actionState.value = 'idle'
  actionMessage.value = ''
  conclusion.value = 'violation_confirmed'
  rationale.value = ''
  enforcementReason.value = ''
  enforcementDecisionType.value = 'no_action'
  enforcementGuidelines.value = []
  enforcementGuidelineState.value = 'idle'
  selectedGuidelineRuleId.value = ''
  enforcementState.value = 'idle'
  enforcementMessage.value = ''
  pendingEnforcementCommand.value = null
}

function requestEnforcementConfirmation() {
  if (
    !canEnforceMembers.value ||
    !detail.value?.decision ||
    detail.value.enforcement ||
    isEnforcementBusy.value ||
    isMutationBlocked.value
  )
    return
  const reasonSummary = enforcementReason.value.trim()
  if (reasonSummary.length === 0 || [...reasonSummary].length > 1000) {
    enforcementState.value = 'error'
    enforcementMessage.value = '請輸入 1 至 1000 個字元的處置理由。'
    return
  }
  if (
    !canConfirmAdminCaseEnforcement(
      enforcementDecisionType.value,
      enforcementGuidelineState.value,
      selectedGuideline.value !== null,
    )
  ) {
    enforcementState.value = 'error'
    enforcementMessage.value = '請選擇一條已核准的社群規範。'
    return
  }
  const guideline =
    enforcementDecisionType.value === 'formal_warning' ? selectedGuideline.value : null
  pendingEnforcementCommand.value = {
    reportId: detail.value.report.id,
    operationId: createAdminCaseOperationId('enforcement'),
    reviewDecisionId: detail.value.decision.id,
    decisionType: enforcementDecisionType.value,
    reasonSummary,
    ...(guideline
      ? {
          reasonCode: guideline.reasonCode,
          guidelineRuleId: guideline.guidelineRuleId,
          guidelineVersion: guideline.guidelineVersion,
        }
      : {}),
  }
  enforcementState.value = 'confirming'
  enforcementMessage.value = `請確認：這會建立不可變更的${enforcementDecisionType.value === 'formal_warning' ? '正式警告' : ' No Action'}治理紀錄。`
}

function cancelEnforcementConfirmation() {
  if (isEnforcementBusy.value) return
  pendingEnforcementCommand.value = null
  enforcementState.value = 'idle'
  enforcementMessage.value = ''
}

async function submitPendingEnforcement() {
  const input = pendingEnforcementCommand.value
  if (!input || isEnforcementBusy.value || isMutationBlocked.value) return
  enforcementState.value = 'submitting'
  enforcementMessage.value = '正在記錄處置決定…'
  await submitNewCommand({ action: 'enforcement', actorId: actorId.value, input })
}

function syncCommandScope() {
  if (!actorId.value || !isAdminCaseReportId(reportId.value)) {
    actionState.value = 'blocked'
    actionMessage.value = '目前無法確認案件操作身分，已停用所有變更操作。'
    return
  }
  const scope = adminCaseCommandCoordinator.inspect(actorId.value, reportId.value)
  if (scope.phase === 'idle') {
    if (
      actionState.value === 'submitting' ||
      actionState.value === 'uncertain' ||
      actionState.value === 'blocked'
    ) {
      resetLocalActionState()
    }
    return
  }
  if (scope.phase === 'pending') {
    actionState.value = 'submitting'
    actionMessage.value = '原案件操作仍在等待明確結果；不會建立新的操作識別碼。'
    return
  }
  if (scope.phase === 'uncertain') {
    actionState.value = 'uncertain'
    actionMessage.value = scope.canRetry
      ? '先前案件操作結果尚未確認。僅可使用記憶體中保留的相同操作識別碼與相同命令明確重試。'
      : '先前案件操作結果尚未確認，且目前不能安全重試。新案件操作已停用。'
    return
  }
  actionState.value = 'blocked'
  actionMessage.value =
    scope.phase === 'reload-blocked'
      ? '偵測到重新載入前尚未確認的案件操作，但原始命令已不可可靠還原。新案件操作已停用，必須先完成結果核對或明確安全復原。'
      : '此瀏覽器工作階段有屬於其他案件或管理員的未解決操作。基於身分與資源邊界，本頁不可重播或建立新命令。'
}

async function loadDetail(options: { preserveActionState?: boolean } = {}) {
  const requestedReportId = reportId.value
  const requestedActorId = actorId.value
  const version = ++detailRequestVersion
  detailAbortController?.abort()
  detailAbortController = new AbortController()
  detail.value = null
  enforcementGuidelines.value = []
  enforcementGuidelineState.value = 'idle'
  selectedGuidelineRuleId.value = ''
  if (pendingEnforcementCommand.value?.decisionType === 'formal_warning') {
    pendingEnforcementCommand.value = null
    if (enforcementState.value === 'confirming') {
      enforcementState.value = 'idle'
      enforcementMessage.value = ''
    }
  }
  if (!isAdminCaseReportId(requestedReportId)) {
    detailState.value = 'malformed'
    return
  }
  detailState.value = 'loading'
  try {
    const response = await getAdminCase(requestedReportId, detailAbortController.signal)
    if (
      !isAdminCaseRequestCurrent(
        { version, reportId: requestedReportId, actorId: requestedActorId },
        { version: detailRequestVersion, reportId: reportId.value, actorId: actorId.value },
      )
    )
      return
    detail.value = response
    detailState.value = 'ready'
    if (canEnforceMembers.value && response.decision && !response.enforcement) {
      enforcementGuidelineState.value = 'loading'
      try {
        const guidelines = await listAdminEnforcementGuidelines(detailAbortController.signal)
        if (
          !isAdminCaseRequestCurrent(
            { version, reportId: requestedReportId, actorId: requestedActorId },
            { version: detailRequestVersion, reportId: reportId.value, actorId: actorId.value },
          )
        )
          return
        enforcementGuidelines.value = guidelines
        enforcementGuidelineState.value = 'ready'
      } catch (error) {
        if (axios.isCancel(error)) return
        enforcementGuidelineState.value = 'error'
      }
    }
    if (!options.preserveActionState) syncCommandScope()
  } catch (error) {
    if (
      !isAdminCaseRequestCurrent(
        { version, reportId: requestedReportId, actorId: requestedActorId },
        { version: detailRequestVersion, reportId: reportId.value, actorId: actorId.value },
      ) ||
      axios.isCancel(error)
    )
      return
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    detailState.value =
      status === 400
        ? 'malformed'
        : status === 404
          ? 'not-found'
          : status === 401
            ? 'unauthenticated'
            : status === 403
              ? 'forbidden'
              : 'error'
  }
}

const mutationErrorMessage = (status: number | null, code: string) => {
  if (status === 400) return '送出的案件操作資料無效，未執行操作。'
  if (status === 401) return '登入狀態已失效，未執行案件操作。'
  if (status === 403) return '你目前沒有案件審核權限，未執行操作。'
  if (status === 404) return '找不到此檢舉或案件，請重新整理目前狀態。'
  if (status === 409) {
    if (code === 'CASE_STALE_REVISION') return '案件版本已變更；請重新整理後再建立新操作。'
    if (code === 'CASE_ALREADY_STARTED') return '案件已由審核流程開始；請重新整理目前狀態。'
    if (code === 'CASE_ALREADY_FINALIZED') return '案件已完成審核；請重新整理目前狀態。'
    if (code === 'CASE_OPERATION_ID_REUSED') return '操作識別碼與原命令不一致；已停止送出。'
    return '案件狀態發生衝突；請重新整理後再決定是否建立新操作。'
  }
  if (status === 503) return '案件交易目前不可用。系統不會自動重試。'
  if (status === 500) return '案件資料一致性無法確認，已停止操作。'
  return '案件操作未完成。系統不會自動重試。'
}

const enforcementErrorMessage = (status: number | null, code: string) => {
  if (status === 400) return '處置輸入或規範選擇無效；未建立處置決定。'
  if (status === 401) return '登入狀態已失效；未建立處置決定。'
  if (status === 403) return '你沒有會員處置權限；未建立處置決定。'
  if (status === 404) return '找不到處置所需的 Review Decision；正在重新載入目前狀態。'
  if (status === 409) return '案件狀態已變更或已有處置紀錄；正在重新載入目前狀態。'
  if (status === 422) return '目前的審核結論不允許此處置；正在重新載入目前狀態。'
  if (code === 'CASE_ENFORCEMENT_POLICY_UNAVAILABLE')
    return '核准的處置政策目前不可用；未建立處置決定。'
  if (code === 'CASE_ENFORCEMENT_TRANSACTION_UNAVAILABLE')
    return '處置交易結果尚未確認；系統不會自動重送。'
  if (status === 503) return '處置服務回應無法確認；系統不會自動重送。'
  return '無法確認處置結果；系統不會建立新的操作識別碼或自動重送。'
}

async function handleEnforcementCommandResult(
  result: AdminCaseCommandExecutionResult,
  requestedReportId: string,
  requestedActorId: string,
  version: number,
) {
  if (
    !isAdminCaseRequestCurrent(
      { version, reportId: requestedReportId, actorId: requestedActorId },
      { version: mutationRequestVersion, reportId: reportId.value, actorId: actorId.value },
    )
  )
    return
  if (result.outcome === 'blocked') {
    enforcementState.value = 'error'
    actionState.value = 'blocked'
    enforcementMessage.value =
      result.reason === 'fence-unavailable'
        ? '無法可靠建立操作安全標記，因此沒有送出處置操作。'
        : '已有未解決的操作或安全標記，因此沒有送出新的處置操作。'
    await announce(enforcementMessage.value)
    return
  }
  if (result.outcome === 'confirmed') {
    pendingEnforcementCommand.value = null
    enforcementState.value = 'success'
    enforcementMessage.value =
      result.response.kind === 'replayed'
        ? '原處置操作已安全重播；不會建立第二個操作。'
        : '處置決定已記錄。'
    actionState.value = 'refreshing'
    await announce(`${enforcementMessage.value}正在重新取得目前案件狀態。`)
    await loadDetail({ preserveActionState: true })
    if (!result.fenceCleared) {
      actionState.value = 'blocked'
      await announce('處置結果已確認，但工作階段安全標記無法可靠清除；新操作維持停用。')
      return
    }
    actionState.value = 'success'
    await announce(
      detailState.value === 'ready'
        ? `${enforcementMessage.value}目前案件狀態已重新載入。`
        : `${enforcementMessage.value}但唯讀狀態重新載入失敗。`,
    )
    return
  }
  if (result.outcome === 'uncertain') {
    enforcementState.value = 'error'
    actionState.value = 'uncertain'
    enforcementMessage.value = enforcementErrorMessage(result.error.status, result.error.code)
    await announce(
      result.canRetry
        ? `${enforcementMessage.value}僅可人工重試記憶體中相同操作識別碼與完整命令。`
        : `${enforcementMessage.value}目前不能安全重試。`,
    )
    await loadDetail({ preserveActionState: true })
    return
  }
  pendingEnforcementCommand.value = null
  enforcementState.value = 'error'
  actionState.value = 'error'
  enforcementMessage.value = enforcementErrorMessage(result.error.status, result.error.code)
  await announce(enforcementMessage.value)
  if (!result.fenceCleared) {
    actionState.value = 'blocked'
    await announce('處置操作遭明確拒絕，但安全標記無法可靠清除；新操作維持停用。')
    return
  }
  if (result.error.status === 401 || result.error.status === 403) {
    actionState.value = 'blocked'
    return
  }
  if ([404, 409, 422].includes(result.error.status ?? 0)) {
    await loadDetail({ preserveActionState: true })
  }
}

async function handleCommandResult(
  result: AdminCaseCommandExecutionResult,
  requestedReportId: string,
  requestedActorId: string,
  version: number,
) {
  if (
    !isAdminCaseRequestCurrent(
      { version, reportId: requestedReportId, actorId: requestedActorId },
      { version: mutationRequestVersion, reportId: reportId.value, actorId: actorId.value },
    )
  )
    return
  if (result.outcome === 'blocked') {
    actionState.value = 'blocked'
    await announce(
      result.reason === 'fence-unavailable'
        ? '無法可靠建立操作安全標記，因此沒有送出案件操作。'
        : '已有未解決的案件操作或安全標記；沒有送出新的案件操作。',
    )
    return
  }
  if (result.outcome === 'confirmed') {
    actionState.value = 'refreshing'
    await announce(
      result.response.kind === 'replayed'
        ? '伺服器安全重播了原操作；正在重新取得目前案件狀態。'
        : '伺服器已確認操作；正在重新取得目前案件狀態。',
    )
    await loadDetail({ preserveActionState: true })
    if (
      !isAdminCaseRequestCurrent(
        { version, reportId: requestedReportId, actorId: requestedActorId },
        { version: mutationRequestVersion, reportId: reportId.value, actorId: actorId.value },
      )
    )
      return
    if (!result.fenceCleared) {
      actionState.value = 'blocked'
      await announce('操作結果已確認，但工作階段安全標記無法可靠清除；新操作維持停用。')
      return
    }
    actionState.value = 'success'
    await announce(
      detailState.value === 'ready'
        ? '操作已確認，且目前案件狀態已重新載入。'
        : '操作已確認，但目前案件狀態重新載入失敗；請安全地重新整理唯讀資料。',
    )
    return
  }
  if (result.outcome === 'uncertain') {
    actionState.value = 'uncertain'
    await announce(
      result.canRetry
        ? '提交結果尚未確認。原操作識別碼與完整命令仍只保留在記憶體中；系統不會自動重送。'
        : '提交結果尚未確認，且目前不能安全重試。安全標記將保留，新操作維持停用。',
    )
    await loadDetail({ preserveActionState: true })
    return
  }
  actionState.value = 'error'
  await announce(mutationErrorMessage(result.error.status, result.error.code))
  if (!result.fenceCleared) {
    actionState.value = 'blocked'
    await announce('操作遭明確拒絕，但安全標記無法可靠清除；新操作維持停用。')
    return
  }
  if (result.error.status === 409 || result.error.status === 404) {
    await loadDetail({ preserveActionState: true })
  }
}

async function submitNewCommand(command: AdminCaseCommand) {
  if (isMutationBlocked.value) return
  const requestedReportId = reportId.value
  const requestedActorId = actorId.value
  const version = ++mutationRequestVersion
  actionState.value = 'submitting'
  await announce(
    command.action === 'begin'
      ? '正在送出開始審核操作…'
      : command.action === 'finalize'
        ? '正在送出最終決定…'
        : '正在送出處置決定…',
  )
  const result = await adminCaseCommandCoordinator.executeNew(command)
  if (command.action === 'enforcement') {
    await handleEnforcementCommandResult(result, requestedReportId, requestedActorId, version)
  } else {
    await handleCommandResult(result, requestedReportId, requestedActorId, version)
  }
}

function beginReview() {
  if (
    !canReviewCases.value ||
    !detail.value ||
    detail.value.case.state !== 'needs_review' ||
    isActionBusy.value
  )
    return
  const command: AdminCaseCommand = {
    action: 'begin',
    actorId: actorId.value,
    input: {
      reportId: detail.value.report.id,
      operationId: createAdminCaseOperationId('begin'),
    },
  }
  void submitNewCommand(command)
}

function finalizeReview() {
  if (
    !canReviewCases.value ||
    !detail.value ||
    detail.value.case.state !== 'under_review' ||
    isActionBusy.value
  )
    return
  const trimmedRationale = rationale.value.trim()
  if (trimmedRationale.length === 0 || [...trimmedRationale].length > 1000) {
    actionState.value = 'error'
    void announce('請輸入 1 至 1000 個字元的最終決定理由。')
    return
  }
  const caseId = detail.value.case.id
  if (!caseId) return
  const command: AdminCaseCommand = {
    action: 'finalize',
    actorId: actorId.value,
    input: {
      reportId: detail.value.report.id,
      operationId: createAdminCaseOperationId('finalize'),
      caseId,
      expectedRevision: detail.value.case.revision,
      conclusion: conclusion.value,
      rationale: trimmedRationale,
    },
  }
  void submitNewCommand(command)
}

function retryUnconfirmedCommand() {
  if (!canRetryUncertain.value || isActionBusy.value) return
  const requestedReportId = reportId.value
  const requestedActorId = actorId.value
  const retryAction = adminCaseCommandCoordinator.retainedAction(
    requestedActorId,
    requestedReportId,
  )
  if (!retryAction) {
    actionState.value = 'blocked'
    void announce('無法可靠確認原操作類型，因此未送出重試。')
    return
  }
  const version = ++mutationRequestVersion
  actionState.value = 'submitting'
  void (async () => {
    await announce('正在使用相同操作識別碼與相同命令重試…')
    const result = await adminCaseCommandCoordinator.retry(actorId.value, requestedReportId)
    if (retryAction === 'enforcement') {
      enforcementState.value = 'submitting'
      await handleEnforcementCommandResult(result, requestedReportId, requestedActorId, version)
    } else {
      await handleCommandResult(result, requestedReportId, requestedActorId, version)
    }
  })()
}

async function refreshCurrentState() {
  await loadDetail({ preserveActionState: true })
  syncCommandScope()
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
const conclusionLabel = (value: AdminCaseConclusion) =>
  ({
    violation_confirmed: '確認違規',
    no_violation_found: '未發現違規',
    insufficient_evidence: '證據不足',
  })[value]
const stateLabel = (value: AdminCaseDetail['case']['state']) =>
  ({ needs_review: '待審核', under_review: '審核中', review_completed: '審核完成' })[value]
const dateTimeLabel = (value: string) =>
  new Intl.DateTimeFormat('zh-TW', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Asia/Taipei',
  }).format(new Date(value))

watch(
  [reportId, actorId],
  () => {
    mutationRequestVersion += 1
    resetLocalActionState()
    syncCommandScope()
    void loadDetail({ preserveActionState: true })
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  detailRequestVersion += 1
  mutationRequestVersion += 1
  detailAbortController?.abort()
})
</script>

<template>
  <section aria-labelledby="case-detail-title">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <RouterLink
        :to="returnTarget"
        class="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 font-semibold text-slate-700 hover:bg-slate-200"
        ><ArrowLeft class="size-4" aria-hidden="true" />返回案件列表</RouterLink
      >
      <button
        type="button"
        :disabled="detailState === 'loading'"
        class="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-400 bg-white px-4 font-semibold hover:bg-slate-100 disabled:cursor-wait disabled:opacity-60"
        @click="refreshCurrentState"
      >
        <RefreshCw class="size-4" aria-hidden="true" />重新整理目前狀態
      </button>
    </div>

    <div
      v-if="detailState === 'loading'"
      class="mt-5 rounded-xl border border-slate-200 bg-white p-10 text-center"
      aria-live="polite"
    >
      <p class="font-medium text-slate-700">正在載入案件資料…</p>
    </div>
    <div
      v-else-if="detailState !== 'ready' || !detail"
      role="alert"
      class="mt-5 rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm"
    >
      <h2 id="case-detail-title" class="text-xl font-bold">
        {{
          detailState === 'not-found'
            ? '找不到案件來源檢舉'
            : detailState === 'unauthenticated'
              ? '登入狀態已失效'
              : detailState === 'forbidden'
                ? '沒有案件審核權限'
                : detailState === 'malformed'
                  ? '檢舉識別碼無效'
                  : '案件資料載入失敗'
        }}
      </h2>
      <p class="mt-2 text-sm text-slate-600">
        {{
          detailState === 'error'
            ? '目前無法安全取得案件資料，請稍後再試。'
            : '請返回案件列表，或重新確認登入與案件審核權限。'
        }}
      </p>
      <button
        v-if="detailState === 'error'"
        type="button"
        class="mt-4 min-h-11 rounded-lg bg-slate-950 px-4 font-semibold text-white"
        @click="refreshCurrentState"
      >
        重新載入
      </button>
    </div>

    <template v-else>
      <header class="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <p class="text-sm font-semibold text-amber-700">Case Detail</p>
        <div class="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 id="case-detail-title" class="text-2xl font-bold sm:text-3xl">案件詳情</h2>
            <p class="mt-2 break-all font-mono text-sm text-slate-600">
              Report {{ detail.report.id }}
            </p>
          </div>
          <span class="rounded-full bg-amber-100 px-3 py-1 text-sm font-bold text-amber-950">
            {{ stateLabel(detail.case.state) }}
          </span>
        </div>
      </header>

      <div
        v-if="actionState !== 'idle'"
        ref="actionAnnouncement"
        tabindex="-1"
        :role="actionState === 'error' ? 'alert' : 'status'"
        aria-live="polite"
        class="mt-5 rounded-xl border p-4 focus-visible:outline-2 focus-visible:outline-amber-700"
        :class="
          actionState === 'uncertain' || actionState === 'blocked'
            ? 'border-amber-300 bg-amber-50 text-amber-950'
            : actionState === 'error'
              ? 'border-red-300 bg-red-50 text-red-900'
              : 'border-blue-200 bg-blue-50 text-blue-950'
        "
      >
        <p class="font-semibold">{{ actionMessage }}</p>
        <div v-if="actionState === 'uncertain'" class="mt-3 flex flex-wrap gap-3">
          <button
            v-if="canRetryUncertain"
            type="button"
            class="min-h-11 rounded-lg bg-amber-950 px-4 font-semibold text-white"
            @click="retryUnconfirmedCommand"
          >
            使用相同操作識別碼重試原命令
          </button>
          <button
            type="button"
            class="min-h-11 rounded-lg border border-amber-500 bg-white px-4 font-semibold"
            @click="refreshCurrentState"
          >
            僅重新整理目前狀態
          </button>
          <p class="w-full text-sm">
            唯讀結果只供檢查目前狀態，不會改寫這次未確認操作的來源紀錄。頁面重新載入後若無法可靠保留原命令，系統不會以新操作識別碼盲目重送。
          </p>
        </div>
      </div>

      <div class="mt-5 grid gap-5 xl:grid-cols-2">
        <section class="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <h3 class="text-lg font-bold">案件狀態</h3>
          <dl class="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <dt class="text-sm text-slate-500">狀態</dt>
              <dd class="mt-1 font-semibold">{{ stateLabel(detail.case.state) }}</dd>
            </div>
            <div>
              <dt class="text-sm text-slate-500">版本</dt>
              <dd class="mt-1 font-semibold">{{ detail.case.revision }}</dd>
            </div>
            <div class="min-w-0 sm:col-span-2">
              <dt class="text-sm text-slate-500">案件識別碼</dt>
              <dd class="mt-1 break-all font-mono">
                {{ detail.case.id ?? '尚未建立案件紀錄' }}
              </dd>
            </div>
            <div v-if="detail.case.reviewStartedByUserId" class="min-w-0">
              <dt class="text-sm text-slate-500">開始審核者</dt>
              <dd class="mt-1 break-all font-mono">{{ detail.case.reviewStartedByUserId }}</dd>
            </div>
            <div v-if="detail.case.reviewStartedAt">
              <dt class="text-sm text-slate-500">開始審核時間</dt>
              <dd class="mt-1">{{ dateTimeLabel(detail.case.reviewStartedAt) }}</dd>
            </div>
          </dl>
        </section>

        <section class="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <h3 class="text-lg font-bold">檢舉背景</h3>
          <dl class="mt-4 grid gap-4 sm:grid-cols-2">
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
              <dd class="mt-1">{{ dateTimeLabel(detail.report.submittedAt) }}</dd>
            </div>
            <div v-if="detail.report.description !== undefined" class="min-w-0 sm:col-span-2">
              <dt class="text-sm text-slate-500">說明</dt>
              <dd class="mt-1 break-words whitespace-pre-wrap">
                {{ detail.report.description || '未提供' }}
              </dd>
            </div>
          </dl>
          <RouterLink
            :to="{
              name: 'report-admin-detail',
              params: { reportId: detail.report.id },
              query: { from: route.fullPath },
            }"
            class="mt-5 inline-flex min-h-11 items-center rounded-lg border border-slate-400 px-4 font-semibold hover:bg-slate-100"
            >前往檢舉詳情（證據另行按需存取）</RouterLink
          >
          <p class="mt-2 text-sm text-slate-600">
            案件頁不會自動載入特定訊息證據，也不會讀取完整私人對話。
          </p>
        </section>

        <section class="min-w-0 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <h3 class="text-lg font-bold">相關身分</h3>
          <dl class="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
            <div class="min-w-0">
              <dt class="text-sm text-slate-500">被檢舉會員</dt>
              <dd class="mt-1 break-words font-semibold">
                {{ identityLabel(detail.reportedMember.displayName) }}
              </dd>
              <dd class="break-all text-sm text-slate-500">
                {{ identityLabel(detail.reportedMember.account, '@') }}
              </dd>
              <dd class="mt-1 text-sm">
                {{
                  detail.reportedMember.effectiveAccountStatus.status === 'available'
                    ? accountStatusLabel(detail.reportedMember.effectiveAccountStatus.value)
                    : '帳號狀態目前無法確認'
                }}
              </dd>
            </div>
            <div class="min-w-0">
              <dt class="text-sm text-slate-500">檢舉人</dt>
              <dd class="mt-1 break-words font-semibold">
                {{ identityLabel(detail.reporter.displayName) }}
              </dd>
              <dd class="break-all text-sm text-slate-500">
                {{ identityLabel(detail.reporter.account, '@') }}
              </dd>
            </div>
          </dl>
        </section>

        <section
          v-if="detail.case.state === 'needs_review' && canReviewCases"
          class="min-w-0 rounded-xl border border-amber-200 bg-amber-50 p-5 shadow-sm sm:p-7"
        >
          <h3 class="text-lg font-bold">開始審核</h3>
          <p class="mt-2 text-sm text-slate-700">
            這會建立案件並將狀態由待審核變更為審核中。系統不會自動重試。
          </p>
          <button
            type="button"
            :disabled="isMutationBlocked"
            class="mt-4 min-h-11 rounded-lg bg-slate-950 px-5 font-semibold text-white hover:bg-slate-800 disabled:cursor-wait disabled:opacity-60"
            @click="beginReview"
          >
            {{ isActionBusy ? '正在處理…' : '開始審核' }}
          </button>
        </section>

        <section
          v-else-if="detail.case.state === 'under_review' && canReviewCases"
          class="min-w-0 rounded-xl border border-amber-200 bg-amber-50 p-5 shadow-sm sm:p-7"
        >
          <h3 class="text-lg font-bold">提交最終決定</h3>
          <form class="mt-4 grid gap-4" @submit.prevent="finalizeReview">
            <label class="grid gap-1 text-sm font-semibold">
              結論
              <select
                v-model="conclusion"
                :disabled="isMutationBlocked"
                class="min-h-11 rounded-lg border border-slate-500 bg-white px-3 font-normal"
                required
              >
                <option v-for="value in ADMIN_CASE_CONCLUSIONS" :key="value" :value="value">
                  {{ conclusionLabel(value) }}
                </option>
              </select>
            </label>
            <label class="grid gap-1 text-sm font-semibold">
              理由
              <textarea
                v-model="rationale"
                :disabled="isMutationBlocked"
                rows="6"
                maxlength="1000"
                required
                class="min-h-32 resize-y rounded-lg border border-slate-500 bg-white p-3 font-normal"
                aria-describedby="case-rationale-help"
              ></textarea>
            </label>
            <p id="case-rationale-help" class="text-sm text-slate-600">
              必填，最多 1000 個字元。最終決定提交後不可修改。
            </p>
            <button
              type="submit"
              :disabled="isMutationBlocked"
              class="min-h-11 rounded-lg bg-slate-950 px-5 font-semibold text-white hover:bg-slate-800 disabled:cursor-wait disabled:opacity-60"
            >
              {{ isActionBusy ? '正在處理…' : '提交不可變更的最終決定' }}
            </button>
          </form>
        </section>

        <section
          v-else-if="detail.decision"
          class="min-w-0 rounded-xl border border-emerald-200 bg-emerald-50 p-5 shadow-sm sm:p-7"
        >
          <h3 class="text-lg font-bold">不可變更的最終決定</h3>
          <dl class="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
            <div>
              <dt class="text-sm text-slate-600">結論</dt>
              <dd class="mt-1 font-bold">{{ conclusionLabel(detail.decision.conclusion) }}</dd>
            </div>
            <div>
              <dt class="text-sm text-slate-600">案件版本</dt>
              <dd class="mt-1 font-semibold">{{ detail.decision.caseRevision }}</dd>
            </div>
            <div class="min-w-0">
              <dt class="text-sm text-slate-600">決定者</dt>
              <dd class="mt-1 break-all font-mono">{{ detail.decision.decidedByUserId }}</dd>
            </div>
            <div>
              <dt class="text-sm text-slate-600">決定時間</dt>
              <dd class="mt-1">{{ dateTimeLabel(detail.decision.decidedAt) }}</dd>
            </div>
            <div class="min-w-0 sm:col-span-2">
              <dt class="text-sm text-slate-600">理由</dt>
              <dd class="mt-1 break-words whitespace-pre-wrap">{{ detail.decision.rationale }}</dd>
            </div>
          </dl>
          <p class="mt-4 text-sm font-semibold text-emerald-900">
            最終決定不可重新開啟或編輯；處置決定使用獨立權限與操作。
          </p>

          <div
            v-if="detail.enforcement"
            class="mt-6 rounded-lg border border-emerald-300 bg-white p-4"
          >
            <h4 class="font-bold">已記錄的處置決定</h4>
            <dl class="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <dt class="text-sm text-slate-600">結果</dt>
                <dd class="font-semibold">
                  {{ detail.enforcement.decisionType === 'no_action' ? 'No Action' : '正式警告' }}
                </dd>
              </div>
              <div>
                <dt class="text-sm text-slate-600">記錄時間</dt>
                <dd>{{ dateTimeLabel(detail.enforcement.effectiveAt) }}</dd>
              </div>
              <div class="sm:col-span-2">
                <dt class="text-sm text-slate-600">來源 Review Decision</dt>
                <dd class="break-all font-mono">{{ detail.enforcement.reviewDecisionId }}</dd>
              </div>
              <div class="sm:col-span-2">
                <dt class="text-sm text-slate-600">理由</dt>
                <dd class="whitespace-pre-wrap">{{ detail.enforcement.reasonSummary }}</dd>
              </div>
            </dl>
          </div>

          <div
            v-else-if="canEnforceMembers"
            class="mt-6 rounded-lg border border-slate-300 bg-white p-4"
          >
            <h4 class="font-bold">建立處置決定</h4>
            <fieldset class="mt-3 grid gap-3">
              <legend class="text-sm font-semibold">可用結果</legend>
              <label class="flex items-start gap-3">
                <input
                  v-model="enforcementDecisionType"
                  type="radio"
                  value="no_action"
                  class="mt-1"
                  :disabled="
                    isEnforcementBusy || isMutationBlocked || enforcementState === 'confirming'
                  "
                />
                <span
                  ><strong>No Action</strong><br /><span class="text-sm text-slate-600"
                    >記錄不採取處置的內部理由；不限制會員帳戶。</span
                  ></span
                >
              </label>
              <label v-if="formalWarningCompatible" class="flex items-start gap-3">
                <input
                  v-model="enforcementDecisionType"
                  type="radio"
                  value="formal_warning"
                  class="mt-1"
                  :disabled="
                    isEnforcementBusy ||
                    isMutationBlocked ||
                    enforcementState === 'confirming' ||
                    enforcementGuidelineState !== 'ready'
                  "
                />
                <span
                  ><strong>正式警告</strong><br /><span class="text-sm text-slate-600"
                    >建立會員可見的治理紀錄，但不會暫停或限制帳戶功能。</span
                  ></span
                >
              </label>
            </fieldset>
            <p
              v-if="formalWarningCompatible && enforcementGuidelineState === 'loading'"
              class="mt-3 text-sm text-slate-600"
              role="status"
            >
              正在載入核准的社群規範…
            </p>
            <p
              v-else-if="formalWarningCompatible && enforcementGuidelineState === 'error'"
              class="mt-3 text-sm font-semibold text-red-700"
              role="alert"
            >
              無法取得後端核准的社群規範；正式警告維持停用。
            </p>
            <fieldset v-if="enforcementDecisionType === 'formal_warning'" class="mt-4 grid gap-3">
              <legend class="text-sm font-semibold">適用的社群規範</legend>
              <label
                v-for="guideline in enforcementGuidelines"
                :key="`${guideline.guidelineVersion}:${guideline.guidelineRuleId}`"
                class="flex items-start gap-3 rounded-lg border border-slate-300 p-3"
              >
                <input
                  v-model="selectedGuidelineRuleId"
                  type="radio"
                  :value="guideline.guidelineRuleId"
                  class="mt-1"
                  :disabled="
                    isEnforcementBusy || isMutationBlocked || enforcementState === 'confirming'
                  "
                />
                <span class="min-w-0">
                  <strong>{{ guideline.guidelineRuleId }}・{{ guideline.title }}</strong>
                  <span class="mt-1 block text-sm text-slate-600">{{ guideline.policy }}</span>
                  <span class="mt-1 block text-xs text-slate-500"
                    >版本 {{ guideline.guidelineVersion }}</span
                  >
                </span>
              </label>
            </fieldset>
            <label class="mt-4 grid gap-1 text-sm font-semibold">
              {{
                enforcementDecisionType === 'formal_warning'
                  ? '會員可見的正式警告理由'
                  : 'No Action 內部理由'
              }}
              <textarea
                v-model="enforcementReason"
                rows="4"
                maxlength="1000"
                :disabled="
                  isEnforcementBusy || isMutationBlocked || enforcementState === 'confirming'
                "
                required
                class="min-h-24 resize-y rounded-lg border border-slate-500 p-3 font-normal"
              ></textarea>
            </label>
            <p class="mt-2 text-sm text-slate-600">
              {{
                enforcementDecisionType === 'formal_warning'
                  ? '此理由與規範依據會顯示給受影響會員；請勿填入檢舉者、私人證據、內部審核理由或管理員資訊。'
                  : '此理由不會自動顯示給會員。'
              }}
            </p>
            <button
              v-if="enforcementState !== 'confirming'"
              type="button"
              :disabled="isEnforcementBusy || isMutationBlocked"
              class="mt-4 min-h-11 rounded-lg bg-slate-950 px-5 font-semibold text-white disabled:opacity-60"
              @click="requestEnforcementConfirmation"
            >
              {{ isEnforcementBusy ? '正在處理…' : '檢查並確認處置決定' }}
            </button>
            <div
              v-else
              class="mt-4 min-w-0 rounded-lg border border-amber-300 bg-amber-50 p-4"
              role="group"
              aria-label="確認處置決定"
            >
              <p class="font-semibold">{{ enforcementMessage }}</p>
              <dl v-if="pendingEnforcementCommand" class="mt-3 grid min-w-0 gap-3 text-sm">
                <div>
                  <dt class="font-semibold text-slate-700">處置</dt>
                  <dd class="break-words">
                    {{
                      pendingEnforcementCommand.decisionType === 'formal_warning'
                        ? '正式警告'
                        : 'No Action'
                    }}
                  </dd>
                </div>
                <div v-if="selectedGuideline">
                  <dt class="font-semibold text-slate-700">核准規範</dt>
                  <dd class="break-words">
                    {{ selectedGuideline.guidelineRuleId }}・{{ selectedGuideline.title }}（版本
                    {{ selectedGuideline.guidelineVersion }}；原因代碼
                    {{ selectedGuideline.reasonCode }}）
                  </dd>
                </div>
                <div>
                  <dt class="font-semibold text-slate-700">處置理由</dt>
                  <dd class="break-words whitespace-pre-wrap">
                    {{ pendingEnforcementCommand.reasonSummary }}
                  </dd>
                </div>
              </dl>
              <div class="mt-3 flex flex-wrap gap-3">
                <button
                  type="button"
                  :disabled="isEnforcementBusy || isMutationBlocked"
                  class="min-h-11 rounded-lg bg-slate-950 px-4 font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-60"
                  @click="submitPendingEnforcement"
                >
                  確認建立處置決定
                </button>
                <button
                  type="button"
                  :disabled="isEnforcementBusy"
                  class="min-h-11 rounded-lg border border-slate-400 px-4 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-60"
                  @click="cancelEnforcementConfirmation"
                >
                  返回修改
                </button>
              </div>
            </div>
            <p
              v-if="enforcementState === 'error' || enforcementState === 'success'"
              class="mt-3 text-sm font-semibold"
              :role="enforcementState === 'error' ? 'alert' : 'status'"
              aria-live="polite"
            >
              {{ enforcementMessage }}
            </p>
          </div>
          <p v-else class="mt-5 text-sm text-slate-700">
            你可以檢視最終決定，但沒有建立會員處置決定的權限。
          </p>
        </section>

        <section
          v-else
          class="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-5 shadow-sm sm:p-7"
        >
          <h3 class="text-lg font-bold">僅供檢視</h3>
          <p class="mt-2 text-sm text-slate-700">
            目前管理員可以查看案件，但沒有開始或完成案件審核的權限。
          </p>
        </section>
      </div>
    </template>
  </section>
</template>

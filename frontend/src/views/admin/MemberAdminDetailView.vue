<script setup lang="ts">
import axios from 'axios'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ArrowLeft, RotateCcw } from '@lucide/vue'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import {
  getAdminMember,
  isAdminMemberId,
  type AdminMemberDetail,
  type AdminMemberRole,
  type AdminMemberStatus,
} from '@/services/adminMembers'
import {
  adminReversalCommandCoordinator,
  createAdminReversalOperationId,
  getAdminEnforcementDecisions,
  isAdminEnforcementTargetId,
  type AdminEnforcementDecision,
  type AdminEnforcementReadResponse,
  type AdminReversalCommand,
} from '@/services/adminEnforcement'
import { useUserStore } from '@/stores/user'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const member = ref<AdminMemberDetail | null>(null)
const enforcement = ref<AdminEnforcementReadResponse | null>(null)
const state = ref<
  'landing' | 'loading' | 'ready' | 'malformed' | 'not-found' | 'forbidden' | 'error'
>('loading')
const targetEntry = ref('')
const selectedDecision = ref<AdminEnforcementDecision | null>(null)
const internalReason = ref('')
const publicReasonCode = ref('')
const rereviewConfirmed = ref(false)
const commandState = ref<'idle' | 'confirming' | 'submitting' | 'success' | 'uncertain' | 'error'>(
  'idle',
)
const commandMessage = ref('')
const pendingCommand = ref<AdminReversalCommand | null>(null)
const commandStatus = ref<HTMLElement | null>(null)
const dialogInvoker = ref<HTMLElement | null>(null)
const dialogFallback = ref<HTMLElement | null>(null)
const internalReasonInput = ref<HTMLTextAreaElement | null>(null)
let requestVersion = 0
let controller: AbortController | null = null
let restoreDialogInvokerOnClose = false

const enforcementOnly = computed(() => route.path.startsWith('/admin/enforcement'))
const memberId = computed(() =>
  typeof route.params.memberId === 'string' ? route.params.memberId : '',
)
const actorId = computed(() => userStore.currentUser?._id ?? '')
const canEnforce = computed(() => userStore.currentUser?.capabilities.enforceMembers === true)
const confirmationOpen = computed(
  () => commandState.value === 'confirming' && selectedDecision.value !== null,
)
const returnTarget = computed(() => {
  const from = typeof route.query.from === 'string' ? route.query.from : ''
  return from === '/admin/members' || from.startsWith('/admin/members?') ? from : '/admin/members'
})
const identity = computed(
  () =>
    enforcement.value?.member ??
    (member.value
      ? {
          id: member.value.id,
          displayName: member.value.displayName,
          account: member.value.account,
        }
      : null),
)

const statusLabel = (status: AdminMemberStatus) =>
  ({ active: '啟用中', suspended: '暫停中', deactivated: '已停用' })[status]
const statusClass = (status: AdminMemberStatus) =>
  ({
    active: 'bg-emerald-100 text-emerald-800',
    suspended: 'bg-amber-100 text-amber-900',
    deactivated: 'bg-rose-100 text-rose-800',
  })[status]
const roleLabel = (role: AdminMemberRole) => ({ user: '會員', admin: '管理員' })[role]
const dateLabel = (value: string) =>
  new Intl.DateTimeFormat('zh-TW', { dateStyle: 'long', timeStyle: 'short' }).format(
    new Date(value),
  )
const initials = (value: { displayName: string; account: string }) =>
  (value.displayName || value.account).trim().charAt(0).toUpperCase()
const decisionLabel = (value: AdminEnforcementDecision) =>
  value.decisionType === 'formal_warning' ? '正式警告' : '暫時停權'

function resetCommand() {
  selectedDecision.value = null
  internalReason.value = ''
  publicReasonCode.value = ''
  rereviewConfirmed.value = false
  pendingCommand.value = null
  commandState.value = 'idle'
  commandMessage.value = ''
}

async function loadEnforcement(targetId: string, version: number) {
  enforcement.value = await getAdminEnforcementDecisions(targetId, controller?.signal)
  if (version !== requestVersion) return
  const retained = adminReversalCommandCoordinator.inspect(actorId.value)
  if (retained.blockedByOtherActor) {
    commandState.value = 'error'
    commandMessage.value = '此瀏覽器工作階段存在其他管理員的未解決操作，已停用撤銷。'
  } else if (retained.command) {
    pendingCommand.value = retained.command
    commandState.value = 'uncertain'
    commandMessage.value = '先前撤銷結果尚未確認；只可使用保留的相同操作識別碼與內容重試。'
  }
}

async function loadPage() {
  const version = ++requestVersion
  controller?.abort()
  controller = new AbortController()
  member.value = null
  enforcement.value = null
  resetCommand()
  if (enforcementOnly.value && !memberId.value) {
    state.value = 'landing'
    return
  }
  if (!isAdminMemberId(memberId.value)) {
    state.value = 'malformed'
    return
  }
  state.value = 'loading'
  try {
    if (enforcementOnly.value) {
      // Data-isolation boundary: never call the general Member Admin API here.
      await loadEnforcement(memberId.value, version)
    } else {
      member.value = await getAdminMember(memberId.value)
      if (version !== requestVersion) return
      if (canEnforce.value) await loadEnforcement(memberId.value, version)
    }
    if (version === requestVersion) state.value = 'ready'
  } catch (error) {
    if (version !== requestVersion || axios.isCancel(error)) return
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    state.value =
      status === 400
        ? 'malformed'
        : status === 404
          ? 'not-found'
          : status === 401 || status === 403
            ? 'forbidden'
            : 'error'
  }
}

async function openTarget() {
  const value = targetEntry.value.trim()
  if (!isAdminEnforcementTargetId(value)) {
    state.value = 'malformed'
    return
  }
  await router.push({ name: 'member-enforcement-detail', params: { memberId: value } })
}

function requestConfirmation(decision: AdminEnforcementDecision, event: MouseEvent) {
  if (!canEnforce.value || decision.state !== 'reversible') return
  dialogInvoker.value = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  restoreDialogInvokerOnClose = false
  selectedDecision.value = decision
  internalReason.value = ''
  publicReasonCode.value = ''
  rereviewConfirmed.value = false
  commandState.value = 'confirming'
  commandMessage.value = ''
}

function handleConfirmationOpenChange(open: boolean) {
  if (open || commandState.value !== 'confirming') return
  restoreDialogInvokerOnClose = true
  resetCommand()
}

function cancelConfirmation() {
  restoreDialogInvokerOnClose = true
  resetCommand()
}

function handleConfirmationOpenAutoFocus(event: Event) {
  event.preventDefault()
  internalReasonInput.value?.focus({ preventScroll: true })
}

function handleConfirmationCloseAutoFocus(event: Event) {
  event.preventDefault()
  const invoker = dialogInvoker.value
  const restoreInvoker = restoreDialogInvokerOnClose
  dialogInvoker.value = null
  restoreDialogInvokerOnClose = false
  void nextTick(() => {
    if (!restoreInvoker) {
      commandStatus.value?.focus({ preventScroll: true })
      return
    }
    if (invoker?.isConnected) return invoker.focus({ preventScroll: true })
    dialogFallback.value?.focus({ preventScroll: true })
  })
}

function preventConfirmationOutsideInteraction(event: Event) {
  event.preventDefault()
}

function prepareCommand() {
  const decision = selectedDecision.value
  const reasonSummary = internalReason.value.trim()
  if (!decision || reasonSummary.length < 1 || [...reasonSummary].length > 1000) {
    commandMessage.value = '請輸入 1 至 1000 個字元的內部撤銷理由。'
    return
  }
  if (
    decision.decisionType === 'formal_warning' &&
    (!rereviewConfirmed.value || !publicReasonCode.value)
  ) {
    commandMessage.value = '正式警告只能在完成重新審查並選擇核准公開理由後撤銷。'
    return
  }
  pendingCommand.value = {
    actorId: actorId.value,
    decisionId: decision.id,
    operationId: createAdminReversalOperationId(),
    reasonSummary,
    ...(decision.decisionType === 'formal_warning'
      ? { memberFacingReasonCode: publicReasonCode.value }
      : {}),
  }
  commandMessage.value = '請最後確認：原決定會保留，系統只會附加一筆不可變更的撤銷紀錄。'
}

async function announce(message: string) {
  commandMessage.value = message
  await nextTick()
  commandStatus.value?.focus({ preventScroll: true })
}

async function executePending(retry = false) {
  const command = pendingCommand.value
  if (!command || commandState.value === 'submitting') return
  commandState.value = 'submitting'
  await announce('正在提交撤銷命令…')
  const result = retry
    ? await adminReversalCommandCoordinator.retry(actorId.value)
    : await adminReversalCommandCoordinator.executeNew(command)
  if (result.kind === 'success') {
    const message =
      result.response.kind === 'replayed' ? '撤銷已確認（安全重播）。' : '撤銷已完成。'
    await loadPage()
    commandState.value = 'success'
    await announce(message)
    return
  }
  if (result.kind === 'uncertain') {
    commandState.value = 'uncertain'
    await announce('交易結果尚未確認；請只使用下方按鈕以相同操作識別碼重試。')
    return
  }
  commandState.value = 'error'
  await announce(
    result.error.status === 403
      ? '目前沒有執行會員撤銷的權限。'
      : '撤銷未完成；請重新載入最新狀態後再試。',
  )
}

watch([memberId, enforcementOnly], loadPage, { immediate: true })
onBeforeUnmount(() => {
  requestVersion += 1
  controller?.abort()
})
</script>

<template>
  <section class="text-slate-950" aria-labelledby="member-detail-title">
    <RouterLink
      v-if="!enforcementOnly"
      :to="returnTarget"
      class="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 font-semibold text-slate-700 hover:bg-slate-200"
    >
      <ArrowLeft class="size-4" aria-hidden="true" />返回會員列表
    </RouterLink>

    <div
      v-if="state === 'landing'"
      class="mx-auto max-w-xl rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7"
    >
      <p class="text-sm font-semibold text-amber-700">Member Enforcement</p>
      <h2 id="member-detail-title" class="mt-1 text-2xl font-bold">會員撤銷</h2>
      <p class="mt-3 text-slate-600">
        請輸入經既有核准工作流程取得的會員識別碼。本頁不提供會員目錄或一般會員資料查詢。
      </p>
      <form class="mt-6" @submit.prevent="openTarget">
        <label for="enforcement-target-id" class="font-semibold">目標會員識別碼</label>
        <input
          id="enforcement-target-id"
          v-model="targetEntry"
          autocomplete="off"
          class="mt-2 min-h-11 w-full rounded-lg border border-slate-400 px-3 font-mono"
          placeholder="24 位 ObjectId"
        />
        <button
          class="mt-4 min-h-11 rounded-lg bg-slate-950 px-5 font-semibold text-white"
          type="submit"
        >
          讀取處置決定
        </button>
      </form>
    </div>

    <div v-else-if="state === 'loading'" class="mt-5 rounded-xl border bg-white p-10 text-center">
      <p class="font-medium text-slate-700" role="status">正在載入授權範圍內的資料…</p>
    </div>

    <div
      v-else-if="state !== 'ready' || !identity"
      role="alert"
      class="mt-5 rounded-xl border bg-white p-8 text-center shadow-sm"
    >
      <h2 id="member-detail-title" class="text-xl font-bold">
        {{
          state === 'not-found'
            ? '找不到目標會員'
            : state === 'forbidden'
              ? '無法存取會員撤銷'
              : state === 'malformed'
                ? '會員識別碼無效'
                : '資料載入失敗'
        }}
      </h2>
      <p class="mt-2 text-sm text-slate-600">
        {{
          state === 'forbidden' ? '權限可能已被撤銷，後端已拒絕本次請求。' : '請確認資料後再試。'
        }}
      </p>
      <RouterLink
        v-if="enforcementOnly"
        to="/admin/enforcement"
        class="mt-4 inline-flex min-h-11 items-center rounded-lg bg-slate-950 px-4 font-semibold text-white"
      >
        返回會員撤銷
      </RouterLink>
      <button
        v-else-if="state === 'error'"
        type="button"
        class="mt-4 min-h-11 rounded-lg bg-slate-950 px-4 font-semibold text-white"
        @click="loadPage"
      >
        重新載入
      </button>
    </div>

    <template v-else>
      <div class="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div class="border-b border-slate-200 bg-slate-100 p-5 sm:p-7">
          <div class="flex items-center gap-4">
            <img
              v-if="!enforcementOnly && member?.avatar"
              :src="member.avatar"
              alt=""
              class="size-16 rounded-full object-cover sm:size-20"
            />
            <span
              v-else
              class="flex size-16 shrink-0 items-center justify-center rounded-full bg-amber-100 text-2xl font-bold text-amber-900 sm:size-20"
              aria-hidden="true"
              >{{ initials(identity) }}</span
            >
            <div class="min-w-0">
              <p class="text-sm font-semibold text-amber-700">
                {{ enforcementOnly ? 'Member Enforcement' : 'Member Detail' }}
              </p>
              <h2 id="member-detail-title" class="break-words text-2xl font-bold sm:text-3xl">
                {{ identity.displayName }}
              </h2>
              <p class="truncate text-slate-600">@{{ identity.account }}</p>
              <p class="mt-1 break-all font-mono text-xs text-slate-500">{{ identity.id }}</p>
            </div>
          </div>
        </div>

        <dl v-if="!enforcementOnly && member" class="grid gap-6 p-5 sm:grid-cols-2 sm:p-7">
          <div>
            <dt class="text-sm text-slate-500">角色</dt>
            <dd class="font-semibold">{{ roleLabel(member.role) }}</dd>
          </div>
          <div>
            <dt class="text-sm text-slate-500">有效帳號狀態</dt>
            <dd>
              <span
                :class="[
                  'inline-flex rounded-full px-2.5 py-1 font-semibold',
                  statusClass(member.accountStatus),
                ]"
              >
                {{ statusLabel(member.accountStatus) }}
              </span>
            </dd>
          </div>
          <div>
            <dt class="text-sm text-slate-500">註冊日期</dt>
            <dd>{{ dateLabel(member.registrationDate) }}</dd>
          </div>
          <div class="sm:col-span-2">
            <dt class="text-sm text-slate-500">自我介紹</dt>
            <dd class="whitespace-pre-wrap">{{ member.bio || '尚未填寫' }}</dd>
          </div>
        </dl>
      </div>

      <section v-if="enforcement" class="mt-6" aria-labelledby="enforcement-title">
        <div class="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p class="text-sm font-semibold text-amber-700">Append-only governance</p>
            <h3
              id="enforcement-title"
              ref="dialogFallback"
              tabindex="-1"
              class="text-2xl font-bold focus-visible:outline-2 focus-visible:outline-amber-700"
            >
              處置決定
            </h3>
          </div>
          <RouterLink
            v-if="enforcementOnly"
            to="/admin/enforcement"
            class="min-h-11 rounded-lg px-3 py-2 font-semibold text-slate-700"
          >
            更換目標
          </RouterLink>
        </div>
        <p
          v-if="enforcement.decisions.length === 0"
          class="mt-4 rounded-xl border bg-white p-5 text-slate-600"
        >
          沒有可供此 MVP 顯示的正式警告或暫時停權決定。
        </p>
        <ol v-else class="mt-4 grid gap-4">
          <li
            v-for="decision in enforcement.decisions"
            :key="decision.id"
            class="rounded-xl border bg-white p-5 shadow-sm"
          >
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                <h4 class="font-bold">{{ decisionLabel(decision) }}</h4>
                <p class="mt-1 text-sm text-slate-600">
                  記錄時間：{{ dateLabel(decision.effectiveAt) }}
                </p>
                <p v-if="decision.endsAt" class="text-sm text-slate-600">
                  原結束時間：{{ dateLabel(decision.endsAt) }}
                </p>
                <p class="mt-3 whitespace-pre-wrap break-words">{{ decision.reasonSummary }}</p>
              </div>
              <span class="rounded-full bg-slate-100 px-2.5 py-1 text-sm font-semibold">
                {{
                  decision.state === 'reversed'
                    ? '已撤銷'
                    : decision.expired
                      ? '已到期・可歷史修正'
                      : '可撤銷'
                }}
              </span>
            </div>
            <p v-if="decision.reversal" class="mt-3 text-sm text-emerald-800">
              撤銷時間：{{ dateLabel(decision.reversal.effectiveAt) }}
            </p>
            <button
              v-else
              type="button"
              class="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg bg-slate-950 px-4 font-semibold text-white disabled:opacity-50"
              :disabled="
                !canEnforce || commandState === 'uncertain' || commandState === 'submitting'
              "
              @click="requestConfirmation(decision, $event)"
            >
              <RotateCcw class="size-4" aria-hidden="true" />撤銷此決定
            </button>
          </li>
        </ol>
      </section>

      <Dialog :open="confirmationOpen" :modal="true" @update:open="handleConfirmationOpenChange">
        <DialogContent
          v-if="selectedDecision"
          :show-close-button="false"
          class="max-h-[calc(100vh-2rem)] overflow-y-auto border-2 border-amber-500 bg-amber-50 sm:max-w-2xl"
          @open-auto-focus="handleConfirmationOpenAutoFocus"
          @close-auto-focus="handleConfirmationCloseAutoFocus"
          @pointer-down-outside="preventConfirmationOutsideInteraction"
          @interact-outside="preventConfirmationOutsideInteraction"
        >
          <DialogTitle class="text-xl font-bold">
            確認撤銷 {{ decisionLabel(selectedDecision) }}
          </DialogTitle>
          <DialogDescription class="text-slate-700">
            請完成內部理由與必要的重新審查確認。原決定會保留，系統只會附加撤銷紀錄。
          </DialogDescription>
          <label for="reversal-internal-reason" class="mt-5 block font-semibold"
            >內部撤銷理由</label
          >
          <textarea
            id="reversal-internal-reason"
            ref="internalReasonInput"
            v-model="internalReason"
            rows="4"
            maxlength="1000"
            class="mt-2 w-full rounded-lg border border-slate-400 p-3"
          />

          <template v-if="selectedDecision.decisionType === 'formal_warning'">
            <label for="public-reason" class="mt-5 block font-semibold">會員可見理由</label>
            <select
              id="public-reason"
              v-model="publicReasonCode"
              class="mt-2 min-h-11 w-full rounded-lg border border-slate-400 px-3"
            >
              <option value="">請選擇已核准理由</option>
              <option
                v-for="option in enforcement?.memberFacingReasonOptions"
                :key="option.code"
                :value="option.code"
              >
                {{ option.summary }}
              </option>
            </select>
            <label
              class="mt-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-white p-4"
            >
              <input v-model="rereviewConfirmed" type="checkbox" class="mt-1 size-5 shrink-0" />
              <span>我確認已實際完成重新審查，因此上述「經重新審查」公開文字為真實陳述。</span>
            </label>
          </template>

          <p v-if="commandMessage" class="mt-4 font-medium text-rose-800" role="alert">
            {{ commandMessage }}
          </p>
          <div class="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              class="min-h-11 rounded-lg bg-slate-950 px-5 font-semibold text-white"
              @click="pendingCommand ? executePending() : prepareCommand()"
            >
              {{ pendingCommand ? '確認並提交' : '檢查撤銷內容' }}
            </button>
            <button
              type="button"
              class="min-h-11 rounded-lg border border-slate-400 bg-white px-5 font-semibold"
              @click="cancelConfirmation"
            >
              取消
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <div
        v-if="['submitting', 'success', 'uncertain', 'error'].includes(commandState)"
        ref="commandStatus"
        tabindex="-1"
        :role="commandState === 'error' ? 'alert' : 'status'"
        class="mt-6 rounded-xl border bg-white p-5 focus-visible:outline-2 focus-visible:outline-amber-700"
      >
        <p class="whitespace-pre-wrap break-words font-semibold">{{ commandMessage }}</p>
        <button
          v-if="commandState === 'uncertain'"
          type="button"
          class="mt-4 min-h-11 rounded-lg bg-slate-950 px-5 font-semibold text-white"
          @click="executePending(true)"
        >
          使用相同 operationId 重試
        </button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import axios from 'axios'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ArrowLeft } from '@lucide/vue'
import {
  getAdminMember,
  isAdminMemberId,
  type AdminMemberDetail,
  type AdminMemberRole,
  type AdminMemberStatus,
} from '@/services/adminMembers'

const route = useRoute()
const member = ref<AdminMemberDetail | null>(null)
const state = ref<'loading' | 'ready' | 'malformed' | 'not-found' | 'forbidden' | 'error'>(
  'loading',
)
let requestVersion = 0

const memberId = computed(() =>
  typeof route.params.memberId === 'string' ? route.params.memberId : '',
)
const returnTarget = computed(() => {
  const from = typeof route.query.from === 'string' ? route.query.from : ''
  return from === '/admin/members' || from.startsWith('/admin/members?') ? from : '/admin/members'
})

async function loadMember() {
  const version = ++requestVersion
  member.value = null
  if (!isAdminMemberId(memberId.value)) {
    state.value = 'malformed'
    return
  }
  state.value = 'loading'
  try {
    const response = await getAdminMember(memberId.value)
    if (version !== requestVersion) return
    member.value = response
    state.value = 'ready'
  } catch (error) {
    if (version !== requestVersion) return
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
  new Intl.DateTimeFormat('zh-TW', { dateStyle: 'long', timeZone: 'Asia/Taipei' }).format(
    new Date(value),
  )
const initials = (value: AdminMemberDetail) =>
  (value.displayName || value.account).trim().charAt(0).toUpperCase()

watch(memberId, loadMember, { immediate: true })
onBeforeUnmount(() => {
  requestVersion += 1
})
</script>

<template>
  <section class="page-shell py-8 sm:py-12" aria-labelledby="member-detail-title">
    <RouterLink
      :to="returnTarget"
      class="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 font-semibold text-slate-700 hover:bg-slate-200"
      ><ArrowLeft class="size-4" aria-hidden="true" />返回會員列表</RouterLink
    >

    <div
      v-if="state === 'loading'"
      class="mt-5 rounded-xl border border-slate-200 bg-white p-10 text-center"
    >
      <p class="font-medium text-slate-700">正在載入會員資料…</p>
    </div>
    <div
      v-else-if="state !== 'ready' || !member"
      role="alert"
      class="mt-5 rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm"
    >
      <h2 id="member-detail-title" class="text-xl font-bold">
        {{
          state === 'not-found'
            ? '找不到會員'
            : state === 'forbidden'
              ? '無法檢視會員'
              : state === 'malformed'
                ? '會員識別碼無效'
                : '資料載入失敗'
        }}
      </h2>
      <p class="mt-2 text-sm text-slate-600">
        {{
          state === 'not-found'
            ? '此會員不存在或已無法取得。'
            : state === 'forbidden'
              ? '登入狀態已失效，或你目前沒有檢視會員的權限。'
              : state === 'malformed'
                ? '請從會員列表重新選擇會員。'
                : '目前無法載入會員資料，請稍後再試。'
        }}
      </p>
      <button
        v-if="state === 'error'"
        type="button"
        class="mt-4 min-h-11 rounded-lg bg-slate-950 px-4 font-semibold text-white"
        @click="loadMember"
      >
        重新載入
      </button>
    </div>

    <template v-else>
      <div class="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div class="border-b border-slate-200 bg-slate-100 p-5 sm:p-7">
          <div class="flex items-center gap-4">
            <img
              v-if="member.avatar"
              :src="member.avatar"
              alt=""
              class="size-16 rounded-full bg-slate-200 object-cover sm:size-20"
            />
            <span
              v-else
              class="flex size-16 items-center justify-center rounded-full bg-amber-100 text-2xl font-bold text-amber-900 sm:size-20"
              aria-hidden="true"
              >{{ initials(member) }}</span
            >
            <div class="min-w-0">
              <p class="text-sm font-semibold text-amber-700">Member Detail</p>
              <h2 id="member-detail-title" class="break-words text-2xl font-bold sm:text-3xl">
                {{ member.displayName }}
              </h2>
              <p class="truncate text-slate-600">@{{ member.account }}</p>
            </div>
          </div>
        </div>

        <dl class="grid gap-x-8 gap-y-6 p-5 sm:grid-cols-2 sm:p-7">
          <div>
            <dt class="text-sm font-medium text-slate-500">會員識別碼</dt>
            <dd class="mt-1 break-all font-mono text-sm">{{ member.id }}</dd>
          </div>
          <div>
            <dt class="text-sm font-medium text-slate-500">角色</dt>
            <dd class="mt-1 font-semibold">{{ roleLabel(member.role) }}</dd>
          </div>
          <div>
            <dt class="text-sm font-medium text-slate-500">有效帳號狀態</dt>
            <dd class="mt-1">
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
            <dt class="text-sm font-medium text-slate-500">註冊日期</dt>
            <dd class="mt-1 font-semibold">{{ dateLabel(member.registrationDate) }}</dd>
          </div>
          <div>
            <dt class="text-sm font-medium text-slate-500">最近登入</dt>
            <dd class="mt-1 font-semibold">無可用資料</dd>
          </div>
          <div class="sm:col-span-2">
            <dt class="text-sm font-medium text-slate-500">自我介紹</dt>
            <dd class="mt-1 whitespace-pre-wrap text-slate-800">{{ member.bio || '尚未填寫' }}</dd>
          </div>
        </dl>
      </div>
      <p class="mt-4 text-sm text-slate-500">此頁面僅提供唯讀資訊，不包含會員帳號操作。</p>
    </template>
  </section>
</template>

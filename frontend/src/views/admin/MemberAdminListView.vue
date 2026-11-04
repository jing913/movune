<script setup lang="ts">
import axios from 'axios'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ChevronLeft, ChevronRight, Search, Users } from '@lucide/vue'
import {
  ADMIN_MEMBER_ROLES,
  ADMIN_MEMBER_STATUSES,
  listAdminMembers,
  type AdminMemberListItem,
  type AdminMemberListQuery,
  type AdminMemberRole,
  type AdminMemberStatus,
} from '@/services/adminMembers'

const route = useRoute()
const router = useRouter()
const members = ref<AdminMemberListItem[]>([])
const pagination = ref({ page: 1, limit: 20, total: 0, totalPages: 0 })
const isLoading = ref(false)
const errorMessage = ref('')
let requestVersion = 0

const firstQueryValue = (value: unknown) => (typeof value === 'string' ? value : '')
const positiveInteger = (value: unknown, fallback: number, maximum: number) => {
  const parsed = Number(firstQueryValue(value))
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback
}

const filters = reactive({ search: '', status: '', role: '', registeredFrom: '', registeredTo: '' })

function readRouteQuery(): AdminMemberListQuery {
  const status = firstQueryValue(route.query.status)
  const role = firstQueryValue(route.query.role)
  const query: AdminMemberListQuery = {
    page: positiveInteger(route.query.page, 1, 10_000),
    limit: positiveInteger(route.query.limit, 20, 30),
  }
  const search = firstQueryValue(route.query.search).trim().slice(0, 50)
  const registeredFrom = firstQueryValue(route.query.registeredFrom)
  const registeredTo = firstQueryValue(route.query.registeredTo)
  if (search) query.search = search
  if (ADMIN_MEMBER_STATUSES.includes(status as AdminMemberStatus)) {
    query.status = status as AdminMemberStatus
  }
  if (ADMIN_MEMBER_ROLES.includes(role as AdminMemberRole)) query.role = role as AdminMemberRole
  if (/^\d{4}-\d{2}-\d{2}$/.test(registeredFrom)) query.registeredFrom = registeredFrom
  if (/^\d{4}-\d{2}-\d{2}$/.test(registeredTo)) query.registeredTo = registeredTo
  return query
}

function syncFiltersFromRoute(query: AdminMemberListQuery) {
  filters.search = query.search ?? ''
  filters.status = query.status ?? ''
  filters.role = query.role ?? ''
  filters.registeredFrom = query.registeredFrom ?? ''
  filters.registeredTo = query.registeredTo ?? ''
}

function queryForRoute(page = 1) {
  return {
    ...(filters.search.trim() ? { search: filters.search.trim().slice(0, 50) } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.role ? { role: filters.role } : {}),
    ...(filters.registeredFrom ? { registeredFrom: filters.registeredFrom } : {}),
    ...(filters.registeredTo ? { registeredTo: filters.registeredTo } : {}),
    ...(page > 1 ? { page: String(page) } : {}),
    ...(pagination.value.limit !== 20 ? { limit: String(pagination.value.limit) } : {}),
  }
}

async function loadMembers() {
  const version = ++requestVersion
  const query = readRouteQuery()
  syncFiltersFromRoute(query)
  isLoading.value = true
  errorMessage.value = ''
  try {
    const response = await listAdminMembers(query)
    if (version !== requestVersion) return
    members.value = response.members
    pagination.value = response.pagination
  } catch (error) {
    if (version !== requestVersion) return
    members.value = []
    pagination.value = { page: query.page ?? 1, limit: query.limit ?? 20, total: 0, totalPages: 0 }
    const status = axios.isAxiosError(error) ? error.response?.status : undefined
    errorMessage.value =
      status === 401
        ? '登入狀態已失效，請重新登入。'
        : status === 403
          ? '你目前沒有檢視會員的權限。'
          : status === 400
            ? '查詢條件無效，請調整後再試。'
            : '目前無法載入會員資料，請稍後再試。'
  } finally {
    if (version === requestVersion) isLoading.value = false
  }
}

function submitFilters() {
  void router.push({ name: 'member-admin-list', query: queryForRoute() })
}

function resetFilters() {
  filters.search = ''
  filters.status = ''
  filters.role = ''
  filters.registeredFrom = ''
  filters.registeredTo = ''
  void router.push({ name: 'member-admin-list' })
}

function goToPage(page: number) {
  if (page < 1 || page > pagination.value.totalPages || page === pagination.value.page) return
  void router.push({ name: 'member-admin-list', query: queryForRoute(page) })
}

const detailQuery = computed(() => ({ from: route.fullPath }))
const resultSummary = computed(() => {
  if (!pagination.value.total) return '找不到符合條件的會員'
  const start = (pagination.value.page - 1) * pagination.value.limit + 1
  const end = Math.min(pagination.value.page * pagination.value.limit, pagination.value.total)
  return `顯示第 ${start}–${end} 筆，共 ${pagination.value.total} 筆`
})

const statusLabel = (status: AdminMemberStatus) =>
  ({ active: '啟用中', suspended: '暫停中', deactivated: '已停用' })[status]
const statusClass = (status: AdminMemberStatus) =>
  ({
    active: 'bg-emerald-100 text-emerald-800',
    suspended: 'bg-amber-100 text-amber-900',
    deactivated: 'bg-rose-100 text-rose-800',
  })[status]
const dateLabel = (value: string) =>
  new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeZone: 'Asia/Taipei' }).format(
    new Date(value),
  )
const initials = (member: AdminMemberListItem) =>
  (member.displayName || member.account).trim().charAt(0).toUpperCase()

watch(() => route.fullPath, loadMembers, { immediate: true })
onBeforeUnmount(() => {
  requestVersion += 1
})
</script>

<template>
  <section class="page-shell py-8 sm:py-12" aria-labelledby="member-list-title">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p class="text-sm font-semibold text-amber-700">Member Management</p>
        <h2 id="member-list-title" class="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
          會員管理
        </h2>
        <p class="mt-2 text-sm text-slate-600">唯讀檢視會員基本資料與目前有效帳號狀態。</p>
      </div>
    </div>

    <form
      class="mt-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      aria-label="會員搜尋與篩選"
      @submit.prevent="submitFilters"
    >
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <label class="grid gap-1.5 text-sm font-medium text-slate-700 xl:col-span-2">
          帳號或顯示名稱
          <input
            v-model="filters.search"
            type="search"
            maxlength="50"
            autocomplete="off"
            class="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-slate-950 placeholder:text-slate-400"
            placeholder="輸入關鍵字"
          />
        </label>
        <label class="grid gap-1.5 text-sm font-medium text-slate-700">
          帳號狀態
          <select
            v-model="filters.status"
            class="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-slate-950"
          >
            <option value="">全部狀態</option>
            <option value="active">啟用中</option>
            <option value="suspended">暫停中</option>
            <option value="deactivated">已停用</option>
          </select>
        </label>
        <label class="grid gap-1.5 text-sm font-medium text-slate-700">
          角色
          <select
            v-model="filters.role"
            class="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-slate-950"
          >
            <option value="">全部角色</option>
            <option value="user">會員</option>
            <option value="admin">管理員</option>
          </select>
        </label>
        <div class="flex items-end gap-2">
          <button
            type="submit"
            class="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-slate-950 px-4 font-semibold text-white hover:bg-slate-800"
          >
            <Search class="size-4" aria-hidden="true" />搜尋
          </button>
          <button
            type="button"
            class="min-h-11 rounded-lg border border-slate-300 px-4 font-medium text-slate-700 hover:bg-slate-100"
            @click="resetFilters"
          >
            清除
          </button>
        </div>
        <label class="grid gap-1.5 text-sm font-medium text-slate-700">
          註冊起日
          <input
            v-model="filters.registeredFrom"
            type="date"
            class="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-slate-950"
          />
        </label>
        <label class="grid gap-1.5 text-sm font-medium text-slate-700">
          註冊迄日
          <input
            v-model="filters.registeredTo"
            type="date"
            class="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-slate-950"
          />
        </label>
      </div>
    </form>

    <div class="mt-5" aria-live="polite">
      <div v-if="isLoading" class="rounded-xl border border-slate-200 bg-white p-10 text-center">
        <p class="font-medium text-slate-700">正在載入會員資料…</p>
      </div>
      <div
        v-else-if="errorMessage"
        role="alert"
        class="rounded-xl border border-red-200 bg-red-50 p-5 text-red-800"
      >
        <p class="font-semibold">無法載入會員</p>
        <p class="mt-1 text-sm">{{ errorMessage }}</p>
        <button
          type="button"
          class="mt-4 min-h-11 rounded-lg border border-red-300 bg-white px-4 font-semibold hover:bg-red-100"
          @click="loadMembers"
        >
          重新載入
        </button>
      </div>
      <div
        v-else-if="members.length === 0"
        class="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center"
      >
        <Users class="mx-auto size-8 text-slate-400" aria-hidden="true" />
        <p class="mt-3 font-semibold">{{ resultSummary }}</p>
        <p class="mt-1 text-sm text-slate-600">請調整搜尋或篩選條件。</p>
      </div>
      <template v-else>
        <p class="mb-3 text-sm text-slate-600">{{ resultSummary }}</p>
        <div
          class="hidden overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm md:block"
        >
          <table class="w-full text-left text-sm">
            <thead class="bg-slate-100 text-xs tracking-wide text-slate-600 uppercase">
              <tr>
                <th scope="col" class="px-5 py-3">會員</th>
                <th scope="col" class="px-5 py-3">帳號狀態</th>
                <th scope="col" class="px-5 py-3">註冊日期</th>
                <th scope="col" class="px-5 py-3">最近登入</th>
                <th scope="col" class="px-5 py-3 text-right"><span class="sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200">
              <tr v-for="member in members" :key="member.id" class="hover:bg-slate-50">
                <td class="px-5 py-4">
                  <div class="flex items-center gap-3">
                    <img
                      v-if="member.avatar"
                      :src="member.avatar"
                      alt=""
                      class="size-10 rounded-full bg-slate-200 object-cover"
                    />
                    <span
                      v-else
                      class="flex size-10 items-center justify-center rounded-full bg-amber-100 font-bold text-amber-900"
                      aria-hidden="true"
                      >{{ initials(member) }}</span
                    >
                    <div class="min-w-0">
                      <p class="truncate font-semibold">{{ member.displayName }}</p>
                      <p class="truncate text-slate-500">@{{ member.account }}</p>
                    </div>
                  </div>
                </td>
                <td class="px-5 py-4">
                  <span
                    :class="[
                      'rounded-full px-2.5 py-1 font-medium',
                      statusClass(member.accountStatus),
                    ]"
                  >
                    {{ statusLabel(member.accountStatus) }}
                  </span>
                </td>
                <td class="px-5 py-4 text-slate-600">{{ dateLabel(member.registrationDate) }}</td>
                <td class="px-5 py-4 text-slate-500">無資料</td>
                <td class="px-5 py-4 text-right">
                  <RouterLink
                    :to="{
                      name: 'member-admin-detail',
                      params: { memberId: member.id },
                      query: detailQuery,
                    }"
                    class="inline-flex min-h-11 items-center rounded-lg px-3 font-semibold text-amber-800 hover:bg-amber-50"
                    >查看</RouterLink
                  >
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="grid min-w-0 gap-3 md:hidden">
          <article
            v-for="member in members"
            :key="member.id"
            class="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <div class="flex min-w-0 items-start gap-3">
              <img
                v-if="member.avatar"
                :src="member.avatar"
                alt=""
                class="size-12 shrink-0 rounded-full bg-slate-200 object-cover"
              />
              <span
                v-else
                class="flex size-12 shrink-0 items-center justify-center rounded-full bg-amber-100 text-lg font-bold text-amber-900"
                aria-hidden="true"
                >{{ initials(member) }}</span
              >
              <div class="min-w-0 flex-1">
                <h3 class="break-words whitespace-normal font-semibold">
                  {{ member.displayName }}
                </h3>
                <p class="break-all text-sm text-slate-500">@{{ member.account }}</p>
              </div>
            </div>
            <dl class="mt-4 grid min-w-0 grid-cols-2 gap-3 text-sm">
              <div>
                <dt class="text-slate-500">狀態</dt>
                <dd class="mt-1">
                  <span
                    :class="[
                      'inline-flex rounded-full px-2.5 py-1 font-medium',
                      statusClass(member.accountStatus),
                    ]"
                  >
                    {{ statusLabel(member.accountStatus) }}
                  </span>
                </dd>
              </div>
              <div>
                <dt class="text-slate-500">註冊日期</dt>
                <dd class="mt-1 font-medium">{{ dateLabel(member.registrationDate) }}</dd>
              </div>
              <div>
                <dt class="text-slate-500">最近登入</dt>
                <dd class="mt-1 font-medium">無資料</dd>
              </div>
            </dl>
            <RouterLink
              :to="{
                name: 'member-admin-detail',
                params: { memberId: member.id },
                query: detailQuery,
              }"
              class="mt-4 inline-flex min-h-11 w-full min-w-0 items-center justify-center rounded-lg bg-slate-950 px-4 font-semibold text-white"
              >查看會員</RouterLink
            >
          </article>
        </div>

        <nav class="mt-5 flex items-center justify-between gap-3" aria-label="會員分頁">
          <button
            type="button"
            class="inline-flex min-h-11 items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 font-medium disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="pagination.page <= 1"
            @click="goToPage(pagination.page - 1)"
          >
            <ChevronLeft class="size-4" aria-hidden="true" />上一頁
          </button>
          <p class="text-sm text-slate-600">
            第 {{ pagination.page }} 頁<span v-if="pagination.totalPages"
              >／共 {{ pagination.totalPages }} 頁</span
            >
          </p>
          <button
            type="button"
            class="inline-flex min-h-11 items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 font-medium disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="pagination.page >= pagination.totalPages"
            @click="goToPage(pagination.page + 1)"
          >
            下一頁<ChevronRight class="size-4" aria-hidden="true" />
          </button>
        </nav>
      </template>
    </div>
  </section>
</template>

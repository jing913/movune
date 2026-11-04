<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { ArrowLeft, LogOut, Megaphone, Menu, Users, X } from '@lucide/vue'
import { useUserStore } from '@/stores/user'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const isMobileNavigationOpen = ref(false)
const adminMain = ref<HTMLElement | null>(null)

const destinations = computed(() => [
  ...(userStore.currentUser?.capabilities.viewMembers === true
    ? [{ to: '/admin/members', label: '會員管理', icon: Users }]
    : []),
  ...(userStore.currentUser?.capabilities.manageAnnouncements === true
    ? [{ to: '/admin/announcements', label: '公告管理', icon: Megaphone }]
    : []),
])
const administratorName = computed(
  () => userStore.currentUser?.displayName || userStore.currentUser?.account || '管理員',
)
const administratorAccount = computed(() => userStore.currentUser?.account || '')
const administratorInitial = computed(() => administratorName.value.trim().charAt(0).toUpperCase())

watch(
  () => route.fullPath,
  () => {
    isMobileNavigationOpen.value = false
  },
)

watch(
  () => route.path,
  async (path, previousPath) => {
    if (path === previousPath) return
    await nextTick()
    adminMain.value?.focus({ preventScroll: true })
  },
  { flush: 'post' },
)

const isCurrent = (path: string) => route.path === path || route.path.startsWith(`${path}/`)

async function handleLogout() {
  await userStore.logout()
  isMobileNavigationOpen.value = false
  await router.push('/')
}
</script>

<template>
  <div class="admin-theme min-h-dvh overflow-x-clip bg-slate-50 text-slate-950 lg:flex">
    <aside
      class="hidden w-64 shrink-0 border-r border-slate-800 bg-slate-950 text-slate-100 lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col"
    >
      <div class="flex min-h-0 flex-1 flex-col px-5 py-7">
        <p class="text-xs font-semibold tracking-[0.2em] text-amber-300 uppercase">Movune</p>
        <h1 class="mt-2 text-xl font-semibold">管理員後台</h1>
        <div class="mt-5 flex min-w-0 items-center gap-3 border-y border-slate-800 py-4">
          <span
            class="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-300 text-sm font-bold text-slate-950"
            aria-hidden="true"
          >
            {{ administratorInitial }}
          </span>
          <div class="min-w-0">
            <p class="truncate text-sm font-semibold text-white">{{ administratorName }}</p>
            <p v-if="administratorAccount" class="truncate text-xs text-slate-400">
              @{{ administratorAccount }}
            </p>
          </div>
        </div>
        <nav class="mt-5 space-y-2" aria-label="管理員後台">
          <RouterLink
            v-for="destination in destinations"
            :key="destination.to"
            :to="destination.to"
            :aria-current="isCurrent(destination.to) ? 'page' : undefined"
            :class="[
              'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
              isCurrent(destination.to)
                ? 'bg-amber-300 text-slate-950'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white',
            ]"
          >
            <component :is="destination.icon" class="size-5" aria-hidden="true" />
            {{ destination.label }}
          </RouterLink>
        </nav>

        <div class="mt-auto space-y-2 border-t border-slate-800 pt-5">
          <button
            type="button"
            class="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-rose-300 transition-colors hover:bg-rose-950/60 hover:text-rose-100"
            @click="handleLogout"
          >
            <LogOut class="size-5" aria-hidden="true" />
            登出
          </button>
          <RouterLink
            to="/"
            class="flex min-h-11 items-center gap-3 rounded-lg border-t border-slate-800 px-3 pt-3 pb-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-white"
          >
            <ArrowLeft class="size-5" aria-hidden="true" />
            返回 Movune
          </RouterLink>
        </div>
      </div>
    </aside>

    <div class="min-w-0 flex-1">
      <header class="border-b border-slate-200 bg-white px-4 py-3 shadow-sm lg:hidden">
        <div class="flex items-center justify-between gap-4">
          <div class="shrink-0">
            <p class="text-xs font-semibold tracking-[0.18em] text-amber-700 uppercase">Movune</p>
            <p class="font-semibold">管理員後台</p>
          </div>
          <div class="flex min-w-0 items-center gap-2">
            <div class="min-w-0 text-right">
              <p class="max-w-28 truncate text-sm font-semibold sm:max-w-48">
                {{ administratorName }}
              </p>
              <p
                v-if="administratorAccount"
                class="hidden truncate text-xs text-slate-500 sm:block"
              >
                @{{ administratorAccount }}
              </p>
            </div>
            <button
              type="button"
              class="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-800 hover:bg-slate-100"
              :aria-expanded="isMobileNavigationOpen"
              aria-controls="admin-mobile-navigation"
              :aria-label="isMobileNavigationOpen ? '關閉管理選單' : '開啟管理選單'"
              @click="isMobileNavigationOpen = !isMobileNavigationOpen"
            >
              <X v-if="isMobileNavigationOpen" class="size-5" aria-hidden="true" />
              <Menu v-else class="size-5" aria-hidden="true" />
            </button>
          </div>
        </div>
        <nav
          v-if="isMobileNavigationOpen"
          id="admin-mobile-navigation"
          class="mt-3 grid gap-2 border-t border-slate-200 pt-3"
          aria-label="管理員後台"
        >
          <RouterLink
            v-for="destination in destinations"
            :key="destination.to"
            :to="destination.to"
            :aria-current="isCurrent(destination.to) ? 'page' : undefined"
            :class="[
              'flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 font-medium',
              isCurrent(destination.to)
                ? 'bg-amber-100 text-amber-950'
                : 'text-slate-700 hover:bg-slate-100',
            ]"
          >
            <component :is="destination.icon" class="size-5" aria-hidden="true" />
            {{ destination.label }}
          </RouterLink>
          <button
            type="button"
            class="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 font-medium text-rose-700 hover:bg-rose-50"
            @click="handleLogout"
          >
            <LogOut class="size-5" aria-hidden="true" />
            登出
          </button>
          <RouterLink
            to="/"
            class="mt-1 flex min-h-11 items-center gap-3 border-t border-slate-200 px-3 pt-3 font-medium text-slate-700 hover:text-slate-950"
          >
            <ArrowLeft class="size-5" aria-hidden="true" />
            返回 Movune
          </RouterLink>
        </nav>
      </header>

      <main
        ref="adminMain"
        tabindex="-1"
        aria-label="管理員內容"
        class="mx-auto w-full max-w-[96rem] px-4 py-6 focus-visible:outline-2 focus-visible:outline-amber-700 sm:px-6 lg:px-8 lg:py-9 xl:px-10"
      >
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style>
.admin-theme {
  color-scheme: light;
  --background: #f8fafc;
  --surface: #ffffff;
  --surface-raised: #f1f5f9;
  --border: #cbd5e1;
  --foreground: #0f172a;
  --muted-foreground: #475569;
  --primary-cta: #0f172a;
  --primary-cta-hover: #1e293b;
  --primary-cta-pressed: #334155;
  --primary-foreground: #ffffff;
  --control-border: #94a3b8;
  --focus-ring: #b45309;
  --card: #ffffff;
  --card-foreground: #0f172a;
  --popover: #ffffff;
  --popover-foreground: #0f172a;
  --secondary: #f1f5f9;
  --secondary-foreground: #0f172a;
  --muted: #f1f5f9;
  --accent: #fef3c7;
  --accent-foreground: #451a03;
  --input: #94a3b8;
  --ring: #b45309;
}
</style>

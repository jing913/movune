<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import UserAvatar from '@/components/user/UserAvatar.vue'
import InboxNavLink from '@/components/InboxNavLink.vue'
import { useUserStore } from '@/stores/user'
import {
  getMoviePrimaryTitle,
  getMovieSecondaryTitle,
  searchMovies,
  type Movie,
} from '@/services/tmdb'
import { ChevronDown, Search } from '@lucide/vue'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const emit = defineEmits<{
  'open-login': [opener?: HTMLElement]
}>()
const isMenuOpen = ref(false)
const isUserMenuOpen = ref(false)
const peopleMenuOpen = ref(false)
const isMobilePeopleOpen = ref(route.path === '/people' || route.path === '/encounter')
const isMobileSearchVisible = ref(true)
const isContextualSearchOpen = ref(false)
const isMobileAccountOpen = ref(false)
const navbarSearchQuery = ref('')
const searchSuggestions = ref<Movie[]>([])
const completedSearchQuery = ref('')
const isSearchLoading = ref(false)
const hasSearchError = ref(false)
type SearchSurface = 'desktop' | 'top' | 'contextual'

const activeSearchSurface = ref<SearchSurface | null>(null)
const activeSuggestionIndex = ref(-1)
const mobileNavbar = ref<HTMLElement | null>(null)
const mobileSearchRegion = ref<HTMLElement | null>(null)
const topSearchContainer = ref<HTMLElement | null>(null)
const desktopSearchContainer = ref<HTMLElement | null>(null)
const contextualSearchContainer = ref<HTMLElement | null>(null)
const contextualSearchInput = ref<HTMLInputElement | null>(null)
const contextualSearchTrigger = ref<HTMLButtonElement | null>(null)
const mobileNavigationTrigger = ref<HTMLButtonElement | null>(null)
const mobileAccountPanel = ref<HTMLElement | null>(null)
const mobileAccountTrigger = ref<HTMLButtonElement | null>(null)
const userMenuContainer = ref<HTMLElement | null>(null)
const userMenuButton = ref<HTMLButtonElement | null>(null)
const userMenu = ref<HTMLElement | null>(null)
let mobileSearchObserver: IntersectionObserver | null = null
let mobileNavbarResizeObserver: ResizeObserver | null = null
let searchDebounceTimer: number | null = null
let searchRequestVersion = 0

type MobileNavigationDestination =
  | '/'
  | '/explore'
  | '/announcements'
  | '/people'
  | '/encounter'
  | '/inbox'
  | '/movie-space'
  | '/movie-space?view=favorites'
  | '/movie-space?view=settings'

const primaryMobileNavigationItems = [
  { to: '/', label: '首頁' },
  { to: '/explore', label: '探索電影' },
] as const

const mobileNavigationLinkClass =
  'block min-h-11 rounded-md py-2.5 font-medium text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none'
const mobileNavigationCurrentClass = '!bg-surface-raised !font-semibold !text-foreground'
const trimmedSearchQuery = computed(() => navbarSearchQuery.value.trim())

function isMobileDestinationCurrent(destination: MobileNavigationDestination) {
  if (destination === '/announcements') {
    return route.path === '/announcements' || route.path.startsWith('/announcements/')
  }

  if (destination === '/movie-space') {
    return route.path === '/movie-space' && (!route.query.view || route.query.view === 'profile')
  }

  if (destination === '/movie-space?view=favorites') {
    return route.path === '/movie-space' && route.query.view === 'favorites'
  }

  if (destination === '/movie-space?view=settings') {
    return route.path === '/movie-space' && route.query.view === 'settings'
  }

  return route.path === destination
}

function handleMobileNavigation(event: MouseEvent, navigate: (event?: MouseEvent) => unknown) {
  navigate(event)
  isMenuOpen.value = false
}

function handleMobileAccountNavigation(
  event: MouseEvent,
  navigate: (event?: MouseEvent) => unknown,
) {
  navigate(event)
  isMobileAccountOpen.value = false
}

function toggleMobileMenu() {
  void closeContextualSearch()
  isMobileAccountOpen.value = false
  isUserMenuOpen.value = false
  isMenuOpen.value = !isMenuOpen.value
}

async function closeMobileAccount(restoreFocus = false) {
  if (!isMobileAccountOpen.value) return

  isMobileAccountOpen.value = false
  if (restoreFocus) {
    await nextTick()
    mobileAccountTrigger.value?.focus()
  }
}

function toggleMobileAccount() {
  void closeContextualSearch()
  isMenuOpen.value = false
  isUserMenuOpen.value = false
  isMobileAccountOpen.value = !isMobileAccountOpen.value
}

function closeSearchSuggestions(surface?: SearchSurface) {
  if (!surface || activeSearchSurface.value === surface) activeSearchSurface.value = null
  activeSuggestionIndex.value = -1
}

async function closeContextualSearch(restoreFocus = false) {
  if (!isContextualSearchOpen.value) return

  isContextualSearchOpen.value = false
  closeSearchSuggestions('contextual')
  if (restoreFocus) {
    await nextTick()
    contextualSearchTrigger.value?.focus()
  }
}

async function toggleContextualSearch() {
  if (isContextualSearchOpen.value) {
    await closeContextualSearch(true)
    return
  }

  isUserMenuOpen.value = false
  isMenuOpen.value = false
  isMobileAccountOpen.value = false
  isContextualSearchOpen.value = true
  activeSearchSurface.value = 'contextual'
  await nextTick()
  contextualSearchInput.value?.focus({ preventScroll: true })
}

function openSearchSuggestions(surface: SearchSurface) {
  isMenuOpen.value = false
  isMobileAccountOpen.value = false
  activeSearchSurface.value = surface
  activeSuggestionIndex.value = -1
}

function isSuggestionPopupOpen(surface: SearchSurface) {
  return activeSearchSurface.value === surface && Boolean(trimmedSearchQuery.value)
}

function getSuggestionListId(surface: SearchSurface) {
  return `${surface}-movie-search-suggestions`
}

function getSuggestionOptionId(surface: SearchSurface, movie: Movie) {
  return `${surface}-movie-search-option-${movie.id}`
}

function getActiveSuggestionId(surface: SearchSurface) {
  const movie = searchSuggestions.value[activeSuggestionIndex.value]
  return movie && isSuggestionPopupOpen(surface) ? getSuggestionOptionId(surface, movie) : undefined
}

function getMovieSuggestionYear(movie: Movie) {
  return movie.release_date?.slice(0, 4) || null
}

async function selectSearchSuggestion(movie: Movie) {
  navbarSearchQuery.value = ''
  closeSearchSuggestions()
  await closeContextualSearch()
  await router.push(`/movies/${movie.id}`)
}

function handleSearchKeydown(event: KeyboardEvent, surface: SearchSurface) {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (surface === 'contextual') void closeContextualSearch(true)
    else closeSearchSuggestions(surface)
    return
  }

  if (!searchSuggestions.value.length) return

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeSuggestionIndex.value =
      activeSuggestionIndex.value < searchSuggestions.value.length - 1
        ? activeSuggestionIndex.value + 1
        : 0
    return
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeSuggestionIndex.value =
      activeSuggestionIndex.value > 0
        ? activeSuggestionIndex.value - 1
        : searchSuggestions.value.length - 1
    return
  }

  if (event.key === 'Enter' && activeSuggestionIndex.value >= 0) {
    event.preventDefault()
    const movie = searchSuggestions.value[activeSuggestionIndex.value]
    if (movie) void selectSearchSuggestion(movie)
  }
}

function observeMobileSearchVisibility() {
  mobileSearchObserver?.disconnect()
  if (!mobileSearchRegion.value) return

  const navbarHeight = mobileNavbar.value?.getBoundingClientRect().height ?? 0
  mobileSearchObserver = new IntersectionObserver(
    ([entry]) => {
      isMobileSearchVisible.value = entry?.isIntersecting ?? false
      if (isMobileSearchVisible.value) void closeContextualSearch()
    },
    { rootMargin: `-${navbarHeight}px 0px 0px 0px` },
  )
  mobileSearchObserver.observe(mobileSearchRegion.value)
}

async function handleNavbarSearch() {
  const query = navbarSearchQuery.value.trim()
  if (!query) return

  navbarSearchQuery.value = ''
  closeSearchSuggestions()
  await closeContextualSearch()
  isMenuOpen.value = false
  await router.push({ path: '/explore', query: { q: query } })
}

function openLoginDialog(event?: MouseEvent) {
  void closeContextualSearch()
  isMobileAccountOpen.value = false
  isUserMenuOpen.value = false
  isMenuOpen.value = false
  const opener = event?.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
  emit('open-login', opener)
}

async function handleLogout() {
  await userStore.logout()
  isMobileAccountOpen.value = false
  isUserMenuOpen.value = false
  isMenuOpen.value = false

  if (route.meta.requiresAuth) {
    await router.push('/')
  }
}

function getUserMenuItems() {
  return Array.from(userMenu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
}

async function openUserMenu(position: 'first' | 'last' = 'first') {
  isUserMenuOpen.value = true
  await nextTick()

  const menuItems = getUserMenuItems()
  const target = position === 'last' ? menuItems.at(-1) : menuItems[0]
  target?.focus()
}

async function closeUserMenu(restoreFocus = false) {
  if (!isUserMenuOpen.value) return

  isUserMenuOpen.value = false
  if (restoreFocus) {
    await nextTick()
    userMenuButton.value?.focus()
  }
}

function toggleUserMenu() {
  void closeContextualSearch()
  isMobileAccountOpen.value = false
  isMenuOpen.value = false
  if (isUserMenuOpen.value) {
    void closeUserMenu()
  } else {
    void openUserMenu()
  }
}

function handleUserMenuButtonKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return

  event.preventDefault()
  void openUserMenu(event.key === 'ArrowUp' ? 'last' : 'first')
}

function handleUserMenuKeydown(event: KeyboardEvent) {
  const menuItems = getUserMenuItems()
  const currentIndex = menuItems.indexOf(document.activeElement as HTMLElement)
  let nextIndex: number

  switch (event.key) {
    case 'ArrowDown':
      nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % menuItems.length
      break
    case 'ArrowUp':
      nextIndex =
        currentIndex < 0
          ? menuItems.length - 1
          : (currentIndex - 1 + menuItems.length) % menuItems.length
      break
    case 'Home':
      nextIndex = 0
      break
    case 'End':
      nextIndex = menuItems.length - 1
      break
    case 'Escape':
      event.preventDefault()
      event.stopPropagation()
      void closeUserMenu(true)
      return
    case 'Tab':
      void closeUserMenu()
      return
    default:
      return
  }

  if (menuItems[nextIndex]) {
    event.preventDefault()
    menuItems[nextIndex].focus()
  }
}

function handleDocumentPointerDown(event: PointerEvent) {
  const target = event.target
  if (!(target instanceof Node)) return
  const isPanelTrigger =
    mobileNavigationTrigger.value?.contains(target) ||
    contextualSearchTrigger.value?.contains(target) ||
    mobileAccountTrigger.value?.contains(target)

  if (
    isContextualSearchOpen.value &&
    !contextualSearchContainer.value?.contains(target) &&
    !isPanelTrigger
  ) {
    void closeContextualSearch()
  }
  if (activeSearchSurface.value === 'top' && !topSearchContainer.value?.contains(target)) {
    closeSearchSuggestions('top')
  }
  if (activeSearchSurface.value === 'desktop' && !desktopSearchContainer.value?.contains(target)) {
    closeSearchSuggestions('desktop')
  }
  if (isMobileAccountOpen.value && !mobileAccountPanel.value?.contains(target) && !isPanelTrigger) {
    void closeMobileAccount()
  }
  if (isUserMenuOpen.value && !userMenuContainer.value?.contains(target)) {
    void closeUserMenu()
  }
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return

  if (isContextualSearchOpen.value) void closeContextualSearch(true)
  else if (isMenuOpen.value) isMenuOpen.value = false
  else if (isMobileAccountOpen.value) void closeMobileAccount(true)
  else void closeUserMenu(true)
}

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  document.addEventListener('keydown', handleDocumentKeydown)

  observeMobileSearchVisibility()
  if (mobileNavbar.value) {
    mobileNavbarResizeObserver = new ResizeObserver(observeMobileSearchVisibility)
    mobileNavbarResizeObserver.observe(mobileNavbar.value)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  document.removeEventListener('keydown', handleDocumentKeydown)
  mobileSearchObserver?.disconnect()
  mobileNavbarResizeObserver?.disconnect()
  if (searchDebounceTimer !== null) window.clearTimeout(searchDebounceTimer)
})

watch([navbarSearchQuery, activeSearchSurface], ([value, surface]) => {
  if (searchDebounceTimer !== null) window.clearTimeout(searchDebounceTimer)
  const version = ++searchRequestVersion
  const query = value.trim()

  activeSuggestionIndex.value = -1
  hasSearchError.value = false

  if (!query) {
    searchSuggestions.value = []
    completedSearchQuery.value = ''
    isSearchLoading.value = false
    return
  }

  if (!surface || completedSearchQuery.value === query) {
    isSearchLoading.value = false
    return
  }

  completedSearchQuery.value = ''
  isSearchLoading.value = true
  searchDebounceTimer = window.setTimeout(async () => {
    try {
      const results = await searchMovies(query)
      if (version !== searchRequestVersion) return
      searchSuggestions.value = results.slice(0, 6)
    } catch {
      if (version !== searchRequestVersion) return
      searchSuggestions.value = []
      hasSearchError.value = true
    } finally {
      if (version === searchRequestVersion) {
        completedSearchQuery.value = query
        isSearchLoading.value = false
      }
    }
  }, 250)
})

watch(
  () => route.fullPath,
  () => {
    isMenuOpen.value = false
    isUserMenuOpen.value = false
    isMobileAccountOpen.value = false
    void closeContextualSearch()
    closeSearchSuggestions()
    isMobilePeopleOpen.value = route.path === '/people' || route.path === '/encounter'
  },
)

watch(isMenuOpen, (isOpen) => {
  if (isOpen && (route.path === '/people' || route.path === '/encounter')) {
    isMobilePeopleOpen.value = true
  }
})
</script>

<template>
  <header class="sticky top-0 z-40 border-b border-border bg-surface lg:static lg:z-auto">
    <div ref="mobileNavbar" class="page-shell">
      <div
        class="flex min-h-18 items-center justify-between gap-4 sm:min-h-20 lg:grid lg:grid-cols-[minmax(9rem,0.62fr)_minmax(31rem,1.65fr)_minmax(15rem,0.9fr)] lg:gap-6"
      >
        <button
          ref="mobileNavigationTrigger"
          type="button"
          class="flex size-11 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-surface-raised active:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background lg:hidden"
          aria-controls="mobile-navigation"
          :aria-expanded="isMenuOpen"
          :aria-label="isMenuOpen ? '關閉導覽選單' : '開啟導覽選單'"
          @click="toggleMobileMenu"
        >
          <svg
            v-if="!isMenuOpen"
            class="size-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
          <svg
            v-else
            class="size-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>

        <RouterLink
          class="brand-logo-link group mr-auto inline-flex min-w-0 flex-col items-start justify-center rounded-lg py-1 lg:mr-0"
          to="/"
        >
          <span class="min-w-0">
            <span
              class="brand-logo-metallic brand-logo-name block text-4xl leading-none tracking-tight"
              data-text="Movune"
              >Movune</span
            >
            <span
              class="brand-logo-metallic brand-logo-slogan mt-0.5 hidden text-lg leading-6 xl:block"
            >
              Movies move. Stories connect.
            </span>
          </span>
        </RouterLink>

        <div class="hidden min-w-0 items-center justify-between gap-6 lg:flex xl:gap-10">
          <nav class="shrink-0" aria-label="主要導覽">
            <ul class="flex items-center gap-6">
              <li>
                <RouterLink
                  to="/"
                  class="block border-b-2 border-transparent px-1 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                  exact-active-class="!border-accent-caramel !text-foreground"
                >
                  首頁
                </RouterLink>
              </li>
              <li>
                <RouterLink
                  to="/explore"
                  class="block border-b-2 border-transparent px-1 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                  active-class="!border-accent-caramel !text-foreground"
                >
                  探索電影
                </RouterLink>
              </li>
              <li>
                <DropdownMenu v-model:open="peopleMenuOpen">
                  <DropdownMenuTrigger as-child>
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 whitespace-nowrap border-b-2 border-transparent px-1 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground"
                      :class="
                        route.path === '/people' || route.path === '/encounter'
                          ? '!border-accent-caramel !text-foreground'
                          : ''
                      "
                    >
                      <span>探索同好</span>
                      <ChevronDown
                        class="size-3.5 shrink-0 transition-transform"
                        :class="{ 'rotate-180': peopleMenuOpen }"
                        aria-hidden="true"
                      />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    class="w-40 rounded-md border border-border bg-surface-raised p-2 shadow-[0_18px_44px_rgba(0,0,0,0.34)]"
                  >
                    <DropdownMenuItem
                      as-child
                      class="rounded-md p-0 data-[highlighted]:bg-surface data-[highlighted]:text-foreground"
                    >
                      <RouterLink
                        to="/people"
                        class="block min-h-11 w-full rounded-md px-4 py-3 font-semibold"
                      >
                        推薦同好
                      </RouterLink>
                    </DropdownMenuItem>

                    <DropdownMenuItem
                      as-child
                      class="mt-1 rounded-md p-0 data-[highlighted]:bg-surface data-[highlighted]:text-foreground"
                    >
                      <RouterLink
                        to="/encounter"
                        class="block min-h-11 w-full rounded-md px-4 py-3 font-semibold"
                      >
                        今日雷達
                      </RouterLink>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
              <li>
                <RouterLink
                  to="/announcements"
                  class="block whitespace-nowrap border-b-2 border-transparent px-1 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                  active-class="!border-accent-caramel !text-foreground"
                >
                  公告中心
                </RouterLink>
              </li>
            </ul>
          </nav>

          <form
            ref="desktopSearchContainer"
            class="relative ml-auto flex min-w-0 max-w-[23.75rem] flex-1 items-center"
            role="search"
            aria-label="導覽列電影搜尋"
            @submit.prevent="handleNavbarSearch"
          >
            <label class="sr-only" for="navbar-movie-search">搜尋電影</label>
            <div class="relative w-full">
              <svg
                class="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-4-4" />
              </svg>
              <input
                id="navbar-movie-search"
                v-model="navbarSearchQuery"
                class="min-h-10 w-full rounded-md border border-control bg-background py-2 pl-10 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
                type="search"
                role="combobox"
                placeholder="搜尋電影..."
                autocomplete="off"
                aria-autocomplete="list"
                :aria-expanded="isSuggestionPopupOpen('desktop')"
                :aria-controls="getSuggestionListId('desktop')"
                :aria-activedescendant="getActiveSuggestionId('desktop')"
                @focus="openSearchSuggestions('desktop')"
                @keydown="handleSearchKeydown($event, 'desktop')"
              />

              <div
                v-if="isSuggestionPopupOpen('desktop')"
                :id="getSuggestionListId('desktop')"
                class="absolute left-0 right-0 top-[calc(100%+0.4rem)] z-50 overflow-hidden rounded-md border border-border bg-surface-raised shadow-[0_18px_44px_rgba(0,0,0,0.4)]"
                role="listbox"
                aria-label="電影搜尋建議"
              >
                <p
                  v-if="isSearchLoading"
                  class="px-4 py-3 text-sm text-muted-foreground"
                  role="option"
                  aria-disabled="true"
                >
                  搜尋中…
                </p>
                <p
                  v-else-if="hasSearchError"
                  class="px-4 py-3 text-sm text-muted-foreground"
                  role="option"
                  aria-disabled="true"
                >
                  搜尋暫時失敗，請稍後再試。
                </p>
                <p
                  v-else-if="
                    completedSearchQuery === trimmedSearchQuery && searchSuggestions.length === 0
                  "
                  class="px-4 py-3 text-sm text-muted-foreground"
                  role="option"
                  aria-disabled="true"
                >
                  找不到符合的電影。
                </p>
                <ul v-else>
                  <li
                    v-for="(movie, index) in searchSuggestions"
                    :id="getSuggestionOptionId('desktop', movie)"
                    :key="movie.id"
                    class="cursor-pointer border-b border-border px-4 py-3 last:border-b-0 hover:bg-surface"
                    :class="index === activeSuggestionIndex ? 'bg-surface' : ''"
                    role="option"
                    :aria-selected="index === activeSuggestionIndex"
                    @pointermove="activeSuggestionIndex = index"
                    @click="selectSearchSuggestion(movie)"
                  >
                    <p class="truncate text-sm font-semibold text-foreground">
                      {{ getMoviePrimaryTitle(movie) }}
                    </p>
                    <p
                      v-if="getMovieSecondaryTitle(movie) || getMovieSuggestionYear(movie)"
                      class="mt-0.5 truncate text-xs text-muted-foreground"
                    >
                      {{
                        [getMovieSecondaryTitle(movie), getMovieSuggestionYear(movie)]
                          .filter(Boolean)
                          .join(' · ')
                      }}
                    </p>
                  </li>
                </ul>
              </div>
            </div>
          </form>
        </div>

        <div class="ml-auto flex min-w-0 items-center justify-end gap-1 lg:ml-0 lg:gap-2">
          <button
            v-if="!isMobileSearchVisible"
            ref="contextualSearchTrigger"
            type="button"
            class="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background lg:hidden"
            aria-label="搜尋電影"
            aria-controls="contextual-mobile-search"
            :aria-expanded="isContextualSearchOpen"
            @click="toggleContextualSearch"
          >
            <Search class="size-5" aria-hidden="true" />
          </button>

          <InboxNavLink v-if="!userStore.isAuthLoading && userStore.currentUser" />

          <div ref="userMenuContainer" class="relative min-w-0 shrink-0">
            <div
              v-if="userStore.isAuthLoading"
              class="flex items-center gap-2"
              aria-label="登入狀態載入中"
            >
              <Skeleton class="size-10 rounded-full" />
              <Skeleton class="hidden h-4 w-16 lg:block" />
            </div>
            <template v-else-if="!userStore.currentUser">
              <button
                type="button"
                class="inline-flex min-h-11 items-center justify-center rounded-md bg-transparent px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-raised active:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:px-5 lg:hidden"
                @click="openLoginDialog"
              >
                登入
              </button>
              <button
                type="button"
                class="hidden min-h-11 items-center justify-center rounded-md bg-primary-cta px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-cta-hover active:bg-primary-cta-pressed lg:inline-flex"
                @click="openLoginDialog"
              >
                登入
              </button>
            </template>
            <template v-else>
              <button
                id="mobile-account-button"
                ref="mobileAccountTrigger"
                type="button"
                class="flex min-h-11 min-w-11 items-center justify-center rounded-md bg-transparent text-foreground transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background lg:hidden"
                aria-controls="mobile-account-panel"
                :aria-expanded="isMobileAccountOpen"
                :aria-label="isMobileAccountOpen ? '關閉會員選單' : '開啟會員選單'"
                @click="toggleMobileAccount"
              >
                <UserAvatar
                  :account="userStore.currentUser.account"
                  :user-id="userStore.currentUser._id"
                />
              </button>

              <button
                id="user-menu-button"
                ref="userMenuButton"
                type="button"
                class="group hidden min-h-11 items-center gap-2 rounded-md bg-transparent py-1.5 pl-1.5 pr-3 text-sm font-semibold text-foreground transition-colors hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-ring lg:flex"
                :class="isUserMenuOpen ? 'bg-surface-raised' : ''"
                aria-haspopup="menu"
                aria-controls="user-menu"
                :aria-expanded="isUserMenuOpen"
                @click="toggleUserMenu"
                @keydown="handleUserMenuButtonKeydown"
              >
                <UserAvatar
                  :account="userStore.currentUser.account"
                  :user-id="userStore.currentUser._id"
                />
                <span>{{
                  userStore.currentUser.displayName || userStore.currentUser.account
                }}</span>
                <svg
                  class="size-4 text-muted-foreground transition-[color,transform] group-hover:text-foreground"
                  :class="isUserMenuOpen ? 'rotate-180 text-foreground' : ''"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  aria-hidden="true"
                >
                  <path d="m7 10 5 5 5-5" />
                </svg>
              </button>

              <div
                v-if="isUserMenuOpen"
                id="user-menu"
                ref="userMenu"
                class="absolute right-0 top-[calc(100%+0.65rem)] z-50 hidden w-52 rounded-md border border-border bg-surface-raised p-2 shadow-[0_18px_44px_rgba(0,0,0,0.34)] lg:block"
                role="menu"
                aria-labelledby="user-menu-button"
                @keydown="handleUserMenuKeydown"
              >
                <RouterLink
                  to="/movie-space"
                  class="block rounded-md px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-surface"
                  role="menuitem"
                  @click="closeUserMenu()"
                >
                  會員中心
                </RouterLink>
                <RouterLink
                  to="/movie-space?view=favorites"
                  class="mt-1 block rounded-md px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-surface"
                  role="menuitem"
                  @click="closeUserMenu()"
                >
                  我的電影空間
                </RouterLink>
                <RouterLink
                  to="/movie-space?view=settings"
                  class="mt-1 block rounded-md px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-surface"
                  role="menuitem"
                  @click="closeUserMenu()"
                >
                  帳號設定
                </RouterLink>
                <button
                  type="button"
                  class="mt-1 block w-full rounded-md px-4 py-3 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
                  role="menuitem"
                  @click="handleLogout"
                >
                  登出
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="isContextualSearchOpen"
      id="contextual-mobile-search"
      ref="contextualSearchContainer"
      class="border-t border-border bg-surface pb-3 pt-3 shadow-[0_14px_30px_rgba(0,0,0,0.28)] lg:hidden"
    >
      <div class="page-shell">
        <form
          class="relative"
          role="search"
          aria-label="行動版情境電影搜尋"
          @submit.prevent="handleNavbarSearch"
        >
          <label class="sr-only" for="contextual-navbar-movie-search">搜尋電影</label>
          <Search
            class="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            id="contextual-navbar-movie-search"
            ref="contextualSearchInput"
            v-model="navbarSearchQuery"
            class="min-h-11 w-full rounded-md border border-control bg-background py-2 pl-10 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            type="search"
            role="combobox"
            placeholder="搜尋電影..."
            autocomplete="off"
            aria-autocomplete="list"
            :aria-expanded="isSuggestionPopupOpen('contextual')"
            :aria-controls="getSuggestionListId('contextual')"
            :aria-activedescendant="getActiveSuggestionId('contextual')"
            @focus="openSearchSuggestions('contextual')"
            @keydown="handleSearchKeydown($event, 'contextual')"
          />

          <div
            v-if="isSuggestionPopupOpen('contextual')"
            :id="getSuggestionListId('contextual')"
            class="absolute left-0 right-0 top-[calc(100%+0.4rem)] z-50 overflow-hidden rounded-md border border-border bg-surface-raised shadow-[0_18px_44px_rgba(0,0,0,0.4)]"
            role="listbox"
            aria-label="電影搜尋建議"
          >
            <p
              v-if="isSearchLoading"
              class="px-4 py-3 text-sm text-muted-foreground"
              role="option"
              aria-disabled="true"
            >
              搜尋中…
            </p>
            <p
              v-else-if="hasSearchError"
              class="px-4 py-3 text-sm text-muted-foreground"
              role="option"
              aria-disabled="true"
            >
              搜尋暫時無法使用。
            </p>
            <p
              v-else-if="
                completedSearchQuery === trimmedSearchQuery && searchSuggestions.length === 0
              "
              class="px-4 py-3 text-sm text-muted-foreground"
              role="option"
              aria-disabled="true"
            >
              找不到相符的電影。
            </p>
            <ul v-else>
              <li
                v-for="(movie, index) in searchSuggestions"
                :id="getSuggestionOptionId('contextual', movie)"
                :key="movie.id"
                class="cursor-pointer border-b border-border px-4 py-3 last:border-b-0 hover:bg-surface"
                :class="index === activeSuggestionIndex ? 'bg-surface' : ''"
                role="option"
                :aria-selected="index === activeSuggestionIndex"
                @pointermove="activeSuggestionIndex = index"
                @click="selectSearchSuggestion(movie)"
              >
                <p class="truncate text-sm font-semibold text-foreground">
                  {{ getMoviePrimaryTitle(movie) }}
                </p>
                <p
                  v-if="getMovieSecondaryTitle(movie) || getMovieSuggestionYear(movie)"
                  class="mt-0.5 truncate text-xs text-muted-foreground"
                >
                  {{
                    [getMovieSecondaryTitle(movie), getMovieSuggestionYear(movie)]
                      .filter(Boolean)
                      .join(' · ')
                  }}
                </p>
              </li>
            </ul>
          </div>
        </form>
      </div>
    </div>

    <section
      v-if="isMobileAccountOpen && userStore.currentUser"
      id="mobile-account-panel"
      ref="mobileAccountPanel"
      class="absolute left-0 right-0 top-full max-h-[50dvh] overflow-y-auto border-y border-border bg-surface lg:hidden"
      aria-labelledby="mobile-account-button"
    >
      <div class="page-shell py-4">
        <div class="flex flex-col items-center px-4 py-2 text-center">
          <UserAvatar
            :account="userStore.currentUser.account"
            :user-id="userStore.currentUser._id"
            size="large"
          />
          <p class="mt-3 text-lg font-semibold text-foreground">
            {{ userStore.currentUser.displayName || userStore.currentUser.account }}
          </p>
          <p class="mt-1 text-sm text-muted-foreground">@{{ userStore.currentUser.account }}</p>
        </div>

        <nav class="mt-3 border-t border-border pt-3" aria-label="會員導覽">
          <RouterLink v-slot="{ href, navigate }" to="/movie-space" custom>
            <a
              :href="href"
              :aria-current="isMobileDestinationCurrent('/movie-space') ? 'page' : undefined"
              class="block min-h-11 rounded-md px-4 py-3 font-medium text-foreground transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              @click="handleMobileAccountNavigation($event, navigate)"
            >
              會員中心
            </a>
          </RouterLink>
          <RouterLink v-slot="{ href, navigate }" to="/movie-space?view=favorites" custom>
            <a
              :href="href"
              :aria-current="
                isMobileDestinationCurrent('/movie-space?view=favorites') ? 'page' : undefined
              "
              class="mt-1 block min-h-11 rounded-md px-4 py-3 font-medium text-foreground transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              @click="handleMobileAccountNavigation($event, navigate)"
            >
              我的電影空間
            </a>
          </RouterLink>
          <RouterLink v-slot="{ href, navigate }" to="/movie-space?view=settings" custom>
            <a
              :href="href"
              :aria-current="
                isMobileDestinationCurrent('/movie-space?view=settings') ? 'page' : undefined
              "
              class="mt-1 block min-h-11 rounded-md px-4 py-3 font-medium text-foreground transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              @click="handleMobileAccountNavigation($event, navigate)"
            >
              帳號設定
            </a>
          </RouterLink>
        </nav>

        <div class="mt-3 border-t border-border pt-3">
          <button
            type="button"
            class="block min-h-11 w-full rounded-md px-4 py-3 text-left font-medium text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            @click="handleLogout"
          >
            登出
          </button>
        </div>
      </div>
    </section>

    <div
      v-if="isMenuOpen"
      id="mobile-navigation"
      class="absolute left-0 right-0 top-full max-h-[calc(100dvh-4.5rem)] overflow-y-auto border-y border-border bg-surface lg:hidden sm:max-h-[calc(100dvh-5rem)]"
    >
      <nav class="page-shell py-8" aria-label="行動版主要導覽">
        <ul class="grid gap-2">
          <li v-for="item in primaryMobileNavigationItems" :key="item.to">
            <RouterLink v-slot="{ href, navigate }" :to="item.to" custom>
              <a
                :href="href"
                :aria-current="isMobileDestinationCurrent(item.to) ? 'page' : undefined"
                :class="[
                  mobileNavigationLinkClass,
                  'px-3',
                  isMobileDestinationCurrent(item.to) ? mobileNavigationCurrentClass : '',
                ]"
                @click="handleMobileNavigation($event, navigate)"
              >
                {{ item.label }}
              </a>
            </RouterLink>
          </li>
          <li class="border-t border-border pt-3">
            <button
              type="button"
              class="flex min-h-11 w-full items-center justify-between rounded-md px-3 py-2.5 text-left font-medium text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              aria-controls="mobile-people-navigation"
              :aria-expanded="isMobilePeopleOpen"
              @click="isMobilePeopleOpen = !isMobilePeopleOpen"
            >
              探索同好
              <ChevronDown
                class="size-4 shrink-0 text-muted-foreground transition-transform"
                :class="{ 'rotate-180': isMobilePeopleOpen }"
                aria-hidden="true"
              />
            </button>
            <ul v-show="isMobilePeopleOpen" id="mobile-people-navigation" class="mt-1 grid gap-1">
              <li>
                <RouterLink v-slot="{ href, navigate }" to="/people" custom>
                  <a
                    :href="href"
                    :aria-current="isMobileDestinationCurrent('/people') ? 'page' : undefined"
                    :class="[
                      mobileNavigationLinkClass,
                      'px-5',
                      isMobileDestinationCurrent('/people') ? mobileNavigationCurrentClass : '',
                    ]"
                    @click="handleMobileNavigation($event, navigate)"
                  >
                    推薦同好
                  </a>
                </RouterLink>
              </li>
              <li>
                <RouterLink v-slot="{ href, navigate }" to="/encounter" custom>
                  <a
                    :href="href"
                    :aria-current="isMobileDestinationCurrent('/encounter') ? 'page' : undefined"
                    :class="[
                      mobileNavigationLinkClass,
                      'px-5',
                      isMobileDestinationCurrent('/encounter') ? mobileNavigationCurrentClass : '',
                    ]"
                    @click="handleMobileNavigation($event, navigate)"
                  >
                    今日雷達
                  </a>
                </RouterLink>
              </li>
            </ul>
          </li>
          <li>
            <RouterLink v-slot="{ href, navigate }" to="/announcements" custom>
              <a
                :href="href"
                :aria-current="isMobileDestinationCurrent('/announcements') ? 'page' : undefined"
                :class="[
                  mobileNavigationLinkClass,
                  'px-3',
                  isMobileDestinationCurrent('/announcements') ? mobileNavigationCurrentClass : '',
                ]"
                @click="handleMobileNavigation($event, navigate)"
              >
                公告中心
              </a>
            </RouterLink>
          </li>
        </ul>
      </nav>
    </div>
  </header>

  <div ref="mobileSearchRegion" class="border-b border-border bg-surface py-3 lg:hidden">
    <form
      ref="topSearchContainer"
      class="page-shell"
      role="search"
      aria-label="行動版電影搜尋"
      @submit.prevent="handleNavbarSearch"
    >
      <label class="sr-only" for="mobile-navbar-movie-search">搜尋電影</label>
      <div class="relative">
        <Search
          class="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          id="mobile-navbar-movie-search"
          v-model="navbarSearchQuery"
          class="min-h-11 w-full rounded-md border border-control bg-background py-2 pl-10 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          type="search"
          role="combobox"
          placeholder="搜尋電影..."
          autocomplete="off"
          aria-autocomplete="list"
          :aria-expanded="isSuggestionPopupOpen('top')"
          :aria-controls="getSuggestionListId('top')"
          :aria-activedescendant="getActiveSuggestionId('top')"
          @focus="openSearchSuggestions('top')"
          @keydown="handleSearchKeydown($event, 'top')"
        />

        <div
          v-if="isSuggestionPopupOpen('top')"
          :id="getSuggestionListId('top')"
          class="absolute left-0 right-0 top-[calc(100%+0.4rem)] z-30 overflow-hidden rounded-md border border-border bg-surface-raised shadow-[0_18px_44px_rgba(0,0,0,0.4)]"
          role="listbox"
          aria-label="電影搜尋建議"
        >
          <p
            v-if="isSearchLoading"
            class="px-4 py-3 text-sm text-muted-foreground"
            role="option"
            aria-disabled="true"
          >
            搜尋中…
          </p>
          <p
            v-else-if="hasSearchError"
            class="px-4 py-3 text-sm text-muted-foreground"
            role="option"
            aria-disabled="true"
          >
            搜尋暫時無法使用。
          </p>
          <p
            v-else-if="
              completedSearchQuery === trimmedSearchQuery && searchSuggestions.length === 0
            "
            class="px-4 py-3 text-sm text-muted-foreground"
            role="option"
            aria-disabled="true"
          >
            找不到相符的電影。
          </p>
          <ul v-else>
            <li
              v-for="(movie, index) in searchSuggestions"
              :id="getSuggestionOptionId('top', movie)"
              :key="movie.id"
              class="cursor-pointer border-b border-border px-4 py-3 last:border-b-0 hover:bg-surface"
              :class="index === activeSuggestionIndex ? 'bg-surface' : ''"
              role="option"
              :aria-selected="index === activeSuggestionIndex"
              @pointermove="activeSuggestionIndex = index"
              @click="selectSearchSuggestion(movie)"
            >
              <p class="truncate text-sm font-semibold text-foreground">
                {{ getMoviePrimaryTitle(movie) }}
              </p>
              <p
                v-if="getMovieSecondaryTitle(movie) || getMovieSuggestionYear(movie)"
                class="mt-0.5 truncate text-xs text-muted-foreground"
              >
                {{
                  [getMovieSecondaryTitle(movie), getMovieSuggestionYear(movie)]
                    .filter(Boolean)
                    .join(' · ')
                }}
              </p>
            </li>
          </ul>
        </div>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useQuery, useQueryCache } from '@pinia/colada'
import { useRoute, useRouter } from 'vue-router'
import MovieCarousel from '@/components/MovieCarousel.vue'
import CollectionFormDialog from '@/components/collections/CollectionFormDialog.vue'
import CollectionSummaryPreview from '@/components/collections/CollectionSummaryPreview.vue'
import PeopleCard from '@/components/user/PeopleCard.vue'
import UserAvatar from '@/components/user/UserAvatar.vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useFavorites } from '@/composables/useFavorites'
import { useMovieDna } from '@/composables/useMovieDna'
import { useCollections } from '@/composables/useCollections'
import { groupFavoriteMovies } from '@/lib/favoriteShelves'
import {
  followUser,
  getFollowSummary,
  getMyFollowerUsers,
  getMyFollowingUsers,
  unfollowUser,
} from '@/services/follows'
import { getMovieDetails, getMovieGenres, type Movie } from '@/services/tmdb'
import {
  createCollection,
  getDeletedCollections,
  getCollectionErrorMessage,
  restoreCollection,
  type DeletedCollectionSummary,
  type CollectionMetadataInput,
} from '@/services/collections'
import type { FollowingPerson, UserSummary } from '@/services/users'
import { useUserStore } from '@/stores/user'

type MovieSpaceView =
  'profile' | 'favorites' | 'collections' | 'following' | 'followers' | 'settings'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const queryCache = useQueryCache()
const { favoritesQuery, favoritesVisibilityQuery, updateFavoritesVisibilityMutation } =
  useFavorites({ includeVisibility: true })
const { movieDnaQuery } = useMovieDna()
const { collectionsQuery } = useCollections()
type NavigationItem = { id: MovieSpaceView; label: string; mobileLabel: string }
const profileNavigationItem: NavigationItem = {
  id: 'profile',
  label: '個人資料',
  mobileLabel: '個人資料',
}
const movieSpaceNavigationItems: NavigationItem[] = [
  { id: 'favorites', label: '我的收藏', mobileLabel: '收藏' },
  { id: 'collections', label: '收藏清單', mobileLabel: '清單' },
]
const socialNavigationItems: NavigationItem[] = [
  { id: 'following', label: '我的關注', mobileLabel: '關注' },
  { id: 'followers', label: '我的粉絲', mobileLabel: '粉絲' },
]
const settingsNavigationItem: NavigationItem = {
  id: 'settings',
  label: '帳號設定',
  mobileLabel: '設定',
}
const navigationItems = [
  profileNavigationItem,
  ...movieSpaceNavigationItems,
  ...socialNavigationItems,
  settingsNavigationItem,
]
const validViews = new Set(navigationItems.map((item) => item.id))
const initialView = String(route.query.view ?? 'profile') as MovieSpaceView
const activeView = ref<MovieSpaceView>(validViews.has(initialView) ? initialView : 'profile')
const favoriteMovies = ref<Movie[]>([])
const favoriteMoviesLoading = ref(false)
const favoriteMoviesError = ref(false)
const hasPartialFavoriteMovieError = ref(false)
const visibilitySaving = ref(false)
const visibilityError = ref('')
const visibilityMessage = ref('')
const publishFavoritesDialogOpen = ref(false)
const pendingUserId = ref<string | null>(null)
const networkActionError = ref('')
const displayNameInput = ref('')
const bioInput = ref('')
const profileSaving = ref(false)
const profileMessage = ref('')
const profileError = ref('')
const collectionDialogOpen = ref(false)
const collectionSaving = ref(false)
const collectionMutationError = ref('')
const collectionLifecycleMessage = ref('')
const recoveryOpen = ref(false)
const recoveryActionError = ref('')
const restoringCollectionId = ref<string | null>(null)
const mobileMemberNavigation = ref<HTMLElement | null>(null)
let favoriteMoviesRequestVersion = 0

function requireAuth() {
  const userId = userStore.currentUser?._id
  const accessToken = userStore.accessToken
  if (!userId || !accessToken) throw new Error('Authenticated user is required')
  return { userId, accessToken }
}

const genreQuery = useQuery({ key: () => ['tmdb', 'movie-genres'], query: getMovieGenres })
const followSummaryQuery = useQuery({
  key: () => ['follow-summary', userStore.currentUser?._id ?? 'anonymous'],
  enabled: () => Boolean(userStore.currentUser && userStore.accessToken),
  query: () => {
    const { userId, accessToken } = requireAuth()
    return getFollowSummary(userId, accessToken)
  },
})
const followingQuery = useQuery({
  key: () => ['my-network', userStore.currentUser?._id ?? 'anonymous', 'following'],
  enabled: () => Boolean(userStore.currentUser && userStore.accessToken),
  query: () => getMyFollowingUsers(requireAuth().accessToken),
})
const followersQuery = useQuery({
  key: () => ['my-network', userStore.currentUser?._id ?? 'anonymous', 'followers'],
  enabled: () => Boolean(userStore.currentUser && userStore.accessToken),
  query: () => getMyFollowerUsers(requireAuth().accessToken),
})
const deletedCollectionsQuery = useQuery({
  key: () => ['collections-deleted', userStore.currentUser?._id ?? 'anonymous'],
  enabled: () => Boolean(recoveryOpen.value && userStore.currentUser && userStore.accessToken),
  query: getDeletedCollections,
})

const favoriteRecords = computed(() => favoritesQuery.data.value ?? [])
const favoriteCount = computed(() => favoriteRecords.value.length)
const collections = computed(() => collectionsQuery.data.value ?? [])
const deletedCollections = computed<DeletedCollectionSummary[]>(
  () => deletedCollectionsQuery.data.value ?? [],
)
const favoritesVisibility = computed(() => favoritesVisibilityQuery.data.value)
const genreNames = computed(() =>
  Object.fromEntries((genreQuery.data.value ?? []).map((genre) => [genre.id, genre.name])),
)
const favoriteShelves = computed(() =>
  groupFavoriteMovies(favoriteRecords.value, favoriteMovies.value, genreNames.value),
)
const movieDna = computed(() => movieDnaQuery.data.value)
const displayedDnaGenres = computed(() =>
  (movieDna.value?.genres ?? []).slice(0, 5).map((genre) => ({
    ...genre,
    name: genreNames.value[genre.genreId] ?? '其他',
  })),
)
const profileDisplayName = computed(
  () =>
    userStore.currentUser?.displayName?.trim() || userStore.currentUser?.account || 'Movune User',
)
const networkUsers = computed(() =>
  activeView.value === 'following'
    ? (followingQuery.data.value ?? [])
    : (followersQuery.data.value ?? []),
)
const networkLoading = computed(() =>
  activeView.value === 'following'
    ? followingQuery.asyncStatus.value === 'loading'
    : followersQuery.asyncStatus.value === 'loading',
)
const networkError = computed(() =>
  activeView.value === 'following' ? followingQuery.error.value : followersQuery.error.value,
)

const getNetworkSharedDnaGenres = (person: UserSummary | FollowingPerson) =>
  'sharedDnaGenres' in person ? person.sharedDnaGenres : []

watch(
  () => route.query.view,
  (view) => {
    const candidate = String(view ?? 'profile') as MovieSpaceView
    activeView.value = validViews.has(candidate) ? candidate : 'profile'
  },
)

watch(
  () => route.query.collectionStatus,
  async (status) => {
    if (status !== 'deleted') return
    collectionLifecycleMessage.value = '收藏清單已刪除'
    const query = { ...route.query }
    delete query.collectionStatus
    await router.replace({ query })
  },
  { immediate: true },
)

watch(
  activeView,
  async () => {
    await nextTick()
    if (!window.matchMedia('(max-width: 1023px)').matches) return
    mobileMemberNavigation.value
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' })
  },
  { immediate: true, flush: 'post' },
)

watch(
  () => userStore.currentUser,
  (user) => {
    displayNameInput.value = user?.displayName?.trim() || user?.account || ''
    bioInput.value = user?.bio ?? ''
  },
  { immediate: true },
)

watch(
  () => favoriteRecords.value.map((favorite) => favorite.tmdbId).join(','),
  async () => {
    const requestVersion = ++favoriteMoviesRequestVersion
    favoriteMovies.value = []
    favoriteMoviesError.value = false
    hasPartialFavoriteMovieError.value = false
    if (!favoriteRecords.value.length) {
      favoriteMoviesLoading.value = false
      return
    }

    favoriteMoviesLoading.value = true
    const results = await Promise.allSettled(
      favoriteRecords.value.map((favorite) => getMovieDetails(favorite.tmdbId)),
    )
    if (requestVersion !== favoriteMoviesRequestVersion) return
    favoriteMovies.value = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    )
    const failedCount = results.length - favoriteMovies.value.length
    favoriteMoviesError.value = failedCount > 0 && favoriteMovies.value.length === 0
    hasPartialFavoriteMovieError.value = failedCount > 0 && favoriteMovies.value.length > 0
    favoriteMoviesLoading.value = false
  },
  { immediate: true },
)

async function selectView(view: MovieSpaceView) {
  activeView.value = view
  await router.replace({
    query: { ...route.query, view: view === 'profile' ? undefined : view },
  })
}

function openCollectionDialog() {
  collectionMutationError.value = ''
  collectionDialogOpen.value = true
}

function toggleRecovery() {
  recoveryActionError.value = ''
  recoveryOpen.value = !recoveryOpen.value
  if (
    recoveryOpen.value &&
    (deletedCollectionsQuery.data.value !== undefined || deletedCollectionsQuery.error.value)
  ) {
    void deletedCollectionsQuery.refresh()
  }
}

function formatDeletedAt(value: string | null) {
  if (!value) return '刪除時間未記錄'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '刪除時間未記錄'
  return `刪除於 ${new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium' }).format(date)}`
}

async function restoreDeletedCollection(collectionId: string) {
  if (restoringCollectionId.value) return
  restoringCollectionId.value = collectionId
  recoveryActionError.value = ''
  collectionLifecycleMessage.value = ''
  try {
    await restoreCollection(collectionId)
  } catch {
    recoveryActionError.value = '無法復原收藏清單，請稍後再試。'
    restoringCollectionId.value = null
    return
  }

  const refreshResults = await Promise.allSettled([
    queryCache.invalidateQueries({
      key: ['collections', userStore.currentUser?._id ?? 'anonymous'],
    }),
    queryCache.invalidateQueries({
      key: ['collections-deleted', userStore.currentUser?._id ?? 'anonymous'],
    }),
  ])
  restoringCollectionId.value = null
  collectionLifecycleMessage.value = '收藏清單已復原'
  if (refreshResults.some((result) => result.status === 'rejected')) {
    recoveryActionError.value = '收藏清單已復原，但清單目前無法重新載入。'
  }
}

async function handleCreateCollection(input: CollectionMetadataInput) {
  collectionSaving.value = true
  collectionMutationError.value = ''
  try {
    const collection = await createCollection(input)
    await queryCache.invalidateQueries({
      key: ['collections', userStore.currentUser?._id ?? 'anonymous'],
    })
    collectionDialogOpen.value = false
    await router.push({ name: 'collection-detail', params: { id: collection._id } })
  } catch (error) {
    collectionMutationError.value = getCollectionErrorMessage(
      error,
      '收藏清單無法建立，請稍後再試。',
    )
  } finally {
    collectionSaving.value = false
  }
}

async function applyFavoritesVisibility(visibility: 'private' | 'public') {
  if (visibilitySaving.value || favoritesVisibility.value === visibility) return
  visibilitySaving.value = true
  visibilityError.value = ''
  visibilityMessage.value = ''
  try {
    await updateFavoritesVisibilityMutation.mutateAsync(visibility)
    visibilityMessage.value =
      visibility === 'public'
        ? '你的「我的收藏」現在是公開狀態。'
        : '你的「我的收藏」現在只有你能查看。'
    publishFavoritesDialogOpen.value = false
  } catch {
    visibilityError.value = '收藏可見度無法更新，原有設定未變更。請稍後再試。'
  } finally {
    visibilitySaving.value = false
  }
}

function chooseFavoritesVisibility(visibility: 'private' | 'public') {
  visibilityError.value = ''
  visibilityMessage.value = ''
  if (visibility === 'public' && favoritesVisibility.value === 'private') {
    publishFavoritesDialogOpen.value = true
    return
  }
  void applyFavoritesVisibility(visibility)
}

async function toggleFollow(person: UserSummary) {
  if (pendingUserId.value) return
  const { accessToken } = requireAuth()
  pendingUserId.value = person._id
  networkActionError.value = ''
  try {
    if (person.isFollowing) await unfollowUser(person._id, accessToken)
    else await followUser(person._id, accessToken)
    queryCache.invalidateQueries({ key: ['my-network'] })
    queryCache.invalidateQueries({ key: ['follow-summary'] })
    queryCache.invalidateQueries({ key: ['people'] })
  } catch {
    networkActionError.value = '關注狀態無法更新，請稍後再試。'
  } finally {
    pendingUserId.value = null
  }
}

async function saveProfile() {
  profileMessage.value = ''
  profileError.value = ''
  const displayName = displayNameInput.value.trim()
  const bio = bioInput.value.trim()
  if (displayName.length < 2 || displayName.length > 40) {
    profileError.value = '顯示名稱需要 2–40 個字元。'
    return
  }
  if (bio.length > 160) {
    profileError.value = '個人簡介最多 160 個字元。'
    return
  }

  profileSaving.value = true
  try {
    await userStore.updateProfile({ displayName, bio })
    profileMessage.value = '個人資料已儲存。'
  } catch {
    profileError.value = '個人資料無法儲存，請稍後再試。'
  } finally {
    profileSaving.value = false
  }
}
</script>

<template>
  <div class="page-shell pb-10 pt-8 sm:pt-10">
    <header class="mb-5 lg:hidden">
      <p
        class="font-display-en text-xs font-semibold uppercase tracking-[0.18em] text-accent-caramel"
      >
        Member Center
      </p>
      <h1 class="mt-1 text-3xl font-bold tracking-tight">會員中心</h1>
    </header>

    <nav
      ref="mobileMemberNavigation"
      class="mb-6 max-w-full overflow-x-auto border-b border-border lg:hidden"
      aria-label="會員中心導覽"
    >
      <div class="flex min-w-max gap-2 px-1">
        <button
          v-for="item in navigationItems"
          :key="item.id"
          type="button"
          class="min-h-11 whitespace-nowrap border-b-2 px-3 text-sm font-semibold transition"
          :class="
            activeView === item.id
              ? 'border-accent-caramel text-foreground'
              : 'border-transparent text-muted-foreground'
          "
          :aria-current="activeView === item.id ? 'page' : undefined"
          @click="selectView(item.id)"
        >
          {{ item.label }}
        </button>
      </div>
    </nav>

    <div class="grid min-w-0 gap-8 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside
        class="hidden self-start rounded-lg border border-border bg-card p-5 shadow-[0_12px_36px_rgba(72,17,34,0.05)] lg:block"
      >
        <div class="flex items-center gap-3">
          <UserAvatar
            v-if="userStore.currentUser"
            :account="userStore.currentUser.account"
            :user-id="userStore.currentUser._id"
          />
          <div class="min-w-0">
            <p
              class="font-display-en text-xs font-semibold uppercase tracking-[0.14em] text-accent-caramel"
            >
              Member Center
            </p>
            <h1 class="truncate text-lg font-bold">{{ profileDisplayName }}</h1>
          </div>
        </div>
        <nav class="mt-5 border-t border-border pt-4" aria-label="會員中心導覽">
          <button
            type="button"
            class="mt-1 flex min-h-11 w-full items-center rounded-md border-l-2 px-3 text-left text-sm font-semibold transition"
            :class="
              activeView === profileNavigationItem.id
                ? 'border-accent-caramel bg-accent-caramel-soft text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground'
            "
            :aria-current="activeView === profileNavigationItem.id ? 'page' : undefined"
            @click="selectView(profileNavigationItem.id)"
          >
            {{ profileNavigationItem.label }}
          </button>
          <div class="mt-5">
            <p class="px-3 text-[0.68rem] font-bold tracking-[0.14em] text-accent-caramel/85">
              我的電影空間
            </p>
            <div class="mt-2 grid gap-1">
              <button
                v-for="item in movieSpaceNavigationItems"
                :key="item.id"
                type="button"
                class="flex min-h-11 w-full items-center rounded-md border-l-2 pl-7 pr-3 text-left text-sm font-semibold transition"
                :class="
                  activeView === item.id
                    ? 'border-accent-caramel bg-accent-caramel-soft text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground'
                "
                :aria-current="activeView === item.id ? 'page' : undefined"
                @click="selectView(item.id)"
              >
                {{ item.label }}
              </button>
            </div>
          </div>
          <div class="mt-5">
            <p class="px-3 text-[0.68rem] font-bold tracking-[0.14em] text-accent-caramel/85">
              社交
            </p>
            <div class="mt-2 grid gap-1">
              <button
                v-for="item in socialNavigationItems"
                :key="item.id"
                type="button"
                class="flex min-h-11 w-full items-center rounded-md border-l-2 pl-7 pr-3 text-left text-sm font-semibold transition"
                :class="
                  activeView === item.id
                    ? 'border-accent-caramel bg-accent-caramel-soft text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground'
                "
                :aria-current="activeView === item.id ? 'page' : undefined"
                @click="selectView(item.id)"
              >
                {{ item.label }}
              </button>
            </div>
          </div>
          <button
            type="button"
            class="mt-5 flex min-h-11 w-full items-center rounded-md border-l-2 px-3 text-left text-sm font-semibold transition"
            :class="
              activeView === settingsNavigationItem.id
                ? 'border-accent-caramel bg-accent-caramel-soft text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-secondary hover:text-foreground'
            "
            :aria-current="activeView === settingsNavigationItem.id ? 'page' : undefined"
            @click="selectView(settingsNavigationItem.id)"
          >
            {{ settingsNavigationItem.label }}
          </button>
        </nav>
      </aside>

      <main class="min-w-0">
        <template v-if="activeView === 'profile'">
          <section
            class="rounded-xl border border-border bg-card p-5 shadow-[0_12px_36px_rgba(72,17,34,0.05)] sm:p-8"
            aria-labelledby="profile-heading"
          >
            <div class="flex items-start gap-4 sm:items-center sm:gap-6">
              <UserAvatar
                v-if="userStore.currentUser"
                class="shrink-0"
                :account="userStore.currentUser.account"
                :user-id="userStore.currentUser._id"
                size="large"
              />
              <div class="min-w-0">
                <p
                  class="font-display-en text-xs font-semibold uppercase tracking-[0.16em] text-accent-caramel"
                >
                  Member Profile
                </p>
                <h2 id="profile-heading" class="mt-1 truncate text-2xl font-bold sm:text-3xl">
                  {{ profileDisplayName }}
                </h2>
                <p class="text-sm text-muted-foreground">@{{ userStore.currentUser?.account }}</p>
                <p class="mt-2 line-clamp-3 text-sm leading-6 text-muted-foreground">
                  {{ userStore.currentUser?.bio || '尚未填寫個人簡介。' }}
                </p>
              </div>
            </div>
          </section>

          <section
            class="mt-6 rounded-xl border border-border bg-card p-5 shadow-[0_12px_36px_rgba(72,17,34,0.05)] sm:p-8"
            aria-labelledby="movie-dna-heading"
          >
            <div class="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p
                  class="font-display-en text-xs font-semibold uppercase tracking-[0.16em] text-accent-caramel"
                >
                  Taste Profile
                </p>
                <h2 id="movie-dna-heading" class="mt-1 text-2xl font-bold">Movie DNA</h2>
              </div>
              <p class="text-sm text-muted-foreground">
                已分析 {{ movieDna?.analyzedFavorites ?? 0 }} 部收藏
              </p>
            </div>
            <div
              v-if="
                movieDnaQuery.asyncStatus.value === 'loading' ||
                genreQuery.asyncStatus.value === 'loading'
              "
              class="mt-5 rounded-lg bg-secondary/50 p-5 text-sm text-muted-foreground"
              role="status"
            >
              正在整理類型分布…
            </div>
            <div
              v-else-if="movieDnaQuery.error.value || genreQuery.error.value"
              class="mt-5 rounded-lg bg-secondary/50 p-5 text-sm text-muted-foreground"
              role="alert"
            >
              Movie DNA 目前無法載入。
            </div>
            <div
              v-else-if="!displayedDnaGenres.length"
              class="mt-5 rounded-lg bg-secondary/50 p-5 text-sm text-muted-foreground"
              role="status"
            >
              收藏包含類型資料的電影後，這裡會顯示類型分布。
            </div>
            <div v-else class="mt-5 grid gap-6 md:grid-cols-[10rem_1fr] md:items-center">
              <div
                class="hidden aspect-square items-center justify-center rounded-full border-2 border-dashed border-accent-caramel/35 bg-secondary/45 text-center md:flex"
                role="img"
                :aria-label="`主要類型為${displayedDnaGenres[0]?.name}`"
              >
                <div>
                  <strong class="block text-foreground">{{ displayedDnaGenres[0]?.name }}</strong
                  ><span class="text-2xl font-bold">{{ displayedDnaGenres[0]?.percentage }}%</span>
                </div>
              </div>
              <ol class="grid gap-3" aria-label="Movie DNA 類型分布">
                <li v-for="genre in displayedDnaGenres" :key="genre.genreId">
                  <div class="mb-1 flex justify-between gap-3 text-sm">
                    <span class="font-semibold">{{ genre.name }}</span
                    ><span class="text-muted-foreground">{{ genre.percentage }}%</span>
                  </div>
                  <div class="h-2 overflow-hidden rounded-full bg-secondary">
                    <div
                      class="h-full rounded-full bg-accent-caramel"
                      :style="{ width: `${genre.percentage}%` }"
                    ></div>
                  </div>
                </li>
              </ol>
            </div>
          </section>

          <section class="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="電影空間摘要">
            <article class="rounded-lg border border-border bg-card p-5">
              <h2 class="font-bold">收藏摘要</h2>
              <p class="mt-2 text-2xl font-bold text-foreground">{{ favoriteCount }} 部</p>
              <button
                type="button"
                class="mt-2 min-h-10 text-sm font-semibold text-foreground underline-offset-4 hover:text-accent-caramel hover:underline"
                @click="selectView('favorites')"
              >
                查看我的收藏 →
              </button>
            </article>
            <article class="rounded-lg border border-border bg-card p-5">
              <h2 class="font-bold">收藏清單</h2>
              <p class="mt-2 text-2xl font-bold text-foreground">{{ collections.length }} 份</p>
              <button
                type="button"
                class="mt-2 min-h-10 text-sm font-semibold text-foreground underline-offset-4 hover:text-accent-caramel hover:underline"
                @click="selectView('collections')"
              >
                管理收藏清單 →
              </button>
            </article>
            <article class="rounded-lg border border-border bg-card p-5">
              <h2 class="font-bold">社交連結</h2>
              <p class="mt-2 text-sm text-muted-foreground">
                <strong class="text-xl text-foreground">{{
                  followSummaryQuery.data.value?.followingCount ?? 0
                }}</strong>
                關注
                <span class="mx-2">·</span>
                <strong class="text-xl text-foreground">{{
                  followSummaryQuery.data.value?.followerCount ?? 0
                }}</strong>
                粉絲
              </p>
              <div class="mt-2 flex gap-4">
                <button
                  type="button"
                  class="min-h-10 text-sm font-semibold text-foreground underline-offset-4 hover:text-accent-caramel hover:underline"
                  @click="selectView('following')"
                >
                  查看關注
                </button>
                <button
                  type="button"
                  class="min-h-10 text-sm font-semibold text-foreground underline-offset-4 hover:text-accent-caramel hover:underline"
                  @click="selectView('followers')"
                >
                  查看粉絲
                </button>
              </div>
            </article>
          </section>
        </template>

        <section v-else-if="activeView === 'favorites'" aria-labelledby="favorites-heading">
          <div class="mb-5">
            <p
              class="font-display-en text-xs font-semibold uppercase tracking-[0.16em] text-accent-caramel"
            >
              Favorite Library
            </p>
            <h2 id="favorites-heading" class="mt-1 text-3xl font-bold">我的收藏</h2>
            <p class="mt-2 text-sm leading-6 text-muted-foreground">
              每部電影依第一個有效的已儲存類型歸入一個書架，並只出現一次。
            </p>
          </div>
          <section
            class="mb-6 rounded-xl border border-border bg-card p-5 shadow-[0_12px_36px_rgba(72,17,34,0.05)] sm:p-6"
            aria-labelledby="favorites-visibility-heading"
          >
            <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div class="max-w-2xl">
                <h3 id="favorites-visibility-heading" class="text-lg font-bold">
                  「我的收藏」可見度
                </h3>
                <p class="mt-2 text-sm leading-6 text-muted-foreground">
                  私人時，只有你能查看收藏關係；Movie DNA 與配對仍可在系統內部使用這些資料。
                  公開時，其他會員可在允許的公開電影空間中查看收藏，但不代表會被推薦或散布。
                </p>
              </div>
              <div
                v-if="favoritesVisibilityQuery.asyncStatus.value === 'loading'"
                class="text-sm text-muted-foreground"
                role="status"
              >
                正在載入可見度…
              </div>
              <div
                v-else-if="favoritesVisibilityQuery.error.value || !favoritesVisibility"
                class="text-sm text-destructive"
                role="alert"
              >
                可見度目前無法載入。
              </div>
              <div
                v-else
                class="inline-flex shrink-0 rounded-lg border border-control bg-background p-1"
                role="group"
                aria-label="選擇我的收藏可見度"
              >
                <button
                  v-for="option in ['private', 'public'] as const"
                  :key="option"
                  type="button"
                  class="min-h-11 rounded-md px-5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-wait disabled:opacity-60"
                  :class="
                    favoritesVisibility === option
                      ? 'bg-primary-cta text-primary-foreground'
                      : 'text-foreground hover:bg-secondary'
                  "
                  :aria-pressed="favoritesVisibility === option"
                  :disabled="visibilitySaving"
                  @click="chooseFavoritesVisibility(option)"
                >
                  {{ option === 'private' ? '私人' : '公開' }}
                </button>
              </div>
            </div>
            <p v-if="visibilityError" class="mt-3 text-sm text-destructive" role="alert">
              {{ visibilityError }}
            </p>
            <p
              v-else-if="visibilitySaving || visibilityMessage"
              class="mt-3 text-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {{ visibilitySaving ? '正在更新可見度…' : visibilityMessage }}
            </p>
          </section>
          <div
            v-if="
              favoritesQuery.asyncStatus.value === 'loading' ||
              favoriteMoviesLoading ||
              genreQuery.asyncStatus.value === 'loading'
            "
            class="rounded-lg border border-border bg-card p-8 text-muted-foreground"
            role="status"
          >
            正在整理收藏書架…
          </div>
          <div
            v-else-if="favoritesQuery.error.value || favoriteMoviesError || genreQuery.error.value"
            class="rounded-lg border border-border bg-card p-8 text-muted-foreground"
            role="alert"
          >
            收藏清單目前無法載入。
          </div>
          <div
            v-else-if="!favoriteCount"
            class="rounded-lg border border-border bg-card p-10 text-center"
          >
            <p class="font-semibold">目前尚未收藏電影</p>
            <RouterLink
              to="/explore"
              class="mt-4 inline-flex min-h-11 items-center rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground hover:bg-primary-cta-hover active:bg-primary-cta-pressed"
              >探索電影</RouterLink
            >
          </div>
          <div v-else class="space-y-7">
            <p
              v-if="hasPartialFavoriteMovieError"
              class="rounded-lg bg-secondary/50 p-4 text-sm text-muted-foreground"
              role="status"
            >
              部分電影資料暫時無法載入，已顯示可取得的收藏。
            </p>
            <section
              v-for="shelf in favoriteShelves"
              :key="shelf.id"
              class="rounded-lg border border-border bg-card p-4 sm:p-5"
              :aria-labelledby="`shelf-${shelf.id}`"
            >
              <div class="mb-4 flex items-baseline justify-between gap-3">
                <h3 :id="`shelf-${shelf.id}`" class="text-xl font-bold">{{ shelf.name }}</h3>
                <span class="text-sm text-muted-foreground">{{ shelf.movies.length }} 部</span>
              </div>
              <MovieCarousel
                :movies="shelf.movies"
                :label="`${shelf.name}收藏電影`"
                :desktop-columns="4"
                shelf
              />
            </section>
          </div>
        </section>

        <section v-else-if="activeView === 'collections'" aria-labelledby="collections-heading">
          <div class="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p
                class="font-display-en text-xs font-semibold uppercase tracking-[0.16em] text-accent-caramel"
              >
                Curated Collections
              </p>
              <h2 id="collections-heading" class="mt-1 text-3xl font-bold">收藏清單</h2>
              <p class="mt-2 text-sm leading-6 text-muted-foreground">
                自由整理電影與順序。收藏清單不會改變「我的收藏」或 Movie DNA。
              </p>
            </div>
            <button
              type="button"
              class="min-h-11 shrink-0 rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground hover:bg-primary-cta-hover active:bg-primary-cta-pressed"
              @click="openCollectionDialog"
            >
              建立收藏清單
            </button>
          </div>

          <p
            v-if="collectionLifecycleMessage"
            class="mb-5 rounded-md border border-accent-caramel/30 bg-accent-caramel-soft px-4 py-3 text-sm font-semibold"
            role="status"
            aria-live="polite"
          >
            {{ collectionLifecycleMessage }}
          </p>

          <div
            v-if="collectionsQuery.asyncStatus.value === 'loading'"
            class="grid gap-4 sm:grid-cols-2"
            aria-label="收藏清單載入中"
          >
            <div
              v-for="index in 4"
              :key="index"
              class="h-44 animate-pulse rounded-lg bg-secondary"
            ></div>
          </div>
          <div
            v-else-if="collectionsQuery.error.value"
            class="rounded-lg border border-border bg-card p-8 text-center"
            role="alert"
          >
            <p class="font-semibold">收藏清單目前無法載入。</p>
            <button
              type="button"
              class="mt-4 min-h-11 rounded-md border border-control px-5 font-semibold"
              @click="collectionsQuery.refresh()"
            >
              再試一次
            </button>
          </div>
          <div
            v-else-if="collections.length === 0"
            class="rounded-lg border border-border bg-card px-6 py-12 text-center"
            role="status"
          >
            <p class="text-lg font-semibold">建立第一份收藏清單</p>
            <p class="mt-2 text-sm text-muted-foreground">
              依主題、心情或片單自由整理；新清單預設為私人。
            </p>
            <button
              type="button"
              class="mt-5 min-h-11 rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground"
              @click="openCollectionDialog"
            >
              建立收藏清單
            </button>
          </div>
          <ul v-else class="grid gap-4 sm:grid-cols-2">
            <li v-for="collection in collections" :key="collection._id">
              <RouterLink
                :to="{ name: 'collection-detail', params: { id: collection._id } }"
                class="group flex min-w-0 flex-col rounded-lg border border-border bg-card p-5 shadow-[0_12px_36px_rgba(72,17,34,0.04)] transition hover:border-accent-caramel/60 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <div class="flex items-start justify-between gap-3">
                  <h3 class="min-w-0 break-words text-xl font-bold group-hover:text-accent-caramel">
                    {{ collection.name }}
                  </h3>
                  <span
                    class="shrink-0 rounded-full bg-secondary px-3 py-1 text-xs font-semibold text-muted-foreground"
                  >
                    {{ collection.visibility === 'public' ? '公開' : '私人' }}
                  </span>
                </div>
                <p class="mt-2 text-sm font-semibold text-muted-foreground">
                  {{ collection.movieCount }} 部電影
                </p>
                <CollectionSummaryPreview
                  class="mt-4"
                  :collection-name="collection.name"
                  :movie-count="collection.movieCount"
                  :preview-movies="collection.previewMovies"
                />
                <p class="mt-3 line-clamp-3 text-sm leading-6 text-muted-foreground">
                  {{ collection.description || '尚未加入描述。' }}
                </p>
                <span class="mt-auto pt-4 text-sm font-semibold">查看清單 →</span>
              </RouterLink>
            </li>
          </ul>

          <section
            class="mt-8 border-t border-border pt-6"
            aria-labelledby="deleted-collections-heading"
          >
            <div class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 id="deleted-collections-heading" class="text-lg font-bold">已刪除的收藏清單</h3>
                <p class="mt-1 text-sm leading-6 text-muted-foreground">
                  在這裡找回先前刪除的收藏清單；原有電影與順序會保留。
                </p>
              </div>
              <button
                type="button"
                class="min-h-11 shrink-0 rounded-md border border-control px-4 text-sm font-semibold hover:border-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                :aria-expanded="recoveryOpen"
                aria-controls="deleted-collections-panel"
                @click="toggleRecovery"
              >
                {{ recoveryOpen ? '收起已刪除清單' : '查看已刪除清單' }}
              </button>
            </div>

            <div v-if="recoveryOpen" id="deleted-collections-panel" class="mt-5">
              <div
                v-if="deletedCollectionsQuery.asyncStatus.value === 'loading'"
                class="space-y-3"
                role="status"
                aria-label="已刪除的收藏清單載入中"
              >
                <div
                  v-for="index in 2"
                  :key="index"
                  class="h-28 animate-pulse rounded-lg bg-secondary"
                ></div>
              </div>
              <div
                v-else-if="deletedCollectionsQuery.error.value"
                class="rounded-lg border border-border bg-card p-6"
                role="alert"
              >
                <p class="font-semibold">已刪除的收藏清單目前無法載入。</p>
                <button
                  type="button"
                  class="mt-3 min-h-11 rounded-md border border-control px-4 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  @click="deletedCollectionsQuery.refresh()"
                >
                  再試一次
                </button>
              </div>
              <div
                v-else-if="deletedCollections.length === 0"
                class="rounded-lg border border-border bg-card px-6 py-8 text-center text-muted-foreground"
                role="status"
              >
                沒有已刪除的收藏清單
              </div>
              <template v-else>
                <p v-if="recoveryActionError" class="mb-4 text-sm text-destructive" role="alert">
                  {{ recoveryActionError }}
                </p>
                <ul class="grid gap-3" aria-label="已刪除的收藏清單">
                  <li
                    v-for="deletedCollection in deletedCollections"
                    :key="deletedCollection._id"
                    class="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div class="min-w-0">
                      <h4 class="break-words font-bold">{{ deletedCollection.name }}</h4>
                      <p
                        v-if="deletedCollection.description"
                        class="mt-1 break-words text-sm leading-6 text-muted-foreground"
                      >
                        {{ deletedCollection.description }}
                      </p>
                      <p class="mt-2 text-xs text-muted-foreground">
                        {{ formatDeletedAt(deletedCollection.deletedAt) }} · 可復原
                      </p>
                    </div>
                    <button
                      type="button"
                      class="min-h-11 shrink-0 rounded-md border border-accent-caramel/60 px-4 text-sm font-semibold text-accent-caramel hover:bg-accent-caramel-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-wait disabled:opacity-60"
                      :disabled="restoringCollectionId !== null"
                      :aria-busy="restoringCollectionId === deletedCollection._id"
                      :aria-label="`復原收藏清單「${deletedCollection.name}」`"
                      @click="restoreDeletedCollection(deletedCollection._id)"
                    >
                      {{
                        restoringCollectionId === deletedCollection._id ? '復原中…' : '復原收藏清單'
                      }}
                    </button>
                  </li>
                </ul>
              </template>
            </div>
          </section>
        </section>

        <section
          v-else-if="activeView === 'following' || activeView === 'followers'"
          :aria-labelledby="`${activeView}-heading`"
        >
          <div class="mb-5">
            <p
              class="font-display-en text-xs font-semibold uppercase tracking-[0.16em] text-accent-caramel"
            >
              Connections
            </p>
            <h2 :id="`${activeView}-heading`" class="mt-1 text-3xl font-bold">
              {{ activeView === 'following' ? '我的關注' : '我的粉絲' }}
            </h2>
          </div>
          <p v-if="networkActionError" class="mb-4 text-sm text-destructive" role="alert">
            {{ networkActionError }}
          </p>
          <div v-if="networkLoading" class="grid gap-4 md:grid-cols-2" aria-label="會員清單載入中">
            <div
              v-for="index in 4"
              :key="index"
              class="h-64 animate-pulse rounded-lg bg-secondary"
            ></div>
          </div>
          <div
            v-else-if="networkError"
            class="rounded-lg border border-border bg-card p-8 text-muted-foreground"
            role="alert"
          >
            會員清單目前無法載入。
          </div>
          <div
            v-else-if="!networkUsers.length"
            class="rounded-lg border border-border bg-card p-10 text-center text-muted-foreground"
            role="status"
          >
            {{ activeView === 'following' ? '目前尚未關注其他會員。' : '目前尚沒有粉絲。' }}
          </div>
          <ul v-else class="grid gap-4 md:grid-cols-2">
            <li v-for="person in networkUsers" :key="person._id">
              <PeopleCard
                :person="person"
                :genre-names="genreNames"
                :pending="pendingUserId === person._id"
                :recommendation-mode="
                  activeView === 'following' ? 'following-shared-dna' : 'relationship-only'
                "
                :contextual-shared-dna-genres="getNetworkSharedDnaGenres(person)"
                @toggle-follow="toggleFollow"
              />
            </li>
          </ul>
        </section>

        <template v-else>
          <header class="mb-5">
            <p
              class="font-display-en text-xs font-semibold uppercase tracking-[0.16em] text-accent-caramel"
            >
              Account Settings
            </p>
            <h2 id="settings-heading" class="mt-1 text-3xl font-bold">帳號設定</h2>
            <p class="mt-2 text-sm leading-6 text-muted-foreground">
              修改公開顯示名稱與個人簡介。登入帳號 @{{ userStore.currentUser?.account }} 不會變更。
            </p>
          </header>
          <section
            class="w-full rounded-xl border border-border bg-card p-5 shadow-[0_12px_36px_rgba(72,17,34,0.05)] sm:p-8"
            aria-labelledby="settings-heading"
          >
            <form class="grid gap-5" @submit.prevent="saveProfile">
              <label class="grid gap-2 font-semibold"
                >顯示名稱
                <input
                  v-model="displayNameInput"
                  type="text"
                  minlength="2"
                  maxlength="40"
                  required
                  class="min-h-11 rounded-md border border-control bg-card px-4 font-normal focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
                  aria-describedby="display-name-help"
                />
                <span id="display-name-help" class="text-xs font-normal text-muted-foreground"
                  >2–40 個字元；這不是登入帳號。</span
                >
              </label>
              <label class="grid gap-2 font-semibold"
                >個人簡介
                <textarea
                  v-model="bioInput"
                  maxlength="160"
                  rows="5"
                  class="resize-y rounded-md border border-control bg-card px-4 py-3 font-normal focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
                  aria-describedby="bio-count"
                ></textarea>
                <span id="bio-count" class="text-right text-xs font-normal text-muted-foreground"
                  >{{ bioInput.length }} / 160</span
                >
              </label>
              <p v-if="profileError" class="text-sm text-destructive" role="alert">
                {{ profileError }}
              </p>
              <p
                v-if="profileMessage"
                class="text-sm text-emerald-400"
                role="status"
                aria-live="polite"
              >
                {{ profileMessage }}
              </p>
              <button
                type="submit"
                class="min-h-11 justify-self-start rounded-md bg-primary-cta px-6 font-semibold text-primary-foreground hover:bg-primary-cta-hover active:bg-primary-cta-pressed disabled:cursor-wait disabled:opacity-60"
                :disabled="profileSaving"
                :aria-busy="profileSaving"
              >
                {{ profileSaving ? '儲存中…' : '儲存變更' }}
              </button>
            </form>
          </section>
        </template>
      </main>
    </div>
    <CollectionFormDialog
      v-model:open="collectionDialogOpen"
      :saving="collectionSaving"
      :error="collectionMutationError"
      @submit="handleCreateCollection"
    />
    <Dialog v-model:open="publishFavoritesDialogOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>將「我的收藏」設為公開？</DialogTitle>
          <DialogDescription>
            你目前的所有收藏，以及之後新增的收藏，都會讓其他會員透過允許的公開電影空間查看；直到你再次改回私人為止。
          </DialogDescription>
        </DialogHeader>
        <p v-if="visibilityError" class="text-sm text-destructive" role="alert">
          {{ visibilityError }}
        </p>
        <DialogFooter>
          <button
            type="button"
            class="min-h-11 rounded-md border border-control px-5 font-semibold hover:bg-secondary disabled:opacity-60"
            :disabled="visibilitySaving"
            @click="publishFavoritesDialogOpen = false"
          >
            取消
          </button>
          <button
            type="button"
            class="min-h-11 rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground hover:bg-primary-cta-hover active:bg-primary-cta-pressed disabled:cursor-wait disabled:opacity-60"
            :disabled="visibilitySaving"
            :aria-busy="visibilitySaving"
            @click="applyFavoritesVisibility('public')"
          >
            {{ visibilitySaving ? '設定中…' : '設為公開' }}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

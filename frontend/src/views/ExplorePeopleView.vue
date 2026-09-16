<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery, useQueryCache } from '@pinia/colada'
import PeopleCard from '@/components/user/PeopleCard.vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { followUser, unfollowUser } from '@/services/follows'
import { getMovieGenres } from '@/services/tmdb'
import {
  getFormalRecommendations,
  getUsers,
  type FormalRecommendationItem,
  type UserSummary,
} from '@/services/users'
import { useUserStore } from '@/stores/user'

type FollowingFilter = 'all' | 'following' | 'not-following'
type ExplorePeopleMode = 'formal' | 'discovery'

const userStore = useUserStore()
const queryCache = useQueryCache()
const mode = ref<ExplorePeopleMode>('formal')
const followingFilter = ref<FollowingFilter>('all')
const genreIds = ref<number[]>([])
const sharedFavoritesOnly = ref(false)
const formalPage = ref(1)
const discoveryPage = ref(1)
const pendingUserId = ref<string | null>(null)
const actionError = ref('')
const mobileFilterOpen = ref(false)
const genreQuery = useQuery({ key: () => ['tmdb', 'movie-genres'], query: getMovieGenres })

const formalRecommendationsQuery = useQuery({
  key: () => [
    'formal-recommendations',
    userStore.currentUser?._id ?? 'anonymous',
    formalPage.value,
  ],
  enabled: () => Boolean(mode.value === 'formal' && userStore.currentUser && userStore.accessToken),
  query: () => {
    const accessToken = userStore.accessToken
    if (!accessToken) throw new Error('Access token is required')
    return getFormalRecommendations({ page: formalPage.value, limit: 12 }, accessToken)
  },
})

const discoveryQuery = useQuery({
  key: () => [
    'people',
    userStore.currentUser?._id ?? 'anonymous',
    followingFilter.value,
    genreIds.value.join(','),
    sharedFavoritesOnly.value,
    discoveryPage.value,
  ],
  enabled: () =>
    Boolean(mode.value === 'discovery' && userStore.currentUser && userStore.accessToken),
  query: () => {
    const accessToken = userStore.accessToken
    if (!accessToken) throw new Error('Access token is required')
    return getUsers(
      {
        following: followingFilter.value,
        genreIds: genreIds.value,
        sharedFavorites: sharedFavoritesOnly.value,
        page: discoveryPage.value,
        limit: 12,
      },
      accessToken,
    )
  },
})

const formalRecommendations = computed(() => formalRecommendationsQuery.data.value?.items ?? [])
const formalStatus = computed(() => formalRecommendationsQuery.data.value?.status)
const formalPagination = computed(() => formalRecommendationsQuery.data.value?.pagination)
const formalLoading = computed(() => formalRecommendationsQuery.asyncStatus.value === 'loading')
const formalError = computed(() => Boolean(formalRecommendationsQuery.error.value))
const people = computed(() => discoveryQuery.data.value?.users ?? [])
const discoveryPagination = computed(() => discoveryQuery.data.value?.pagination)
const discoveryLoading = computed(() => discoveryQuery.asyncStatus.value === 'loading')
const discoveryError = computed(() => Boolean(discoveryQuery.error.value))
const genres = computed(() => genreQuery.data.value ?? [])
const genreNames = computed(() =>
  Object.fromEntries(genres.value.map((genre) => [genre.id, genre.name])),
)
const hasActiveFilters = computed(
  () => genreIds.value.length > 0 || followingFilter.value !== 'all' || sharedFavoritesOnly.value,
)

function resetFilters() {
  followingFilter.value = 'all'
  genreIds.value = []
  sharedFavoritesOnly.value = false
  discoveryPage.value = 1
}

watch(
  [followingFilter, genreIds, sharedFavoritesOnly],
  () => {
    discoveryPage.value = 1
  },
  { deep: true },
)

function showDiscovery() {
  mode.value = 'discovery'
}

async function toggleFollow(user: UserSummary | FormalRecommendationItem) {
  const accessToken = userStore.accessToken
  if (!accessToken || pendingUserId.value) return
  pendingUserId.value = user._id
  actionError.value = ''

  try {
    const wasFollowing = user.isFollowing
    if (wasFollowing) await unfollowUser(user._id, accessToken)
    else await followUser(user._id, accessToken)
    user.isFollowing = !wasFollowing
    user.followerCount = Math.max(0, user.followerCount + (wasFollowing ? -1 : 1))
    queryCache.invalidateQueries({ key: ['home-people'] })
    queryCache.invalidateQueries({ key: ['my-network'] })
    queryCache.invalidateQueries({ key: ['follow-summary'] })
  } catch {
    actionError.value = '關注狀態無法更新，請稍後再試。'
  } finally {
    pendingUserId.value = null
  }
}
</script>

<template>
  <div class="page-shell pb-12 pt-8 sm:pt-10">
    <header class="max-w-3xl">
      <p
        class="font-display-en text-sm font-semibold uppercase tracking-[0.2em] text-accent-caramel"
      >
        Explore People
      </p>
      <h1
        class="mt-2 font-display-zh text-3xl font-semibold tracking-tight text-foreground sm:text-4xl"
      >
        探索電影同好
      </h1>
      <p class="mt-3 text-base leading-7 text-muted-foreground">
        從 Movie DNA 找到推薦同好，也能瀏覽更多喜歡電影的會員。
      </p>
    </header>

    <nav class="mt-7 flex flex-wrap gap-2" aria-label="同好探索方式">
      <button
        type="button"
        class="min-h-11 rounded-md border px-5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        :class="
          mode === 'formal'
            ? 'border-primary-cta bg-primary-cta text-primary-foreground'
            : 'border-control bg-card text-foreground hover:bg-surface-raised'
        "
        :aria-pressed="mode === 'formal'"
        @click="mode = 'formal'"
      >
        推薦同好
      </button>
      <button
        type="button"
        class="min-h-11 rounded-md border px-5 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        :class="
          mode === 'discovery'
            ? 'border-primary-cta bg-primary-cta text-primary-foreground'
            : 'border-control bg-card text-foreground hover:bg-surface-raised'
        "
        :aria-pressed="mode === 'discovery'"
        @click="showDiscovery"
      >
        探索其他會員
      </button>
    </nav>

    <div v-if="mode === 'discovery'" class="mt-6 lg:hidden">
      <button
        type="button"
        class="min-h-11 w-full rounded-md border border-control bg-card font-semibold text-foreground hover:bg-surface-raised"
        @click="mobileFilterOpen = true"
      >
        篩選<span v-if="hasActiveFilters" class="ml-1">•</span>
      </button>
    </div>

    <Dialog v-model:open="mobileFilterOpen">
      <DialogContent
        class="bottom-0 left-0 top-auto max-h-[85dvh] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-b-none rounded-t-xl p-5 lg:hidden"
        style="inset: auto 0 0 0; width: 100%; max-width: none; transform: none"
      >
        <DialogHeader>
          <DialogTitle>篩選電影同好</DialogTitle>
          <DialogDescription>共同資訊只使用對方明確公開的收藏。</DialogDescription>
        </DialogHeader>

        <fieldset class="mt-5 border-t border-border pt-5">
          <legend class="text-sm font-semibold text-foreground">關注狀態</legend>
          <div class="mt-2 grid gap-1">
            <label
              v-for="option in [
                { value: 'all', label: '全部' },
                { value: 'following', label: '已關注' },
                { value: 'not-following', label: '尚未關注' },
              ] as const"
              :key="option.value"
              class="flex min-h-10 items-center gap-3 rounded-md px-2"
            >
              <input
                v-model="followingFilter"
                class="accent-accent-caramel"
                type="radio"
                :value="option.value"
              />
              <span>{{ option.label }}</span>
            </label>
          </div>
        </fieldset>

        <label class="mt-4 flex min-h-11 items-center gap-3 rounded-md bg-secondary/60 px-3">
          <input
            v-model="sharedFavoritesOnly"
            type="checkbox"
            class="size-4 accent-accent-caramel"
          />
          <span class="font-semibold">只顯示有共同收藏的會員</span>
        </label>

        <fieldset class="mt-5 border-t border-border pt-5">
          <legend class="text-sm font-semibold text-foreground">收藏類型</legend>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">依會員公開收藏的電影類型篩選。</p>
          <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
            <label
              v-for="genre in genres"
              :key="genre.id"
              class="flex min-h-10 items-center gap-2 rounded-md px-2"
            >
              <input
                v-model="genreIds"
                type="checkbox"
                :value="genre.id"
                class="size-4 accent-accent-caramel"
              />
              <span class="text-sm">{{ genre.name }}</span>
            </label>
          </div>
        </fieldset>

        <div class="sticky bottom-0 mt-5 flex gap-3 bg-background pt-3">
          <button
            type="button"
            class="min-h-11 flex-1 rounded-md border border-control font-semibold text-foreground hover:bg-surface-raised disabled:opacity-40"
            :disabled="!hasActiveFilters"
            @click="resetFilters"
          >
            清除篩選
          </button>
          <button
            type="button"
            class="min-h-11 flex-1 rounded-md bg-primary-cta font-semibold text-primary-foreground hover:bg-primary-cta-hover active:bg-primary-cta-pressed"
            @click="mobileFilterOpen = false"
          >
            套用
          </button>
        </div>
      </DialogContent>
    </Dialog>

    <p v-if="actionError" class="mt-5 text-sm font-medium text-destructive" role="alert">
      {{ actionError }}
    </p>

    <main v-if="mode === 'formal'" class="mt-8 min-w-0" aria-labelledby="formal-heading">
      <div class="mb-5 border-b border-border pb-4">
        <h2 id="formal-heading" class="text-lg font-semibold tracking-tight">推薦同好</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          依你的 Movie DNA 整理，順序由推薦系統統一決定。
        </p>
      </div>

      <div
        v-if="formalLoading"
        class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
        aria-label="推薦同好載入中"
      >
        <div
          v-for="index in 6"
          :key="index"
          class="h-64 animate-pulse rounded-lg bg-secondary"
        ></div>
      </div>
      <div
        v-else-if="formalError || genreQuery.error.value"
        class="rounded-lg border border-border bg-card px-6 py-14 text-center"
        role="alert"
      >
        <p class="font-semibold text-foreground">推薦同好目前無法載入。</p>
        <p class="mt-2 text-sm text-muted-foreground">請稍後再試，或先探索其他會員。</p>
        <button
          type="button"
          class="mt-5 min-h-11 rounded-md border border-control px-5 font-semibold text-foreground hover:bg-surface-raised"
          @click="showDiscovery"
        >
          探索其他會員
        </button>
      </div>
      <div
        v-else-if="formalStatus === 'insufficient_signal'"
        class="rounded-lg border border-border bg-card px-6 py-14 text-center"
        role="status"
      >
        <p class="font-semibold text-foreground">需要更多電影收藏，才能建立足夠的推薦依據。</p>
        <p class="mt-2 text-sm text-muted-foreground">
          收藏幾部真正喜歡的電影，Movie DNA 會逐漸形成。
        </p>
        <RouterLink
          to="/explore"
          class="mt-5 inline-flex min-h-11 items-center rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground hover:bg-primary-cta-hover"
        >
          探索電影
        </RouterLink>
      </div>
      <div
        v-else-if="formalStatus === 'eligible' && formalRecommendations.length === 0"
        class="rounded-lg border border-border bg-card px-6 py-14 text-center"
        role="status"
      >
        <p class="font-semibold text-foreground">目前還沒有符合正式推薦條件的同好。</p>
        <p class="mt-2 text-sm text-muted-foreground">你仍可以從更多會員中慢慢找到共同話題。</p>
        <button
          type="button"
          class="mt-5 min-h-11 rounded-md border border-control px-5 font-semibold text-foreground hover:bg-surface-raised"
          @click="showDiscovery"
        >
          探索其他會員
        </button>
      </div>
      <section v-else-if="formalRecommendations.length > 0" aria-label="正式推薦同好清單">
        <ul class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <li v-for="person in formalRecommendations" :key="person._id">
            <PeopleCard
              :person="person"
              :genre-names="genreNames"
              :pending="pendingUserId === person._id"
              recommendation-mode="formal"
              :formal-shared-dna-genres="person.sharedDnaGenres"
              :formal-revealable-shared-favorite-tmdb-ids="person.revealableSharedFavoriteTmdbIds"
              @toggle-follow="toggleFollow"
            />
          </li>
        </ul>

        <nav
          v-if="formalPagination && formalPagination.totalPages > 1"
          class="mt-8 flex items-center justify-center gap-4"
          aria-label="推薦同好分頁"
        >
          <button
            type="button"
            class="min-h-11 rounded-md border border-control bg-card px-5 font-semibold text-foreground hover:bg-surface-raised disabled:opacity-40"
            :disabled="formalPage <= 1"
            @click="formalPage -= 1"
          >
            上一頁
          </button>
          <span class="text-sm text-muted-foreground">
            第 {{ formalPage }} / {{ formalPagination.totalPages }} 頁
          </span>
          <button
            type="button"
            class="min-h-11 rounded-md border border-control bg-card px-5 font-semibold text-foreground hover:bg-surface-raised disabled:opacity-40"
            :disabled="formalPage >= formalPagination.totalPages"
            @click="formalPage += 1"
          >
            下一頁
          </button>
        </nav>
      </section>
    </main>

    <div v-else class="mt-8 grid min-w-0 gap-8 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside
        class="hidden self-start rounded-lg border border-border bg-card p-5 shadow-[0_12px_36px_rgba(72,17,34,0.05)] lg:block"
        aria-label="電影同好篩選"
      >
        <p
          class="font-display-en text-xs font-semibold uppercase tracking-[0.18em] text-accent-caramel"
        >
          Discovery
        </p>
        <h2 class="mt-2 text-lg font-semibold">篩選條件</h2>

        <fieldset class="mt-5 border-t border-border pt-5">
          <legend class="text-sm font-semibold text-foreground">關注狀態</legend>
          <div class="mt-2">
            <label
              v-for="option in [
                { value: 'all', label: '全部' },
                { value: 'following', label: '已關注' },
                { value: 'not-following', label: '尚未關注' },
              ] as const"
              :key="option.value"
              class="flex min-h-10 items-center gap-3 rounded-md px-2 hover:bg-secondary"
            >
              <input
                v-model="followingFilter"
                class="accent-accent-caramel"
                type="radio"
                :value="option.value"
              />
              <span class="text-sm">{{ option.label }}</span>
            </label>
          </div>
        </fieldset>

        <label class="mt-4 flex items-start gap-3 border-t border-border pt-5">
          <input
            v-model="sharedFavoritesOnly"
            type="checkbox"
            class="mt-0.5 size-4 accent-accent-caramel"
          />
          <span class="text-sm font-semibold">有共同收藏</span>
        </label>

        <fieldset class="mt-5 border-t border-border pt-5">
          <legend class="text-sm font-semibold text-foreground">收藏類型</legend>
          <div class="mt-2 max-h-64 overflow-y-auto pr-1">
            <label
              v-for="genre in genres"
              :key="genre.id"
              class="flex min-h-9 items-center gap-3 rounded-md px-2 hover:bg-secondary"
            >
              <input
                v-model="genreIds"
                type="checkbox"
                :value="genre.id"
                class="size-4 accent-accent-caramel"
              />
              <span class="text-sm">{{ genre.name }}</span>
            </label>
          </div>
        </fieldset>

        <p class="mt-4 text-xs leading-5 text-muted-foreground">依會員公開收藏的電影類型篩選。</p>
        <button
          type="button"
          class="mt-5 min-h-10 w-full rounded-md border border-control text-sm font-semibold text-foreground hover:bg-surface-raised disabled:opacity-40"
          :disabled="!hasActiveFilters"
          @click="resetFilters"
        >
          清除篩選
        </button>
      </aside>

      <main class="min-w-0">
        <div class="mb-5 flex items-end justify-between gap-3 border-b border-border pb-4">
          <div>
            <h2 class="text-lg font-semibold tracking-tight">探索其他會員</h2>
            <p class="mt-1 text-sm text-muted-foreground">
              {{
                discoveryPagination
                  ? `共 ${discoveryPagination.total.toLocaleString()} 位`
                  : '正在整理會員結果'
              }}
            </p>
          </div>
        </div>

        <div
          v-if="discoveryLoading"
          class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
          aria-label="會員清單載入中"
        >
          <div
            v-for="index in 6"
            :key="index"
            class="h-64 animate-pulse rounded-lg bg-secondary"
          ></div>
        </div>
        <div
          v-else-if="discoveryError || genreQuery.error.value"
          class="rounded-lg border border-border bg-card px-6 py-14 text-center text-muted-foreground"
          role="alert"
        >
          會員清單目前無法載入，請稍後再試。
        </div>
        <div
          v-else-if="people.length === 0"
          class="rounded-lg border border-border bg-card px-6 py-14 text-center text-muted-foreground"
          role="status"
        >
          找不到符合目前篩選條件的會員。
        </div>
        <section v-else aria-label="電影同好清單">
          <ul class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <li v-for="person in people" :key="person._id">
              <PeopleCard
                :person="person"
                :pending="pendingUserId === person._id"
                recommendation-mode="discovery"
                @toggle-follow="toggleFollow"
              />
            </li>
          </ul>

          <nav
            v-if="discoveryPagination && discoveryPagination.totalPages > 1"
            class="mt-8 flex items-center justify-center gap-4"
            aria-label="會員清單分頁"
          >
            <button
              type="button"
              class="min-h-11 rounded-md border border-control bg-card px-5 font-semibold text-foreground hover:bg-surface-raised disabled:opacity-40"
              :disabled="discoveryPage <= 1"
              @click="discoveryPage -= 1"
            >
              上一頁
            </button>
            <span class="text-sm text-muted-foreground"
              >第 {{ discoveryPage }} / {{ discoveryPagination.totalPages }} 頁</span
            >
            <button
              type="button"
              class="min-h-11 rounded-md border border-control bg-card px-5 font-semibold text-foreground hover:bg-surface-raised disabled:opacity-40"
              :disabled="discoveryPage >= discoveryPagination.totalPages"
              @click="discoveryPage += 1"
            >
              下一頁
            </button>
          </nav>
        </section>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useQuery, useQueryCache } from '@pinia/colada'
import { useRoute } from 'vue-router'
import MovieCarousel from '@/components/MovieCarousel.vue'
import UserAvatar from '@/components/user/UserAvatar.vue'
import UserSafetyActions from '@/components/user/UserSafetyActions.vue'
import { followUser, getFollowSummary, unfollowUser } from '@/services/follows'
import type { ContactInteraction } from '@/services/safety'
import { getMovieDetails, getMovieGenres, type Movie } from '@/services/tmdb'
import { getDnaMatch, getMovieDna, getMovieSpace } from '@/services/users'
import { useUserStore } from '@/stores/user'
import { connectRealtime, onRealtime, onRealtimeConnect } from '@/services/realtime'

const route = useRoute()
const userStore = useUserStore()
const queryCache = useQueryCache()
const userId = computed(() => String(route.params.id ?? ''))
const sharedMovies = ref<Movie[]>([])
const sharedMoviesLoading = ref(false)
const sharedMoviesError = ref(false)
const followActionPending = ref(false)
const followActionError = ref('')
const safetyInteraction = ref<ContactInteraction | null>(null)
const relationshipResetByBlock = ref(false)
const safetyMutationPending = ref(false)
let sharedMovieRequestVersion = 0

function requireAccessToken() {
  const accessToken = userStore.accessToken
  if (!accessToken) throw new Error('Access token is required')
  return accessToken
}

const profileQuery = useQuery({
  key: () => ['public-movie-space', userStore.currentUser?._id ?? 'anonymous', userId.value],
  enabled: () => Boolean(userId.value && userStore.accessToken),
  query: () => getMovieSpace(userId.value, requireAccessToken()),
})
const movieDnaQuery = useQuery({
  key: () => ['movie-dna', userStore.currentUser?._id ?? 'anonymous', userId.value],
  enabled: () => Boolean(userId.value && userStore.accessToken),
  query: () => getMovieDna(userId.value, requireAccessToken()),
})
const dnaMatchQuery = useQuery({
  key: () => ['dna-match', userStore.currentUser?._id ?? 'anonymous', userId.value],
  enabled: () => Boolean(userId.value && userStore.accessToken),
  query: () => getDnaMatch(userId.value, requireAccessToken()),
})
const followSummaryQuery = useQuery({
  key: () => ['follow-summary', userStore.currentUser?._id ?? 'anonymous', userId.value],
  enabled: () => Boolean(userId.value && userStore.accessToken),
  query: () => getFollowSummary(userId.value, requireAccessToken()),
})
const genreQuery = useQuery({ key: () => ['tmdb', 'movie-genres'], query: getMovieGenres })

const profile = computed(() => profileQuery.data.value?.user)
const followSummary = computed(() => followSummaryQuery.data.value)
const isFollowing = computed(
  () => !relationshipResetByBlock.value && followSummary.value?.isFollowing === true,
)
const canFollow = computed(
  () => safetyInteraction.value?.capabilities.canFollowUser ?? !followSummary.value?.isSelf,
)
const canStartConversation = computed(
  () =>
    !safetyInteraction.value ||
    safetyInteraction.value.capabilities.canSendMessage ||
    safetyInteraction.value.capabilities.canCreateMessageRequest,
)
const genreNames = computed(() =>
  Object.fromEntries((genreQuery.data.value ?? []).map((genre) => [genre.id, genre.name])),
)
const allDnaGenres = computed(() =>
  (movieDnaQuery.data.value?.movieDna?.genres ?? []).map((genre) => ({
    ...genre,
    name: genreNames.value[genre.genreId] ?? '其他類型',
  })),
)
const displayedDnaGenres = computed(() => allDnaGenres.value.slice(0, 5))
const sharedDnaGenres = computed(() =>
  (dnaMatchQuery.data.value?.sharedDnaGenres ?? []).map((genre) => ({
    ...genre,
    name: genreNames.value[genre.genreId] ?? '其他類型',
  })),
)
const sharedFavoriteIds = computed(
  () => dnaMatchQuery.data.value?.revealableSharedFavoriteTmdbIds ?? [],
)
const hasSharedFavorites = computed(() => sharedFavoriteIds.value.length > 0)
const hasInsufficientSignal = computed(
  () => dnaMatchQuery.data.value?.status === 'insufficient_signal',
)
const movieSpaceTarget = computed(() =>
  followSummary.value?.isSelf
    ? { name: 'movie-space' }
    : { name: 'public-user-movie-space', params: { id: userId.value } },
)
watch(userId, () => {
  safetyInteraction.value = null
  relationshipResetByBlock.value = false
  safetyMutationPending.value = false
})
watch(
  () => sharedFavoriteIds.value.join(','),
  async () => {
    const requestVersion = ++sharedMovieRequestVersion
    sharedMovies.value = []
    sharedMoviesError.value = false
    if (sharedFavoriteIds.value.length === 0) {
      sharedMoviesLoading.value = false
      return
    }
    sharedMoviesLoading.value = true
    const results = await Promise.allSettled(sharedFavoriteIds.value.map(getMovieDetails))
    if (requestVersion !== sharedMovieRequestVersion) return
    sharedMovies.value = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    )
    sharedMoviesError.value = sharedMovies.value.length !== results.length
    sharedMoviesLoading.value = false
  },
  { immediate: true },
)

async function toggleFollow() {
  if (!followSummary.value || followSummary.value.isSelf || followActionPending.value) return
  followActionPending.value = true
  followActionError.value = ''
  try {
    if (isFollowing.value) await unfollowUser(userId.value, requireAccessToken())
    else await followUser(userId.value, requireAccessToken())
    queryCache.invalidateQueries({ key: ['follow-summary'] })
    queryCache.invalidateQueries({ key: ['people'] })
  } catch {
    followActionError.value = '關注狀態無法更新，請稍後再試。'
  } finally {
    followActionPending.value = false
  }
}

function handleSafetyInteraction(interaction: ContactInteraction) {
  safetyInteraction.value = interaction
  if (interaction.interactionState === 'blocked') relationshipResetByBlock.value = true
  else void followSummaryQuery.refresh()
}

function reconcileVisibleProfile() {
  void Promise.allSettled([
    profileQuery.refresh(),
    movieDnaQuery.refresh(),
    dnaMatchQuery.refresh(),
    followSummaryQuery.refresh(),
  ])
}

let realtimeCleanups: Array<() => void> = []
onMounted(() => {
  if (!userStore.accessToken || !userStore.currentUser) return
  connectRealtime(userStore.accessToken, userStore.currentUser._id)
  realtimeCleanups = [
    onRealtimeConnect(() => {
      if (safetyInteraction.value?.interactionState !== 'blocked') reconcileVisibleProfile()
    }),
    onRealtime('relationship.updated', (payload) => {
      if (
        payload.userId === userId.value &&
        !safetyMutationPending.value &&
        safetyInteraction.value?.interactionState !== 'blocked'
      )
        reconcileVisibleProfile()
    }),
  ]
})
onBeforeUnmount(() => realtimeCleanups.forEach((cleanup) => cleanup()))
</script>

<template>
  <div class="page-shell pb-12 pt-8 sm:pt-10">
    <div
      v-if="profileQuery.asyncStatus.value === 'loading'"
      class="space-y-6"
      aria-label="個人檔案載入中"
    >
      <div class="h-52 animate-pulse rounded-xl bg-secondary"></div>
      <div class="h-72 animate-pulse rounded-xl bg-secondary"></div>
    </div>
    <div
      v-else-if="profileQuery.error.value || !profile"
      class="rounded-xl border border-border bg-card px-6 py-16 text-center text-muted-foreground"
      role="alert"
    >
      這個個人檔案目前無法載入，或會員不存在。
    </div>
    <template v-else>
      <section class="pb-10 sm:pb-12" aria-labelledby="public-profile-heading">
        <div class="flex flex-col gap-6 sm:flex-row sm:items-start">
          <UserAvatar
            class="shrink-0"
            :account="profile.account"
            :user-id="profile._id"
            size="large"
          />
          <div class="min-w-0 flex-1">
            <p
              class="font-display-en text-sm font-semibold uppercase tracking-[0.18em] text-accent-caramel"
            >
              Profile
            </p>
            <h1
              id="public-profile-heading"
              class="mt-2 break-words text-3xl font-bold tracking-tight sm:text-4xl"
            >
              {{ profile.displayName || profile.account }}
            </h1>
            <p
              v-if="followSummary"
              class="mt-2 flex flex-wrap gap-x-2 text-sm text-muted-foreground"
            >
              <span class="break-all">@{{ profile.account }}</span
              ><span aria-hidden="true">·</span> <span>{{ followSummary.followerCount }} 粉絲</span
              ><span aria-hidden="true">·</span>
              <span>{{ followSummary.followingCount }} 關注</span>
            </p>
            <p v-else class="mt-2 break-all text-sm text-muted-foreground">
              @{{ profile.account }}
            </p>
            <p class="mt-4 max-w-2xl break-words leading-7 text-muted-foreground">
              {{ profile.bio || '這位會員尚未填寫自我介紹。' }}
            </p>
            <div class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1">
              <RouterLink
                v-if="followSummary && !followSummary.isSelf && canStartConversation"
                :to="{ path: '/inbox', query: { tab: 'messages', compose: userId } }"
                class="inline-flex min-h-11 items-center rounded-md text-sm font-semibold text-foreground underline-offset-4 hover:text-accent-caramel hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                私訊 →
              </RouterLink>
              <RouterLink
                :to="movieSpaceTarget"
                class="inline-flex min-h-11 items-center rounded-md text-sm font-semibold text-foreground underline-offset-4 hover:text-accent-caramel hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                查看電影空間 →
              </RouterLink>
            </div>
          </div>
          <div
            v-if="followSummary && !followSummary.isSelf"
            class="flex shrink-0 items-center gap-1"
          >
            <button
              v-if="isFollowing || canFollow"
              type="button"
              class="min-h-11 shrink-0 rounded-md px-6 font-medium transition-colors disabled:cursor-wait disabled:opacity-60"
              :class="
                isFollowing
                  ? 'border border-control bg-transparent text-foreground hover:bg-surface-raised'
                  : 'bg-primary-cta text-primary-foreground hover:bg-primary-cta-hover active:bg-primary-cta-pressed'
              "
              :disabled="followActionPending"
              :aria-pressed="isFollowing"
              :aria-busy="followActionPending"
              :aria-label="
                isFollowing
                  ? `取消關注 ${profile.displayName || profile.account}`
                  : `關注 ${profile.displayName || profile.account}`
              "
              @click="toggleFollow"
            >
              {{ isFollowing ? '✓ 已關注' : '+ 關注' }}
            </button>
            <UserSafetyActions
              :user-id="userId"
              :display-name="profile.displayName || profile.account"
              :can-block="safetyInteraction?.capabilities.canBlockUser ?? true"
              :can-unblock="safetyInteraction?.capabilities.canUnblockUser ?? false"
              :can-report="safetyInteraction?.capabilities.canReportUser ?? true"
              @interaction-changed="handleSafetyInteraction"
              @mutation-pending="safetyMutationPending = $event"
            />
          </div>
        </div>
        <p v-if="followActionError" class="mt-4 text-sm font-medium text-destructive" role="alert">
          {{ followActionError }}
        </p>
      </section>

      <section class="border-t border-border pt-10 sm:pt-12" aria-labelledby="public-dna-heading">
        <p
          class="font-display-en text-sm font-semibold uppercase tracking-[0.18em] text-accent-caramel"
        >
          Movie DNA
        </p>
        <h2
          id="public-dna-heading"
          class="mt-2 font-display-zh text-2xl font-semibold tracking-tight sm:text-3xl"
        >
          電影類型分布
        </h2>
        <div
          v-if="
            movieDnaQuery.asyncStatus.value === 'loading' ||
            genreQuery.asyncStatus.value === 'loading'
          "
          class="mt-6 rounded-lg bg-secondary/45 px-5 py-8 text-muted-foreground"
          role="status"
        >
          Movie DNA 載入中…
        </div>
        <div
          v-else-if="movieDnaQuery.error.value || genreQuery.error.value"
          class="mt-6 rounded-lg bg-secondary/45 px-5 py-8 text-muted-foreground"
          role="alert"
        >
          Movie DNA 目前無法載入。
        </div>
        <div
          v-else-if="allDnaGenres.length === 0"
          class="mt-6 rounded-lg bg-secondary/45 px-5 py-8 text-muted-foreground"
          role="status"
        >
          尚未有足夠的電影類型資料。
        </div>
        <div v-else class="mx-auto mt-6 max-w-3xl">
          <ol class="grid gap-4" aria-label="Movie DNA 類型分布">
            <li
              v-for="genre in displayedDnaGenres"
              :key="genre.genreId"
              class="rounded-lg bg-secondary/45 p-4"
            >
              <div class="flex justify-between gap-3 text-sm">
                <span class="min-w-0 break-words font-semibold text-foreground">{{
                  genre.name
                }}</span>
                <span class="shrink-0 text-muted-foreground">{{ genre.percentage }}%</span>
              </div>
              <div class="mt-2 h-2 overflow-hidden rounded-full bg-card">
                <div
                  class="h-full rounded-full bg-accent-caramel"
                  :style="{ width: `${genre.percentage}%` }"
                ></div>
              </div>
            </li>
          </ol>
        </div>
      </section>

      <section
        class="mt-10 border-t border-border pt-10 sm:mt-12 sm:pt-12"
        aria-labelledby="dna-match-heading"
      >
        <div
          class="flex flex-col items-start gap-3 md:flex-row md:items-end md:justify-between md:gap-4"
        >
          <div class="min-w-0 max-w-2xl">
            <p
              class="font-display-en text-sm font-semibold uppercase tracking-[0.18em] text-accent-caramel"
            >
              Movie DNA Match
            </p>
            <div class="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2
                id="dna-match-heading"
                class="font-display-zh text-2xl font-semibold tracking-tight sm:text-3xl"
              >
                <template v-if="hasInsufficientSignal">尚未有足夠的電影喜好訊號</template>
                <template v-else-if="hasSharedFavorites">你們都收藏了這些電影</template>
                <template v-else-if="sharedDnaGenres.length">你們有相似的電影類型偏好</template>
                <template v-else>尚未找到共同的電影喜好</template>
              </h2>
              <span
                v-if="hasSharedFavorites"
                class="shrink-0 text-sm font-semibold text-muted-foreground"
              >
                共 {{ sharedFavoriteIds.length }} 部
              </span>
            </div>
          </div>
        </div>
        <div
          v-if="
            dnaMatchQuery.asyncStatus.value === 'loading' ||
            genreQuery.asyncStatus.value === 'loading' ||
            sharedMoviesLoading
          "
          class="mt-6 rounded-lg bg-secondary/45 px-5 py-8 text-muted-foreground"
          role="status"
        >
          正在整理你們的電影喜好…
        </div>
        <div
          v-else-if="dnaMatchQuery.error.value || genreQuery.error.value"
          class="mt-6 rounded-lg bg-secondary/45 px-5 py-8 text-muted-foreground"
          role="alert"
        >
          Movie DNA Match 目前無法載入。
        </div>
        <div
          v-else-if="hasInsufficientSignal"
          class="mt-6 rounded-lg bg-secondary/45 px-5 py-8 text-sm leading-6 text-muted-foreground"
          role="status"
        >
          目前還沒有足夠的電影喜好訊號建立正式 Movie DNA Match。
        </div>
        <div v-else-if="hasSharedFavorites" class="mt-3 md:mt-5">
          <div
            class="flex min-w-0 max-w-full flex-col items-start gap-5 md:flex-row md:items-center md:justify-between md:gap-4"
          >
            <RouterLink
              :to="{ path: '/inbox', query: { tab: 'messages', compose: userId } }"
              class="inline-flex min-h-11 shrink-0 items-center rounded-md px-2 font-sans text-sm font-semibold text-foreground hover:text-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background md:order-2 md:ml-auto"
            >
              聊聊這些電影
              <span class="ml-2" aria-hidden="true">→</span>
            </RouterLink>
            <div
              v-if="sharedDnaGenres.length"
              class="relative min-w-0 max-w-full md:order-1 md:flex-1 after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-8 after:bg-gradient-to-l after:from-background after:to-transparent after:content-[''] sm:after:hidden"
            >
              <ul
                class="flex min-w-0 max-w-full snap-x snap-mandatory flex-nowrap gap-2 overflow-x-auto overscroll-x-contain pb-2 pr-8 sm:flex-wrap sm:overflow-visible sm:pb-0 sm:pr-0"
                aria-label="共同 Movie DNA 類型"
              >
                <li
                  v-for="genre in sharedDnaGenres"
                  :key="genre.genreId"
                  class="shrink-0 snap-start rounded-full border border-border bg-secondary/45 px-3 py-2 text-sm font-semibold text-muted-foreground"
                >
                  {{ genre.name }}
                </li>
              </ul>
            </div>
          </div>
          <p v-if="sharedMoviesError" class="mt-4 text-sm text-muted-foreground" role="status">
            部分共同收藏的電影資料暫時無法載入。
          </p>
          <div v-if="sharedMovies.length" class="mt-5">
            <div class="md:hidden">
              <MovieCarousel
                :movies="sharedMovies"
                label="共同收藏電影"
                :desktop-columns="5"
                paged
              />
            </div>
            <div class="hidden md:block">
              <MovieCarousel
                :movies="sharedMovies"
                label="共同收藏電影"
                :desktop-columns="5"
                paged
                presentation="showcase"
              />
            </div>
          </div>
          <p
            v-else
            class="mt-5 rounded-lg bg-secondary/45 px-5 py-8 text-muted-foreground"
            role="alert"
          >
            共同收藏的電影資料目前無法載入。
          </p>
        </div>
        <div v-else class="mt-5">
          <div
            v-if="sharedDnaGenres.length"
            class="relative mt-4 max-w-full after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-8 after:bg-gradient-to-l after:from-background after:to-transparent after:content-[''] sm:after:hidden"
          >
            <ul
              class="flex min-w-0 max-w-full snap-x snap-mandatory flex-nowrap gap-2 overflow-x-auto overscroll-x-contain pb-2 pr-8 sm:flex-wrap sm:overflow-visible sm:pb-0 sm:pr-0"
              aria-label="共同 Movie DNA 類型"
            >
              <li
                v-for="genre in sharedDnaGenres"
                :key="genre.genreId"
                class="shrink-0 snap-start rounded-full border border-border bg-secondary/45 px-3 py-2 text-sm font-semibold text-muted-foreground"
              >
                {{ genre.name }}
              </li>
            </ul>
          </div>
          <p class="mt-5 text-sm leading-6 text-muted-foreground" role="status">
            目前沒有可供顯示的共同收藏電影
          </p>
        </div>
      </section>
    </template>
  </div>
</template>

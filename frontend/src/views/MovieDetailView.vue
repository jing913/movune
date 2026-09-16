<template>
  <div class="page-shell pb-8 pt-6 sm:pt-8">
    <nav
      class="mb-6 flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
      aria-label="麵包屑"
    >
      <RouterLink class="shrink-0 rounded-md transition hover:text-accent-caramel" to="/">
        首頁
      </RouterLink>
      <span aria-hidden="true">/</span>
      <RouterLink class="shrink-0 rounded-md transition hover:text-accent-caramel" to="/explore">
        探索電影
      </RouterLink>
      <template v-if="movie">
        <span aria-hidden="true">/</span>
        <span class="truncate text-foreground" aria-current="page">{{ primaryTitle }}</span>
      </template>
    </nav>

    <div v-if="isLoading" aria-label="電影詳情載入中">
      <div class="grid gap-8 py-2 lg:grid-cols-[minmax(15rem,22rem)_1fr] lg:gap-12">
        <div class="aspect-[2/3] animate-pulse rounded-sm bg-secondary"></div>
        <div class="py-2">
          <div class="h-4 w-28 animate-pulse rounded bg-secondary"></div>
          <div class="mt-5 h-10 w-3/4 animate-pulse rounded bg-secondary"></div>
          <div class="mt-6 flex gap-3">
            <div class="h-9 w-24 animate-pulse rounded-full bg-secondary"></div>
            <div class="h-9 w-28 animate-pulse rounded-full bg-secondary"></div>
          </div>
          <div class="mt-10 h-5 w-24 animate-pulse rounded bg-secondary"></div>
          <div class="mt-4 space-y-3">
            <div class="h-4 w-full animate-pulse rounded bg-secondary"></div>
            <div class="h-4 w-full animate-pulse rounded bg-secondary"></div>
            <div class="h-4 w-4/5 animate-pulse rounded bg-secondary"></div>
          </div>
        </div>
      </div>
    </div>

    <div
      v-else-if="errorMessage"
      class="rounded-xl border border-border bg-card px-6 py-16 text-center shadow-[0_12px_36px_rgba(72,17,34,0.05)]"
      role="alert"
    >
      <p class="text-xl font-bold text-foreground">電影詳情載入失敗</p>
      <p class="mt-3 text-sm text-muted-foreground">目前無法取得這部電影的資訊，請稍後再試。</p>
      <div class="mt-7 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          class="rounded-md bg-primary-cta px-6 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary-cta-hover active:bg-primary-cta-pressed"
          @click="loadMovieData(currentMovieId)"
        >
          重新載入
        </button>
        <RouterLink
          class="rounded-md border border-control bg-transparent px-6 py-3 font-medium text-foreground transition-colors hover:bg-surface-raised"
          to="/explore"
        >
          返回探索電影
        </RouterLink>
      </div>
    </div>

    <div v-else-if="movie">
      <article class="grid gap-8 py-2 lg:grid-cols-[minmax(15rem,22rem)_1fr] lg:gap-12">
        <div class="mx-auto w-full max-w-[15rem] sm:max-w-xs lg:mx-0 lg:max-w-sm">
          <img
            v-if="movie.poster_path"
            :src="getPosterUrl(movie.poster_path)"
            :alt="`${primaryTitle} 電影海報`"
            class="aspect-[2/3] w-full rounded-sm object-cover shadow-[0_20px_44px_rgba(0,0,0,0.3)]"
          />
          <div
            v-else
            class="flex aspect-[2/3] w-full flex-col items-center justify-center gap-3 rounded-sm bg-secondary text-muted-foreground"
            role="img"
            :aria-label="`${primaryTitle} 暫無電影海報`"
          >
            <span class="text-5xl font-bold text-accent-caramel/30" aria-hidden="true">M</span>
            <span>暫無海報</span>
          </div>
        </div>

        <div class="min-w-0 py-1 lg:flex lg:flex-col lg:py-3">
          <p
            class="font-display-en text-sm font-semibold uppercase tracking-[0.2em] text-accent-caramel"
          >
            Movie Detail
          </p>
          <div
            class="mt-3 grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-end md:gap-6"
          >
            <h1
              class="min-w-0 font-display-zh text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-4xl lg:text-5xl"
            >
              {{ primaryTitle }}
            </h1>
            <button
              v-if="userStore.isLoggedIn"
              type="button"
              class="inline-flex min-h-11 w-fit shrink-0 items-center rounded-md px-2 font-sans text-sm font-semibold text-foreground hover:text-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-60 md:justify-self-end"
              :disabled="discussionResolving"
              @click="openDiscussion"
            >
              {{ discussionResolving ? '開啟中…' : '聊聊這部電影' }}
              <span class="ml-2" aria-hidden="true">→</span>
            </button>
          </div>
          <p v-if="discussionError" class="mt-2 text-sm text-destructive" role="alert">
            {{ discussionError }}
          </p>
          <p
            v-if="secondaryTitle"
            class="mt-2 text-base font-normal leading-7 text-muted-foreground sm:text-lg"
          >
            {{ secondaryTitle }}
          </p>

          <dl v-if="hasMetadata" class="mt-5 flex flex-wrap gap-x-4 gap-y-2 text-sm">
            <div v-if="movie.release_date" class="border-r border-border pr-4">
              <dt class="sr-only">上映日期</dt>
              <dd>
                <span class="mr-1.5 text-muted-foreground">上映</span>{{ movie.release_date }}
              </dd>
            </div>
            <div v-if="genreNames" class="border-r border-border pr-4">
              <dt class="sr-only">電影類型</dt>
              <dd>{{ genreNames }}</dd>
            </div>
            <div v-if="formattedRuntime" class="border-r border-border pr-4">
              <dt class="sr-only">片長</dt>
              <dd>{{ formattedRuntime }}</dd>
            </div>
            <div v-if="formattedRating" class="font-semibold">
              <dt class="sr-only">TMDB 評分</dt>
              <dd>
                <span class="mr-1 text-accent-caramel" aria-hidden="true">★</span
                >{{ formattedRating }}<span class="sr-only">，滿分 10 分</span>
              </dd>
            </div>
          </dl>

          <section class="mt-7" aria-labelledby="movie-overview-heading">
            <h2 id="movie-overview-heading" class="text-xl font-bold text-foreground">電影簡介</h2>
            <p
              v-if="movie.overview && movie.overviewLocale === 'en-US'"
              class="mt-2 text-xs text-muted-foreground"
            >
              暫無繁體中文簡介，以下顯示英文資料。
            </p>
            <p
              v-if="movie.overview"
              class="mt-2 max-w-3xl text-base leading-7 text-muted-foreground"
            >
              {{ movie.overview }}
            </p>
            <p v-else class="mt-3 text-base text-muted-foreground">目前沒有電影簡介。</p>
          </section>

          <div class="mt-7 grid gap-5 border-t border-border pt-6 lg:flex-1 lg:pt-0">
            <div class="flex items-center gap-4">
              <button
                type="button"
                class="flex size-12 shrink-0 items-center justify-center rounded-full border border-control bg-surface-raised shadow-md transition-[background-color,color,transform] hover:scale-105 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:hover:scale-100"
                :class="[
                  isFavorite ? 'text-accent-caramel' : 'text-foreground',
                  isFavoriteMutating ? 'cursor-wait opacity-70' : '',
                ]"
                :disabled="isFavoriteMutating"
                :aria-label="isFavorite ? `取消收藏《${primaryTitle}》` : `收藏《${primaryTitle}》`"
                :aria-pressed="isFavorite"
                :aria-busy="isFavoriteMutating"
                :title="isFavorite ? '取消收藏' : '收藏電影'"
                @click="toggleFavorite"
              >
                <svg
                  class="size-6"
                  :class="isFavorite ? 'fill-current' : 'fill-none'"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  stroke-width="1.8"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path
                    d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z"
                  />
                </svg>
              </button>
              <div>
                <p class="font-semibold text-foreground">
                  {{ isFavorite ? '已收藏' : '收藏電影' }}
                </p>
                <p class="mt-1 text-sm leading-6 text-muted-foreground">
                  收藏的電影將成為未來建立 Movie DNA 的基礎。
                </p>
              </div>
            </div>
            <div v-if="userStore.isLoggedIn" class="flex items-center gap-4">
              <button
                type="button"
                class="flex min-h-11 shrink-0 items-center rounded-md border border-control bg-surface-raised px-4 font-semibold transition hover:border-accent-caramel hover:text-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                @click="openCollectionPicker"
              >
                管理收藏清單
              </button>
              <p class="text-sm leading-6 text-muted-foreground">
                加入收藏清單不會改變收藏狀態或 Movie DNA。
              </p>
            </div>
          </div>
        </div>
      </article>

      <section class="mt-16 sm:mt-20 lg:mt-24" aria-labelledby="movie-people-heading">
        <div class="mb-6">
          <p
            class="font-display-en text-sm font-semibold uppercase tracking-[0.18em] text-accent-caramel sm:text-base"
          >
            Movie Community
          </p>
          <h2
            id="movie-people-heading"
            class="mt-2 font-display-zh text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
          >
            他們也收藏了這部電影
          </h2>
        </div>

        <div
          v-if="!userStore.isLoggedIn"
          class="rounded-lg bg-secondary/45 px-6 py-10 text-center"
          role="status"
        >
          <p class="text-lg font-semibold text-foreground">登入查看也收藏這部電影的會員</p>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">
            從同一部電影開始，遇見更多電影同好。
          </p>
          <RouterLink
            :to="`/people`"
            class="mt-6 inline-flex min-h-11 items-center rounded-md bg-primary-cta px-6 font-semibold text-primary-foreground hover:bg-primary-cta-hover active:bg-primary-cta-pressed"
          >
            立即登入探索
          </RouterLink>
        </div>
        <div
          v-else-if="moviePeopleQuery.asyncStatus.value === 'loading'"
          class="flex gap-4 overflow-hidden md:grid md:grid-cols-3"
          aria-label="電影同好載入中"
        >
          <div
            v-for="index in 3"
            :key="index"
            class="h-64 w-[88%] shrink-0 animate-pulse rounded-lg bg-secondary md:w-auto"
          ></div>
        </div>
        <div
          v-else-if="moviePeopleQuery.error.value"
          class="rounded-lg bg-secondary/45 px-6 py-10 text-center text-muted-foreground"
          role="alert"
        >
          電影同好目前無法載入，請稍後再試。
        </div>
        <div
          v-else-if="moviePeople.length === 0"
          class="rounded-lg bg-secondary/45 px-6 py-10 text-center text-muted-foreground"
          role="status"
        >
          目前沒有公開收藏這部電影的其他會員。
        </div>
        <ul
          v-else
          class="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-2 md:grid md:grid-cols-3 md:overflow-visible md:pb-0"
          aria-label="同樣收藏這部電影的會員"
        >
          <li
            v-for="person in moviePeople"
            :key="person._id"
            class="w-[88%] shrink-0 snap-start md:w-auto"
          >
            <PeopleCard
              :person="person"
              :pending="peoplePendingUserId === person._id"
              recommendation-mode="current-movie"
              @toggle-follow="togglePeopleFollow"
            />
          </li>
        </ul>
        <p v-if="peopleFollowError" class="mt-4 text-sm font-medium text-destructive" role="alert">
          {{ peopleFollowError }}
        </p>
      </section>

      <section class="mt-16 sm:mt-20 lg:mt-24" aria-labelledby="recommended-movies-heading">
        <div class="mb-6 border-b border-border pb-5">
          <p class="font-display-zh text-sm font-semibold text-accent-caramel">延續觀影靈感</p>
          <h2
            id="recommended-movies-heading"
            class="mt-1 text-2xl font-bold tracking-tight sm:text-3xl"
          >
            推薦電影
          </h2>
        </div>

        <div
          v-if="recommendedMovies.length === 0"
          class="rounded-lg border border-border bg-card px-6 py-12 text-center text-muted-foreground"
          role="status"
        >
          目前沒有推薦電影。
        </div>
        <MovieCarousel
          v-else
          :movies="recommendedMovies"
          label="推薦電影"
          :desktop-columns="5"
          paged
          presentation="showcase"
        />
      </section>
    </div>

    <CollectionMembershipPicker
      v-if="movie"
      v-model:open="collectionPickerOpen"
      :tmdb-id="movie.id"
      :movie-title="primaryTitle"
    />
  </div>
</template>

<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { computed, ref, onMounted, watch } from 'vue'
import { useQuery, useQueryCache } from '@pinia/colada'
import MovieCarousel from '@/components/MovieCarousel.vue'
import CollectionMembershipPicker from '@/components/collections/CollectionMembershipPicker.vue'
import PeopleCard from '@/components/user/PeopleCard.vue'
import { followUser, unfollowUser } from '@/services/follows'
import {
  getMovieDetailsWithFallback,
  getMoviePrimaryTitle,
  getMovieSecondaryTitle,
  getPosterUrl,
  getRecommendedMovies,
  type Movie,
  type MovieDetails,
} from '@/services/tmdb'
import { getMoviePeople, type UserSummary } from '@/services/users'
import { useFavorites } from '@/composables/useFavorites'
import { useUserStore } from '@/stores/user'
import { resolveDiscussionRoom } from '@/services/messaging'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const queryCache = useQueryCache()
const {
  isFavorite: checkIsFavorite,
  toggleFavorite: toggleFavoriteById,
  isFavoriteMutating,
} = useFavorites()

const currentMovieId = computed(() => Number(route.params.id))
const movie = ref<MovieDetails | null>(null)
const recommendedMovies = ref<Movie[]>([])

const isLoading = ref<boolean>(true)
const errorMessage = ref<string>('')
const peoplePendingUserId = ref<string | null>(null)
const peopleFollowError = ref('')
const discussionResolving = ref(false)
const discussionError = ref('')
const collectionPickerOpen = ref(false)

function openCollectionPicker() {
  collectionPickerOpen.value = true
}

async function openDiscussion() {
  if (discussionResolving.value) return
  discussionResolving.value = true
  discussionError.value = ''
  try {
    const room = await resolveDiscussionRoom(currentMovieId.value)
    await router.push({ path: '/inbox', query: { tab: 'discussions', room: room.id } })
  } catch {
    discussionError.value = 'The movie discussion could not be opened. Please try again.'
  } finally {
    discussionResolving.value = false
  }
}

const moviePeopleQuery = useQuery({
  key: () => ['movie-people', userStore.currentUser?._id ?? 'anonymous', currentMovieId.value],
  enabled: () => Boolean(currentMovieId.value && userStore.currentUser && userStore.accessToken),
  query: () => {
    const accessToken = userStore.accessToken
    if (!accessToken) throw new Error('Access token is required')
    return getMoviePeople(currentMovieId.value, { page: 1, limit: 6 }, accessToken)
  },
})
const moviePeople = computed(() => moviePeopleQuery.data.value?.users ?? [])

async function togglePeopleFollow(person: UserSummary) {
  const accessToken = userStore.accessToken
  if (!accessToken || peoplePendingUserId.value) return
  peoplePendingUserId.value = person._id
  peopleFollowError.value = ''

  try {
    const wasFollowing = person.isFollowing
    if (wasFollowing) await unfollowUser(person._id, accessToken)
    else await followUser(person._id, accessToken)
    person.isFollowing = !wasFollowing
    person.followerCount = Math.max(0, person.followerCount + (wasFollowing ? -1 : 1))
    queryCache.invalidateQueries({ key: ['people'] })
    queryCache.invalidateQueries({ key: ['home-people'] })
    queryCache.invalidateQueries({ key: ['follow-summary'] })
  } catch {
    peopleFollowError.value = '關注狀態無法更新，請稍後再試。'
  } finally {
    peoplePendingUserId.value = null
  }
}

const isFavorite = computed(() => {
  if (!movie.value) return false
  return checkIsFavorite(movie.value.id)
})

const primaryTitle = computed(() => (movie.value ? getMoviePrimaryTitle(movie.value) : ''))
const secondaryTitle = computed(() => (movie.value ? getMovieSecondaryTitle(movie.value) : null))

const genreNames = computed(() => {
  const genres = movie.value?.genres
  if (!genres?.length) return null

  const names = genres.map((genre) => genre.name).filter(Boolean)
  return names.length > 0 ? names.join(' · ') : null
})

const formattedRuntime = computed(() => {
  const runtime = movie.value?.runtime
  if (typeof runtime !== 'number' || !Number.isFinite(runtime) || runtime <= 0) return null
  return `${runtime} 分鐘`
})

const formattedRating = computed(() => {
  const rating = movie.value?.vote_average
  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 10) {
    return null
  }
  return rating.toFixed(1)
})

const hasMetadata = computed(() => {
  return Boolean(
    movie.value?.release_date ||
    genreNames.value ||
    formattedRuntime.value ||
    formattedRating.value,
  )
})

async function loadMovieData(id: number) {
  // 電影載入狀態
  isLoading.value = true
  errorMessage.value = ''
  // 清空舊的電影資料
  movie.value = null
  recommendedMovies.value = []

  try {
    movie.value = await getMovieDetailsWithFallback(id)
    try {
      recommendedMovies.value = await getRecommendedMovies(id)
    } catch {
      recommendedMovies.value = []
    }
  } catch {
    errorMessage.value = '載入失敗'
  } finally {
    isLoading.value = false
  }
}

function toggleFavorite() {
  if (!movie.value) return
  toggleFavoriteById(movie.value.id, movie.value.genres?.map((genre) => genre.id) ?? [])
}

onMounted(async () => {
  // 取詳細電影資料、推薦電影列表
  await loadMovieData(currentMovieId.value)
})

watch(
  () => route.params.id,
  async (newId) => {
    const newMovieId = Number(newId)
    await loadMovieData(newMovieId)
  },
)
</script>

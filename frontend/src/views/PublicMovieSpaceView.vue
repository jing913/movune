<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import { useRoute } from 'vue-router'
import MovieCarousel from '@/components/MovieCarousel.vue'
import CollectionSummaryPreview from '@/components/collections/CollectionSummaryPreview.vue'
import UserAvatar from '@/components/user/UserAvatar.vue'
import { groupFavoriteMovies } from '@/lib/favoriteShelves'
import { getMovieDetails, getMovieGenres, type Movie } from '@/services/tmdb'
import { getMovieSpace } from '@/services/users'
import { useUserStore } from '@/stores/user'

const route = useRoute()
const userStore = useUserStore()
const userId = computed(() => String(route.params.id ?? ''))
const favoriteMovies = ref<Movie[]>([])
const favoriteMoviesLoading = ref(false)
const favoriteMoviesError = ref(false)
let favoriteRequestVersion = 0

function requireAccessToken() {
  const accessToken = userStore.accessToken
  if (!accessToken) throw new Error('Access token is required')
  return accessToken
}

const movieSpaceQuery = useQuery({
  key: () => ['public-movie-space', userStore.currentUser?._id ?? 'anonymous', userId.value],
  enabled: () => Boolean(userId.value && userStore.accessToken),
  refetchOnMount: 'always',
  query: () => getMovieSpace(userId.value, requireAccessToken()),
})

const genreQuery = useQuery({ key: () => ['tmdb', 'movie-genres'], query: getMovieGenres })
const movieSpace = computed(() => movieSpaceQuery.data.value)
const profile = computed(() => movieSpace.value?.user)
const favorites = computed(() => movieSpace.value?.favorites ?? [])
const collections = computed(() => movieSpace.value?.collections ?? [])
const hasRevealableFavorites = computed(() => Array.isArray(movieSpace.value?.favorites))
const genreNames = computed(() =>
  Object.fromEntries((genreQuery.data.value ?? []).map((genre) => [genre.id, genre.name])),
)
const favoriteShelves = computed(() =>
  groupFavoriteMovies(favorites.value, favoriteMovies.value, genreNames.value),
)

watch(
  () => favorites.value.map((favorite) => favorite.tmdbId).join(','),
  async () => {
    const requestVersion = ++favoriteRequestVersion
    favoriteMovies.value = []
    favoriteMoviesError.value = false
    if (!hasRevealableFavorites.value || favorites.value.length === 0) {
      favoriteMoviesLoading.value = false
      return
    }
    favoriteMoviesLoading.value = true
    const results = await Promise.allSettled(
      favorites.value.map((favorite) => getMovieDetails(favorite.tmdbId)),
    )
    if (requestVersion !== favoriteRequestVersion) return
    favoriteMovies.value = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    )
    favoriteMoviesError.value = favoriteMovies.value.length !== results.length
    favoriteMoviesLoading.value = false
  },
  { immediate: true },
)
</script>

<template>
  <div class="page-shell pb-12 pt-8 sm:pt-10">
    <div
      v-if="movieSpaceQuery.asyncStatus.value === 'loading'"
      class="space-y-6"
      aria-label="電影空間載入中"
    >
      <div class="h-40 animate-pulse rounded-xl bg-secondary"></div>
      <div class="h-72 animate-pulse rounded-xl bg-secondary"></div>
    </div>
    <div
      v-else-if="movieSpaceQuery.error.value || !profile"
      class="rounded-xl border border-border bg-card px-6 py-16 text-center text-muted-foreground"
      role="alert"
    >
      這個電影空間目前無法載入，或會員不存在。
    </div>
    <template v-else>
      <header
        class="rounded-xl border border-border bg-card p-6 shadow-[0_12px_36px_rgba(72,17,34,0.05)] sm:p-8"
      >
        <div class="flex items-center gap-5">
          <UserAvatar
            class="shrink-0"
            :account="profile.account"
            :user-id="profile._id"
            size="large"
          />
          <div class="min-w-0 flex-1">
            <p
              class="font-display-en text-xs font-semibold uppercase tracking-[0.18em] text-accent-caramel"
            >
              Movie Space
            </p>
            <h1 class="mt-2 break-words text-3xl font-bold tracking-tight sm:text-4xl">
              {{ profile.displayName || profile.account }} 的電影空間
            </h1>
            <RouterLink
              :to="{ name: 'public-movie-space', params: { id: userId } }"
              class="mt-3 inline-flex min-h-11 items-center rounded-md text-sm font-semibold text-foreground underline-offset-4 hover:text-accent-caramel hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              ← 返回個人檔案
            </RouterLink>
          </div>
        </div>
      </header>
      <section
        class="mt-6 rounded-xl border border-border bg-card p-4 shadow-[0_12px_36px_rgba(72,17,34,0.05)] sm:p-6"
        aria-labelledby="public-favorites-heading"
      >
        <h2 id="public-favorites-heading" class="text-2xl font-bold tracking-tight">
          收藏電影清單
        </h2>
        <div
          v-if="!hasRevealableFavorites"
          class="mt-6 rounded-lg border border-border bg-secondary/40 px-6 py-12 text-center text-muted-foreground"
          role="status"
        >
          目前沒有可供你查看的公開電影內容。
        </div>
        <div
          v-else-if="favoriteMoviesLoading || genreQuery.asyncStatus.value === 'loading'"
          class="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5"
          aria-label="公開收藏載入中"
        >
          <div
            v-for="index in 5"
            :key="index"
            class="aspect-[2/3] animate-pulse rounded-sm bg-secondary"
          ></div>
        </div>
        <div
          v-else-if="(favoriteMoviesError && favoriteMovies.length === 0) || genreQuery.error.value"
          class="mt-6 rounded-lg bg-secondary/40 px-6 py-12 text-center text-muted-foreground"
          role="alert"
        >
          公開收藏目前無法載入。
        </div>
        <div
          v-else-if="favorites.length === 0"
          class="mt-6 rounded-lg bg-secondary/40 px-6 py-12 text-center text-muted-foreground"
          role="status"
        >
          目前沒有可供你查看的公開電影內容。
        </div>
        <div v-else class="mt-6">
          <p v-if="favoriteMoviesError" class="mb-4 text-sm text-muted-foreground" role="status">
            部分電影資料暫時無法載入。
          </p>
          <div class="space-y-7">
            <section
              v-for="shelf in favoriteShelves"
              :key="shelf.id"
              class="rounded-lg border border-border bg-background/50 p-4"
              :aria-labelledby="`public-shelf-${shelf.id}`"
            >
              <div class="mb-4 flex items-baseline justify-between gap-3">
                <h3 :id="`public-shelf-${shelf.id}`" class="text-lg font-bold">{{ shelf.name }}</h3>
                <span class="text-sm text-muted-foreground">{{ shelf.movies.length }} 部</span>
              </div>
              <MovieCarousel
                :movies="shelf.movies"
                :label="`${shelf.name}公開收藏`"
                :desktop-columns="5"
                shelf
              />
            </section>
          </div>
        </div>
      </section>
      <section
        class="mt-6 rounded-xl border border-border bg-card p-4 shadow-[0_12px_36px_rgba(72,17,34,0.05)] sm:p-6"
        aria-labelledby="public-collections-heading"
      >
        <h2 id="public-collections-heading" class="text-2xl font-bold tracking-tight">收藏清單</h2>
        <div
          v-if="collections.length === 0"
          class="mt-6 rounded-lg border border-border bg-secondary/40 px-6 py-12 text-center text-muted-foreground"
          role="status"
        >
          目前沒有可供你查看的公開收藏清單。
        </div>
        <ul v-else class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <li v-for="collection in collections" :key="collection._id">
            <RouterLink
              :to="{ name: 'collection-detail', params: { id: collection._id } }"
              class="group flex h-full min-w-0 flex-col rounded-lg border border-border bg-background/50 p-5 transition hover:-translate-y-0.5 hover:border-accent-caramel/60 hover:shadow-[0_12px_28px_rgba(72,17,34,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              <h3 class="break-words text-xl font-bold group-hover:text-accent-caramel">
                {{ collection.name }}
              </h3>
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
      </section>
    </template>
  </div>
</template>

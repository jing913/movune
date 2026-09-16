<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useQuery } from '@pinia/colada'
import { useRoute, useRouter } from 'vue-router'
import MovieCard from '@/components/MovieCard.vue'
import SortSelect from '@/components/SortSelect.vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  discoverMovies,
  getMovieGenres,
  searchMoviePage,
  type Movie,
  type MovieDiscoveryState,
  type MovieSort,
  type MovieSortDirection,
} from '@/services/tmdb'

const route = useRoute()
const router = useRouter()
const activeQuery = ref('')
const discoveryState = ref<MovieDiscoveryState>('all')
const sort = ref<MovieSort>('popular')
const sortDirection = ref<MovieSortDirection>('desc')
const genreIds = ref<number[]>([])
const page = ref(1)
const movies = ref<Movie[]>([])
const totalPages = ref(0)
const totalResults = ref(0)
const loading = ref(true)
const hasError = ref(false)
const mobileFilterOpen = ref(false)
let requestVersion = 0

const genreQuery = useQuery({ key: () => ['tmdb', 'movie-genres'], query: getMovieGenres })
const genres = computed(() => genreQuery.data.value ?? [])
const hasSearched = computed(() => Boolean(activeQuery.value))
const hasActiveBrowseFilters = computed(
  () =>
    discoveryState.value !== 'all' ||
    sort.value !== 'popular' ||
    sortDirection.value !== 'desc' ||
    genreIds.value.length > 0,
)
const resultHeading = computed(() =>
  hasSearched.value ? `「${activeQuery.value}」的搜尋結果` : '探索結果',
)

const stateOptions: Array<{ value: MovieDiscoveryState; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'now-playing', label: '現正上映' },
  { value: 'acclaimed', label: '口碑精選' },
]
const sortOptions: Array<{ value: MovieSort; label: string }> = [
  { value: 'popular', label: '熱門程度' },
  { value: 'rating', label: '觀眾評分' },
  { value: 'newest', label: '上映日期' },
]
const sortDirectionOptions = computed<Array<{ value: MovieSortDirection; label: string }>>(() =>
  sort.value === 'newest'
    ? [
        { value: 'desc', label: '由新到舊' },
        { value: 'asc', label: '由舊到新' },
      ]
    : [
        { value: 'desc', label: '由高到低' },
        { value: 'asc', label: '由低到高' },
      ],
)

async function loadMovies() {
  const version = ++requestVersion
  loading.value = true
  hasError.value = false
  movies.value = []

  try {
    const result = activeQuery.value
      ? await searchMoviePage(activeQuery.value, page.value)
      : await discoverMovies({
          page: page.value,
          genreIds: genreIds.value,
          state: discoveryState.value,
          sort: sort.value,
          sortDirection: sortDirection.value,
        })

    if (version !== requestVersion) return
    movies.value = result.results
    totalPages.value = Math.min(result.total_pages, 500)
    totalResults.value = result.total_results
  } catch {
    if (version !== requestVersion) return
    hasError.value = true
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

watch(
  [() => route.query.q, discoveryState, sort, sortDirection, genreIds, page],
  async ([queryValue]) => {
    const query = typeof queryValue === 'string' ? queryValue.trim() : ''
    if (query !== activeQuery.value) {
      activeQuery.value = query
      if (page.value !== 1) {
        page.value = 1
        return
      }
    }
    await loadMovies()
  },
  { immediate: true, deep: true },
)

watch(discoveryState, (state) => {
  sort.value = state === 'acclaimed' ? 'rating' : 'popular'
  sortDirection.value = 'desc'
})

watch([discoveryState, sort, sortDirection, genreIds], () => {
  if (page.value !== 1) page.value = 1
})

async function clearSearch() {
  if (route.query.q) await router.replace({ path: '/explore' })
}

function resetBrowseFilters() {
  discoveryState.value = 'all'
  sort.value = 'popular'
  sortDirection.value = 'desc'
  genreIds.value = []
  page.value = 1
}
</script>

<template>
  <div class="page-shell pb-12 pt-8 sm:pt-10">
    <header class="max-w-3xl">
      <p
        class="font-display-en text-sm font-semibold uppercase tracking-[0.2em] text-accent-caramel"
      >
        Explore Movies
      </p>
      <h1
        class="mt-2 font-display-zh text-3xl font-semibold tracking-tight text-foreground sm:text-4xl"
      >
        探索電影
      </h1>
      <p class="mt-3 text-base leading-7 text-muted-foreground">
        探索電影，收藏喜歡的作品，慢慢形成你的 Movie DNA。
      </p>
    </header>

    <div class="mt-6 grid grid-cols-2 gap-3 lg:hidden">
      <button
        type="button"
        class="col-span-2 inline-flex min-h-11 items-center justify-center rounded-md border border-control bg-card px-4 font-semibold text-foreground hover:bg-surface-raised"
        :disabled="hasSearched"
        @click="mobileFilterOpen = true"
      >
        篩選<span v-if="genreIds.length" class="ml-1">({{ genreIds.length }})</span>
      </button>
      <SortSelect
        v-model="sort"
        class="min-w-0 flex-1"
        :options="sortOptions"
        label="電影排序"
        :disabled="hasSearched"
      />
      <SortSelect
        v-model="sortDirection"
        class="min-w-0"
        :options="sortDirectionOptions"
        label="排序方向"
        prefix="方向"
        :disabled="hasSearched"
      />
    </div>

    <Dialog v-model:open="mobileFilterOpen">
      <DialogContent
        class="bottom-0 left-0 top-auto max-h-[85dvh] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-b-none rounded-t-xl p-5 lg:hidden"
        style="inset: auto 0 0 0; width: 100%; max-width: none; transform: none"
      >
        <DialogHeader>
          <DialogTitle>篩選電影</DialogTitle>
          <DialogDescription>依探索分類與電影類型縮小探索結果。</DialogDescription>
        </DialogHeader>

        <fieldset class="mt-5 border-t border-border pt-5">
          <legend class="text-sm font-semibold text-foreground">探索分類</legend>
          <div class="mt-2 grid grid-cols-2 gap-2">
            <label
              v-for="option in stateOptions"
              :key="option.value"
              class="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-control px-3"
            >
              <input
                v-model="discoveryState"
                class="accent-accent-caramel"
                type="radio"
                :value="option.value"
              />
              <span>{{ option.label }}</span>
            </label>
          </div>
        </fieldset>

        <fieldset class="mt-5 border-t border-border pt-5">
          <legend class="text-sm font-semibold text-foreground">電影類型</legend>
          <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
            <label
              v-for="genre in genres"
              :key="genre.id"
              class="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-secondary"
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
            :disabled="!hasActiveBrowseFilters"
            @click="resetBrowseFilters"
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

    <div class="mt-8 grid min-w-0 gap-8 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside
        class="hidden self-start rounded-lg border border-border bg-card p-5 shadow-[0_12px_36px_rgba(72,17,34,0.05)] lg:block"
        aria-label="電影探索篩選"
      >
        <p
          class="font-display-en text-xs font-semibold uppercase tracking-[0.18em] text-accent-caramel"
        >
          Discovery
        </p>
        <h2 class="mt-2 text-lg font-semibold">篩選條件</h2>
        <div :inert="hasSearched || undefined">
          <fieldset class="mt-5 border-t border-border pt-5">
            <legend class="text-sm font-semibold text-foreground">探索分類</legend>
            <div class="mt-2">
              <label
                v-for="option in stateOptions"
                :key="option.value"
                class="flex min-h-10 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-secondary"
              >
                <input
                  v-model="discoveryState"
                  class="accent-accent-caramel"
                  type="radio"
                  :value="option.value"
                  :disabled="hasSearched"
                />
                <span class="text-sm">{{ option.label }}</span>
              </label>
            </div>
          </fieldset>

          <fieldset class="mt-5 border-t border-border pt-5">
            <legend class="text-sm font-semibold text-foreground">電影類型</legend>
            <div class="mt-2 max-h-72 overflow-y-auto pr-1">
              <label
                v-for="genre in genres"
                :key="genre.id"
                class="flex min-h-9 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-secondary"
              >
                <input
                  v-model="genreIds"
                  type="checkbox"
                  :value="genre.id"
                  class="size-4 accent-accent-caramel"
                  :disabled="hasSearched"
                />
                <span class="text-sm">{{ genre.name }}</span>
              </label>
            </div>
          </fieldset>
        </div>

        <p v-if="hasSearched" class="mt-4 text-xs leading-5 text-muted-foreground">
          目前顯示導覽列名稱搜尋結果；返回探索後可使用篩選。
        </p>
        <button
          type="button"
          class="mt-5 min-h-10 w-full rounded-md border border-control text-sm font-semibold text-foreground hover:bg-surface-raised disabled:opacity-40"
          :disabled="hasSearched || !hasActiveBrowseFilters"
          @click="resetBrowseFilters"
        >
          清除篩選
        </button>
      </aside>

      <main class="min-w-0">
        <div
          class="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4"
        >
          <div class="min-w-0">
            <h2 class="text-lg font-semibold tracking-tight">{{ resultHeading }}</h2>
            <p class="mt-1 text-sm text-muted-foreground">
              {{ totalResults ? `共 ${totalResults.toLocaleString()} 部` : '正在整理電影結果' }}
            </p>
            <p class="mt-1 text-xs text-muted-foreground">電影資料與觀眾評分來自 TMDB</p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <button
              v-if="hasSearched"
              type="button"
              class="min-h-10 rounded-md px-3 text-sm font-semibold text-foreground hover:bg-secondary hover:text-accent-caramel"
              @click="clearSearch"
            >
              返回電影探索
            </button>
            <SortSelect
              v-model="sort"
              class="hidden w-48 lg:inline-flex"
              :options="sortOptions"
              label="電影排序"
              :disabled="hasSearched"
            />
            <SortSelect
              v-model="sortDirection"
              class="hidden w-40 lg:inline-flex"
              :options="sortDirectionOptions"
              label="排序方向"
              prefix="方向"
              :disabled="hasSearched"
            />
          </div>
        </div>

        <div
          v-if="loading"
          class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5"
          aria-label="電影結果載入中"
        >
          <div v-for="index in 10" :key="index" class="space-y-3">
            <div class="aspect-[2/3] animate-pulse rounded-sm bg-secondary"></div>
            <div class="h-4 w-3/4 animate-pulse rounded bg-secondary"></div>
          </div>
        </div>
        <div
          v-else-if="hasError || genreQuery.error.value"
          class="rounded-lg border border-border bg-card px-6 py-12 text-center"
          role="alert"
        >
          <p class="font-semibold text-foreground">電影載入失敗</p>
          <p class="mt-2 text-sm text-muted-foreground">目前無法取得結果，請稍後再試。</p>
        </div>
        <div
          v-else-if="movies.length === 0"
          class="rounded-lg border border-border bg-card px-6 py-12 text-center"
          role="status"
        >
          <p class="font-semibold text-foreground">找不到符合條件的電影</p>
          <p class="mt-2 text-sm text-muted-foreground">請調整或清除篩選。</p>
        </div>
        <div v-else class="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
          <MovieCard v-for="movie in movies" :key="movie.id" :movie="movie" />
        </div>

        <nav
          v-if="!loading && !hasError && totalPages > 1"
          class="mt-9 flex items-center justify-center gap-4"
          aria-label="電影結果分頁"
        >
          <button
            type="button"
            class="min-h-11 rounded-md border border-control bg-card px-5 font-semibold text-foreground hover:bg-surface-raised disabled:opacity-40"
            :disabled="page <= 1"
            @click="page -= 1"
          >
            上一頁
          </button>
          <span class="text-sm text-muted-foreground">第 {{ page }} / {{ totalPages }} 頁</span>
          <button
            type="button"
            class="min-h-11 rounded-md border border-control bg-card px-5 font-semibold text-foreground hover:bg-surface-raised disabled:opacity-40"
            :disabled="page >= totalPages"
            @click="page += 1"
          >
            下一頁
          </button>
        </nav>
      </main>
    </div>
  </div>
</template>

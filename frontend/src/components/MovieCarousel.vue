<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import { computed, ref, watch } from 'vue'
import MovieCard from '@/components/MovieCard.vue'
import { getMoviePrimaryTitle, getPosterUrl, type Movie } from '@/services/tmdb'

type StagePosition = -2 | -1 | 0 | 1 | 2

const props = withDefaults(
  defineProps<{
    movies: Movie[]
    label: string
    desktopColumns?: 4 | 5
    shelf?: boolean
    paged?: boolean
    presentation?: 'standard' | 'showcase'
  }>(),
  {
    desktopColumns: 5,
    shelf: false,
    paged: false,
    presentation: 'standard',
  },
)

const desktopGridClass = computed(() =>
  props.desktopColumns === 4 ? 'md:grid-cols-4' : 'md:grid-cols-3 lg:grid-cols-5',
)
const desktopShelfWidth = computed(() =>
  props.desktopColumns === 4 ? 'md:w-[calc((100%_-_3rem)/4)]' : 'md:w-[calc((100%_-_4rem)/5)]',
)

const page = ref(0)
const pageCount = computed(() => Math.ceil(props.movies.length / props.desktopColumns))
const visibleMovies = computed(() => {
  const start = page.value * props.desktopColumns
  return props.movies.slice(start, start + props.desktopColumns)
})

const activeIndex = ref(0)
const isDesktopShowcase = useMediaQuery('(min-width: 48rem)')
const hasShowcaseNavigation = computed(() => props.movies.length >= 5)
const showsActiveShowcaseMovie = computed(
  () => props.movies.length === 1 || hasShowcaseNavigation.value,
)
const activeMovie = computed(() => props.movies[activeIndex.value] ?? null)
const activeRating = computed(() => {
  const rating = activeMovie.value?.vote_average
  return typeof rating === 'number' && Number.isFinite(rating) && rating >= 0 && rating <= 10
    ? rating.toFixed(1)
    : null
})

function formatMovieRating(movie: Movie) {
  const rating = movie.vote_average
  return typeof rating === 'number' && Number.isFinite(rating) && rating >= 0 && rating <= 10
    ? rating.toFixed(1)
    : null
}

function wrapMovieIndex(index: number) {
  const count = props.movies.length
  return count === 0 ? 0 : ((index % count) + count) % count
}

function positionsForCount(count: number): StagePosition[] {
  if (count >= 5) return [-2, -1, 0, 1, 2]
  if (count === 4) return [-1, 0, 1, 2]
  if (count === 3) return [-1, 0, 1]
  if (count === 2) return [0, 1]
  return count === 1 ? [0] : []
}

const stageMovies = computed(() => {
  const positions = positionsForCount(props.movies.length)

  if (!hasShowcaseNavigation.value) {
    return positions.map((position, index) => ({ movie: props.movies[index]!, position }))
  }

  return positions.map((position) => {
    const index = wrapMovieIndex(activeIndex.value + position)
    return { movie: props.movies[index]!, position }
  })
})

function moveShowcase(direction: -1 | 1) {
  activeIndex.value = wrapMovieIndex(activeIndex.value + direction)
}

watch(
  () => props.movies.map((movie) => movie.id),
  (movieIds, previousMovieIds) => {
    const activeMovieId = previousMovieIds?.[activeIndex.value]
    const preservedIndex = activeMovieId == null ? -1 : movieIds.indexOf(activeMovieId)

    activeIndex.value = preservedIndex >= 0 ? preservedIndex : 0
    page.value = Math.min(page.value, Math.max(pageCount.value - 1, 0))
  },
)
</script>

<template>
  <template v-if="presentation === 'showcase'">
    <section
      v-if="isDesktopShowcase"
      class="min-w-0 max-w-full overflow-hidden"
      :aria-label="label"
    >
      <div
        class="movie-showcase-stage"
        :data-movie-count="movies.length"
        :data-static-showcase="!hasShowcaseNavigation || undefined"
      >
        <ol class="absolute inset-0 m-0 list-none p-0">
          <li
            v-for="stageMovie in stageMovies"
            :key="stageMovie.movie.id"
            class="movie-showcase-slot"
            :data-depth="stageMovie.position"
          >
            <div class="movie-showcase-frame">
              <RouterLink
                :to="`/movies/${stageMovie.movie.id}`"
                class="movie-showcase-link block focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                :aria-label="`查看《${getMoviePrimaryTitle(stageMovie.movie)}》電影詳情`"
                :aria-current="
                  showsActiveShowcaseMovie && stageMovie.position === 0 ? 'true' : undefined
                "
              >
                <img
                  v-if="stageMovie.movie.poster_path"
                  :src="getPosterUrl(stageMovie.movie.poster_path)"
                  :alt="`${getMoviePrimaryTitle(stageMovie.movie)} 電影海報`"
                  class="movie-showcase-poster aspect-[2/3] w-full object-cover"
                  loading="lazy"
                />
                <div
                  v-else
                  class="movie-showcase-poster flex aspect-[2/3] w-full flex-col items-center justify-center gap-2 bg-secondary px-4 text-center text-muted-foreground"
                  role="img"
                  :aria-label="`${getMoviePrimaryTitle(stageMovie.movie)} 暫無電影海報`"
                >
                  <span class="text-3xl font-bold text-muted-foreground/35" aria-hidden="true"
                    >M</span
                  >
                  <span class="text-sm">暫無海報</span>
                </div>
              </RouterLink>

              <img
                v-if="
                  (!hasShowcaseNavigation || Math.abs(stageMovie.position) <= 1) &&
                  stageMovie.movie.poster_path
                "
                :src="getPosterUrl(stageMovie.movie.poster_path)"
                alt=""
                class="movie-showcase-reflection"
                aria-hidden="true"
                loading="lazy"
              />
            </div>

            <div
              v-if="movies.length >= 2 && !hasShowcaseNavigation"
              class="movie-showcase-static-info"
            >
              <RouterLink
                :to="`/movies/${stageMovie.movie.id}`"
                class="inline-block rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <h3 class="text-lg font-semibold leading-snug text-foreground">
                  {{ getMoviePrimaryTitle(stageMovie.movie) }}
                </h3>
              </RouterLink>
              <p
                v-if="formatMovieRating(stageMovie.movie)"
                class="mt-1.5 flex items-center justify-center gap-2 font-ui-en text-sm font-semibold text-foreground"
              >
                <span class="text-accent-caramel" aria-hidden="true">★</span>
                <span>{{ formatMovieRating(stageMovie.movie) }}</span>
                <span class="sr-only">，滿分 10 分</span>
              </p>
            </div>
          </li>
        </ol>

        <button
          v-if="hasShowcaseNavigation"
          type="button"
          class="movie-showcase-control movie-showcase-control--previous absolute left-1 top-[42%] z-20 flex size-11 -translate-y-1/2 items-center justify-center rounded-full border border-control bg-background/85 text-muted-foreground shadow-md backdrop-blur-sm transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:left-3"
          :aria-label="`上一部${label}`"
          @click="moveShowcase(-1)"
        >
          <span aria-hidden="true">←</span>
        </button>

        <button
          v-if="hasShowcaseNavigation"
          type="button"
          class="movie-showcase-control movie-showcase-control--next absolute right-1 top-[42%] z-20 flex size-11 -translate-y-1/2 items-center justify-center rounded-full border border-control bg-background/85 text-muted-foreground shadow-md backdrop-blur-sm transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:right-3"
          :aria-label="`下一部${label}`"
          @click="moveShowcase(1)"
        >
          <span aria-hidden="true">→</span>
        </button>

        <Transition name="showcase-info" mode="out-in">
          <div
            v-if="activeMovie && showsActiveShowcaseMovie"
            :key="activeMovie.id"
            class="movie-showcase-info"
            aria-live="polite"
          >
            <span class="mx-auto mb-2 block h-px w-10 bg-accent-caramel" aria-hidden="true"></span>
            <RouterLink
              :to="`/movies/${activeMovie.id}`"
              class="inline-block rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <h3 class="text-xl font-semibold text-foreground sm:text-2xl">
                {{ getMoviePrimaryTitle(activeMovie) }}
              </h3>
            </RouterLink>
            <p
              v-if="activeRating"
              class="mt-1.5 flex items-center justify-center gap-2 font-ui-en text-sm font-semibold text-foreground"
            >
              <span class="text-accent-caramel" aria-hidden="true">★</span>
              <span>{{ activeRating }}</span>
              <span class="sr-only">，滿分 10 分</span>
            </p>
          </div>
        </Transition>
      </div>
    </section>

    <ul
      v-else
      class="flex min-w-0 max-w-full snap-x snap-mandatory gap-4 overflow-x-auto pb-2"
      :aria-label="label"
    >
      <li
        v-for="movie in movies"
        :key="movie.id"
        class="w-[calc((100%_-_1rem)/2)] shrink-0 snap-start"
      >
        <MovieCard :movie="movie" />
      </li>
    </ul>
  </template>

  <div v-else-if="paged" class="relative min-w-0 max-w-full md:px-14">
    <button
      v-if="pageCount > 1"
      type="button"
      class="absolute left-0 top-1/2 z-10 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full border border-control bg-surface text-muted-foreground shadow-sm transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-35 md:flex"
      :disabled="page === 0"
      :aria-label="`上一組${label}`"
      @click="page -= 1"
    >
      <span aria-hidden="true">←</span>
    </button>

    <ul
      class="flex min-w-0 max-w-full snap-x snap-mandatory gap-4 overflow-x-auto pb-2 md:hidden"
      :aria-label="label"
    >
      <li
        v-for="movie in movies"
        :key="movie.id"
        class="w-[calc((100%_-_1rem)/2)] shrink-0 snap-start"
      >
        <MovieCard :movie="movie" />
      </li>
    </ul>

    <ul
      class="hidden gap-4 md:grid"
      :class="desktopGridClass"
      :aria-label="label"
      aria-live="polite"
    >
      <li v-for="movie in visibleMovies" :key="movie.id">
        <MovieCard :movie="movie" />
      </li>
    </ul>

    <button
      v-if="pageCount > 1"
      type="button"
      class="absolute right-0 top-1/2 z-10 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full border border-control bg-surface text-muted-foreground shadow-sm transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-35 md:flex"
      :disabled="page >= pageCount - 1"
      :aria-label="`下一組${label}`"
      @click="page += 1"
    >
      <span aria-hidden="true">→</span>
    </button>
  </div>

  <ul
    v-else
    class="flex min-w-0 max-w-full snap-x snap-mandatory gap-4 overflow-x-auto pb-2"
    :class="!shelf && ['md:grid md:overflow-visible md:pb-0', desktopGridClass]"
    :aria-label="label"
  >
    <li
      v-for="movie in movies"
      :key="movie.id"
      class="w-[calc((100%_-_1rem)/2)] shrink-0 snap-start"
      :class="shelf ? desktopShelfWidth : 'md:w-auto'"
    >
      <MovieCard :movie="movie" />
    </li>
  </ul>
</template>

<template>
  <article class="group flex h-full min-w-0 flex-col">
    <div
      class="poster-separation relative rounded-sm bg-secondary transition-[transform,box-shadow] duration-200 group-hover:-translate-y-0.5 group-hover:scale-[1.01] motion-reduce:transform-none motion-reduce:transition-shadow"
      data-motion="decorative"
    >
      <RouterLink
        :to="`/movies/${movie.id}`"
        class="block rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        :aria-label="`查看《${primaryTitle}》電影詳情`"
      >
        <img
          v-if="movie.poster_path"
          :src="getPosterUrl(movie.poster_path)"
          :alt="`${primaryTitle} 電影海報`"
          class="aspect-[2/3] w-full rounded-sm object-cover"
          loading="lazy"
        />
        <div
          v-else
          class="flex aspect-[2/3] w-full flex-col items-center justify-center gap-2 rounded-sm bg-secondary px-4 text-center text-muted-foreground"
          role="img"
          :aria-label="`${primaryTitle} 暫無電影海報`"
        >
          <span class="text-3xl font-bold text-muted-foreground/35" aria-hidden="true">M</span>
          <span class="text-sm">暫無海報</span>
        </div>
      </RouterLink>

      <button
        type="button"
        class="absolute right-2.5 top-2.5 flex size-11 items-center justify-center rounded-full border border-control bg-surface-raised/95 shadow-md transition-[background-color,color,transform] hover:scale-105 hover:bg-surface motion-reduce:hover:scale-100"
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
          class="size-5"
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
    </div>

    <RouterLink
      :to="`/movies/${movie.id}`"
      class="mt-3 flex flex-1 flex-col rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <h3
        class="line-clamp-2 min-h-10 text-sm font-semibold leading-5 text-foreground sm:text-base"
      >
        {{ primaryTitle }}
      </h3>
      <p class="mt-1 text-xs text-muted-foreground">
        <span v-if="releaseYear">{{ releaseYear }} · </span>電影
      </p>
      <p
        v-if="formattedRating"
        class="mt-3 flex items-center gap-1.5 font-ui-en text-sm font-semibold text-foreground"
      >
        <span class="text-accent-caramel" aria-hidden="true">★</span>
        <span>{{ formattedRating }}</span>
        <span class="sr-only">，滿分 10 分</span>
      </p>
    </RouterLink>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { getMoviePrimaryTitle, getPosterUrl, type Movie } from '@/services/tmdb'
import { useFavorites } from '@/composables/useFavorites'

const props = defineProps<{
  movie: Movie
}>()

const {
  isFavorite: checkIsFavorite,
  toggleFavorite: toggleFavoriteById,
  isFavoriteMutating,
} = useFavorites()

const isFavorite = computed(() => checkIsFavorite(props.movie.id))
const primaryTitle = computed(() => getMoviePrimaryTitle(props.movie))
const releaseYear = computed(() => {
  const year = props.movie.release_date?.slice(0, 4)
  return /^\d{4}$/.test(year ?? '') ? year : null
})

const formattedRating = computed(() => {
  const rating = props.movie.vote_average

  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 10) {
    return null
  }

  return rating.toFixed(1)
})

function toggleFavorite() {
  const genreIds = props.movie.genre_ids ?? props.movie.genres?.map((genre) => genre.id) ?? []
  toggleFavoriteById(props.movie.id, genreIds)
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CollectionPreviewMovie } from '@/services/collections'
import {
  getMovieDetails,
  getMoviePrimaryTitle,
  getPosterUrl,
  type MovieDetails,
} from '@/services/tmdb'

const props = defineProps<{
  collectionName: string
  movieCount: number
  previewMovies: CollectionPreviewMovie[]
}>()

const boundedPreviews = computed(() => props.previewMovies.slice(0, 3))
const resolvedMovies = ref<Array<MovieDetails | null | undefined>>([])
const failedPosterTmdbIds = ref(new Set<number>())
let requestVersion = 0

function markPosterUnavailable(tmdbId: number) {
  failedPosterTmdbIds.value = new Set(failedPosterTmdbIds.value).add(tmdbId)
}

watch(
  () => boundedPreviews.value.map(({ tmdbId }) => tmdbId).join(','),
  async () => {
    const version = ++requestVersion
    const previews = boundedPreviews.value
    resolvedMovies.value = Array.from({ length: previews.length })
    failedPosterTmdbIds.value = new Set()
    if (!previews.length) return

    const results = await Promise.allSettled(previews.map(({ tmdbId }) => getMovieDetails(tmdbId)))
    if (version !== requestVersion) return

    resolvedMovies.value = results.map((result) =>
      result.status === 'fulfilled' ? result.value : null,
    )
  },
  { immediate: true },
)
</script>

<template>
  <div
    class="flex h-40 min-w-0 items-center justify-center gap-2 overflow-hidden rounded-md border border-border bg-secondary/30 p-2"
    role="group"
    :aria-label="`${collectionName}電影預覽`"
  >
    <p v-if="boundedPreviews.length === 0" class="px-4 text-center text-sm text-muted-foreground">
      {{ movieCount === 0 ? '尚未加入電影' : '電影預覽暫缺' }}
    </p>
    <div
      v-for="(preview, index) in boundedPreviews"
      v-else
      :key="`${preview.tmdbId}-${index}`"
      class="aspect-[2/3] w-full max-w-24 min-w-0 flex-1 overflow-hidden rounded-sm bg-secondary"
    >
      <div
        v-if="resolvedMovies[index] === undefined"
        class="size-full animate-pulse bg-secondary"
        aria-hidden="true"
      ></div>
      <img
        v-else-if="resolvedMovies[index]?.poster_path && !failedPosterTmdbIds.has(preview.tmdbId)"
        :src="getPosterUrl(resolvedMovies[index]!.poster_path!)"
        :alt="`${getMoviePrimaryTitle(resolvedMovies[index]!)}電影海報`"
        class="size-full object-cover"
        loading="lazy"
        @error="markPosterUnavailable(preview.tmdbId)"
      />
      <div
        v-else-if="resolvedMovies[index]"
        class="flex size-full items-center justify-center px-2 text-center text-xs text-muted-foreground"
        role="img"
        :aria-label="`${getMoviePrimaryTitle(resolvedMovies[index]!)}暫無電影海報`"
      >
        暫無海報
      </div>
      <div
        v-else
        class="flex size-full items-center justify-center px-2 text-center text-xs text-muted-foreground"
        aria-hidden="true"
      >
        海報暫缺
      </div>
    </div>
  </div>
</template>

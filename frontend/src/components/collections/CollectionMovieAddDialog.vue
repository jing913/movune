<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getMoviePrimaryTitle, getPosterUrl, searchMovies, type Movie } from '@/services/tmdb'

const props = withDefaults(
  defineProps<{
    open: boolean
    collectionName: string
    existingTmdbIds: number[]
    adding?: boolean
    addError?: string
  }>(),
  {
    adding: false,
    addError: '',
  },
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [movie: Movie]
  'clear-error': []
}>()

const query = ref('')
const results = ref<Movie[]>([])
const searching = ref(false)
const searchError = ref('')
const hasSearched = ref(false)
let searchVersion = 0

const existingTmdbIdSet = computed(() => new Set(props.existingTmdbIds))

function handleOpenChange(open: boolean) {
  if (!open && props.adding) return
  emit('update:open', open)
}

async function submitSearch() {
  const normalizedQuery = query.value.trim()
  emit('clear-error')
  if (!normalizedQuery) {
    searchError.value = '請輸入電影名稱。'
    return
  }

  const version = ++searchVersion
  searching.value = true
  searchError.value = ''
  hasSearched.value = true
  try {
    const movies = await searchMovies(normalizedQuery)
    if (version !== searchVersion || !props.open) return
    results.value = movies.slice(0, 10)
  } catch {
    if (version !== searchVersion || !props.open) return
    results.value = []
    searchError.value = '目前無法搜尋電影，請稍後再試。'
  } finally {
    if (version === searchVersion) searching.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      searchVersion += 1
      return
    }
    query.value = ''
    results.value = []
    searching.value = false
    searchError.value = ''
    hasSearched.value = false
  },
)
</script>

<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent
      class="flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col gap-0 overflow-hidden p-0"
    >
      <DialogHeader class="shrink-0 px-5 pb-4 pt-6 text-left sm:px-6">
        <DialogTitle>加入電影</DialogTitle>
        <DialogDescription>搜尋並加入「{{ collectionName }}」。</DialogDescription>
      </DialogHeader>

      <form class="flex shrink-0 gap-2 px-5 pb-4 sm:px-6" @submit.prevent="submitSearch">
        <label class="min-w-0 flex-1">
          <span class="sr-only">搜尋電影名稱</span>
          <input
            v-model="query"
            type="search"
            required
            autofocus
            autocomplete="off"
            placeholder="搜尋電影名稱…"
            class="min-h-11 w-full min-w-0 rounded-md border border-control bg-card px-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            :disabled="searching || adding"
          />
        </label>
        <button
          type="submit"
          class="min-h-11 shrink-0 rounded-md bg-primary-cta px-4 font-semibold text-primary-foreground disabled:cursor-wait disabled:opacity-60"
          :disabled="searching || adding"
          :aria-busy="searching"
        >
          {{ searching ? '搜尋中…' : '搜尋' }}
        </button>
      </form>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 pb-6 sm:px-6">
        <p v-if="searchError || addError" class="mb-3 text-sm text-destructive" role="alert">
          {{ searchError || addError }}
        </p>
        <div
          v-if="searching"
          class="rounded-md bg-secondary p-5 text-sm text-muted-foreground"
          role="status"
        >
          正在搜尋電影…
        </div>
        <div
          v-else-if="hasSearched && results.length === 0 && !searchError"
          class="rounded-md bg-secondary p-5 text-center text-sm text-muted-foreground"
          role="status"
        >
          找不到符合的電影
        </div>
        <ul v-else-if="results.length" class="grid gap-2" aria-label="電影搜尋結果">
          <li v-for="movie in results" :key="movie.id">
            <button
              type="button"
              class="flex min-h-20 w-full min-w-0 items-center gap-3 rounded-md border border-control p-3 text-left transition hover:border-accent-caramel hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="adding || existingTmdbIdSet.has(movie.id)"
              :aria-busy="adding && !existingTmdbIdSet.has(movie.id)"
              @click="emit('select', movie)"
            >
              <div class="h-16 w-11 shrink-0 overflow-hidden rounded-sm bg-secondary">
                <img
                  v-if="movie.poster_path"
                  :src="getPosterUrl(movie.poster_path)"
                  :alt="`${getMoviePrimaryTitle(movie)}電影海報`"
                  class="size-full object-cover"
                  loading="lazy"
                />
                <div
                  v-else
                  class="flex size-full items-center justify-center text-[0.65rem] text-muted-foreground"
                  aria-hidden="true"
                >
                  無海報
                </div>
              </div>
              <span class="min-w-0 flex-1">
                <strong class="block break-words">{{ getMoviePrimaryTitle(movie) }}</strong>
                <small class="mt-1 block text-muted-foreground">
                  {{ movie.release_date?.slice(0, 4) || '年份未提供' }}
                </small>
              </span>
              <span class="shrink-0 text-sm font-semibold text-accent-caramel">
                {{ existingTmdbIdSet.has(movie.id) ? '已在清單中' : adding ? '加入中…' : '加入' }}
              </span>
            </button>
          </li>
        </ul>
      </div>
    </DialogContent>
  </Dialog>
</template>

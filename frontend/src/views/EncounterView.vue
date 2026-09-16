<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type CSSProperties } from 'vue'
import { Dna, RefreshCw } from '@lucide/vue'
import UserAvatar from '@/components/user/UserAvatar.vue'
import {
  getMovieDetails,
  getMovieGenres,
  getMoviePrimaryTitle,
  getPosterUrl,
} from '@/services/tmdb'
import type { EncounterCandidate } from '@/services/users'
import { useEncounterStore, type EncounterSharedMovie } from '@/stores/encounter'
import { useUserStore } from '@/stores/user'

const encounterStore = useEncounterStore()
const userStore = useUserStore()
const genreNames = ref<Record<number, string>>({})
const revealContainer = ref<HTMLElement | null>(null)
const selectionCandidateId = ref<string | null>(null)
const selectionInProgress = ref(false)
const isChangingGroup = ref(false)
const loadingVisible = ref(false)
const sharedMovieLoading = ref(false)
const sharedMovieError = ref(false)
const liveMessage = ref('')
const reduceMotion = ref(false)
let selectionTimer: number | undefined
let groupTimer: number | undefined
let motionQuery: MediaQueryList | undefined

const candidateCount = computed(() => encounterStore.currentCandidates.length)
const selectedCandidate = computed(() => encounterStore.selectedCandidate)
const sharedMoviePoster = computed(
  () => encounterStore.selectedSharedMovies.find((movie) => movie.posterPath)?.posterPath,
)
const sharedMoviePosterUrl = computed(() =>
  sharedMoviePoster.value ? getPosterUrl(sharedMoviePoster.value) : null,
)
const sharedMovieTitles = computed(() => [
  ...new Set(encounterStore.selectedSharedMovies.map((movie) => movie.title).filter(Boolean)),
])
const sharedMovieCopy = computed(() =>
  sharedMovieTitles.value.length
    ? `你們都收藏了${sharedMovieTitles.value.map((title) => `《${title}》`).join('、')}`
    : '',
)
const activeStageVisible = computed(
  () => encounterStore.phase === 'active' || selectionInProgress.value,
)
const instruction = computed(() => {
  const count = candidateCount.value
  if (count === 1) return '今天還有一位電影同好可以遇見。'
  const numerals = ['零', '一', '兩', '三', '四', '五']
  return `從${numerals[count] ?? count}張牌中，選一張翻開。`
})
const sharedDnaNames = computed(() =>
  (selectedCandidate.value?.sharedDnaGenres ?? [])
    .map(({ genreId }) => genreNames.value[genreId])
    .filter((name): name is string => Boolean(name)),
)

const wait = (duration: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, duration))

function requireSession() {
  const user = userStore.currentUser
  const accessToken = userStore.accessToken
  if (!user || !accessToken) throw new Error('Authenticated Encounter session required')
  encounterStore.ensureSession(user._id)
  return { user, accessToken }
}

async function loadRound() {
  if (loadingVisible.value || encounterStore.isLoading) return
  const { user, accessToken } = requireSession()
  liveMessage.value = '正在尋找新的電影同好。'
  loadingVisible.value = true
  await Promise.all([encounterStore.loadRound(user._id, accessToken), wait(240)])
  loadingVisible.value = false

  if (encounterStore.loadState === 'idle') {
    liveMessage.value = `找到 ${candidateCount.value} 位電影同好。`
  } else if (encounterStore.loadState === 'insufficient') {
    liveMessage.value = '需要更多電影收藏，才能建立足夠的配對依據。'
  } else if (encounterStore.loadState === 'empty') {
    liveMessage.value = '目前沒有新的電影同好可以遇見。'
  } else {
    liveMessage.value = '暫時無法取得新的電影同好。'
  }
}

function cardStyle(index: number): CSSProperties {
  const center = (candidateCount.value - 1) / 2
  const position = index - center
  const distance = Math.abs(position)
  return {
    '--card-x': `${position * 184}px`,
    '--card-y': `${distance * 10}px`,
    '--card-rz': `${position * 3.5}deg`,
    '--card-ry': `${position * -4}deg`,
    '--mobile-card-x': `${position * 48}px`,
    '--mobile-card-y': `${distance * 15}px`,
    '--mobile-card-rz': `${position * 6}deg`,
    '--exit-x': `${position < 0 ? -90 : position > 0 ? 90 : 0}px`,
    '--card-z': `${20 - Math.round(distance)}`,
    '--enter-delay': `${distance * 60}ms`,
    '--float-delay': `${index * -0.7}s`,
  } as CSSProperties
}

function clearRevealTimers() {
  if (selectionTimer !== undefined) window.clearTimeout(selectionTimer)
  selectionTimer = undefined
}

async function focusReveal() {
  await nextTick()
  revealContainer.value?.focus({ preventScroll: true })
}

function showPersonReveal() {
  if (encounterStore.revealState === 'mystery' || encounterStore.revealState === 'personReveal') {
    return
  }
  encounterStore.showPersonReveal()
  liveMessage.value = '電影同好已揭曉。'
  void focusReveal()
}

async function loadSharedMovies(candidate: EncounterCandidate) {
  sharedMovieLoading.value = true
  sharedMovieError.value = false

  const tmdbIds = [...new Set(candidate.revealableSharedFavoriteTmdbIds)].slice(0, 1)
  const results = await Promise.allSettled(tmdbIds.map((tmdbId) => getMovieDetails(tmdbId)))
  const movies = results.flatMap<EncounterSharedMovie>((result, index) =>
    result.status === 'fulfilled'
      ? [
          {
            tmdbId: tmdbIds[index]!,
            title: getMoviePrimaryTitle(result.value),
            posterPath: result.value.poster_path,
          },
        ]
      : [],
  )

  if (encounterStore.selectedCandidate?._id === candidate._id) {
    encounterStore.setSelectedSharedMovies(movies)
    sharedMovieError.value = movies.length === 0 || !movies.some((movie) => movie.posterPath)
  }
  sharedMovieLoading.value = false
}

function selectCandidate(candidate: EncounterCandidate) {
  if (selectionInProgress.value || isChangingGroup.value) return
  if (!encounterStore.selectCandidate(candidate._id)) return

  clearRevealTimers()
  selectionCandidateId.value = candidate._id
  selectionInProgress.value = true
  liveMessage.value = '已選擇卡牌，正在揭曉。'

  const sharedMoviesRequest = candidate.revealableSharedFavoriteTmdbIds.length
    ? loadSharedMovies(candidate)
    : Promise.resolve()

  selectionTimer = window.setTimeout(
    async () => {
      await sharedMoviesRequest
      if (encounterStore.selectedCandidate?._id !== candidate._id) return
      selectionInProgress.value = false
      encounterStore.showEvidenceReveal()
      liveMessage.value =
        encounterStore.revealState === 'movieReveal'
          ? '你們都收藏了這部電影。'
          : encounterStore.revealState === 'dnaReveal'
            ? '你們的電影品味，在這些類型產生了交集。'
            : '一個新的電影同好。'
      void focusReveal()
    },
    reduceMotion.value ? 20 : 360,
  )
}

function changeGroup() {
  if (isChangingGroup.value || encounterStore.isLoading) return
  isChangingGroup.value = true
  liveMessage.value = '正在更換這組卡牌。'
  groupTimer = window.setTimeout(
    async () => {
      await loadRound()
      isChangingGroup.value = false
    },
    reduceMotion.value ? 20 : 240,
  )
}

function updateMotionPreference(event: MediaQueryListEvent | MediaQueryList) {
  reduceMotion.value = event.matches
}

onMounted(async () => {
  const user = userStore.currentUser
  if (user) encounterStore.ensureSession(user._id)

  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  updateMotionPreference(motionQuery)
  motionQuery.addEventListener('change', updateMotionPreference)

  try {
    const genres = await getMovieGenres()
    genreNames.value = Object.fromEntries(genres.map((genre) => [genre.id, genre.name]))
  } catch {
    genreNames.value = {}
  }

  if (
    encounterStore.selectedCandidate?.revealableSharedFavoriteTmdbIds.length &&
    encounterStore.selectedSharedMovies.length === 0
  ) {
    void loadSharedMovies(encounterStore.selectedCandidate)
  }
})

onBeforeUnmount(() => {
  clearRevealTimers()
  if (groupTimer !== undefined) window.clearTimeout(groupTimer)
  motionQuery?.removeEventListener('change', updateMotionPreference)
})
</script>

<template>
  <div class="page-shell overflow-x-clip pb-14 pt-8 sm:pt-10">
    <header class="mx-auto max-w-2xl text-center">
      <h1 class="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">今日雷達</h1>
    </header>

    <p class="sr-only" aria-live="polite" aria-atomic="true">{{ liveMessage }}</p>

    <main
      class="encounter-stage mx-auto mt-10 max-w-6xl sm:mt-12"
      :class="{ 'encounter-stage--result': encounterStore.phase === 'result' }"
    >
      <section
        v-if="loadingVisible || encounterStore.isLoading"
        class="encounter-state-panel"
        aria-labelledby="encounter-loading-heading"
        aria-busy="true"
      >
        <RefreshCw class="mx-auto size-7 animate-spin text-accent-caramel" aria-hidden="true" />
        <h2 id="encounter-loading-heading" class="mt-4 text-lg font-semibold">
          正在尋找新的電影同好…
        </h2>
      </section>

      <section v-else-if="encounterStore.loadState === 'error'" class="encounter-state-panel">
        <p class="text-muted-foreground" role="alert">暫時無法取得新的電影同好。</p>
        <button type="button" class="encounter-primary-button mt-5" @click="loadRound">
          再試一次
        </button>
      </section>

      <section
        v-else-if="encounterStore.loadState === 'insufficient'"
        class="encounter-state-panel"
        role="status"
      >
        <p class="text-lg font-semibold">需要更多電影收藏，才能建立足夠的配對依據。</p>
        <p class="mt-2 text-muted-foreground">先收藏至少三部具有類型資料的電影。</p>
        <RouterLink to="/explore" class="encounter-primary-button mt-5">探索電影</RouterLink>
      </section>

      <section v-else-if="encounterStore.loadState === 'empty'" class="encounter-state-panel">
        <p class="text-lg font-semibold">目前沒有新的電影同好可以遇見。</p>
        <p class="mt-2 text-muted-foreground">收藏更多電影後，再回來看看。</p>
        <RouterLink to="/explore" class="encounter-primary-button mt-5">探索電影</RouterLink>
      </section>

      <section
        v-else-if="encounterStore.phase === 'entry'"
        class="encounter-entry-panel pt-14 sm:pt-12"
      >
        <p class="text-base leading-7 text-muted-foreground">
          解析你的 Movie DNA，探索今日與你電影喜好相近的同好。
        </p>
        <button
          type="button"
          class="encounter-primary-button mt-24"
          :disabled="encounterStore.isLoading"
          @click="loadRound"
        >
          開始探索
        </button>
      </section>

      <section
        v-else-if="activeStageVisible"
        class="pt-2 sm:pt-4"
        aria-labelledby="encounter-instruction"
      >
        <div
          class="mx-auto grid max-w-5xl grid-cols-1 items-center gap-3 px-1 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
        >
          <p id="encounter-instruction" class="text-center font-semibold sm:col-start-2">
            {{ instruction }}
          </p>
          <button
            type="button"
            class="inline-flex min-h-11 shrink-0 items-center gap-2 justify-self-end rounded-md px-3 text-sm font-semibold text-foreground transition-colors hover:bg-surface-raised disabled:cursor-wait disabled:opacity-50 sm:col-start-3 sm:row-start-1"
            :disabled="isChangingGroup || selectionInProgress"
            @click="changeGroup"
          >
            <RefreshCw class="size-4" aria-hidden="true" />
            換一組
          </button>
        </div>

        <div class="encounter-card-field" :data-count="candidateCount">
          <button
            v-for="(candidate, index) in encounterStore.currentCandidates"
            :key="candidate._id"
            type="button"
            class="mystery-card"
            :class="{
              'is-selected': selectionCandidateId === candidate._id && selectionInProgress,
              'is-exiting':
                (selectionInProgress && selectionCandidateId !== candidate._id) || isChangingGroup,
            }"
            :style="cardStyle(index)"
            :aria-disabled="selectionInProgress || isChangingGroup"
            :aria-label="`神秘卡牌 ${index + 1}`"
            @click="selectCandidate(candidate)"
          >
            <span class="mystery-card__pattern" aria-hidden="true">
              <span class="mystery-card__mark">M</span>
            </span>
          </button>
        </div>
      </section>

      <section
        v-else-if="selectedCandidate"
        class="flex flex-col items-center"
        aria-label="今日雷達揭曉"
      >
        <Transition name="reveal-flip" mode="out-in" appear>
          <article
            v-if="encounterStore.revealState !== 'personReveal'"
            :key="encounterStore.revealState"
            ref="revealContainer"
            tabindex="-1"
            class="encounter-reveal-card encounter-reveal-card--movie"
          >
            <template v-if="encounterStore.revealState === 'movieReveal'">
              <div v-if="sharedMovieLoading" class="text-center" role="status">
                <RefreshCw
                  class="mx-auto size-7 animate-spin text-accent-caramel"
                  aria-hidden="true"
                />
                <p class="mt-4 text-sm text-muted-foreground">正在準備電影線索…</p>
              </div>
              <template v-else>
                <img
                  v-if="sharedMoviePosterUrl"
                  :src="sharedMoviePosterUrl"
                  alt=""
                  class="encounter-shared-poster"
                  aria-hidden="true"
                />
                <p v-else class="text-sm text-destructive" role="alert">電影海報暫時無法載入。</p>
              </template>
              <p class="mt-6 whitespace-nowrap text-center text-lg font-semibold leading-7">
                你們都收藏了這部電影。
              </p>
            </template>

            <template v-else-if="encounterStore.revealState === 'dnaReveal'">
              <Dna class="size-9 text-accent-caramel" aria-hidden="true" />
              <h2 class="mt-5 text-center text-xl font-semibold">共同的電影類型</h2>
              <ul class="mt-6 flex flex-wrap justify-center gap-2" aria-label="共同電影類型">
                <li
                  v-for="genre in sharedDnaNames"
                  :key="genre"
                  class="rounded-full bg-secondary px-3 py-1.5 text-sm font-medium text-foreground"
                >
                  {{ genre }}
                </li>
              </ul>
              <p class="mt-6 text-center text-base leading-7 text-muted-foreground">
                你們的電影品味，在這些類型產生了交集。
              </p>
            </template>

            <template v-else>
              <Dna class="size-9 text-accent-caramel" aria-hidden="true" />
              <h2 class="mt-5 text-center text-xl font-semibold">一個新的電影同好</h2>
              <p class="mt-6 text-center text-base leading-7 text-muted-foreground">
                有些相遇，不一定從同一部電影開始。
              </p>
            </template>

            <button
              type="button"
              class="mt-8 min-h-11 rounded-md px-4 text-sm font-semibold text-foreground hover:bg-surface-raised"
              @click="showPersonReveal"
            >
              立即揭曉
            </button>
          </article>

          <article
            v-else
            key="person"
            ref="revealContainer"
            tabindex="-1"
            class="encounter-reveal-card encounter-reveal-card--person"
            aria-labelledby="encounter-person-name"
          >
            <UserAvatar
              class="encounter-avatar"
              :account="selectedCandidate.account"
              :user-id="selectedCandidate._id"
            />
            <h2 id="encounter-person-name" class="mt-4 text-xl font-semibold">
              {{ selectedCandidate.displayName || selectedCandidate.account }}
            </h2>

            <div
              class="mt-5 flex items-center justify-center gap-2 text-sm font-semibold text-accent-caramel"
            >
              <Dna class="size-5" aria-hidden="true" />
              <span>Movie DNA Match</span>
            </div>

            <dl v-if="sharedDnaNames.length" class="mt-6 w-full space-y-5 text-center">
              <div>
                <dt class="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  共同電影類型
                </dt>
                <dd class="mt-2 font-medium">
                  {{ sharedDnaNames.join(' · ') }}
                </dd>
              </div>
            </dl>

            <p v-if="sharedMovieCopy" class="mt-6 text-center text-sm leading-6 text-foreground">
              {{ sharedMovieCopy }}
            </p>
            <p v-else-if="sharedMovieError" class="mt-6 text-center text-sm text-destructive">
              共同收藏電影暫時無法載入。
            </p>

            <div class="mt-7 w-full">
              <RouterLink
                :to="`/people/${selectedCandidate._id}`"
                class="encounter-primary-button w-full"
              >
                查看主頁
              </RouterLink>
            </div>
          </article>
        </Transition>

        <button
          v-if="encounterStore.phase === 'result'"
          type="button"
          class="mt-6 min-h-11 rounded-md px-5 font-semibold text-foreground hover:bg-surface-raised"
          @click="loadRound"
        >
          探索下一位 →
        </button>
      </section>
    </main>
  </div>
</template>

<style scoped>
.encounter-stage {
  min-height: 36rem;
}

.encounter-stage--result {
  min-height: 43rem;
}

.encounter-state-panel {
  display: flex;
  min-height: 25rem;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem 1rem;
  text-align: center;
}

.encounter-entry-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-inline: 1rem;
  text-align: center;
}

.encounter-primary-button {
  display: inline-flex;
  min-height: 2.75rem;
  align-items: center;
  justify-content: center;
  border-radius: 0.5rem;
  background: var(--primary-cta);
  padding: 0.625rem 1.25rem;
  font-weight: 600;
  color: var(--primary-foreground);
  transition:
    background-color 180ms ease,
    opacity 180ms ease;
}

.encounter-primary-button:hover {
  background: var(--primary-cta-hover);
}

.encounter-primary-button:active {
  background: var(--primary-cta-pressed);
}

.encounter-primary-button:disabled {
  cursor: wait;
  opacity: 0.6;
}

.encounter-card-field {
  position: relative;
  min-height: 30rem;
  perspective: 1100px;
  margin-top: 1.75rem;
}

.mystery-card {
  position: absolute;
  top: 5.5rem;
  left: 50%;
  z-index: var(--card-z);
  width: 11.75rem;
  height: 16.75rem;
  padding: 0.55rem;
  border: 1px solid color-mix(in srgb, var(--accent-caramel) 42%, var(--border));
  border-radius: 0.75rem;
  background: linear-gradient(145deg, var(--surface-raised), var(--card));
  box-shadow:
    0 20px 45px rgba(0, 0, 0, 0.3),
    0 0 0 1px color-mix(in srgb, var(--accent-caramel) 10%, transparent);
  transform: translateX(calc(-50% + var(--card-x))) translateY(var(--card-y))
    rotateZ(var(--card-rz)) rotateY(var(--card-ry));
  transform-style: preserve-3d;
  animation: encounter-enter 520ms ease-out var(--enter-delay) both;
  transition:
    transform 360ms cubic-bezier(0.2, 0.8, 0.2, 1),
    width 360ms cubic-bezier(0.2, 0.8, 0.2, 1),
    height 360ms cubic-bezier(0.2, 0.8, 0.2, 1),
    opacity 240ms ease,
    filter 240ms ease,
    box-shadow 180ms ease;
  touch-action: manipulation;
}

.mystery-card:hover,
.mystery-card:focus-visible {
  z-index: 40;
  transform: translateX(calc(-50% + var(--card-x))) translateY(calc(var(--card-y) - 10px))
    rotateZ(0deg) rotateY(0deg) scale(1.04);
  box-shadow:
    0 26px 58px rgba(0, 0, 0, 0.38),
    0 0 28px color-mix(in srgb, var(--accent-caramel) 26%, transparent);
}

.mystery-card:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.mystery-card.is-exiting {
  pointer-events: none;
  opacity: 0;
  filter: blur(2px);
  transform: translateX(calc(-50% + var(--card-x))) translateX(var(--exit-x)) translateY(2.5rem)
    scale(0.88);
}

.mystery-card.is-selected {
  z-index: 50;
  width: min(calc(100vw - 2.5rem), 18.75rem);
  height: 32rem;
  transform: translateX(-50%) translateY(-3.25rem) rotate(0deg);
}

.mystery-card__pattern {
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--accent-caramel) 28%, transparent);
  border-radius: 0.5rem;
  background:
    radial-gradient(
      circle at center,
      transparent 0 22%,
      rgba(181, 132, 61, 0.12) 22% 23%,
      transparent 23% 39%,
      rgba(181, 132, 61, 0.1) 39% 40%,
      transparent 40%
    ),
    repeating-linear-gradient(45deg, transparent 0 12px, rgba(181, 132, 61, 0.055) 12px 13px),
    var(--surface-raised);
  animation: encounter-float 4.2s ease-in-out calc(600ms + var(--float-delay)) infinite;
}

.mystery-card:hover .mystery-card__pattern,
.mystery-card:focus-visible .mystery-card__pattern,
.mystery-card.is-selected .mystery-card__pattern {
  animation-play-state: paused;
}

.mystery-card__mark {
  display: grid;
  width: 4rem;
  height: 4rem;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent-caramel) 45%, transparent);
  border-radius: 999px;
  font-family: var(--font-family-ui-en);
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--accent-caramel);
}

.encounter-reveal-card {
  display: flex;
  width: min(calc(100vw - 2.5rem), 18.75rem);
  min-height: 32rem;
  flex-direction: column;
  align-items: center;
  border: 1px solid color-mix(in srgb, var(--accent-caramel) 30%, var(--border));
  border-radius: 0.75rem;
  background: linear-gradient(160deg, var(--surface-raised), var(--card));
  padding: 2rem 1.5rem;
  box-shadow: 0 28px 70px rgba(0, 0, 0, 0.36);
}

.encounter-reveal-card--movie {
  justify-content: center;
  padding-block: 1.75rem;
}

.encounter-reveal-card--person {
  justify-content: center;
}

.encounter-shared-poster {
  width: 10.5rem;
  aspect-ratio: 2 / 3;
  border-radius: 0.25rem;
  object-fit: cover;
  box-shadow: 0 18px 38px rgba(0, 0, 0, 0.4);
}

.encounter-reveal-card:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.encounter-avatar {
  width: 5rem;
  height: 5rem;
}

.reveal-flip-enter-active,
.reveal-flip-leave-active {
  transition:
    transform 260ms ease,
    opacity 180ms ease;
  backface-visibility: hidden;
}

.reveal-flip-enter-from {
  opacity: 0;
  transform: rotateY(90deg);
}

.reveal-flip-leave-to {
  opacity: 0;
  transform: rotateY(-90deg);
}

@keyframes encounter-enter {
  from {
    opacity: 0;
  }
}

@keyframes encounter-float {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-5px);
  }
}

@media (max-width: 47.999rem) {
  .encounter-card-field {
    min-height: 29rem;
  }

  .mystery-card {
    top: 6rem;
    width: 8.75rem;
    height: 13rem;
    transform: translateX(calc(-50% + var(--mobile-card-x))) translateY(var(--mobile-card-y))
      rotateZ(var(--mobile-card-rz));
  }

  .mystery-card:hover,
  .mystery-card:focus-visible {
    transform: translateX(calc(-50% + var(--mobile-card-x)))
      translateY(calc(var(--mobile-card-y) - 6px)) rotateZ(0deg) scale(1.03);
  }

  .mystery-card.is-exiting {
    transform: translateX(calc(-50% + var(--mobile-card-x))) translateX(var(--exit-x))
      translateY(2rem) scale(0.9);
  }

  .mystery-card.is-selected {
    width: min(calc(100vw - 2.5rem), 18.75rem);
    height: 32rem;
    transform: translateX(-50%) translateY(-4rem) rotate(0deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .mystery-card,
  .mystery-card:hover,
  .mystery-card:focus-visible,
  .mystery-card.is-selected,
  .mystery-card.is-exiting {
    animation: none;
    transition: opacity 80ms linear;
  }

  .mystery-card__pattern {
    animation: none;
  }

  .mystery-card {
    transform: translateX(calc(-50% + var(--card-x)));
  }

  .mystery-card.is-selected {
    transform: translateX(-50%);
  }

  .mystery-card.is-exiting {
    opacity: 0;
    filter: none;
  }

  .reveal-flip-enter-active,
  .reveal-flip-leave-active {
    transition: opacity 80ms linear;
  }

  .reveal-flip-enter-from,
  .reveal-flip-leave-to {
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) and (max-width: 47.999rem) {
  .mystery-card {
    transform: translateX(calc(-50% + var(--mobile-card-x)));
  }

  .mystery-card.is-selected {
    transform: translateX(-50%);
  }
}
</style>

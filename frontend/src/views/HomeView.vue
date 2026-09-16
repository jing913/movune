<template>
  <div>
    <section
      class="home-hero page-shell relative isolate grid min-h-[34rem] items-center overflow-hidden pb-14 pt-10 sm:min-h-[38rem] lg:min-h-[36rem] lg:grid-cols-[0.82fr_1.18fr] lg:pb-20 lg:pt-16"
    >
      <div class="home-hero__atmosphere" aria-hidden="true">
        <img :src="homeHeroAtmosphere" alt="" class="home-hero__image" />
        <span class="home-hero__mask"></span>
      </div>

      <div class="relative z-10 max-w-xl">
        <h1
          class="font-display-en text-5xl font-medium leading-[0.88] tracking-[-0.025em] text-accent-caramel sm:text-6xl lg:text-7xl"
        >
          Meet People<br />Through Movies
        </h1>
        <p
          class="mt-6 font-display-zh text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-4xl lg:text-5xl"
        >
          透過電影，<br />拉近彼此的距離。
        </p>
        <p class="mt-6 font-sans text-lg leading-8 text-muted-foreground">
          探索精彩電影，遇見志同道合的人。
        </p>
        <RouterLink
          to="/explore"
          class="home-hero-cta relative isolate mt-8 inline-flex min-h-12 items-center justify-center overflow-hidden rounded-md bg-primary-cta px-7 py-3 font-medium text-primary-foreground shadow-md active:bg-primary-cta-pressed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span class="home-hero-cta__fill absolute inset-0" aria-hidden="true"></span>
          <span class="relative z-10 inline-flex items-center">
            開始探索
            <span class="home-hero-cta__arrow" aria-hidden="true">→</span>
          </span>
        </RouterLink>
      </div>
    </section>

    <section class="page-shell pb-16" aria-labelledby="how-movune-works">
      <div class="mb-7">
        <p
          class="font-display-en text-sm font-semibold uppercase tracking-[0.18em] text-accent-caramel"
        >
          How Movune Works
        </p>
        <h2
          id="how-movune-works"
          class="mt-2 font-display-zh text-2xl font-semibold tracking-tight sm:text-3xl"
        >
          從喜歡的電影，展開一段故事
        </h2>
      </div>

      <ol class="story-path">
        <li class="story-step">
          <span class="story-marker" aria-label="步驟 1">1</span>
          <div class="story-cue story-cue--collection" aria-hidden="true">
            <span class="story-poster story-poster--back"></span>
            <span class="story-poster story-poster--middle"></span>
            <span class="story-poster story-poster--front"></span>
            <span class="story-favorite"><Heart class="size-4" :stroke-width="1.8" /></span>
          </div>
          <h3 class="story-title">收藏電影</h3>
          <p class="story-description">紀錄珍藏片單，沉澱專屬於你的觀影品味。</p>
        </li>
        <li class="story-step">
          <span class="story-marker" aria-label="步驟 2">2</span>
          <div class="story-cue story-cue--dna" aria-hidden="true">
            <span class="story-dna-ring story-dna-ring--outer"></span>
            <span class="story-dna-ring story-dna-ring--inner"></span>
            <span class="story-dna-core"></span>
            <span class="story-dna-orbit story-dna-orbit--one"></span>
            <span class="story-dna-orbit story-dna-orbit--two"></span>
            <span class="story-dna-orbit story-dna-orbit--three"></span>
          </div>
          <h3 class="story-title">建立 Movie DNA</h3>
          <p class="story-description">每一部收藏，都在勾勒你的電影個性。</p>
        </li>
        <li class="story-step">
          <span class="story-marker" aria-label="步驟 3">3</span>
          <div class="story-cue story-cue--match" aria-hidden="true">
            <span class="story-match-dna story-match-dna--one"></span>
            <span class="story-match-dna story-match-dna--two"></span>
            <span class="story-match-resonance"></span>
          </div>
          <h3 class="story-title">探索電影同好</h3>
          <p class="story-description">以相同的喜好為引，尋找與你頻率相近的人。</p>
        </li>
      </ol>
    </section>

    <section class="page-shell pb-12" aria-labelledby="home-people-heading">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div class="w-full min-w-0 max-w-2xl sm:w-auto">
          <p
            class="font-display-en text-sm font-semibold uppercase tracking-[0.18em] text-accent-caramel"
          >
            Explore People
          </p>
          <h2
            id="home-people-heading"
            class="mt-2 font-display-zh text-2xl font-semibold tracking-tight sm:text-3xl"
          >
            探索與你有相同品味的同好
          </h2>
          <p class="mt-3 text-sm leading-6 text-muted-foreground sm:text-base">
            收藏喜歡的電影，遇見懂你的人。
          </p>
        </div>
        <RouterLink
          to="/people"
          class="group inline-flex min-h-11 items-center rounded-md px-2 font-sans text-sm font-semibold text-foreground transition-colors hover:text-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          探索更多同好
          <span
            class="ml-2 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none"
            aria-hidden="true"
            >→</span
          >
        </RouterLink>
      </div>

      <div
        v-if="!userStore.isLoggedIn"
        class="mt-7 rounded-lg bg-secondary/55 px-6 py-10 text-center"
        role="status"
      >
        <p class="font-semibold text-foreground">登入解鎖 Movie DNA Match</p>
        <p class="mt-2 text-sm leading-6 text-muted-foreground">
          查看你們重疊的珍藏片單，開啟第一句電影對話。
        </p>
        <RouterLink
          to="/people"
          class="mt-5 inline-flex min-h-11 items-center rounded-md bg-primary-cta px-6 font-semibold text-primary-foreground hover:bg-primary-cta-hover active:bg-primary-cta-pressed"
        >
          立即登入探索
        </RouterLink>
      </div>
      <div
        v-else-if="homePeopleQuery.asyncStatus.value === 'loading'"
        class="mt-7 grid gap-5 md:grid-cols-3"
        aria-label="同好推薦載入中"
      >
        <div
          v-for="index in 3"
          :key="index"
          class="h-64 animate-pulse rounded-lg bg-secondary"
        ></div>
      </div>
      <div
        v-else-if="homePeopleQuery.error.value || homeGenreQuery.error.value"
        class="mt-7 rounded-lg bg-secondary/55 px-6 py-10 text-center text-muted-foreground"
        role="alert"
      >
        同好推薦目前無法載入，仍可前往探索同好稍後重試。
      </div>
      <div
        v-else-if="homeRecommendationStatus === 'insufficient_signal'"
        class="mt-7 rounded-lg bg-secondary/55 px-6 py-10 text-center"
        role="status"
      >
        <p class="font-semibold text-foreground">需要更多電影收藏，才能建立足夠的推薦依據。</p>
        <RouterLink
          to="/explore"
          class="mt-5 inline-flex min-h-11 items-center rounded-md bg-primary-cta px-6 font-semibold text-primary-foreground hover:bg-primary-cta-hover active:bg-primary-cta-pressed"
        >
          探索電影
        </RouterLink>
      </div>
      <div
        v-else-if="homeRecommendationStatus === 'eligible' && homePeople.length === 0"
        class="mt-7 rounded-lg bg-secondary/55 px-6 py-10 text-center"
        role="status"
      >
        <p class="font-semibold text-foreground">目前還沒有符合推薦條件的同好。</p>
        <RouterLink
          to="/people"
          class="mt-5 inline-flex min-h-11 items-center rounded-md border border-control px-6 font-semibold text-foreground hover:bg-surface-raised"
        >
          探索其他會員
        </RouterLink>
      </div>
      <ul v-else-if="homePeople.length > 0" class="mt-7 grid gap-5 md:grid-cols-3">
        <li v-for="person in homePeople" :key="person._id">
          <PeopleCard
            :person="person"
            :genre-names="homeGenreNames"
            :pending="homePendingUserId === person._id"
            recommendation-mode="formal"
            :formal-shared-dna-genres="person.sharedDnaGenres"
            :formal-revealable-shared-favorite-tmdb-ids="person.revealableSharedFavoriteTmdbIds"
            @toggle-follow="toggleHomeFollow"
          />
        </li>
      </ul>
      <p v-if="homeFollowError" class="mt-4 text-sm font-medium text-destructive" role="alert">
        {{ homeFollowError }}
      </p>
    </section>

    <section class="page-shell pb-12" aria-labelledby="popular-movies">
      <div class="border-y border-border/70 bg-background py-7 sm:py-9">
        <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p class="font-display-zh text-sm font-semibold text-accent-caramel">本週焦點</p>
            <h2
              id="popular-movies"
              class="mt-1 font-display-zh text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              熱門電影
            </h2>
          </div>
          <RouterLink
            class="group inline-flex min-h-11 items-center rounded-md px-2 font-sans text-sm font-semibold text-foreground transition-colors hover:text-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            to="/explore"
          >
            查看更多
            <span
              class="ml-2 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none"
              aria-hidden="true"
              >→</span
            >
          </RouterLink>
        </div>

        <div
          v-if="popularLoading"
          class="flex gap-5 overflow-hidden pb-10 md:grid md:grid-cols-3 lg:grid-cols-5"
          aria-label="熱門電影載入中"
        >
          <div
            v-for="index in 5"
            :key="index"
            class="poster-separation aspect-[2/3] w-[68vw] max-w-56 shrink-0 animate-pulse rounded-sm bg-secondary md:w-auto md:max-w-none"
          ></div>
        </div>
        <div
          v-else-if="popularError"
          class="rounded-lg border border-border bg-surface p-8 text-center text-muted-foreground"
          role="status"
        >
          熱門電影載入失敗，請稍後再試。
        </div>
        <div
          v-else-if="popularMovies.length === 0"
          class="rounded-lg border border-border bg-surface p-8 text-center text-muted-foreground"
        >
          目前沒有熱門電影。
        </div>
        <MovieCarousel
          v-else
          :movies="popularMovies"
          label="熱門電影"
          :desktop-columns="5"
          paged
          presentation="showcase"
        />
      </div>
    </section>

    <section class="page-shell pb-4" aria-labelledby="now-playing-movies">
      <div class="border-y border-border/70 bg-background py-7 sm:py-9">
        <div class="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p class="font-display-zh text-sm font-semibold text-accent-caramel">走進電影院</p>
            <h2
              id="now-playing-movies"
              class="mt-1 font-display-zh text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              現正上映
            </h2>
          </div>
          <RouterLink
            class="group inline-flex min-h-11 items-center rounded-md px-2 font-sans text-sm font-semibold text-foreground transition-colors hover:text-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            to="/explore"
          >
            查看更多
            <span
              class="ml-2 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none"
              aria-hidden="true"
              >→</span
            >
          </RouterLink>
        </div>

        <div
          v-if="nowPlayingLoading"
          class="flex gap-5 overflow-hidden pb-10 md:grid md:grid-cols-3 lg:grid-cols-5"
          aria-label="現正上映電影載入中"
        >
          <div
            v-for="index in 5"
            :key="index"
            class="poster-separation aspect-[2/3] w-[68vw] max-w-56 shrink-0 animate-pulse rounded-sm bg-secondary md:w-auto md:max-w-none"
          ></div>
        </div>
        <div
          v-else-if="nowPlayingError"
          class="rounded-lg border border-border bg-surface p-8 text-center text-muted-foreground"
          role="status"
        >
          現正上映電影載入失敗，請稍後再試。
        </div>
        <div
          v-else-if="nowPlayingMovies.length === 0"
          class="rounded-lg border border-border bg-surface p-8 text-center text-muted-foreground"
        >
          目前沒有現正上映的電影。
        </div>
        <MovieCarousel
          v-else
          :movies="nowPlayingMovies"
          label="現正上映電影"
          :desktop-columns="5"
          paged
          presentation="showcase"
        />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useQuery, useQueryCache } from '@pinia/colada'
import { Heart } from '@lucide/vue'
import homeHeroAtmosphere from '@/assets/home-hero-atmosphere.png'
import MovieCarousel from '@/components/MovieCarousel.vue'
import PeopleCard from '@/components/user/PeopleCard.vue'
import { followUser, unfollowUser } from '@/services/follows'
import { getMovieGenres, getNowPlayingMovies, getPopularMovies, type Movie } from '@/services/tmdb'
import {
  getFormalRecommendations,
  type FormalRecommendationItem,
  type UserSummary,
} from '@/services/users'
import { useUserStore } from '@/stores/user'

const userStore = useUserStore()
const queryCache = useQueryCache()
const homePendingUserId = ref<string | null>(null)
const homeFollowError = ref('')

const homePeopleQuery = useQuery({
  key: () => ['home-people', userStore.currentUser?._id ?? 'guest'],
  enabled: () => Boolean(userStore.currentUser && userStore.accessToken),
  query: () => {
    const accessToken = userStore.accessToken
    if (!accessToken) throw new Error('Access token is required')
    return getFormalRecommendations({ page: 1, limit: 3 }, accessToken)
  },
})
const homeGenreQuery = useQuery({ key: () => ['tmdb', 'movie-genres'], query: getMovieGenres })
const homePeople = computed(() => homePeopleQuery.data.value?.items ?? [])
const homeRecommendationStatus = computed(() => homePeopleQuery.data.value?.status)
const homeGenreNames = computed(() =>
  Object.fromEntries((homeGenreQuery.data.value ?? []).map((genre) => [genre.id, genre.name])),
)

async function toggleHomeFollow(person: FormalRecommendationItem | UserSummary) {
  const accessToken = userStore.accessToken
  if (!accessToken || homePendingUserId.value) return
  homePendingUserId.value = person._id
  homeFollowError.value = ''

  try {
    const wasFollowing = person.isFollowing
    if (wasFollowing) await unfollowUser(person._id, accessToken)
    else await followUser(person._id, accessToken)
    person.isFollowing = !wasFollowing
    person.followerCount = Math.max(0, person.followerCount + (wasFollowing ? -1 : 1))
    queryCache.invalidateQueries({ key: ['formal-recommendations'] })
    queryCache.invalidateQueries({ key: ['people'] })
    queryCache.invalidateQueries({ key: ['follow-summary', person._id] })
  } catch {
    homeFollowError.value = '關注狀態無法更新，請稍後再試。'
  } finally {
    homePendingUserId.value = null
  }
}

const popularMovies = ref<Movie[]>([])
const nowPlayingMovies = ref<Movie[]>([])

const popularLoading = ref(true)
const popularError = ref(false)
const nowPlayingLoading = ref(true)
const nowPlayingError = ref(false)

onMounted(async () => {
  const [popularResult, nowPlayingResult] = await Promise.allSettled([
    getPopularMovies(),
    getNowPlayingMovies(),
  ])

  if (popularResult.status === 'fulfilled') {
    popularMovies.value = popularResult.value
  } else {
    popularError.value = true
  }

  if (nowPlayingResult.status === 'fulfilled') {
    nowPlayingMovies.value = nowPlayingResult.value
  } else {
    nowPlayingError.value = true
  }

  popularLoading.value = false
  nowPlayingLoading.value = false
})
</script>

<style scoped>
.home-hero__atmosphere {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
}

.home-hero__image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 70% center;
}

.home-hero__mask {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--background) 92%, transparent) 0%,
      color-mix(in srgb, var(--background) 84%, transparent) 34%,
      color-mix(in srgb, var(--background) 62%, transparent) 68%,
      color-mix(in srgb, var(--background) 28%, transparent) 100%
    ),
    linear-gradient(
      180deg,
      color-mix(in srgb, var(--background) 32%, transparent) 0%,
      transparent 34%,
      transparent 66%,
      color-mix(in srgb, var(--background) 38%, transparent) 100%
    ),
    rgba(0, 0, 0, 0.22);
}

.home-hero__mask::before,
.home-hero__mask::after {
  position: absolute;
  content: '';
  pointer-events: none;
}

.home-hero__mask::before {
  right: 0;
  bottom: 0;
  left: 0;
  height: 42%;
  background: linear-gradient(
    180deg,
    transparent 0%,
    color-mix(in srgb, var(--background) 10%, transparent) 18%,
    color-mix(in srgb, var(--background) 38%, transparent) 52%,
    color-mix(in srgb, var(--background) 78%, transparent) 80%,
    var(--background) 100%
  );
}

.home-hero__mask::after {
  top: 0;
  right: 0;
  bottom: 0;
  width: 32%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in srgb, var(--background) 8%, transparent) 20%,
    color-mix(in srgb, var(--background) 34%, transparent) 54%,
    color-mix(in srgb, var(--background) 74%, transparent) 82%,
    var(--background) 100%
  );
}

.home-hero-cta__fill {
  pointer-events: none;
  background: var(--primary-cta-hover);
  transform: translateX(-101%);
  transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
}

.home-hero-cta__arrow {
  display: inline-block;
  width: 1em;
  margin-left: 0.5rem;
  opacity: 0;
  transform: translateX(-0.125rem);
  transition:
    opacity 180ms ease,
    transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
}

.home-hero-cta:focus-visible .home-hero-cta__fill,
.home-hero-cta:active .home-hero-cta__fill {
  transform: translateX(0);
}

.home-hero-cta:focus-visible .home-hero-cta__arrow,
.home-hero-cta:active .home-hero-cta__arrow {
  opacity: 1;
  transform: translateX(0);
}

.home-hero-cta:active .home-hero-cta__fill {
  background: var(--primary-cta-pressed);
}

@media (hover: hover) and (pointer: fine) {
  .home-hero-cta:hover .home-hero-cta__fill {
    transform: translateX(0);
  }

  .home-hero-cta:hover .home-hero-cta__arrow {
    opacity: 1;
    transform: translateX(0);
  }
}

@media (min-width: 1024px) {
  .home-hero__image {
    object-position: center;
  }

  .home-hero__mask {
    background:
      linear-gradient(
        90deg,
        color-mix(in srgb, var(--background) 88%, transparent) 0%,
        color-mix(in srgb, var(--background) 74%, transparent) 22%,
        color-mix(in srgb, var(--background) 48%, transparent) 48%,
        color-mix(in srgb, var(--background) 24%, transparent) 74%,
        color-mix(in srgb, var(--background) 10%, transparent) 100%
      ),
      linear-gradient(
        180deg,
        color-mix(in srgb, var(--background) 28%, transparent) 0%,
        transparent 32%,
        transparent 68%,
        color-mix(in srgb, var(--background) 34%, transparent) 100%
      ),
      rgba(0, 0, 0, 0.18);
  }

  .home-hero__mask::before {
    height: 38%;
  }

  .home-hero__mask::after {
    width: 24%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .home-hero-cta__fill,
  .home-hero-cta__arrow {
    transition: none;
  }

  .home-hero-cta:hover .home-hero-cta__arrow,
  .home-hero-cta:focus-visible .home-hero-cta__arrow,
  .home-hero-cta:active .home-hero-cta__arrow {
    transform: none;
  }
}

.story-path {
  --story-gap: 2.5rem;

  position: relative;
  display: grid;
  gap: var(--story-gap);
  list-style: none;
}

.story-step {
  position: relative;
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.story-marker {
  position: relative;
  z-index: 1;
  display: grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent-caramel) 72%, transparent);
  border-radius: 9999px;
  color: var(--accent-caramel-light);
  background: var(--background);
  font-family: var(--font-family-ui-en);
  font-size: 0.8125rem;
  font-weight: 700;
  line-height: 1;
}

.story-marker::after {
  position: absolute;
  top: calc(100% + 0.25rem);
  left: 50%;
  width: 1px;
  height: 0.5rem;
  background: color-mix(in srgb, var(--accent-caramel) 38%, transparent);
  content: '';
}

.story-cue {
  position: relative;
  width: 5.5rem;
  height: 5.5rem;
  margin-top: 1rem;
}

.story-title {
  margin-top: 1.25rem;
  color: var(--foreground);
  font-size: 1.125rem;
  font-weight: 700;
}

.story-description {
  max-width: 19rem;
  margin-top: 0.5rem;
  color: var(--muted-foreground);
  font-family: var(--font-family-ui-zh);
  font-size: 0.875rem;
  line-height: 1.5rem;
}

.story-poster {
  position: absolute;
  bottom: 0;
  width: 2.75rem;
  height: 4.125rem;
  border: 1px solid color-mix(in srgb, var(--accent-caramel) 42%, var(--border));
  border-radius: 0.2rem;
  background: var(--surface-raised);
  box-shadow: 0 0.5rem 1.25rem rgba(0, 0, 0, 0.26);
}

.story-poster::after {
  position: absolute;
  right: 0.4rem;
  bottom: 0.45rem;
  left: 0.4rem;
  height: 1px;
  background: color-mix(in srgb, var(--accent-caramel) 45%, transparent);
  content: '';
}

.story-poster--back {
  left: 2.15rem;
  opacity: 0.42;
  transform: rotate(8deg) translateY(0.15rem);
}

.story-poster--middle {
  left: 1.25rem;
  opacity: 0.7;
  transform: rotate(2deg);
}

.story-poster--front {
  left: 0.25rem;
  background: linear-gradient(145deg, var(--surface-raised), var(--surface));
  transform: rotate(-5deg) translateY(-0.1rem);
}

.story-favorite {
  position: absolute;
  right: 0;
  bottom: 0.3rem;
  z-index: 2;
  display: grid;
  width: 2rem;
  height: 2rem;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--accent-caramel) 48%, var(--border));
  border-radius: 9999px;
  color: var(--accent-caramel-light);
  background: var(--surface);
}

.story-cue--dna {
  display: grid;
  place-items: center;
}

.story-dna-ring,
.story-dna-core,
.story-dna-orbit {
  position: absolute;
  border-radius: 9999px;
}

.story-dna-ring--outer {
  width: 5rem;
  height: 5rem;
  border: 1px solid color-mix(in srgb, var(--accent-caramel) 34%, transparent);
  border-top-color: var(--accent-caramel);
  transform: rotate(28deg);
}

.story-dna-ring--inner {
  width: 3.25rem;
  height: 3.25rem;
  border: 1px dashed color-mix(in srgb, var(--accent-caramel-light) 55%, transparent);
  transform: rotate(-18deg);
}

.story-dna-core {
  width: 1.25rem;
  height: 1.25rem;
  border: 1px solid var(--accent-caramel-light);
  background: var(--accent-caramel-soft);
}

.story-dna-orbit {
  width: 0.4rem;
  height: 0.4rem;
  background: var(--accent-caramel-light);
  box-shadow: 0 0 0.75rem var(--cinema-glow);
}

.story-dna-orbit--one {
  top: 0.42rem;
  left: 4.65rem;
}

.story-dna-orbit--two {
  right: 0.25rem;
  bottom: 1.05rem;
  opacity: 0.72;
}

.story-dna-orbit--three {
  bottom: 1.35rem;
  left: 0.25rem;
  opacity: 0.48;
}

.story-cue--match {
  display: grid;
  place-items: center;
}

.story-match-dna {
  position: absolute;
  top: 50%;
  width: 3.25rem;
  height: 3.25rem;
  border: 1px solid color-mix(in srgb, var(--accent-caramel) 52%, transparent);
  border-top-color: var(--accent-caramel);
  border-radius: 9999px;
  background: radial-gradient(
    circle at 82% 20%,
    var(--accent-caramel-light) 0 0.13rem,
    transparent 0.15rem
  );
  transform: translateY(-50%);
}

.story-match-dna::before,
.story-match-dna::after {
  position: absolute;
  top: 50%;
  left: 50%;
  border-radius: 9999px;
  content: '';
  transform: translate(-50%, -50%);
}

.story-match-dna::before {
  width: 2.05rem;
  height: 2.05rem;
  border: 1px dashed color-mix(in srgb, var(--accent-caramel-light) 58%, transparent);
}

.story-match-dna::after {
  width: 0.65rem;
  height: 0.65rem;
  border: 1px solid var(--accent-caramel-light);
  background: var(--accent-caramel-soft);
}

.story-match-dna--one {
  top: calc(50% - 0.18rem);
  left: 0.1rem;
  transform: translateY(-50%) rotate(-24deg);
}

.story-match-dna--two {
  top: calc(50% + 0.18rem);
  right: 0.1rem;
  border-color: color-mix(in srgb, var(--accent-caramel-light) 56%, transparent);
  border-top-color: var(--accent-caramel-light);
  transform: translateY(-50%) rotate(24deg);
}

.story-match-resonance {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 2;
  width: 0.5rem;
  height: 0.5rem;
  border: 1px solid var(--background);
  border-radius: 9999px;
  background: var(--accent-caramel-light);
  box-shadow: 0 0 0.5rem var(--cinema-glow);
  transform: translate(-50%, -50%);
}

@media (min-width: 48rem) {
  .story-path {
    --story-gap: 1.5rem;

    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--story-gap);
  }

  .story-cue {
    margin-top: 1rem;
  }
}

@media (min-width: 64rem) {
  .story-path {
    --story-gap: 2.5rem;
  }
}
</style>

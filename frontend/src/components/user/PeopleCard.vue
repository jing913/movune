<script setup lang="ts">
import { computed } from 'vue'
import { Dna } from '@lucide/vue'
import UserAvatar from '@/components/user/UserAvatar.vue'
import type { SharedDnaGenre, UserSummary } from '@/services/users'

const props = withDefaults(
  defineProps<{
    person: UserSummary
    genreNames?: Record<number, string>
    pending?: boolean
    recommendationMode:
      'discovery' | 'formal' | 'current-movie' | 'following-shared-dna' | 'relationship-only'
    formalSharedDnaGenres?: SharedDnaGenre[]
    formalRevealableSharedFavoriteTmdbIds?: number[]
    contextualSharedDnaGenres?: SharedDnaGenre[]
  }>(),
  {
    genreNames: () => ({}),
    pending: false,
    formalSharedDnaGenres: () => [],
    formalRevealableSharedFavoriteTmdbIds: () => [],
    contextualSharedDnaGenres: () => [],
  },
)

const emit = defineEmits<{
  toggleFollow: [person: UserSummary]
}>()

const displayName = computed(() => props.person.displayName?.trim() || props.person.account)
const sharedGenres = computed(() => {
  const genreIds =
    props.recommendationMode === 'formal'
      ? props.formalSharedDnaGenres.map(({ genreId }) => genreId)
      : props.recommendationMode === 'following-shared-dna'
        ? props.contextualSharedDnaGenres.map(({ genreId }) => genreId)
        : []

  return genreIds
    .map((genreId) => props.genreNames[genreId])
    .filter((name): name is string => Boolean(name))
})
const sharedFavoriteCount = computed(() => props.formalRevealableSharedFavoriteTmdbIds.length)
</script>

<template>
  <article
    class="flex h-full min-w-0 flex-col rounded-lg border border-border bg-card p-4 shadow-[0_10px_28px_rgba(72,17,34,0.05)] sm:p-5"
  >
    <div class="flex min-w-0 items-start gap-3">
      <UserAvatar :account="person.account" :user-id="person._id" />
      <div class="min-w-0 flex-1">
        <h3 class="truncate text-base font-bold text-foreground sm:text-lg">{{ displayName }}</h3>
        <p class="truncate text-xs text-muted-foreground">
          @{{ person.account }} · {{ person.followerCount }} 粉絲 · {{ person.followingCount }} 關注
        </p>
      </div>
      <button
        type="button"
        class="min-h-9 shrink-0 rounded-md px-3 text-xs font-semibold transition disabled:cursor-wait disabled:opacity-60"
        :class="
          person.isFollowing
            ? 'border border-control bg-transparent text-foreground hover:bg-surface-raised'
            : 'bg-primary-cta text-primary-foreground hover:bg-primary-cta-hover active:bg-primary-cta-pressed'
        "
        :disabled="pending"
        :aria-pressed="person.isFollowing"
        :aria-busy="pending"
        :aria-label="person.isFollowing ? `取消關注 ${displayName}` : `關注 ${displayName}`"
        @click="emit('toggleFollow', person)"
      >
        {{ person.isFollowing ? '✓ 已關注' : '+ 關注' }}
      </button>
    </div>

    <p class="mt-3 line-clamp-2 min-h-10 text-sm leading-5 text-muted-foreground">
      {{ person.bio || '這位會員尚未填寫自我介紹。' }}
    </p>

    <div v-if="recommendationMode === 'formal'" class="mt-3 border-t border-border pt-3">
      <p class="flex items-center gap-2 text-sm font-bold text-foreground">
        <Dna class="size-4 text-accent-caramel" aria-hidden="true" />
        <span>Movie DNA Match</span>
      </p>
      <p v-if="sharedFavoriteCount > 0" class="mt-1 text-sm text-muted-foreground">
        收藏 {{ sharedFavoriteCount }} 部相同電影
      </p>
      <ul v-if="sharedGenres.length" class="mt-2 flex flex-wrap gap-1.5" aria-label="共同電影類型">
        <li
          v-for="genre in sharedGenres"
          :key="genre"
          class="rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold text-muted-foreground"
        >
          {{ genre }}
        </li>
      </ul>
    </div>

    <div
      v-else-if="recommendationMode === 'current-movie'"
      class="mt-3 border-t border-border pt-3"
    >
      <p class="text-sm font-semibold text-foreground">也收藏了這部電影</p>
    </div>

    <div
      v-else-if="recommendationMode === 'following-shared-dna' && sharedGenres.length"
      class="mt-3 border-t border-border pt-3"
    >
      <p class="text-sm font-semibold text-foreground">共同的電影類型</p>
      <ul class="mt-2 flex flex-wrap gap-1.5" aria-label="共同電影類型">
        <li
          v-for="genre in sharedGenres"
          :key="genre"
          class="rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold text-muted-foreground"
        >
          {{ genre }}
        </li>
      </ul>
    </div>

    <RouterLink
      :to="`/people/${person._id}`"
      class="mt-auto inline-flex min-h-10 items-center pt-3 text-sm font-semibold text-foreground underline-offset-4 hover:text-accent-caramel hover:underline"
    >
      查看主頁 <span class="ml-1" aria-hidden="true">→</span>
    </RouterLink>
  </article>
</template>

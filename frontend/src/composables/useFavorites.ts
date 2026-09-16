import { useQuery, useMutation, useQueryCache } from '@pinia/colada'
import { useUserStore } from '@/stores/user'
import {
  getFavorites,
  getFavoritesVisibility,
  createFavorite,
  deleteFavorite,
  updateFavoritesVisibility,
  type CreateFavoriteInput,
  type FavoritesVisibility,
} from '@/services/favorites'
import { computed } from 'vue'

export function useFavorites({ includeVisibility = false } = {}) {
  const userStore = useUserStore()
  const queryCache = useQueryCache()

  const favoritesQuery = useQuery({
    key: () => ['favorites', userStore.currentUser?._id ?? 'anonymous'],

    enabled: () => Boolean(userStore.currentUser && userStore.accessToken),

    query: () => {
      const accessToken = userStore.accessToken

      if (!accessToken) {
        throw new Error('Access token is required')
      }

      return getFavorites(accessToken)
    },
  })

  const favoritesVisibilityQuery = useQuery({
    key: () => ['favorites-visibility', userStore.currentUser?._id ?? 'anonymous'],
    enabled: () => Boolean(includeVisibility && userStore.currentUser && userStore.accessToken),
    query: () => {
      const accessToken = userStore.accessToken
      if (!accessToken) throw new Error('Access token is required')
      return getFavoritesVisibility(accessToken)
    },
  })

  const updateFavoritesVisibilityMutation = useMutation({
    mutation: (visibility: FavoritesVisibility) => {
      const accessToken = userStore.accessToken
      if (!accessToken) throw new Error('Access token is required')
      return updateFavoritesVisibility(visibility, accessToken)
    },
    onSuccess: (visibility) => {
      const userId = userStore.currentUser?._id
      if (!userId) return
      queryCache.setQueryData<FavoritesVisibility>(['favorites-visibility', userId], visibility)
      queryCache.invalidateQueries({ key: ['public-movie-space'] })
      queryCache.invalidateQueries({ key: ['people'] })
      queryCache.invalidateQueries({ key: ['dna-match'] })
    },
  })

  function isFavorite(tmdbId: number) {
    return favoritesQuery.data.value?.some((favorite) => favorite.tmdbId === tmdbId) ?? false
  }

  const createFavoriteMutation = useMutation({
    mutation: (input: CreateFavoriteInput) => {
      const accessToken = userStore.accessToken

      if (!accessToken) {
        throw new Error('Access token is required')
      }

      return createFavorite(input, accessToken)
    },
    onSuccess: () => {
      const userId = userStore.currentUser?._id

      if (!userId) {
        return
      }

      queryCache.invalidateQueries({
        key: ['favorites', userId],
      })
      queryCache.invalidateQueries({
        key: ['movie-dna', userId],
      })
      queryCache.invalidateQueries({
        key: ['dna-match'],
      })
    },
  })

  const deleteFavoriteMutation = useMutation({
    mutation: (tmdbId: number) => {
      const accessToken = userStore.accessToken
      if (!accessToken) {
        throw new Error('Access token is required')
      }
      return deleteFavorite(tmdbId, accessToken)
    },

    onSuccess: () => {
      const userId = userStore.currentUser?._id
      if (!userId) {
        return
      }
      queryCache.invalidateQueries({
        key: ['favorites', userId],
      })
      queryCache.invalidateQueries({
        key: ['movie-dna', userId],
      })
      queryCache.invalidateQueries({
        key: ['dna-match'],
      })
    },
  })

  function toggleFavorite(tmdbId: number, genreIds: number[] = []) {
    if (isFavorite(tmdbId)) {
      // 執行 delete mutation
      deleteFavoriteMutation.mutate(tmdbId)
    } else {
      // 執行 create mutation
      createFavoriteMutation.mutate({ tmdbId, genreIds })
    }
  }

  const isFavoriteMutating = computed(() => {
    return (
      createFavoriteMutation.asyncStatus.value === 'loading' ||
      deleteFavoriteMutation.asyncStatus.value === 'loading'
    )
  })

  return {
    favoritesQuery,
    favoritesVisibilityQuery,
    updateFavoritesVisibilityMutation,
    isFavorite,
    createFavoriteMutation,
    deleteFavoriteMutation,
    toggleFavorite,
    isFavoriteMutating,
  }
}

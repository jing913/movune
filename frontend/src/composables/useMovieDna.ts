import { useQuery } from '@pinia/colada'
import { getMovieDna } from '@/services/users'
import { useUserStore } from '@/stores/user'

export function useMovieDna() {
  const userStore = useUserStore()

  const movieDnaQuery = useQuery({
    key: () => ['movie-dna', userStore.currentUser?._id ?? 'anonymous'],
    enabled: () => Boolean(userStore.currentUser && userStore.accessToken),
    query: () => {
      const userId = userStore.currentUser?._id
      const accessToken = userStore.accessToken

      if (!userId || !accessToken) {
        throw new Error('Authenticated user is required')
      }

      return getMovieDna(userId, accessToken).then((response) => response.movieDna)
    },
  })

  return {
    movieDnaQuery,
  }
}

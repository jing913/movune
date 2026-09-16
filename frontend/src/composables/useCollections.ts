import { useQuery } from '@pinia/colada'
import { getCollections } from '@/services/collections'
import { useUserStore } from '@/stores/user'

export function useCollections() {
  const userStore = useUserStore()
  const collectionsQuery = useQuery({
    key: () => ['collections', userStore.currentUser?._id ?? 'anonymous'],
    enabled: () => Boolean(userStore.currentUser && userStore.accessToken),
    query: getCollections,
  })

  return { collectionsQuery }
}

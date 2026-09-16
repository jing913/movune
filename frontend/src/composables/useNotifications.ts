import { computed } from 'vue'
import { useInfiniteQuery, useMutation, useQueryCache } from '@pinia/colada'
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationDto,
} from '@/services/notifications'
import { useUserStore } from '@/stores/user'

const notificationKey = (userId: string) => ['notifications', userId] as const

function requireAccessToken(accessToken: string | null) {
  if (!accessToken) throw new Error('Access token is required')
  return accessToken
}

export function useInboxNotifications() {
  const userStore = useUserStore()

  const query = useInfiniteQuery({
    key: () => [...notificationKey(userStore.currentUser?._id ?? 'anonymous'), 'inbox'],
    enabled: () => Boolean(userStore.currentUser && userStore.accessToken),
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    initialPageParam: null as string | null,
    query: ({ pageParam }) =>
      getNotifications(
        { limit: 20, ...(pageParam ? { cursor: pageParam } : {}) },
        requireAccessToken(userStore.accessToken),
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  })

  const notifications = computed(() => {
    const seen = new Set<string>()
    return (query.data.value?.pages ?? []).flatMap((page) =>
      page.notifications.filter((notification) => {
        if (seen.has(notification._id)) return false
        seen.add(notification._id)
        return true
      }),
    )
  })

  return {
    query,
    notifications,
    unreadCount: computed(() => query.data.value?.pages[0]?.unreadCount ?? 0),
  }
}

export function useNotificationMutations() {
  const userStore = useUserStore()
  const queryCache = useQueryCache()

  const synchronizeNotifications = () => {
    const userId = userStore.currentUser?._id
    if (!userId) return
    return queryCache.invalidateQueries({ key: notificationKey(userId) })
  }

  const markReadMutation = useMutation({
    mutation: (notification: NotificationDto) =>
      markNotificationRead(notification._id, requireAccessToken(userStore.accessToken)),
    onSuccess: synchronizeNotifications,
  })

  const markAllReadMutation = useMutation({
    mutation: () => markAllNotificationsRead(requireAccessToken(userStore.accessToken)),
    onSuccess: synchronizeNotifications,
  })

  return { markReadMutation, markAllReadMutation }
}

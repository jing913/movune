import { computed, ref } from 'vue'
import { getInboxSummary, type InboxSummary } from '@/services/messaging'
import { useUserStore } from '@/stores/user'

const emptySummary: InboxSummary = {
  messagesHasUnread: false,
  discussionsHasUnread: false,
  notificationsHasUnread: false,
  inboxHasUnread: false,
  pendingIncomingRequestCount: 0,
  inboxNeedsAttention: false,
}

const summary = ref<InboxSummary>(emptySummary)
let summaryUserId: string | null = null
let refreshPromise: Promise<InboxSummary> | null = null
let refreshPromiseUserId: string | null = null

export function useInboxSummary() {
  const userStore = useUserStore()

  async function refresh() {
    const userId = userStore.currentUser?._id ?? null
    if (!userId || !userStore.accessToken) {
      summaryUserId = null
      summary.value = emptySummary
      return summary.value
    }
    if (summaryUserId !== userId) {
      summaryUserId = userId
      summary.value = emptySummary
    }
    if (refreshPromise && refreshPromiseUserId === userId) return refreshPromise
    const request = getInboxSummary().then((nextSummary) => {
      if (summaryUserId === userId) summary.value = nextSummary
      return nextSummary
    })
    refreshPromise = request
    refreshPromiseUserId = userId
    void request.then(
      () => {
        if (refreshPromise === request) {
          refreshPromise = null
          refreshPromiseUserId = null
        }
      },
      () => {
        if (refreshPromise === request) {
          refreshPromise = null
          refreshPromiseUserId = null
        }
      },
    )
    return request
  }

  return {
    summary: computed(() => summary.value),
    refresh,
  }
}

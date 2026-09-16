<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Film, Inbox, MessageCircle, MoreHorizontal, Send, UserRound } from '@lucide/vue'
import UserAvatar from '@/components/user/UserAvatar.vue'
import NotificationRow from '@/components/notifications/NotificationRow.vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useInboxSummary } from '@/composables/useInboxSummary'
import { useInboxNotifications, useNotificationMutations } from '@/composables/useNotifications'
import type { NotificationDto } from '@/services/notifications'
import { useUserStore } from '@/stores/user'
import { directInvalidationPolicy } from '@/services/directRealtimePolicy'
import {
  applyOwnedLifecycleFailure,
  commitOwnedDirectSend,
  convergeAuthoritativeDirectConversation,
  createDirectLifecycleMutationLock,
  createDirectPresentationOwnership,
  directLifecycleProblem,
  directResolutionControls,
  reconcileBackgroundDirectConversation,
  reconcileOwnedOrdinaryDirectSend,
  type DirectLifecycleAction,
  type DirectPresentationToken,
} from '@/services/directLifecycle'
import {
  createDirectListCoordinator,
  directViewFromDetail,
  messageTabs,
  tabFocusTarget,
} from '@/services/directReadModel'
import {
  createLatestProjectionReconciler,
  createReadInvalidationHandler,
} from '@/services/readInvalidation'
import {
  acceptDirectConversation,
  declineDirectConversation,
  getDirectConversation,
  getDirectMessages,
  getDiscussionMessages,
  getDiscussionRoom,
  joinDiscussion,
  leaveDiscussion,
  listDirectConversations,
  listDiscussionRooms,
  markDirectRead,
  markDiscussionRead,
  resolveDirectConversation,
  sendDirectMessage,
  sendDiscussionMessage,
  sendFirstDirectMessage,
  type DirectConversationDetailDto,
  type DirectConversationDto,
  type DirectView,
  type DiscussionSummary,
  type MessageDto,
  type Person,
} from '@/services/messaging'
import {
  connectRealtime,
  onRealtime,
  onRealtimeConnect,
  subscribeDiscussion,
  unsubscribeDiscussion,
} from '@/services/realtime'

type Tab = 'messages' | 'discussions' | 'notifications'
const tabs: { id: Tab; label: string }[] = [
  { id: 'messages', label: '訊息' },
  { id: 'discussions', label: '討論群' },
  { id: 'notifications', label: '通知' },
]
const GROUPING_THRESHOLD_MS = 5 * 60 * 1000
const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const activeTab = ref<Tab>('messages')
const focusedTab = ref(0)
const activeDirectView = ref<DirectView>('conversations')
const focusedMessageTab = ref(0)
const directRows = ref<DirectConversationDto[]>([])
const directNextCursor = ref<string | null>(null)
const directPageLoading = ref(false)
const directPageError = ref('')
const discussionRows = ref<DiscussionSummary[]>([])
const selectedDirect = ref<DirectConversationDetailDto | null>(null)
const selectedRoom = ref<DiscussionSummary | null>(null)
const composeTarget = ref<Person | null>(null)
const messages = ref<MessageDto[]>([])
const draft = ref('')
const listLoading = ref(false)
const threadLoading = ref(false)
const listError = ref('')
const threadError = ref('')
const sendError = ref('')
const sending = ref(false)
const lifecycleMutationError = ref('')
const lifecycleLockStates = ref<Record<string, DirectLifecycleAction>>({})
const olderCursor = ref<string | null>(null)
const latestCursor = ref<string | null>(null)
const paginationError = ref('')
const detailPane = ref<HTMLElement | null>(null)
const detailHeading = ref<HTMLElement | null>(null)
const messagePane = ref<HTMLElement | null>(null)
const listPane = ref<HTMLElement | null>(null)
const tabList = ref<HTMLElement | null>(null)
const messageTabList = ref<HTMLElement | null>(null)
const notificationActionError = ref('')
const notificationReadInFlight = new Set<string>()
const hasNewMessages = ref(false)
const isAtLiveEdge = ref(true)
const directActionsStale = ref(false)
const directSharedContextSuppressed = ref(false)
let directReconciliationVersion = 0
let listLoadVersion = 0
const lifecycleMutationLock = createDirectLifecycleMutationLock((change) => {
  const next = { ...lifecycleLockStates.value }
  if (change.action) next[change.conversationId] = change.action
  else delete next[change.conversationId]
  lifecycleLockStates.value = next
})
const directPresentationOwnership = createDirectPresentationOwnership(
  () => selectedDirect.value?.id ?? null,
)
const isMobileDetail = computed(() =>
  Boolean(
    route.query.conversation || route.query.room || route.query.notification || route.query.compose,
  ),
)
const { query: notificationQuery, notifications } = useInboxNotifications()
const { markReadMutation } = useNotificationMutations()
const { summary: inboxSummary, refresh: refreshInboxSummary } = useInboxSummary()
const selectedNotification = computed(() => {
  const notificationId =
    typeof route.query.notification === 'string' ? route.query.notification : null
  return notificationId
    ? (notifications.value.find((notification) => notification._id === notificationId) ?? null)
    : null
})

const selectedContext = computed(() => selectedDirect.value ?? selectedRoom.value)
const isEndedView = computed(() => activeDirectView.value === 'ended')
const directOtherUser = computed<Person | null>(() =>
  selectedDirect.value
    ? {
        id: selectedDirect.value.counterpart.id,
        account: selectedDirect.value.counterpart.username,
        displayName: selectedDirect.value.counterpart.displayName,
        avatar: selectedDirect.value.counterpart.avatarUrl ?? null,
      }
    : composeTarget.value,
)
const directOtherUserId = computed(() => directOtherUser.value?.id ?? null)
const lifecycleMutationPending = computed(() =>
  Boolean(selectedDirect.value && lifecycleLockStates.value[selectedDirect.value.id]),
)
const selectedLifecycleAction = computed(() =>
  selectedDirect.value ? lifecycleLockStates.value[selectedDirect.value.id] : undefined,
)
const resolutionControls = computed(() =>
  directResolutionControls(
    selectedDirect.value,
    directActionsStale.value || lifecycleMutationPending.value,
  ),
)
const sharedMovieContextText = computed(() => {
  if (directSharedContextSuppressed.value || !selectedDirect.value?.sharedContext.shouldRender)
    return ''
  const count = selectedDirect.value.sharedContext.movies?.length ?? 0
  return count ? `你們收藏的電影中，有 ${count} 部相同` : ''
})
const threadTitle = computed(
  () =>
    selectedDirect.value?.counterpart.displayName ||
    selectedDirect.value?.counterpart.username ||
    composeTarget.value?.displayName ||
    composeTarget.value?.account ||
    selectedRoom.value?.movieSnapshot.title ||
    '',
)
const canSend = computed(
  () =>
    draft.value.trim().length > 0 &&
    (selectedDirect.value
      ? !lifecycleMutationPending.value &&
        !directActionsStale.value &&
        resolutionControls.value.mayReply
      : !sending.value),
)
const canLinkDirectCounterpart = computed(
  () =>
    !selectedDirect.value ||
    !['blocked', 'revoked_unavailable'].includes(selectedDirect.value.interactionState),
)

function tabHasUnread(tab: Tab) {
  if (tab === 'messages') return inboxSummary.value.messagesHasUnread
  if (tab === 'discussions') return inboxSummary.value.discussionsHasUnread
  return inboxSummary.value.notificationsHasUnread
}

function validTab(value: unknown): Tab {
  return tabs.some((tab) => tab.id === value) ? (value as Tab) : 'messages'
}
function validDirectView(value: unknown): DirectView {
  return value === 'requests' || value === 'ended' ? value : 'conversations'
}
function directStateLabel(row: DirectConversationDto) {
  if (row.interactionState === 'pending_incoming') return '等待你處理'
  if (row.interactionState === 'pending_outgoing') return '等待對方回覆'
  if (row.interactionState === 'blocked') return '互動已結束'
  if (row.interactionState === 'declined') return '邀請已婉拒'
  if (row.interactionState === 'revoked_unavailable') return '互動已結束'
  return ''
}
function time(value?: string) {
  return value
    ? new Intl.DateTimeFormat('zh-TW', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value))
    : ''
}
function isGrouped(index: number) {
  const current = messages.value[index]
  const previous = messages.value[index - 1]
  return Boolean(
    current &&
    previous &&
    current.senderId === previous.senderId &&
    new Date(current.createdAt).valueOf() - new Date(previous.createdAt).valueOf() <=
      GROUPING_THRESHOLD_MS,
  )
}
function upsertMessage(message: MessageDto) {
  if (!messages.value.some((item) => item.id === message.id)) messages.value.push(message)
  messages.value.sort(
    (a, b) =>
      new Date(a.createdAt).valueOf() - new Date(b.createdAt).valueOf() || a.id.localeCompare(b.id),
  )
}

function updateLiveEdge() {
  const pane = messagePane.value
  if (!pane) return
  const wasAtLiveEdge = isAtLiveEdge.value
  isAtLiveEdge.value = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48
  if (isAtLiveEdge.value) {
    hasNewMessages.value = false
    const latest = messages.value.at(-1)
    if (!wasAtLiveEdge && latest && document.visibilityState === 'visible')
      void markCurrentContextRead(latest.id)
  }
}

async function scrollToLatest() {
  await nextTick()
  const pane = messagePane.value
  if (!pane) return
  pane.scrollTop = pane.scrollHeight
  isAtLiveEdge.value = true
  hasNewMessages.value = false
  const latest = messages.value.at(-1)
  if (latest && document.visibilityState === 'visible') await markCurrentContextRead(latest.id)
}

function reconcileReadProjection(contextType: 'direct' | 'discussion', contextId: string) {
  const rows = contextType === 'direct' ? directRows.value : discussionRows.value
  const row = rows.find((item) => item.id === contextId)
  if (row) row.hasUnread = false
  if (contextType === 'direct' && selectedDirect.value?.id === contextId)
    selectedDirect.value = { ...selectedDirect.value, hasUnread: false }
  if (contextType === 'discussion' && selectedRoom.value?.id === contextId)
    selectedRoom.value.hasUnread = false
}

async function markCurrentContextRead(throughMessageId: string) {
  try {
    if (selectedDirect.value) {
      const contextId = selectedDirect.value.id
      await markDirectRead(contextId, throughMessageId)
      reconcileReadProjection('direct', contextId)
    } else if (selectedRoom.value?.membership?.status === 'joined') {
      const contextId = selectedRoom.value.id
      await markDiscussionRead(contextId, throughMessageId)
      reconcileReadProjection('discussion', contextId)
    } else return
    await refreshInboxSummary().catch(() => {})
  } catch {
    // A realtime read.updated event or the next reconciliation restores server truth.
  }
}

const directListCoordinator = createDirectListCoordinator(
  listDirectConversations,
  (view, rows, nextCursor) => {
    if (activeTab.value !== 'messages' || activeDirectView.value !== view) return
    directRows.value = rows
    directNextCursor.value = nextCursor
    if (selectedDirect.value) {
      const selected = rows.find((row) => row.id === selectedDirect.value?.id)
      if (selected)
        selectedDirect.value = { ...selectedDirect.value, hasUnread: selected.hasUnread }
    }
  },
)

async function reconcileDirectList() {
  if (activeTab.value !== 'messages') return false
  return directListCoordinator.replace(activeDirectView.value)
}
const reconcileDiscussionList = createLatestProjectionReconciler(listDiscussionRooms, (rows) => {
  discussionRows.value = rows
  if (selectedRoom.value) {
    const selected = rows.find((row) => row.id === selectedRoom.value?.id)
    if (selected) selectedRoom.value = selected
  }
})
async function reconcileActiveDirect(
  trigger: 'direct.updated' | 'relationship.updated' | 'reconnect',
) {
  const conversationId = selectedDirect.value?.id
  if (!conversationId) return { applied: false, status: 'superseded' as const }
  const originatingView = activeDirectView.value
  const ownershipToken = directPresentationOwnership.capture(conversationId)
  const requestVersion = ++directReconciliationVersion
  const policy = directInvalidationPolicy(trigger)
  // Fail closed: persisted messages stay visible while shared context and actions remain stale.
  return reconcileBackgroundDirectConversation({
    conversationId,
    originatingView,
    loadConversation: () => getDirectConversation(conversationId),
    markAuthorityStale: () => {
      directActionsStale.value = policy.disableActions
      if (policy.suppressSharedContext) directSharedContextSuppressed.value = true
    },
    install: (conversation) => {
      selectedDirect.value = conversation
      directActionsStale.value = false
      directSharedContextSuppressed.value = false
    },
    currentView: () => activeDirectView.value,
    replaceRoute: async (view, id) => {
      activeDirectView.value = view
      await router.replace({
        path: '/inbox',
        query: { tab: 'messages', view, conversation: id },
      })
    },
    reconcileProjection: reconcileLifecycleProjection,
    refreshSummary: refreshInboxSummary,
    ownsPresentation: () => directPresentationOwnership.owns(ownershipToken),
    isCurrentRequest: () => requestVersion === directReconciliationVersion,
  })
}

async function focusDirectDetailHeading() {
  await nextTick()
  detailHeading.value?.focus({ preventScroll: true })
}

function reconcileLifecycleProjection(view: DirectView) {
  if (activeTab.value === 'messages' && activeDirectView.value === view)
    return directListCoordinator.replace(view)
  return listDirectConversations(view).then(() => true)
}

function refreshInactiveLifecycle(originatingView: DirectView, destinationView?: DirectView) {
  void Promise.allSettled([
    reconcileLifecycleProjection(originatingView),
    ...(destinationView ? [reconcileLifecycleProjection(destinationView)] : []),
    refreshInboxSummary(),
  ])
}

async function applyAuthoritativeDirect(
  conversation: DirectConversationDetailDto,
  originatingView: DirectView,
  ownershipToken: DirectPresentationToken,
  clearMutationError = true,
) {
  if (directPresentationOwnership.owns(ownershipToken)) directReconciliationVersion += 1
  return convergeAuthoritativeDirectConversation({
    conversation,
    originatingView,
    install: (authoritative) => {
      selectedDirect.value = authoritative
      directActionsStale.value = false
      directSharedContextSuppressed.value = false
      if (clearMutationError) lifecycleMutationError.value = ''
    },
    replaceRoute: async (view, conversationId) => {
      activeDirectView.value = view
      await router.replace({
        path: '/inbox',
        query: { tab: 'messages', view, conversation: conversationId },
      })
    },
    reconcileProjection: reconcileLifecycleProjection,
    refreshSummary: refreshInboxSummary,
    focusDetail: focusDirectDetailHeading,
    ownsPresentation: () => directPresentationOwnership.owns(ownershipToken),
  })
}

async function reconcileLifecycleFailure(
  conversationId: string,
  originatingView: DirectView,
  ownershipToken: DirectPresentationToken,
) {
  if (!directPresentationOwnership.owns(ownershipToken)) return
  directActionsStale.value = true
  directSharedContextSuppressed.value = true
  try {
    const conversation = await getDirectConversation(conversationId)
    if (!directPresentationOwnership.owns(ownershipToken)) return
    await applyAuthoritativeDirect(conversation, originatingView, ownershipToken, false)
  } catch {
    if (!directPresentationOwnership.owns(ownershipToken)) return
    refreshInactiveLifecycle(originatingView)
  }
}

async function resolvePendingDirect(action: 'accept' | 'decline') {
  const conversation = selectedDirect.value
  if (!conversation || directActionsStale.value) return
  const isAllowed =
    action === 'accept' ? conversation.capabilities.canAccept : conversation.capabilities.canDecline
  if (!isAllowed) return

  const conversationId = conversation.id
  const originatingView = activeDirectView.value
  const ownershipToken = directPresentationOwnership.capture(conversationId)
  lifecycleMutationError.value = ''
  await lifecycleMutationLock.run(conversationId, action, async () => {
    try {
      const authoritative =
        action === 'accept'
          ? await acceptDirectConversation(conversationId)
          : await declineDirectConversation(conversationId)
      await applyAuthoritativeDirect(authoritative, originatingView, ownershipToken)
    } catch (error: unknown) {
      const problem = directLifecycleProblem(error)
      const applied = await applyOwnedLifecycleFailure({
        ownsPresentation: () => directPresentationOwnership.owns(ownershipToken),
        applyError: () => {
          lifecycleMutationError.value = problem.message
        },
        reconcile: () =>
          problem.reconcile
            ? reconcileLifecycleFailure(conversationId, originatingView, ownershipToken)
            : Promise.resolve(),
      })
      if (!applied) refreshInactiveLifecycle(originatingView)
    }
  })
}

async function selectTab(tab: Tab) {
  directPresentationOwnership.invalidate()
  await router.push({ path: '/inbox', query: { tab } })
}
async function moveTabFocus(index: number) {
  focusedTab.value = (index + tabs.length) % tabs.length
  await nextTick()
  const buttons = tabList.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
  buttons?.[focusedTab.value]?.focus()
}
function tabKeydown(event: KeyboardEvent, index: number) {
  if (event.key === 'ArrowRight' || event.key === 'Right') {
    event.preventDefault()
    void moveTabFocus(index + 1)
  } else if (event.key === 'ArrowLeft' || event.key === 'Left') {
    event.preventDefault()
    void moveTabFocus(index - 1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    void moveTabFocus(0)
  } else if (event.key === 'End') {
    event.preventDefault()
    void moveTabFocus(tabs.length - 1)
  } else if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault()
    void selectTab(tabs[index]!.id)
  }
}

async function selectDirectView(view: DirectView) {
  directPresentationOwnership.invalidate()
  await router.push({ path: '/inbox', query: { tab: 'messages', view } })
}
async function moveMessageTabFocus(index: number) {
  focusedMessageTab.value = (index + messageTabs.length) % messageTabs.length
  await nextTick()
  const buttons = messageTabList.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
  buttons?.[focusedMessageTab.value]?.focus()
}
function messageTabKeydown(event: KeyboardEvent, index: number) {
  const target = tabFocusTarget(event.key, index, messageTabs.length)
  if (target !== null) {
    event.preventDefault()
    void moveMessageTabFocus(target)
    return
  }
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault()
    void selectDirectView(messageTabs[index]!.id)
  }
}

async function loadMoreDirect() {
  if (!directNextCursor.value || directPageLoading.value) return
  const view = activeDirectView.value
  const cursor = directNextCursor.value
  directPageLoading.value = true
  directPageError.value = ''
  try {
    await directListCoordinator.append(view, cursor, directRows.value)
  } catch {
    if (activeDirectView.value === view) directPageError.value = '更多內容目前無法載入。'
  } finally {
    if (activeDirectView.value === view) directPageLoading.value = false
  }
}

async function loadList() {
  const version = ++listLoadVersion
  listLoading.value = true
  listError.value = ''
  directPageError.value = ''
  try {
    if (activeTab.value === 'messages') await reconcileDirectList()
    else {
      directListCoordinator.cancel()
      if (activeTab.value === 'discussions') discussionRows.value = await listDiscussionRooms()
      if (activeTab.value === 'notifications') await notificationQuery.refresh()
    }
    await refreshInboxSummary().catch(() => {})
  } catch {
    if (version === listLoadVersion) listError.value = '收件匣目前無法載入，請稍後再試。'
  } finally {
    if (version === listLoadVersion) listLoading.value = false
  }
}

async function openDirect(id: string) {
  directPresentationOwnership.invalidate()
  await router.push({
    path: '/inbox',
    query: { tab: 'messages', view: activeDirectView.value, conversation: id },
  })
}
async function openRoom(id: string) {
  directPresentationOwnership.invalidate()
  await router.push({ path: '/inbox', query: { tab: 'discussions', room: id } })
}
async function selectNotification(notification: NotificationDto) {
  directPresentationOwnership.invalidate()
  notificationActionError.value = ''
  await router.push({
    path: '/inbox',
    query: { tab: 'notifications', notification: notification._id },
  })
  await markNotificationReadIfNeeded(notification)
}
async function markNotificationReadIfNeeded(notification: NotificationDto) {
  if (notification.readAt || notificationReadInFlight.has(notification._id)) return
  notificationReadInFlight.add(notification._id)
  try {
    await markReadMutation.mutateAsync(notification)
    await refreshInboxSummary().catch(() => {})
  } catch {
    notificationActionError.value = '通知目前無法標示為已讀，請稍後再試。'
  } finally {
    notificationReadInFlight.delete(notification._id)
  }
}
async function openNotificationActor(notification: NotificationDto) {
  if (!notification.actor) return
  directPresentationOwnership.invalidate()
  await router.push({ name: 'public-movie-space', params: { id: notification.actor._id } })
}
function fullDate(value: string) {
  return new Intl.DateTimeFormat('zh-TW', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}
async function closeMobileDetail() {
  directPresentationOwnership.invalidate()
  await router.push({
    path: '/inbox',
    query: {
      tab: activeTab.value,
      ...(activeTab.value === 'messages' ? { view: activeDirectView.value } : {}),
    },
  })
  await nextTick()
  listPane.value?.focus({ preventScroll: true })
}

async function loadThread() {
  directPresentationOwnership.invalidate()
  directReconciliationVersion += 1
  directActionsStale.value = false
  directSharedContextSuppressed.value = false
  threadError.value = ''
  sendError.value = ''
  lifecycleMutationError.value = ''
  messages.value = []
  hasNewMessages.value = false
  isAtLiveEdge.value = true
  olderCursor.value = null
  latestCursor.value = null
  const conversationId =
    typeof route.query.conversation === 'string' ? route.query.conversation : null
  const roomId = typeof route.query.room === 'string' ? route.query.room : null
  const composeId = typeof route.query.compose === 'string' ? route.query.compose : null
  selectedDirect.value = null
  selectedRoom.value = null
  composeTarget.value = null
  if (!conversationId && !roomId && !composeId) return
  threadLoading.value = true
  try {
    if (conversationId) {
      const [conversation, window] = await Promise.all([
        getDirectConversation(conversationId),
        getDirectMessages(conversationId),
      ])
      if (String(route.query.conversation) !== conversationId) return
      selectedDirect.value = conversation
      directActionsStale.value = false
      directSharedContextSuppressed.value = false
      messages.value = window.messages
      olderCursor.value = window.previousCursor
      latestCursor.value = window.latestCursor
    } else if (roomId) {
      const [room, window] = await Promise.all([
        getDiscussionRoom(roomId),
        getDiscussionMessages(roomId),
      ])
      if (String(route.query.room) !== roomId) return
      selectedRoom.value = room
      messages.value = window.messages
      olderCursor.value = window.previousCursor
      latestCursor.value = window.latestCursor
      subscribeDiscussion(roomId)
    } else if (composeId) {
      const resolved = await resolveDirectConversation(composeId)
      if (resolved.conversation) {
        const conversation = await getDirectConversation(resolved.conversation.id)
        if (String(route.query.compose) !== composeId) return
        await router.push({
          path: '/inbox',
          query: {
            tab: 'messages',
            view: directViewFromDetail(conversation),
            conversation: conversation.id,
          },
        })
        return
      }
      composeTarget.value = resolved.otherUser
    }
  } catch {
    threadError.value = '無法開啟這則對話。'
  } finally {
    threadLoading.value = false
  }
  if (!threadError.value && (selectedContext.value || composeTarget.value)) {
    await nextTick()
    detailPane.value?.focus({ preventScroll: true })
    await scrollToLatest()
  }
}

async function loadOlder() {
  if (!olderCursor.value || !selectedContext.value) return
  paginationError.value = ''
  try {
    const window = selectedDirect.value
      ? await getDirectMessages(selectedDirect.value.id, { before: olderCursor.value })
      : await getDiscussionMessages(selectedRoom.value!.id, { before: olderCursor.value })
    const existing = new Set(messages.value.map((message) => message.id))
    messages.value = [
      ...window.messages.filter((message) => !existing.has(message.id)),
      ...messages.value,
    ]
    olderCursor.value = window.previousCursor
  } catch {
    paginationError.value = '較早的訊息目前無法載入。'
  }
}

async function performSend(
  isResolutionReply: boolean,
  originatingView: DirectView,
  ownershipToken?: DirectPresentationToken,
) {
  const trackGlobalSending = !ownershipToken
  if (trackGlobalSending) sending.value = true
  sendError.value = ''
  lifecycleMutationError.value = ''
  const content = draft.value
  const clientMessageId = crypto.randomUUID()
  try {
    let result: { message: MessageDto; conversation?: DirectConversationDetailDto }
    if (ownershipToken) {
      result = await sendDirectMessage(ownershipToken.conversationId, clientMessageId, content)
      const committed = await commitOwnedDirectSend({
        ownsPresentation: () => directPresentationOwnership.owns(ownershipToken),
        insertMessage: () => upsertMessage(result.message),
        applyConversation: async () => {
          if (!result.conversation) return
          if (isResolutionReply) {
            await applyAuthoritativeDirect(result.conversation, originatingView, ownershipToken)
          } else if (directPresentationOwnership.owns(ownershipToken)) {
            directReconciliationVersion += 1
            selectedDirect.value = result.conversation
            directActionsStale.value = false
            directSharedContextSuppressed.value = false
          }
        },
        clearDraft: () => {
          draft.value = ''
        },
        reconcileInactive: () =>
          refreshInactiveLifecycle(originatingView, result.conversation?.bucket),
      })
      if (committed && !isResolutionReply && directPresentationOwnership.owns(ownershipToken))
        void reconcileOwnedOrdinaryDirectSend({
          view: originatingView,
          ownsPresentation: () => directPresentationOwnership.owns(ownershipToken),
          reconcileProjection: reconcileLifecycleProjection,
        })
      if (committed && directPresentationOwnership.owns(ownershipToken)) await scrollToLatest()
      return
    } else if (selectedRoom.value)
      result = await sendDiscussionMessage(selectedRoom.value.id, clientMessageId, content)
    else if (composeTarget.value)
      result = await sendFirstDirectMessage(composeTarget.value.id, clientMessageId, content)
    else return
    upsertMessage(result.message)
    if (result.conversation) {
      directReconciliationVersion += 1
      selectedDirect.value = result.conversation
      directActionsStale.value = false
      directSharedContextSuppressed.value = false
    }
    draft.value = ''
    await scrollToLatest()
    if (composeTarget.value && result.conversation) {
      await router.push({
        path: '/inbox',
        query: {
          tab: 'messages',
          view: directViewFromDetail(result.conversation),
          conversation: result.conversation.id,
        },
      })
    }
    if (selectedRoom.value) {
      selectedRoom.value.membership = {
        ...(selectedRoom.value.membership ?? {
          roomId: selectedRoom.value.id,
          joinedAt: result.message.createdAt,
          leftAt: null,
        }),
        status: 'joined',
      }
      selectedRoom.value.lastMessage = {
        messageId: result.message.id,
        senderId: result.message.senderId,
        preview: result.message.content,
        createdAt: result.message.createdAt,
      }
    }
  } catch (error: unknown) {
    const problem = directLifecycleProblem(error)
    if (ownershipToken) {
      const applied = await applyOwnedLifecycleFailure({
        ownsPresentation: () => directPresentationOwnership.owns(ownershipToken),
        applyError: () => {
          sendError.value = problem.message
          if (problem.reconcile) lifecycleMutationError.value = problem.message
        },
        reconcile: () =>
          problem.reconcile
            ? reconcileLifecycleFailure(
                ownershipToken.conversationId,
                originatingView,
                ownershipToken,
              )
            : Promise.resolve(),
      })
      if (!applied) refreshInactiveLifecycle(originatingView)
    } else {
      sendError.value = problem.message
    }
  } finally {
    if (trackGlobalSending) sending.value = false
  }
}

async function send() {
  if (!canSend.value) return
  const conversation = selectedDirect.value
  if (!conversation) {
    await performSend(false, activeDirectView.value)
    return
  }

  const isResolutionReply =
    conversation.capabilities.canAccept || conversation.capabilities.canDecline
  const ownershipToken = directPresentationOwnership.capture(conversation.id)
  await lifecycleMutationLock.run(conversation.id, 'reply', () =>
    performSend(isResolutionReply, activeDirectView.value, ownershipToken),
  )
}
function composerKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && window.matchMedia('(min-width: 48rem)').matches) {
    event.preventDefault()
    void send()
  }
}
async function toggleMembership() {
  if (!selectedRoom.value) return
  try {
    if (selectedRoom.value.membership?.status === 'joined')
      await leaveDiscussion(selectedRoom.value.id)
    else await joinDiscussion(selectedRoom.value.id)
    selectedRoom.value = await getDiscussionRoom(selectedRoom.value.id)
    await loadList()
  } catch {
    threadError.value = '討論群狀態目前無法更新。'
  }
}

watch(
  () => [route.query.tab, route.query.view] as const,
  async ([tab, view]) => {
    const nextTab = validTab(tab)
    const nextDirectView = validDirectView(view)
    const directViewChanged = activeDirectView.value !== nextDirectView
    activeTab.value = nextTab
    activeDirectView.value = nextDirectView
    focusedTab.value = tabs.findIndex((tab) => tab.id === activeTab.value)
    if (nextDirectView !== 'ended')
      focusedMessageTab.value = messageTabs.findIndex((tab) => tab.id === nextDirectView)
    if (directViewChanged) {
      directListCoordinator.cancel()
      directRows.value = []
      directNextCursor.value = null
      directPageError.value = ''
      directPageLoading.value = false
    }
    await loadList()
  },
  { immediate: true },
)
watch(() => [route.query.conversation, route.query.room, route.query.compose], loadThread, {
  immediate: true,
})
watch(selectedNotification, async (notification) => {
  if (activeTab.value === 'notifications' && notification)
    await markNotificationReadIfNeeded(notification)
})

let realtimeCleanups: (() => void)[] = []
async function reconcileAfterReconnect() {
  const wasAtLiveEdge = isAtLiveEdge.value
  const directResult = selectedDirect.value ? await reconcileActiveDirect('reconnect') : null
  await Promise.allSettled([
    ...(directResult?.applied ? [] : [reconcileDirectList()]),
    reconcileDiscussionList(),
    notificationQuery.refresh(),
    ...(directResult?.applied ? [] : [refreshInboxSummary()]),
  ])
  if (!latestCursor.value) return
  try {
    const window = selectedDirect.value
      ? await getDirectMessages(selectedDirect.value.id, { after: latestCursor.value })
      : selectedRoom.value
        ? await getDiscussionMessages(selectedRoom.value.id, { after: latestCursor.value })
        : null
    window?.messages.forEach(upsertMessage)
    if (window?.latestCursor) latestCursor.value = window.latestCursor
    if (wasAtLiveEdge) await scrollToLatest()
    else if (window?.messages.some((message) => message.senderId !== userStore.currentUser?._id))
      hasNewMessages.value = true
  } catch {
    // The next authoritative thread refresh remains available to the user.
  }
}
async function handleRealtimeMessage({ message }: { message: MessageDto }) {
  const activeId = selectedDirect.value?.id ?? selectedRoom.value?.id
  if (message.contextId === activeId) {
    const shouldFollowLiveEdge = isAtLiveEdge.value
    upsertMessage(message)
    if (shouldFollowLiveEdge) await scrollToLatest()
    else if (message.senderId !== userStore.currentUser?._id) hasNewMessages.value = true
  }
  if (message.contextType === 'direct')
    await Promise.allSettled([reconcileDirectList(), refreshInboxSummary()])
  else await Promise.allSettled([reconcileDiscussionList(), refreshInboxSummary()])
}
async function handleDirectUpdated(payload: { conversationId: string }) {
  if (selectedDirect.value?.id === payload.conversationId) {
    const result = await reconcileActiveDirect('direct.updated')
    if (result.applied) return
  }
  await Promise.allSettled([reconcileDirectList(), refreshInboxSummary()])
}
const handleReadUpdated = createReadInvalidationHandler({
  reconcileDirect: reconcileDirectList,
  reconcileDiscussion: reconcileDiscussionList,
  reconcileNotifications: notificationQuery.refresh,
  reconcileSummary: refreshInboxSummary,
})
async function handleVisibilityChange() {
  if (document.visibilityState !== 'visible' || !isAtLiveEdge.value) return
  const latest = messages.value.at(-1)
  if (latest) await markCurrentContextRead(latest.id)
}
onMounted(() => {
  void refreshInboxSummary().catch(() => {})
  document.addEventListener('visibilitychange', handleVisibilityChange)
  if (userStore.accessToken) {
    connectRealtime(userStore.accessToken, userStore.currentUser!._id)
    realtimeCleanups = [
      onRealtimeConnect(() => void reconcileAfterReconnect()),
      onRealtime('message.created', (payload) => void handleRealtimeMessage(payload)),
      onRealtime('direct.updated', (payload) => void handleDirectUpdated(payload)),
      onRealtime('relationship.updated', (payload) => {
        if (payload.userId === directOtherUserId.value) {
          void reconcileActiveDirect('relationship.updated')
          return
        }
        void reconcileDirectList().catch(() => {})
      }),
      onRealtime('notification.created', () => {
        void notificationQuery.refresh()
        void refreshInboxSummary().catch(() => {})
      }),
      onRealtime('read.updated', (payload) => void handleReadUpdated(payload)),
      onRealtime('discussion.membership.updated', () => {
        void reconcileDiscussionList().catch(() => {})
        void refreshInboxSummary().catch(() => {})
      }),
    ]
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  realtimeCleanups.forEach((cleanup) => cleanup())
  if (selectedRoom.value) unsubscribeDiscussion(selectedRoom.value.id)
})
</script>

<template>
  <main class="page-shell min-w-0 pb-14 pt-8 sm:pt-10">
    <header>
      <p
        class="font-display-en text-sm font-semibold uppercase tracking-[0.2em] text-accent-caramel"
      >
        Inbox
      </p>
      <h1 class="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">收件匣</h1>
    </header>
    <div
      ref="tabList"
      class="mt-5 flex gap-1 border-b border-border"
      role="tablist"
      aria-label="收件匣分類"
    >
      <button
        v-for="(tab, index) in tabs"
        :id="`inbox-tab-${tab.id}`"
        :key="tab.id"
        role="tab"
        type="button"
        class="min-h-11 border-b-2 px-4 font-semibold focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        :class="
          activeTab === tab.id
            ? 'border-accent-caramel text-foreground'
            : 'border-transparent text-muted-foreground'
        "
        :aria-selected="activeTab === tab.id"
        :aria-controls="`inbox-panel-${tab.id}`"
        :tabindex="focusedTab === index ? 0 : -1"
        @click="selectTab(tab.id)"
        @focus="focusedTab = index"
        @keydown="tabKeydown($event, index)"
      >
        <span class="inline-flex items-center gap-2">
          {{ tab.label }}
          <span
            v-if="tabHasUnread(tab.id)"
            class="size-2 rounded-full bg-status-unread"
            aria-hidden="true"
          />
          <span v-if="tabHasUnread(tab.id)" class="sr-only">，有未讀內容</span>
        </span>
      </button>
    </div>
    <section
      :id="`inbox-panel-${activeTab}`"
      role="tabpanel"
      :aria-labelledby="`inbox-tab-${activeTab}`"
      class="mt-5 grid min-h-[30rem] overflow-hidden rounded-xl border border-border bg-card lg:grid-cols-[minmax(18rem,.8fr)_minmax(0,1.2fr)]"
    >
      <div
        ref="listPane"
        tabindex="-1"
        class="min-w-0 border-border lg:h-[calc(100dvh-12rem)] lg:min-h-[30rem] lg:max-h-[46rem] lg:overflow-y-auto lg:border-r"
        :class="isMobileDetail ? 'hidden lg:block' : 'block'"
      >
        <div v-if="activeTab === 'messages'" class="border-b border-border bg-surface/40 p-3">
          <div
            ref="messageTabList"
            class="grid grid-cols-2 gap-1 rounded-lg bg-secondary/60 p-1"
            role="tablist"
            aria-label="訊息分類"
          >
            <button
              v-for="(tab, index) in messageTabs"
              :id="`message-tab-${tab.id}`"
              :key="tab.id"
              type="button"
              role="tab"
              class="min-h-11 rounded-md px-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              :class="
                activeDirectView === tab.id
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              "
              :aria-selected="activeDirectView === tab.id"
              :aria-controls="`message-panel-${tab.id}`"
              :tabindex="focusedMessageTab === index ? 0 : -1"
              @click="selectDirectView(tab.id)"
              @focus="focusedMessageTab = index"
              @keydown="messageTabKeydown($event, index)"
            >
              {{ tab.label }}
              <span v-if="tab.id === 'requests'">
                {{ inboxSummary.pendingIncomingRequestCount }}
                <span class="sr-only">則待處理</span>
              </span>
            </button>
          </div>
          <button
            v-if="!isEndedView"
            type="button"
            class="mt-2 flex min-h-10 w-full items-center justify-between rounded-md px-3 text-left text-sm font-medium text-muted-foreground hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            @click="selectDirectView('ended')"
          >
            已結束的互動
            <span aria-hidden="true">→</span>
          </button>
          <div v-else class="flex min-h-11 items-center justify-between gap-3">
            <div>
              <p class="text-sm font-semibold text-foreground">已結束的互動</p>
              <p class="text-xs text-muted-foreground">查看已婉拒或無法繼續的歷史互動。</p>
            </div>
            <button
              type="button"
              class="min-h-10 shrink-0 rounded-md px-3 text-sm font-semibold text-accent-caramel hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              @click="selectDirectView('conversations')"
            >
              返回對話
            </button>
          </div>
        </div>
        <div v-if="listLoading" class="space-y-2 p-3" role="status" aria-label="正在載入收件匣">
          <div v-for="n in 5" :key="n" class="h-20 animate-pulse rounded-lg bg-secondary" />
        </div>
        <div v-else-if="listError" class="p-8 text-center">
          <p role="alert">{{ listError }}</p>
          <button class="mt-4 min-h-11 rounded-md border border-control px-4" @click="loadList">
            重試
          </button>
        </div>
        <div
          v-else-if="activeTab === 'messages'"
          :id="isEndedView ? undefined : `message-panel-${activeDirectView}`"
          :role="isEndedView ? undefined : 'tabpanel'"
          :aria-labelledby="isEndedView ? undefined : `message-tab-${activeDirectView}`"
        >
          <div
            v-if="!directRows.length"
            class="flex min-h-[30rem] items-center justify-center p-10 text-center lg:h-full"
          >
            <div>
              <MessageCircle class="mx-auto size-8 text-accent-caramel" aria-hidden="true" />
              <h2 class="mt-3 font-bold">
                {{
                  activeDirectView === 'requests'
                    ? '沒有新的訊息邀請。'
                    : activeDirectView === 'ended'
                      ? '尚無已結束的互動。'
                      : '還沒有對話'
                }}
              </h2>
              <p
                v-if="activeDirectView === 'conversations'"
                class="mt-2 text-sm text-muted-foreground"
              >
                從共同喜歡的電影開始，<br />認識和你有相同電影品味的人。
              </p>
              <RouterLink
                v-if="activeDirectView === 'conversations'"
                to="/people"
                class="mt-5 inline-flex min-h-11 items-center rounded-md bg-primary-cta px-4 font-semibold text-primary-foreground"
                >探索同好</RouterLink
              >
            </div>
          </div>
          <button
            v-for="row in directRows"
            :key="row.id"
            type="button"
            class="flex w-full gap-3 border-b border-border p-4 text-left hover:bg-surface-raised"
            :class="selectedDirect?.id === row.id ? 'bg-accent-caramel-soft' : ''"
            @click="openDirect(row.id)"
          >
            <UserAvatar :account="row.counterpart.username" :user-id="row.counterpart.id" /><span
              class="min-w-0 flex-1"
              ><span class="flex justify-between gap-2"
                ><strong class="truncate">{{
                  row.counterpart.displayName || row.counterpart.username
                }}</strong
                ><span v-if="row.hasUnread" class="sr-only">，未讀</span
                ><small class="shrink-0 text-muted-foreground">{{
                  time(row.lastMessage.sentAt)
                }}</small></span
              ><span class="mt-1 block truncate text-sm text-muted-foreground">{{
                row.lastMessage.content
              }}</span
              ><small v-if="directStateLabel(row)" class="text-accent-caramel">{{
                directStateLabel(row)
              }}</small></span
            ><span
              v-if="row.hasUnread"
              class="size-2 self-center rounded-full bg-status-unread"
              aria-hidden="true"
            />
          </button>
          <p v-if="directPageError" class="p-4 text-center text-sm text-destructive" role="alert">
            {{ directPageError }}
          </p>
          <button
            v-if="directNextCursor"
            type="button"
            class="mx-auto my-4 block min-h-11 rounded-md border border-control px-4 text-sm font-semibold hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-wait disabled:opacity-60"
            :disabled="directPageLoading"
            :aria-busy="directPageLoading"
            @click="loadMoreDirect"
          >
            {{ directPageLoading ? '載入中…' : '載入更多' }}
          </button>
        </div>
        <template v-else-if="activeTab === 'discussions'">
          <div
            v-if="!discussionRows.length"
            class="flex min-h-[30rem] items-center justify-center p-10 text-center lg:h-full"
          >
            <div>
              <Film class="mx-auto size-8 text-accent-caramel" />
              <h2 class="mt-3 font-bold">還沒有加入任何電影討論</h2>
              <p class="mt-2 text-sm text-muted-foreground">
                找到感興趣的電影，<br />看看大家正在聊什麼。
              </p>
              <RouterLink
                to="/explore"
                class="mt-5 inline-flex min-h-11 items-center rounded-md bg-primary-cta px-4 font-semibold text-primary-foreground"
                >探索電影</RouterLink
              >
            </div>
          </div>
          <button
            v-for="row in discussionRows"
            :key="row.id"
            type="button"
            class="flex w-full gap-3 border-b border-border p-4 text-left hover:bg-surface-raised"
            :class="selectedRoom?.id === row.id ? 'bg-accent-caramel-soft' : ''"
            @click="openRoom(row.id)"
          >
            <img
              v-if="row.movieSnapshot.posterPath"
              :src="`https://image.tmdb.org/t/p/w92${row.movieSnapshot.posterPath}`"
              alt=""
              class="h-16 w-11 rounded object-cover"
            /><span v-else class="flex h-16 w-11 items-center justify-center rounded bg-secondary"
              ><Film /></span
            ><span class="min-w-0 flex-1"
              ><span class="flex justify-between gap-2"
                ><strong class="truncate">{{ row.movieSnapshot.title }}</strong
                ><span v-if="row.hasUnread" class="sr-only">，未讀</span
                ><small class="shrink-0 text-muted-foreground">{{
                  time(row.lastMessage?.createdAt)
                }}</small></span
              ><span class="mt-1 block truncate text-sm text-muted-foreground">{{
                row.lastMessage?.preview || '已加入討論群'
              }}</span></span
            ><span
              v-if="row.hasUnread"
              class="size-2 self-center rounded-full bg-status-unread"
              aria-hidden="true"
            />
          </button>
        </template>
        <template v-else
          ><div
            v-if="!notifications.length"
            class="flex min-h-[30rem] items-center justify-center p-10 text-center lg:h-full lg:min-h-0"
          >
            <div>
              <Inbox class="mx-auto size-8 text-accent-caramel" />
              <h2 class="mt-3 font-bold">目前沒有通知</h2>
            </div>
          </div>
          <NotificationRow
            v-for="notification in notifications"
            :key="notification._id"
            :notification="notification"
            :selected="selectedNotification?._id === notification._id"
            @select="selectNotification"
        /></template>
      </div>
      <aside
        ref="detailPane"
        tabindex="-1"
        class="h-full min-w-0"
        :class="isMobileDetail ? 'block' : 'hidden lg:block'"
      >
        <div
          v-if="activeTab === 'notifications'"
          class="flex h-full min-h-[30rem] flex-col p-5 sm:p-8 lg:px-12 lg:py-14"
        >
          <button
            v-if="isMobileDetail"
            type="button"
            class="mb-5 inline-flex min-h-11 w-11 items-center justify-center rounded-md font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring lg:hidden"
            aria-label="返回通知列表"
            @click="closeMobileDetail"
          >
            <ArrowLeft class="size-5" aria-hidden="true" />
          </button>
          <p v-if="notificationActionError" class="mb-4 text-sm text-destructive" role="alert">
            {{ notificationActionError }}
          </p>
          <div v-if="selectedNotification" class="max-w-xl">
            <div class="flex items-center gap-4">
              <UserAvatar
                v-if="selectedNotification.actor"
                :account="selectedNotification.actor.account"
                :user-id="selectedNotification.actor._id"
                size="large"
              />
              <span
                v-else
                class="flex size-20 items-center justify-center rounded-full bg-secondary text-muted-foreground sm:size-28"
                aria-hidden="true"
              >
                <UserRound class="size-9" />
              </span>
              <div class="min-w-0">
                <h2 class="truncate text-2xl font-bold">
                  {{
                    selectedNotification.actor?.displayName ||
                    selectedNotification.actor?.account ||
                    '已停用的使用者'
                  }}
                </h2>
                <p
                  v-if="selectedNotification.actor"
                  class="mt-1 truncate text-sm text-muted-foreground"
                >
                  @{{ selectedNotification.actor.account }}
                </p>
              </div>
            </div>
            <div class="mt-9">
              <p class="text-sm text-muted-foreground">
                {{ fullDate(selectedNotification.createdAt) }}
              </p>
              <div class="mt-3 border-l-2 border-accent-caramel py-1 pl-4">
                <p class="text-lg font-semibold">開始關注你</p>
              </div>
            </div>
            <div v-if="selectedNotification.actor" class="mt-9 space-y-2">
              <p class="font-semibold leading-7 text-foreground">
                現在你們可以在 Movune 上一起探索更多好電影了！
              </p>
              <p class="text-sm leading-6 text-muted-foreground">
                前往對方的主頁，看看他喜歡哪些電影。
              </p>
            </div>
            <button
              v-if="selectedNotification.actor"
              type="button"
              class="mt-8 inline-flex min-h-11 items-center rounded-md bg-primary-cta px-5 font-semibold text-primary-foreground hover:bg-primary-cta-hover"
              @click="openNotificationActor(selectedNotification)"
            >
              前往個人主頁 →
            </button>
            <p v-else class="mt-8 max-w-md leading-7 text-muted-foreground">
              這位使用者目前無法使用，但這則關注紀錄仍會保留。
            </p>
          </div>
          <div
            v-else
            class="flex flex-1 items-center justify-center text-center text-muted-foreground"
          >
            <div>
              <Inbox class="mx-auto size-9" />
              <h2 class="mt-3 font-bold text-foreground">選擇一則通知</h2>
              <p class="mt-2">從左側選擇通知以查看詳細內容。</p>
            </div>
          </div>
        </div>
        <div v-else-if="threadLoading" class="p-10" role="status">正在載入對話…</div>
        <div v-else-if="threadError" class="p-10 text-center" role="alert">
          {{ threadError
          }}<button
            class="mt-4 block min-h-11 w-full font-semibold underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            @click="loadThread"
          >
            重試
          </button>
        </div>
        <div
          v-else-if="!selectedContext && !composeTarget"
          class="flex h-full min-h-[30rem] items-center justify-center p-10 text-center text-muted-foreground"
        >
          <div>
            <component
              :is="activeTab === 'discussions' ? Film : MessageCircle"
              class="mx-auto size-9"
            />
            <h2 class="mt-3 font-bold text-foreground">
              {{ activeTab === 'messages' ? '選擇一則對話' : '選擇一個電影討論' }}
            </h2>
            <p class="mt-2">
              {{
                activeTab === 'messages'
                  ? '從左側選擇對話，繼續聊聊彼此喜歡的電影。'
                  : '從左側選擇電影討論，看看大家正在聊什麼。'
              }}
            </p>
          </div>
        </div>
        <div v-else class="flex h-[calc(100dvh-12rem)] min-h-[30rem] max-h-[46rem] flex-col">
          <header
            class="sticky top-0 z-10 flex min-h-16 items-center gap-3 border-b border-border bg-card px-4"
          >
            <button
              type="button"
              class="flex min-h-11 w-11 shrink-0 items-center justify-center rounded-md font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring lg:hidden"
              :aria-label="activeTab === 'messages' ? '返回訊息列表' : '返回討論群列表'"
              @click="closeMobileDetail"
            >
              <ArrowLeft class="size-5" aria-hidden="true" />
            </button>
            <div class="min-w-0 flex-1">
              <h2
                ref="detailHeading"
                tabindex="-1"
                class="truncate rounded-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                {{ threadTitle }}
              </h2>
              <p
                v-if="selectedDirect?.interactionState === 'pending_incoming'"
                class="text-xs text-accent-caramel"
              >
                訊息邀請
              </p>
              <p
                v-else-if="selectedDirect?.interactionState === 'pending_outgoing'"
                class="text-xs text-accent-caramel"
              >
                等待對方回覆
              </p>
            </div>
            <DropdownMenu v-if="(directOtherUser && canLinkDirectCounterpart) || selectedRoom">
              <DropdownMenuTrigger as-child>
                <button
                  type="button"
                  class="flex min-h-11 min-w-11 items-center justify-center rounded-md hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  aria-label="更多選項"
                >
                  <MoreHorizontal aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" class="w-48">
                <DropdownMenuItem v-if="directOtherUser && canLinkDirectCounterpart" as-child>
                  <RouterLink
                    :to="{ name: 'public-movie-space', params: { id: directOtherUser.id } }"
                    class="min-h-10 w-full"
                  >
                    查看他的個人主頁
                  </RouterLink>
                </DropdownMenuItem>
                <DropdownMenuItem v-if="selectedRoom" as-child>
                  <RouterLink :to="`/movies/${selectedRoom.tmdbId}`" class="min-h-10 w-full">
                    查看電影
                  </RouterLink>
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-if="selectedRoom?.membership?.status === 'joined'"
                  class="min-h-10"
                  @select="toggleMembership"
                >
                  退出討論群
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </header>
          <div
            v-if="directOtherUser && sharedMovieContextText"
            class="flex items-center justify-center gap-1 overflow-hidden px-3 py-0.5 text-center text-sm md:flex-col md:border-b md:border-border md:px-4 md:py-2"
          >
            <p class="min-w-0 truncate font-normal text-muted-foreground md:whitespace-normal">
              {{ sharedMovieContextText }}
            </p>
            <span class="shrink-0 text-muted-foreground md:hidden" aria-hidden="true">·</span>
            <RouterLink
              :to="{
                name: 'public-movie-space',
                params: { id: directOtherUser.id },
                hash: '#dna-match-heading',
              }"
              class="inline-flex min-h-8 shrink-0 items-center font-semibold text-accent-caramel underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:min-h-10"
            >
              前往查看
            </RouterLink>
          </div>
          <div
            v-if="selectedRoom"
            class="flex items-center justify-center gap-1 overflow-hidden px-3 py-0.5 text-center text-sm md:flex-col md:border-b md:border-border md:px-4 md:py-2"
          >
            <p class="min-w-0 truncate font-normal text-muted-foreground md:whitespace-normal">
              一起來聊聊《{{ selectedRoom.movieSnapshot.title }}》吧！
            </p>
            <span
              v-if="selectedRoom.membership?.status !== 'joined'"
              class="shrink-0 text-muted-foreground md:hidden"
              aria-hidden="true"
              >·</span
            >
            <button
              v-if="selectedRoom.membership?.status !== 'joined'"
              type="button"
              class="inline-flex min-h-8 shrink-0 items-center font-semibold text-accent-caramel underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring md:min-h-10"
              @click="toggleMembership"
            >
              加入
            </button>
          </div>
          <p
            v-if="lifecycleMutationError"
            class="border-b border-border px-4 py-2 text-sm text-destructive"
            role="alert"
          >
            {{ lifecycleMutationError }}
          </p>
          <div class="relative min-h-0 flex-1">
            <div
              ref="messagePane"
              tabindex="0"
              class="h-full overflow-y-auto p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              @scroll="updateLiveEdge"
            >
              <button
                v-if="olderCursor"
                type="button"
                class="mx-auto mb-4 block min-h-11 text-sm font-semibold underline-offset-4 hover:text-accent-caramel hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                @click="loadOlder"
              >
                載入較早訊息
              </button>
              <p v-if="paginationError" class="mb-3 text-center text-sm text-destructive">
                {{ paginationError }}
              </p>
              <div
                v-for="(message, index) in messages"
                :key="message.id"
                class="mb-2 grid grid-cols-[2.75rem_minmax(0,1fr)] gap-2"
              >
                <RouterLink
                  v-if="
                    selectedDirect &&
                    canLinkDirectCounterpart &&
                    message.sender &&
                    !isGrouped(index) &&
                    message.senderId !== userStore.currentUser?._id
                  "
                  :to="{ name: 'public-movie-space', params: { id: message.sender.id } }"
                  class="col-start-1 row-start-1 size-10 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  :aria-label="`查看 ${message.sender.displayName || message.sender.account} 的個人主頁`"
                >
                  <UserAvatar :account="message.sender.account" :user-id="message.sender.id" />
                </RouterLink>
                <UserAvatar
                  v-else-if="
                    message.sender &&
                    !isGrouped(index) &&
                    message.senderId !== userStore.currentUser?._id
                  "
                  class="col-start-1 row-start-1"
                  :account="message.sender.account"
                  :user-id="message.sender.id"
                />
                <div
                  class="w-fit max-w-[85%] md:max-w-[70%]"
                  :class="
                    message.senderId === userStore.currentUser?._id
                      ? 'col-span-2 ml-auto'
                      : 'col-start-2'
                  "
                >
                  <RouterLink
                    v-if="
                      selectedDirect &&
                      canLinkDirectCounterpart &&
                      message.sender &&
                      !isGrouped(index) &&
                      message.senderId !== userStore.currentUser?._id
                    "
                    :to="{ name: 'public-movie-space', params: { id: message.sender.id } }"
                    class="-mx-1 mb-1 inline-flex min-h-8 items-center rounded-sm px-1 text-sm font-semibold underline-offset-4 hover:text-accent-caramel hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
                  >
                    {{ message.sender.displayName || message.sender.account }}
                  </RouterLink>
                  <p
                    v-else-if="
                      message.sender &&
                      !isGrouped(index) &&
                      message.senderId !== userStore.currentUser?._id
                    "
                    class="mb-1 text-sm font-semibold"
                  >
                    {{ message.sender.displayName || message.sender.account }}
                  </p>
                  <p
                    class="w-fit max-w-full whitespace-pre-wrap break-words rounded-xl px-3 py-2"
                    :class="
                      message.senderId === userStore.currentUser?._id
                        ? 'ml-auto bg-primary-cta text-primary-foreground'
                        : 'bg-secondary'
                    "
                  >
                    {{ message.content }}
                  </p>
                  <small
                    class="mt-1 block text-muted-foreground"
                    :class="message.senderId === userStore.currentUser?._id ? 'text-right' : ''"
                    >{{ time(message.createdAt) }}</small
                  >
                </div>
              </div>
            </div>
            <button
              v-if="hasNewMessages"
              type="button"
              class="absolute bottom-3 left-1/2 min-h-10 -translate-x-1/2 rounded-full border border-control bg-surface-raised px-4 text-sm font-semibold text-foreground shadow-lg hover:text-accent-caramel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              @click="scrollToLatest"
            >
              有新訊息 ↓
            </button>
          </div>
          <footer v-if="!isEndedView" class="border-t border-border bg-card p-3">
            <section
              v-if="resolutionControls.showAccept || resolutionControls.showDecline"
              class="mb-3 rounded-lg border border-border bg-surface/40 p-3"
              :aria-busy="lifecycleMutationPending"
            >
              <p class="text-sm text-muted-foreground">
                回覆即可開始對話；你也可以直接接受，或拒絕這則邀請。
              </p>
              <div class="mt-3 flex flex-wrap gap-2">
                <button
                  v-if="resolutionControls.showAccept"
                  type="button"
                  class="min-h-11 rounded-md bg-primary-cta px-4 font-semibold text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-wait disabled:opacity-60"
                  :disabled="resolutionControls.disabled"
                  @click="resolvePendingDirect('accept')"
                >
                  {{ selectedLifecycleAction === 'accept' ? '接受中…' : '接受' }}
                </button>
                <button
                  v-if="resolutionControls.showDecline"
                  type="button"
                  class="min-h-11 rounded-md border border-control px-4 font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-wait disabled:opacity-60"
                  :disabled="resolutionControls.disabled"
                  @click="resolvePendingDirect('decline')"
                >
                  {{ selectedLifecycleAction === 'decline' ? '拒絕中…' : '拒絕' }}
                </button>
              </div>
              <p v-if="lifecycleMutationPending" class="sr-only" role="status">正在更新對話狀態</p>
            </section>
            <p
              v-if="selectedDirect?.interactionState === 'pending_outgoing'"
              class="mb-2 text-sm text-accent-caramel"
            >
              你已傳送一則訊息。對方回覆或追蹤你後，即可繼續聊天。
            </p>
            <p
              v-if="selectedRoom && selectedRoom.membership?.status !== 'joined'"
              class="mb-2 text-sm text-muted-foreground"
            >
              傳送訊息後將自動加入此討論群。
            </p>
            <div class="flex items-stretch gap-2">
              <textarea
                v-model="draft"
                rows="1"
                maxlength="1000"
                class="h-12 min-h-12 min-w-0 flex-1 resize-y rounded-md border border-control bg-background px-3 py-3 disabled:cursor-not-allowed disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-75"
                placeholder="輸入訊息"
                :disabled="
                  Boolean(
                    selectedDirect &&
                    (!resolutionControls.mayReply ||
                      directActionsStale ||
                      lifecycleMutationPending),
                  )
                "
                @keydown="composerKeydown"
              /><button
                type="button"
                class="flex min-h-11 shrink-0 items-center justify-center rounded-md bg-primary-cta px-4 text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="!canSend"
                aria-label="傳送訊息"
                @click="send"
              >
                <Send class="size-5" />
              </button>
            </div>
            <p v-if="sendError" class="mt-2 text-sm text-destructive" role="alert">
              {{ sendError }}
            </p>
          </footer>
        </div>
      </aside>
    </section>
  </main>
</template>

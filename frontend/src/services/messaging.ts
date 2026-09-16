import api from './api'
import { directListQuery } from './directReadModel'

export type Person = {
  id: string
  account: string
  displayName: string | null
  avatar: string | null
}
export type MessageDto = {
  id: string
  senderId: string
  sender?: Person
  clientMessageId: string
  contextType: 'direct' | 'discussion'
  contextId: string
  content: string
  createdAt: string
  updatedAt: string
}
export type LastMessage = {
  messageId: string
  senderId: string
  preview: string
  createdAt: string
} | null
export type DirectView = 'conversations' | 'requests' | 'ended'
export type DirectConversationDto = {
  id: string
  counterpart: {
    id: string
    username: string
    displayName: string | null
    avatarUrl?: string
  }
  interactionState:
    | 'none'
    | 'direct_allowed'
    | 'request_allowed'
    | 'pending_outgoing'
    | 'pending_incoming'
    | 'declined'
    | 'unlocked'
    | 'blocked'
    | 'revoked_unavailable'
  capabilities: {
    canSendMessage: boolean
    canCreateMessageRequest: boolean
    canAccept: boolean
    canDecline: boolean
    canFollowUser: boolean
    canBlockUser: boolean
    canUnblockUser: boolean
  }
  lastMessage: { id: string; senderId: string; content: string; sentAt: string }
  hasUnread?: boolean
  sharedContext: {
    shouldRender: boolean
    movies?: Array<{ tmdbId: number }>
  }
  updatedAt: string
}
export type DirectConversationDetailDto = DirectConversationDto & { bucket: DirectView }
export type Membership = {
  roomId: string
  status: 'joined' | 'left'
  joinedAt: string
  leftAt: string | null
}
export type DiscussionSummary = {
  id: string
  tmdbId: number
  movieSnapshot: { title: string; posterPath: string | null }
  lastMessage: LastMessage
  membership: Membership | null
  hasUnread: boolean
}
export type MessageWindow = {
  messages: MessageDto[]
  firstUnreadMessageId: string | null
  previousCursor: string | null
  nextCursor: string | null
  latestCursor: string | null
}
export type InboxSummary = {
  messagesHasUnread: boolean
  discussionsHasUnread: boolean
  notificationsHasUnread: boolean
  inboxHasUnread: boolean
  pendingIncomingRequestCount: number
  inboxNeedsAttention: boolean
}

export type DirectConversationPage = {
  conversations: DirectConversationDto[]
  nextCursor: string | null
}

export const getInboxSummary = () => api.get<InboxSummary>('/api/inbox/summary').then((r) => r.data)
export const listDirectConversations = (view: DirectView, cursor?: string) =>
  api
    .get<DirectConversationPage>('/api/direct-conversations', {
      params: directListQuery(view, cursor),
    })
    .then((r) => r.data)
export const getDirectConversation = (id: string) =>
  api
    .get<{ conversation: DirectConversationDetailDto }>(`/api/direct-conversations/${id}`)
    .then((r) => r.data.conversation)
export const resolveDirectConversation = (otherUserId: string) =>
  api
    .post<{ conversation: { id: string } | null; otherUser: Person }>(
      '/api/direct-conversations/resolve',
      { otherUserId },
    )
    .then((r) => r.data)
export const sendFirstDirectMessage = (
  otherUserId: string,
  clientMessageId: string,
  content: string,
) =>
  api
    .post<{ message: MessageDto; conversation: DirectConversationDetailDto }>(
      '/api/direct-conversations/messages',
      { otherUserId, clientMessageId, content },
    )
    .then((r) => r.data)
export const sendDirectMessage = (id: string, clientMessageId: string, content: string) =>
  api
    .post<{ message: MessageDto; conversation: DirectConversationDetailDto }>(
      `/api/direct-conversations/${id}/messages`,
      { clientMessageId, content },
    )
    .then((r) => r.data)
export const acceptDirectConversation = (id: string) =>
  api
    .post<{ conversation: DirectConversationDetailDto }>(`/api/direct-conversations/${id}/accept`)
    .then((r) => r.data.conversation)
export const declineDirectConversation = (id: string) =>
  api
    .post<{ conversation: DirectConversationDetailDto }>(`/api/direct-conversations/${id}/decline`)
    .then((r) => r.data.conversation)
export const getDirectMessages = (
  id: string,
  params: Record<string, string | number | boolean> = { initial: true },
) =>
  api.get<MessageWindow>(`/api/direct-conversations/${id}/messages`, { params }).then((r) => r.data)
export const markDirectRead = (id: string, throughMessageId: string) =>
  api.post(`/api/direct-conversations/${id}/read`, { throughMessageId })

export const resolveDiscussionRoom = (tmdbId: number) =>
  api
    .post<{ room: DiscussionSummary }>('/api/discussion-rooms/resolve', { tmdbId })
    .then((r) => r.data.room)
export const listDiscussionRooms = () =>
  api
    .get<{ rooms: DiscussionSummary[] }>('/api/discussion-rooms', {
      params: { membership: 'joined' },
    })
    .then((r) => r.data.rooms)
export const getDiscussionRoom = (id: string) =>
  api.get<{ room: DiscussionSummary }>(`/api/discussion-rooms/${id}`).then((r) => r.data.room)
export const getDiscussionMessages = (
  id: string,
  params: Record<string, string | number | boolean> = { initial: true },
) => api.get<MessageWindow>(`/api/discussion-rooms/${id}/messages`, { params }).then((r) => r.data)
export const joinDiscussion = (id: string) =>
  api.put(`/api/discussion-rooms/${id}/membership`, { status: 'joined' }).then((r) => r.data)
export const leaveDiscussion = (id: string) =>
  api.delete(`/api/discussion-rooms/${id}/membership`).then((r) => r.data)
export const sendDiscussionMessage = (id: string, clientMessageId: string, content: string) =>
  api
    .post<{ message: MessageDto }>(`/api/discussion-rooms/${id}/messages`, {
      clientMessageId,
      content,
    })
    .then((r) => r.data)
export const markDiscussionRead = (id: string, throughMessageId: string) =>
  api.post(`/api/discussion-rooms/${id}/read`, { throughMessageId })

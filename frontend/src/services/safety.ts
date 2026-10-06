import api from './api'

export type ContactInteraction = {
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
    canFollowUser: boolean
    canBlockUser: boolean
    canUnblockUser: boolean
    canReportUser: boolean
  }
  conversation?: {
    id: string
    state: 'pending' | 'unlocked' | 'declined' | 'revoked'
  }
}

export type ReportReason = 'harassment_or_uncomfortable' | 'spam_or_suspicious' | 'other'

export type ReportInput = {
  reason: ReportReason
  description?: string
}

type ContactInteractionResponse = { contactInteraction: ContactInteraction }

export const blockUser = (userId: string) =>
  api
    .put<ContactInteractionResponse>(`/api/users/${encodeURIComponent(userId)}/block`)
    .then((response) => response.data.contactInteraction)

export const unblockUser = (userId: string) =>
  api
    .delete<ContactInteractionResponse>(`/api/users/${encodeURIComponent(userId)}/block`)
    .then((response) => response.data.contactInteraction)

export const reportProfile = (userId: string, input: ReportInput) =>
  api.post(`/api/users/${encodeURIComponent(userId)}/report`, input)

export const reportConversation = (conversationId: string, input: ReportInput) =>
  api.post(`/api/direct-conversations/${encodeURIComponent(conversationId)}/report-user`, input)

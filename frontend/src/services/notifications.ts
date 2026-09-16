import api from '@/services/api'

export interface NotificationActor {
  _id: string
  account: string
  displayName?: string
  avatar?: string
}

export interface NotificationDto {
  _id: string
  type: 'follow'
  readAt: string | null
  createdAt: string
  updatedAt: string
  actor: NotificationActor | null
}

export interface NotificationsResponse {
  notifications: NotificationDto[]
  unreadCount: number
  nextCursor: string | null
}

export async function getNotifications(
  input: { limit: number; cursor?: string },
  accessToken: string,
) {
  const response = await api.get<NotificationsResponse>('/api/notifications', {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: input,
  })
  return response.data
}

export async function markNotificationRead(notificationId: string, accessToken: string) {
  const response = await api.patch<{ notification: { _id: string; readAt: string } }>(
    `/api/notifications/${encodeURIComponent(notificationId)}/read`,
    undefined,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  return response.data.notification
}

export async function markAllNotificationsRead(accessToken: string) {
  const response = await api.patch<{ updatedCount: number }>(
    '/api/notifications/read-all',
    undefined,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  return response.data
}

import type { Server } from 'socket.io'

let realtimeServer: Server | null = null

export type RealtimeEventMap = {
  'message.created': { message: unknown }
  'direct.updated': { conversationId: string }
  'relationship.updated': { userId: string }
  'notification.created': { notificationId: string }
  'read.updated':
    | { resource: 'direct'; id: string }
    | { resource: 'discussion'; id: string }
    | { resource: 'notification'; id: string }
    | { resource: 'notifications' }
  'discussion.membership.updated': { roomId: string; membership: unknown }
}

export const setRealtimeServer = (server: Server | null) => {
  realtimeServer = server
}

const publish = (room: string, event: string, payload: unknown) => {
  if (!realtimeServer) return false
  try {
    realtimeServer.to(room).emit(event, payload)
    return true
  } catch (error) {
    console.error(`Realtime publication failed for ${event}`, error)
    return false
  }
}

export const publishToUser = <Event extends keyof RealtimeEventMap>(
  userId: string,
  event: Event,
  payload: RealtimeEventMap[Event],
) => publish(`user:${userId}`, event, payload)

export const publishToUsers = <Event extends keyof RealtimeEventMap>(
  userIds: readonly string[],
  event: Event,
  payload: RealtimeEventMap[Event],
) => userIds.map((userId) => publishToUser(userId, event, payload))

export const publishDirectUpdated = (participantIds: readonly string[], conversationId: string) =>
  publishToUsers(participantIds, 'direct.updated', { conversationId })

export const publishRelationshipUpdated = (firstUserId: string, secondUserId: string) => {
  publishToUser(firstUserId, 'relationship.updated', { userId: secondUserId })
  publishToUser(secondUserId, 'relationship.updated', { userId: firstUserId })
}

export const publishDiscussion = <Event extends keyof RealtimeEventMap>(
  roomId: string,
  event: Event,
  payload: RealtimeEventMap[Event],
) => publish(`discussion:${roomId}`, event, payload)

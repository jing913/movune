/* eslint-disable @typescript-eslint/no-explicit-any -- Service results are runtime-validated canonical DTOs. */
import type { NextFunction, Request, Response } from 'express'
import { isObjectIdOrHexString } from 'mongoose'
import { Notification } from '../models/notificationModel.js'
import { DiscussionMembership } from '../models/discussionMembershipModel.js'
import {
  hasUnread,
  getDiscussion,
  getMessages,
  joinDiscussion,
  leaveDiscussion,
  listJoinedDiscussions,
  markRead,
  resolveDirect,
  resolveDiscussion,
  sendDirect,
  sendDiscussion,
  sendFirstDirect,
} from '../services/messagingService.js'
import { acceptMessageRequest, declineMessageRequest } from '../services/contactMutationService.js'
import {
  getDirectConversationRead,
  getDirectInboxRead,
  listDirectConversationRead,
} from '../services/directConversationReadService.js'
import {
  publishDirectUpdated,
  publishDiscussion,
  publishToUser,
} from '../services/realtimeService.js'
import { invalidInput, requireObjectId } from '../utils/messagingPolicy.js'

const userId = (req: Request) => {
  if (!req.user) throw new Error('Authentication middleware invariant failed')
  return req.user._id.toString()
}

const directConversationId = (req: Request) => {
  if (!isObjectIdOrHexString(req.params.conversationId)) throw invalidInput('conversationId')
  return req.params.conversationId
}

const handler =
  (operation: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await operation(req, res)
    } catch (error) {
      next(error)
    }
  }

export const resolveDirectController = handler(async (req, res) => {
  res.json(await resolveDirect(userId(req), req.body.otherUserId))
})

export const listDirectController = handler(async (req, res) => {
  res.json(
    await listDirectConversationRead(userId(req), {
      view: req.query.view,
      cursor: req.query.cursor,
      limit: req.query.limit,
    }),
  )
})

export const getDirectController = handler(async (req, res) => {
  res.json(await getDirectConversationRead(userId(req), req.params.conversationId))
})

export const sendFirstDirectController = handler(async (req, res) => {
  const result: any = await sendFirstDirect(
    userId(req),
    req.body.otherUserId,
    req.body.clientMessageId,
    req.body.content,
  )
  if (result.participantIds) {
    for (const participant of result.participantIds)
      publishToUser(participant.toString(), 'message.created', { message: result.message })
    publishDirectUpdated(
      result.participantIds.map((participant: { toString(): string }) => participant.toString()),
      result.message.contextId,
    )
  }
  const { conversation } = await getDirectConversationRead(userId(req), result.message.contextId)
  res.status(201).json({ message: result.message, conversation })
})

export const sendDirectController = handler(async (req, res) => {
  const result: any = await sendDirect(
    userId(req),
    req.params.conversationId,
    req.body.clientMessageId,
    req.body.content,
  )
  if (result.participantIds) {
    for (const participant of result.participantIds)
      publishToUser(participant.toString(), 'message.created', { message: result.message })
    if (result.lifecycleChanged)
      publishDirectUpdated(
        result.participantIds.map((participant: { toString(): string }) => participant.toString()),
        result.message.contextId,
      )
  }
  const { conversation } = await getDirectConversationRead(userId(req), req.params.conversationId)
  res.status(201).json({ message: result.message, conversation })
})

const resolvePendingDirectController = (
  resolution: typeof acceptMessageRequest | typeof declineMessageRequest,
) =>
  handler(async (req, res) => {
    const actorUserId = userId(req)
    const conversationId = directConversationId(req)
    const result = (await resolution(actorUserId, conversationId)) as {
      conversation: {
        _id: { toString(): string }
        participantIds: Array<{ toString(): string }>
      }
    }
    publishDirectUpdated(
      result.conversation.participantIds.map((participant) => participant.toString()),
      result.conversation._id.toString(),
    )
    res.json(await getDirectConversationRead(actorUserId, conversationId))
  })

export const acceptDirectController = resolvePendingDirectController(acceptMessageRequest)
export const declineDirectController = resolvePendingDirectController(declineMessageRequest)

export const directMessagesController = handler(async (req, res) => {
  res.json(await getMessages(userId(req), 'direct', req.params.conversationId, req.query))
})

export const directReadController = handler(async (req, res) => {
  const result = await markRead(
    userId(req),
    'direct',
    req.params.conversationId,
    req.body.throughMessageId,
  )
  publishToUser(userId(req), 'read.updated', {
    resource: 'direct',
    id: String(result.contextId),
  })
  res.json(result)
})

export const resolveDiscussionController = handler(async (req, res) => {
  res.json({ room: await resolveDiscussion(req.body.tmdbId) })
})

export const listDiscussionController = handler(async (req, res) => {
  res.json({ rooms: await listJoinedDiscussions(userId(req)), nextCursor: null })
})

export const getDiscussionController = handler(async (req, res) => {
  res.json({ room: await getDiscussion(userId(req), req.params.roomId) })
})

export const discussionMessagesController = handler(async (req, res) => {
  res.json(await getMessages(userId(req), 'discussion', req.params.roomId, req.query))
})

export const joinDiscussionController = handler(async (req, res) => {
  const membership = await joinDiscussion(userId(req), req.params.roomId)
  publishToUser(userId(req), 'discussion.membership.updated', {
    roomId: String(req.params.roomId),
    membership,
  })
  res.json({ membership })
})

export const leaveDiscussionController = handler(async (req, res) => {
  const membership = await leaveDiscussion(userId(req), req.params.roomId)
  publishToUser(userId(req), 'discussion.membership.updated', {
    roomId: String(req.params.roomId),
    membership,
  })
  res.json({ membership })
})

export const sendDiscussionController = handler(async (req, res) => {
  const result: any = await sendDiscussion(
    userId(req),
    req.params.roomId,
    req.body.clientMessageId,
    req.body.content,
  )
  const roomId = String(req.params.roomId)
  publishDiscussion(roomId, 'message.created', { message: result.message })
  const joined = await DiscussionMembership.find({
    roomId: requireObjectId(req.params.roomId),
    status: 'joined',
  })
    .select('userId')
    .lean()
  for (const membership of joined)
    publishToUser(membership.userId.toString(), 'message.created', { message: result.message })
  publishToUser(userId(req), 'discussion.membership.updated', {
    roomId,
    membership: result.discussionMembership,
  })
  res.status(201).json(result)
})

export const discussionReadController = handler(async (req, res) => {
  const result = await markRead(
    userId(req),
    'discussion',
    req.params.roomId,
    req.body.throughMessageId,
  )
  publishToUser(userId(req), 'read.updated', {
    resource: 'discussion',
    id: String(result.contextId),
  })
  res.json(result)
})

export const inboxSummaryController = handler(async (req, res) => {
  const id = requireObjectId(userId(req))
  const { messagesHasUnread, pendingIncomingRequestCount } = await getDirectInboxRead(id.toString())
  const memberships = await DiscussionMembership.find({ userId: id, status: 'joined' })
    .select('roomId')
    .lean()
  let discussionsHasUnread = false
  for (const membership of memberships) {
    if (await hasUnread('discussion', membership.roomId, id)) {
      discussionsHasUnread = true
      break
    }
  }
  const notificationsHasUnread = Boolean(
    await Notification.exists({ recipientId: id, readAt: null }),
  )
  const inboxHasUnread = messagesHasUnread || discussionsHasUnread || notificationsHasUnread
  res.json({
    messagesHasUnread,
    discussionsHasUnread,
    notificationsHasUnread,
    inboxHasUnread,
    pendingIncomingRequestCount,
    inboxNeedsAttention: inboxHasUnread || pendingIncomingRequestCount > 0,
  })
})

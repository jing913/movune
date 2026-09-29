/* eslint-disable @typescript-eslint/no-explicit-any -- Lean Mongoose projections are narrowed at DTO boundaries. */
import mongoose, { type ClientSession, Types } from 'mongoose'
import { DirectConversation } from '../models/directConversationModel.js'
import { DirectConversationState } from '../models/directConversationStateModel.js'
import { DiscussionMembership } from '../models/discussionMembershipModel.js'
import { DiscussionRoom } from '../models/discussionRoomModel.js'
import { Message } from '../models/messageModel.js'
import { User } from '../models/userModel.js'
import { evaluateContactAuthorization } from '../utils/contactAuthorizationPolicy.js'
import {
  ApiProblem,
  cursorFilter,
  decodeMessageCursor,
  encodeMessageCursor,
  isAfter,
  normalizeMessageContent,
  parseLimit,
  participantKey,
  requireObjectId,
} from '../utils/messagingPolicy.js'
import { serializeMessage } from './messageSerialization.js'
import {
  getContactAuthorizationContext,
  getContactAuthorizationContextInSession,
} from './contactAuthorizationContextService.js'
import { serializeContactInteraction } from './contactInteractionSerialization.js'
import { writeContactPairGuard } from './contactPairGuardService.js'
import { getAuthoritativeMovieSnapshot } from './tmdbMetadataService.js'

const { connection } = mongoose

type ContextType = 'direct' | 'discussion'

const notFound = () => new ApiProblem(404, 'RESOURCE_NOT_FOUND', 'Resource not found')

const commandId = (value: unknown) => {
  if (typeof value !== 'string' || !/^[\w-]{8,128}$/.test(value)) {
    throw new ApiProblem(400, 'MESSAGE_INVALID', 'Invalid clientMessageId')
  }
  return value
}

const snapshot = (message: {
  _id: Types.ObjectId
  senderId: Types.ObjectId
  content: string
  createdAt: Date
}) => ({
  messageId: message._id,
  senderId: message.senderId,
  preview: message.content.slice(0, 160),
  createdAt: message.createdAt,
})

const createdMessage = <T>(messages: T[]): T => {
  const message = messages[0]
  if (!message) throw new ApiProblem(500, 'TRANSACTION_FAILED', 'Message creation failed')
  return message
}

async function existingCommand(userId: Types.ObjectId, clientMessageId: string) {
  return Message.findOne({ senderId: userId, clientMessageId }).lean()
}

function compareExisting(
  existing: { contextType: string; contextId: Types.ObjectId; content: string },
  contextType: ContextType,
  contextId: Types.ObjectId,
  content: string,
) {
  if (
    existing.contextType !== contextType ||
    existing.contextId.toString() !== contextId.toString() ||
    existing.content !== content
  ) {
    throw new ApiProblem(
      409,
      'IDEMPOTENCY_CONFLICT',
      'clientMessageId was used for another command',
    )
  }
  return { message: serializeMessage(existing as never) }
}

async function loadDirect(
  conversationId: unknown,
  userId: Types.ObjectId,
  session?: ClientSession,
) {
  const id = requireObjectId(conversationId, 'conversation id')
  const query = DirectConversation.findOne({ _id: id, participantIds: userId })
  if (session) query.session(session)
  const conversation = await query
  if (!conversation) throw notFound()
  return conversation
}

export async function resolveDirect(userIdValue: string, otherUserIdValue: unknown) {
  const userId = requireObjectId(userIdValue, 'user id')
  const otherUserId = requireObjectId(otherUserIdValue, 'other user id')
  if (userId.equals(otherUserId))
    throw new ApiProblem(400, 'MESSAGE_INVALID', 'Cannot message yourself')
  const context = await getContactAuthorizationContext(userIdValue, otherUserId.toString())
  const decision = evaluateContactAuthorization(context)
  const [other, conversation] = await Promise.all([
    User.findById(otherUserId).select('account displayName avatar').lean(),
    DirectConversation.findOne({
      participantKey: participantKey(userIdValue, otherUserId.toString()),
    }).lean(),
  ])
  if (!other) throw notFound()
  return {
    conversation: conversation ? await serializeDirectSummary(conversation, userId) : null,
    otherUser: serializeUser(other),
    contactInteraction: serializeContactInteraction(
      decision,
      conversation && context.conversation
        ? {
            id: conversation._id.toString(),
            state: context.conversation.state,
          }
        : undefined,
    ),
  }
}

async function serializeDirectSummary(conversation: any, currentUserId: Types.ObjectId) {
  const otherId = conversation.participantIds.find(
    (id: Types.ObjectId) => !id.equals(currentUserId),
  )
  const [other, state, unread] = await Promise.all([
    User.findById(otherId).select('account displayName avatar').lean(),
    DirectConversationState.findOne({
      conversationId: conversation._id,
      userId: currentUserId,
    }).lean(),
    hasUnread('direct', conversation._id, currentUserId),
  ])
  const isInitiator = String(conversation.initiatedByUserId) === currentUserId.toString()
  return {
    id: conversation._id.toString(),
    otherUser: other ? serializeUser(other) : null,
    state:
      conversation.state === 'unlocked'
        ? 'unlocked'
        : isInitiator
          ? 'pending_outgoing'
          : 'pending_incoming',
    lastMessage: serializeLastMessage(conversation.lastMessage),
    hasUnread: unread,
    readBoundary: state?.lastReadMessageId
      ? { messageId: state.lastReadMessageId.toString(), createdAt: state.lastReadMessageCreatedAt }
      : null,
  }
}

const serializeUser = (user: any) => ({
  id: user._id.toString(),
  account: user.account,
  displayName: user.displayName ?? null,
  avatar: user.avatar ?? null,
})
const serializeLastMessage = (value: any) =>
  value
    ? {
        messageId: value.messageId.toString(),
        senderId: value.senderId.toString(),
        preview: value.preview,
        createdAt: value.createdAt,
      }
    : null

export async function sendFirstDirect(
  userIdValue: string,
  otherUserIdValue: unknown,
  clientMessageIdValue: unknown,
  contentValue: unknown,
  failurePoint?: 'after-states' | 'after-message',
) {
  const userId = requireObjectId(userIdValue, 'user id')
  const otherUserId = requireObjectId(otherUserIdValue, 'other user id')
  if (userId.equals(otherUserId))
    throw new ApiProblem(400, 'MESSAGE_INVALID', 'Cannot message yourself')
  const content = normalizeMessageContent(contentValue)
  const clientMessageId = commandId(clientMessageIdValue)
  const key = participantKey(userId.toString(), otherUserId.toString())
  try {
    let result: any
    await connection.transaction(async (session) => {
      await writeContactPairGuard(userId.toString(), otherUserId.toString(), session)
      const context = await getContactAuthorizationContextInSession(
        userId.toString(),
        otherUserId.toString(),
        session,
      )
      if (!context.targetExists) throw notFound()
      result = context.conversation
        ? await sendExistingDirectInSession(
            userId,
            otherUserId,
            key,
            clientMessageId,
            content,
            session,
            failurePoint,
          )
        : await createFirstDirectInSession(
            userId,
            otherUserId,
            key,
            clientMessageId,
            content,
            session,
            failurePoint,
          )
    })
    return result
  } catch (error: any) {
    if (error?.code === 11000) {
      const existing = await existingCommand(userId, clientMessageId)
      if (existing) {
        const conversation = await DirectConversation.findOne({ participantKey: key })
        if (!conversation) throw error
        return compareExisting(existing as never, 'direct', conversation._id, content)
      }
      if (await DirectConversation.exists({ participantKey: key })) {
        throw new ApiProblem(409, 'DIRECT_STATE_CONFLICT', 'Direct contact already changed')
      }
    }
    throw error
  }
}

export async function sendDirect(
  userIdValue: string,
  conversationIdValue: unknown,
  clientIdValue: unknown,
  contentValue: unknown,
  failurePoint?: 'after-states' | 'after-message',
) {
  const userId = requireObjectId(userIdValue, 'user id')
  const conversationId = requireObjectId(conversationIdValue, 'conversation id')
  const content = normalizeMessageContent(contentValue)
  const clientMessageId = commandId(clientIdValue)
  const prior = await existingCommand(userId, clientMessageId)
  if (prior) return compareExisting(prior as never, 'direct', conversationId, content)

  const pair = await DirectConversation.findOne({
    _id: conversationId,
    participantIds: userId,
  })
    .select('participantIds participantKey')
    .lean()
  if (!pair) throw notFound()
  const otherUserId = pair.participantIds.find((id: Types.ObjectId) => !id.equals(userId))
  if (!otherUserId) throw notFound()

  let result: any
  try {
    await connection.transaction(async (session) => {
      await writeContactPairGuard(userId.toString(), otherUserId.toString(), session)
      result = await sendExistingDirectInSession(
        userId,
        otherUserId,
        pair.participantKey,
        clientMessageId,
        content,
        session,
        failurePoint,
      )
    })
  } catch (error: any) {
    if (error?.code === 11000) {
      const existing = await existingCommand(userId, clientMessageId)
      if (existing) return compareExisting(existing as never, 'direct', conversationId, content)
    }
    throw error
  }
  return result
}

const directStateConflict = (state?: string) =>
  new ApiProblem(409, 'DIRECT_STATE_CONFLICT', 'Conversation state changed', {
    ...(state ? { currentState: state } : {}),
  })

const directUnavailable = () =>
  new ApiProblem(403, 'DIRECT_UNAVAILABLE', 'Direct interaction is unavailable')

async function createFirstDirectInSession(
  userId: Types.ObjectId,
  otherUserId: Types.ObjectId,
  key: string,
  clientMessageId: string,
  content: string,
  session: ClientSession,
  failurePoint?: 'after-states' | 'after-message',
) {
  const context = await getContactAuthorizationContextInSession(
    userId.toString(),
    otherUserId.toString(),
    session,
  )
  const decision = evaluateContactAuthorization(context)
  if (decision.isEffectivelyBlocked) throw directUnavailable()
  const isUnlocked = decision.interactionState === 'direct_allowed'
  if (!isUnlocked && decision.interactionState !== 'request_allowed') {
    throw new ApiProblem(403, 'MESSAGE_REQUEST_NOT_ALLOWED', 'Message request is not allowed')
  }

  const now = new Date()
  const conversation = new DirectConversation({
    participantIds: [userId, otherUserId],
    participantKey: key,
    initiatedByUserId: userId,
    state: isUnlocked ? 'unlocked' : 'pending',
    unlockedAt: isUnlocked ? now : undefined,
    unlockReason: isUnlocked ? 'follow' : undefined,
  })
  await conversation.save({ session })
  await DirectConversationState.create([{ conversationId: conversation._id, userId }], { session })
  await DirectConversationState.create(
    [{ conversationId: conversation._id, userId: otherUserId }],
    { session },
  )
  if (failurePoint === 'after-states') throw new Error('Injected transaction failure after states')
  const message = createdMessage(
    await Message.create(
      [
        {
          senderId: userId,
          clientMessageId,
          contextType: 'direct',
          contextId: conversation._id,
          content,
        },
      ],
      { session },
    ),
  )
  if (failurePoint === 'after-message')
    throw new Error('Injected transaction failure after message')
  conversation.lastMessage = snapshot(message) as never
  await conversation.save({ session })
  return {
    message: serializeMessage(message.toObject() as never),
    conversation,
    participantIds: [userId, otherUserId],
    lifecycleChanged: true,
  }
}

async function sendExistingDirectInSession(
  userId: Types.ObjectId,
  otherUserId: Types.ObjectId,
  key: string,
  clientMessageId: string,
  content: string,
  session: ClientSession,
  failurePoint?: 'after-states' | 'after-message',
) {
  const conversation = await DirectConversation.findOne({ participantKey: key }).session(session)
  if (!conversation) throw directStateConflict()
  const context = await getContactAuthorizationContextInSession(
    userId.toString(),
    otherUserId.toString(),
    session,
  )
  const decision = evaluateContactAuthorization(context)
  if (decision.isEffectivelyBlocked) throw directUnavailable()

  const expectedState = conversation.state
  let nextState: 'pending' | 'unlocked' = 'unlocked'
  let unlockReason: 'reply' | 'follow' | undefined
  let resetInitiator = false

  if (expectedState === 'pending') {
    if (!decision.capabilities.canSendMessage) {
      throw new ApiProblem(403, 'DIRECT_PENDING', 'Wait for a reply before sending another message')
    }
    unlockReason = conversation.initiatedByUserId.equals(userId) ? 'follow' : 'reply'
  } else if (expectedState === 'declined') {
    const isOriginalInitiator = conversation.initiatedByUserId.equals(userId)
    if (!isOriginalInitiator || !context.targetFollowsActor) {
      throw new ApiProblem(403, 'DIRECT_DECLINED', 'The message request was declined')
    }
    unlockReason = 'follow'
  } else if (expectedState === 'revoked') {
    if (decision.interactionState === 'direct_allowed') unlockReason = 'follow'
    else if (decision.interactionState === 'request_allowed') {
      nextState = 'pending'
      resetInitiator = true
    } else throw directUnavailable()
  } else if (expectedState !== 'unlocked') {
    throw directStateConflict(expectedState)
  }

  const message = createdMessage(
    await Message.create(
      [
        {
          senderId: userId,
          clientMessageId,
          contextType: 'direct',
          contextId: conversation._id,
          content,
        },
      ],
      { session },
    ),
  )
  if (failurePoint === 'after-message')
    throw new Error('Injected transaction failure after message')
  const now = new Date()
  const set: Record<string, unknown> = { lastMessage: snapshot(message) }
  const unset: Record<string, 1> = {}
  if (expectedState !== 'unlocked') {
    set.state = nextState
    if (nextState === 'unlocked') {
      set.unlockedAt = now
      set.unlockReason = unlockReason
      unset.declinedAt = 1
      unset.revokedAt = 1
      unset.revocationReason = 1
    } else {
      set.initiatedByUserId = userId
      unset.unlockedAt = 1
      unset.unlockReason = 1
      unset.declinedAt = 1
      unset.revokedAt = 1
      unset.revocationReason = 1
    }
  }
  if (resetInitiator) set.initiatedByUserId = userId
  const updated = await DirectConversation.findOneAndUpdate(
    { _id: conversation._id, state: expectedState },
    { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { returnDocument: 'after', session },
  )
  if (!updated) throw directStateConflict()
  if (failurePoint === 'after-states') throw new Error('Injected transaction failure after states')
  return {
    message: serializeMessage(message.toObject() as never),
    conversation: updated,
    participantIds: updated.participantIds,
    lifecycleChanged: expectedState !== 'unlocked',
  }
}

export async function resolveDiscussion(tmdbIdValue: unknown) {
  const tmdbId = Number(tmdbIdValue)
  if (!Number.isSafeInteger(tmdbId) || tmdbId < 1)
    throw new ApiProblem(400, 'MESSAGE_INVALID', 'Invalid tmdbId')
  const movieSnapshot = await getAuthoritativeMovieSnapshot(tmdbId)
  const room = await DiscussionRoom.findOneAndUpdate(
    { tmdbId },
    { $set: { movieSnapshot } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).lean()
  return serializeRoom(room)
}

const serializeRoom = (room: any, membership?: any, unread = false) => ({
  id: room._id.toString(),
  tmdbId: room.tmdbId,
  movieSnapshot: room.movieSnapshot,
  lastMessage: serializeLastMessage(room.lastMessage),
  membership: membership ? serializeMembership(membership) : null,
  hasUnread: unread,
})
const serializeMembership = (membership: any) => ({
  roomId: membership.roomId.toString(),
  status: membership.status,
  joinedAt: membership.joinedAt,
  leftAt: membership.leftAt ?? null,
  lastReadMessageId: membership.lastReadMessageId?.toString() ?? null,
  lastReadMessageCreatedAt: membership.lastReadMessageCreatedAt ?? null,
})

export async function getDiscussion(userIdValue: string, roomIdValue: unknown) {
  const userId = requireObjectId(userIdValue)
  const roomId = requireObjectId(roomIdValue, 'room id')
  const [room, membership] = await Promise.all([
    DiscussionRoom.findById(roomId).lean(),
    DiscussionMembership.findOne({ roomId, userId }).lean(),
  ])
  if (!room) throw notFound()
  return serializeRoom(
    room,
    membership,
    membership?.status === 'joined' ? await hasUnread('discussion', roomId, userId) : false,
  )
}

export async function listJoinedDiscussions(userIdValue: string) {
  const userId = requireObjectId(userIdValue)
  const memberships = await DiscussionMembership.find({ userId, status: 'joined' }).lean()
  const rows = []
  for (const membership of memberships) {
    const room = await DiscussionRoom.findById(membership.roomId).lean()
    if (room)
      rows.push(serializeRoom(room, membership, await hasUnread('discussion', room._id, userId)))
  }
  return rows.sort(
    (a, b) =>
      new Date(b.lastMessage?.createdAt ?? 0).valueOf() -
      new Date(a.lastMessage?.createdAt ?? 0).valueOf(),
  )
}

async function currentLatest(
  contextType: ContextType,
  contextId: Types.ObjectId,
  session?: ClientSession,
) {
  const query = Message.findOne({ contextType, contextId }).sort({ createdAt: -1, _id: -1 }).lean()
  if (session) query.session(session)
  return query
}

export async function joinDiscussion(userIdValue: string, roomIdValue: unknown) {
  const userId = requireObjectId(userIdValue)
  const roomId = requireObjectId(roomIdValue, 'room id')
  if (!(await DiscussionRoom.exists({ _id: roomId }))) throw notFound()
  const existing = await DiscussionMembership.findOne({ roomId, userId })
  if (existing?.status === 'joined') return serializeMembership(existing)
  const latest = await currentLatest('discussion', roomId)
  const now = new Date()
  const membership = await DiscussionMembership.findOneAndUpdate(
    { roomId, userId },
    {
      $set: {
        status: 'joined',
        joinedAt: now,
        leftAt: null,
        lastReadMessageId: latest?._id,
        lastReadMessageCreatedAt: latest?.createdAt,
      },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  )
  return serializeMembership(membership)
}

export async function leaveDiscussion(userIdValue: string, roomIdValue: unknown) {
  const userId = requireObjectId(userIdValue)
  const roomId = requireObjectId(roomIdValue, 'room id')
  const membership = await DiscussionMembership.findOneAndUpdate(
    { roomId, userId, status: 'joined' },
    { $set: { status: 'left', leftAt: new Date() } },
    { returnDocument: 'after' },
  )
  if (!membership) throw notFound()
  return serializeMembership(membership)
}

export async function sendDiscussion(
  userIdValue: string,
  roomIdValue: unknown,
  clientIdValue: unknown,
  contentValue: unknown,
  failurePoint?: 'after-membership' | 'after-message',
) {
  const userId = requireObjectId(userIdValue)
  const roomId = requireObjectId(roomIdValue, 'room id')
  const content = normalizeMessageContent(contentValue)
  const clientMessageId = commandId(clientIdValue)
  const prior = await existingCommand(userId, clientMessageId)
  if (prior) return compareExisting(prior as never, 'discussion', roomId, content)
  let result: any
  try {
    await connection.transaction(async (session) => {
      const room = await DiscussionRoom.findById(roomId).session(session)
      if (!room) throw notFound()
      let membership = await DiscussionMembership.findOne({ roomId, userId }).session(session)
      if (!membership || membership.status === 'left') {
        const latest = await currentLatest('discussion', roomId, session)
        const now = new Date()
        membership = await DiscussionMembership.findOneAndUpdate(
          { roomId, userId },
          {
            $set: {
              status: 'joined',
              joinedAt: now,
              leftAt: null,
              lastReadMessageId: latest?._id,
              lastReadMessageCreatedAt: latest?.createdAt,
            },
          },
          { upsert: true, returnDocument: 'after', session, setDefaultsOnInsert: true },
        )
      }
      if (failurePoint === 'after-membership')
        throw new Error('Injected transaction failure after membership')
      const message = createdMessage(
        await Message.create(
          [
            {
              senderId: userId,
              clientMessageId,
              contextType: 'discussion',
              contextId: roomId,
              content,
            },
          ],
          { session },
        ),
      )
      if (failurePoint === 'after-message')
        throw new Error('Injected transaction failure after message')
      room.lastMessage = snapshot(message) as never
      await room.save({ session })
      result = {
        message: serializeMessage(message.toObject() as never),
        discussionMembership: serializeMembership(membership),
      }
    })
  } catch (error: any) {
    if (error?.code === 11000) {
      const existing = await existingCommand(userId, clientMessageId)
      if (existing) return compareExisting(existing as never, 'discussion', roomId, content)
    }
    throw error
  }
  return result
}

export async function getMessages(
  userIdValue: string,
  contextType: ContextType,
  contextIdValue: unknown,
  query: Record<string, unknown>,
) {
  const userId = requireObjectId(userIdValue)
  const contextId = requireObjectId(contextIdValue, `${contextType} id`)
  if (contextType === 'direct') await loadDirect(contextId.toString(), userId)
  else if (!(await DiscussionRoom.exists({ _id: contextId }))) throw notFound()
  const before = decodeMessageCursor(query.before)
  const after = decodeMessageCursor(query.after)
  if (before && after) throw new ApiProblem(400, 'MESSAGE_INVALID', 'Use either before or after')
  const limit = parseLimit(query.limit)
  const direction = before ? 'before' : 'after'
  const cursor = before ?? after
  const filter = { contextType, contextId, ...(cursor ? cursorFilter(cursor, direction) : {}) }
  const sort =
    direction === 'before' || !cursor
      ? { createdAt: -1 as const, _id: -1 as const }
      : { createdAt: 1 as const, _id: 1 as const }
  const records = await Message.find(filter)
    .sort(sort)
    .limit(limit + 1)
    .populate('senderId', 'account displayName avatar')
    .lean()
  const hasMore = records.length > limit
  let page = records.slice(0, limit)
  if (direction === 'before' || !cursor) page = page.reverse()
  const state =
    contextType === 'direct'
      ? await DirectConversationState.findOne({ conversationId: contextId, userId }).lean()
      : await DiscussionMembership.findOne({ roomId: contextId, userId }).lean()
  const firstUnread = page.find(
    (message) =>
      String(
        message.senderId && typeof message.senderId === 'object' && '_id' in message.senderId
          ? message.senderId._id
          : message.senderId,
      ) !== userId.toString() &&
      (!state?.lastReadMessageCreatedAt ||
        isAfter(
          { createdAt: message.createdAt, id: message._id },
          { createdAt: state.lastReadMessageCreatedAt, id: state.lastReadMessageId ?? null },
        )),
  )
  const first = page[0]
  const last = page.at(-1)
  return {
    messages: page.map((message) => serializeMessage(message as never)),
    firstUnreadMessageId: firstUnread?._id.toString() ?? null,
    previousCursor:
      hasMore && first ? encodeMessageCursor({ createdAt: first.createdAt, id: first._id }) : null,
    nextCursor: last ? encodeMessageCursor({ createdAt: last.createdAt, id: last._id }) : null,
    latestCursor: last ? encodeMessageCursor({ createdAt: last.createdAt, id: last._id }) : null,
    readBoundary: state?.lastReadMessageId
      ? { messageId: state.lastReadMessageId.toString(), createdAt: state.lastReadMessageCreatedAt }
      : null,
  }
}

export async function markRead(
  userIdValue: string,
  contextType: ContextType,
  contextIdValue: unknown,
  messageIdValue: unknown,
) {
  const userId = requireObjectId(userIdValue)
  const contextId = requireObjectId(contextIdValue)
  const messageId = requireObjectId(messageIdValue, 'message id')
  if (contextType === 'direct') await loadDirect(contextId.toString(), userId)
  const message = await Message.findOne({ _id: messageId, contextType, contextId }).lean()
  if (!message) throw notFound()
  const model: any = contextType === 'direct' ? DirectConversationState : DiscussionMembership
  const identity =
    contextType === 'direct'
      ? { conversationId: contextId, userId }
      : { roomId: contextId, userId, status: 'joined' }
  const current: any = await model.findOne(identity).lean()
  if (!current) throw notFound()
  await model.updateOne(
    {
      ...identity,
      _id: current._id,
      $or: [
        { lastReadMessageCreatedAt: { $exists: false } },
        { lastReadMessageCreatedAt: null },
        { lastReadMessageCreatedAt: { $lt: message.createdAt } },
        { lastReadMessageCreatedAt: message.createdAt, lastReadMessageId: { $lt: message._id } },
      ],
    },
    { $set: { lastReadMessageId: message._id, lastReadMessageCreatedAt: message.createdAt } },
  )
  const canonical: any = await model.findOne(identity).lean()
  return {
    contextType,
    contextId: contextId.toString(),
    lastReadMessageId: canonical.lastReadMessageId.toString(),
    lastReadMessageCreatedAt: canonical.lastReadMessageCreatedAt,
  }
}

export async function hasUnread(
  contextType: ContextType,
  contextId: Types.ObjectId,
  userId: Types.ObjectId,
) {
  const state: any =
    contextType === 'direct'
      ? await DirectConversationState.findOne({ conversationId: contextId, userId }).lean()
      : await DiscussionMembership.findOne({ roomId: contextId, userId, status: 'joined' }).lean()
  if (!state) return false
  const boundary = state.lastReadMessageCreatedAt
    ? cursorFilter(
        { createdAt: state.lastReadMessageCreatedAt, id: state.lastReadMessageId },
        'after',
      )
    : {}
  return Boolean(
    await Message.exists({ contextType, contextId, senderId: { $ne: userId }, ...boundary }),
  )
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Lean projections are narrowed at the DTO boundary. */
import { Types, isObjectIdOrHexString } from 'mongoose'
import { DirectConversation } from '../models/directConversationModel.js'
import { DirectConversationState } from '../models/directConversationStateModel.js'
import { Favorite } from '../models/favoriteModel.js'
import { Follow } from '../models/followModel.js'
import { Message } from '../models/messageModel.js'
import { UserBlock } from '../models/userBlockModel.js'
import { User } from '../models/userModel.js'
import { normalizeMessageRequestPreference } from './contactAuthorizationContextService.js'
import {
  classifyDirectConversationRead,
  type DirectConversationReadBucket,
} from '../utils/directConversationReadClassifier.js'
import type { ContactAuthorizationContext } from '../utils/contactAuthorizationPolicy.js'
import { ApiProblem, invalidInput } from '../utils/messagingPolicy.js'
import {
  decodeReadCursor,
  descendingReadCursorFilter,
  encodeReadCursor,
  parseReadLimit,
} from '../utils/readModelPagination.js'

export type DirectConversationView = DirectConversationReadBucket

const notFound = () => new ApiProblem(404, 'RESOURCE_NOT_FOUND', 'Resource not found')

const parseView = (value: unknown): DirectConversationView | null => {
  if (value === undefined) return null
  if (value !== 'conversations' && value !== 'requests' && value !== 'ended') {
    throw invalidInput('view')
  }
  return value
}

type BlockRow = Readonly<{
  blockerUserId: Types.ObjectId
  blockedUserId: Types.ObjectId
}>

type EnrichedConversation = Readonly<{
  conversation: any
  counterpart: any
  state: any
  classification: ReturnType<typeof classifyDirectConversationRead>
  hasUnread: boolean
  sharedMovieIds: readonly number[]
}>

const counterpartId = (conversation: any, actorUserId: Types.ObjectId) => {
  const id = conversation.participantIds.find(
    (participantId: Types.ObjectId) => !participantId.equals(actorUserId),
  )
  if (!id) throw notFound()
  return id as Types.ObjectId
}

const blockTargetIds = (actorUserId: Types.ObjectId, blocks: readonly BlockRow[]) =>
  blocks.map((block) =>
    block.blockerUserId.equals(actorUserId) ? block.blockedUserId : block.blockerUserId,
  )

const loadActorBlocks = (actorUserId: Types.ObjectId) =>
  UserBlock.find({
    $or: [{ blockerUserId: actorUserId }, { blockedUserId: actorUserId }],
  })
    .select('blockerUserId blockedUserId')
    .lean() as Promise<BlockRow[]>

const pairKey = (first: Types.ObjectId, second: Types.ObjectId) =>
  `${first.toString()}:${second.toString()}`

const unreadConversationIds = async (
  conversations: readonly any[],
  statesByConversation: ReadonlyMap<string, any>,
  actorUserId: Types.ObjectId,
) => {
  const conditions: Record<string, unknown>[] = []
  for (const conversation of conversations) {
    const state = statesByConversation.get(conversation._id.toString())
    if (!state) continue
    const base = { contextId: conversation._id }
    if (!state.lastReadMessageCreatedAt) {
      conditions.push(base)
      continue
    }
    const after: Record<string, unknown>[] = [
      { createdAt: { $gt: state.lastReadMessageCreatedAt } },
    ]
    if (state.lastReadMessageId) {
      after.push({
        createdAt: state.lastReadMessageCreatedAt,
        _id: { $gt: state.lastReadMessageId },
      })
    }
    conditions.push({ ...base, $or: after })
  }
  if (conditions.length === 0) return new Set<string>()
  const ids = await Message.distinct('contextId', {
    contextType: 'direct',
    senderId: { $ne: actorUserId },
    $or: conditions,
  })
  return new Set(ids.map((id) => id.toString()))
}

const enrichConversations = async (
  conversations: readonly any[],
  actorUserId: Types.ObjectId,
  blocks: readonly BlockRow[],
  includeSharedContext: boolean,
): Promise<EnrichedConversation[]> => {
  if (conversations.length === 0) return []
  const otherIds = conversations.map((conversation) => counterpartId(conversation, actorUserId))
  const conversationIds = conversations.map((conversation) => conversation._id as Types.ObjectId)

  const [users, follows, states, actorFavoriteIds] = await Promise.all([
    User.find({ _id: { $in: otherIds } })
      .select('account displayName avatar favoritesPublic messageRequestPreference')
      .lean(),
    Follow.find({
      $or: [
        { followerId: actorUserId, followingId: { $in: otherIds } },
        { followerId: { $in: otherIds }, followingId: actorUserId },
      ],
    })
      .select('followerId followingId')
      .lean(),
    DirectConversationState.find({
      conversationId: { $in: conversationIds },
      userId: actorUserId,
    })
      .select('conversationId lastReadMessageId lastReadMessageCreatedAt')
      .lean(),
    includeSharedContext
      ? Favorite.distinct('tmdbId', { userId: actorUserId })
      : Promise.resolve([] as number[]),
  ])

  const usersById = new Map(users.map((user) => [user._id.toString(), user]))
  const followsByDirection = new Set(
    follows.map((follow) => pairKey(follow.followerId, follow.followingId)),
  )
  const statesByConversation = new Map(
    states.map((state) => [state.conversationId.toString(), state]),
  )
  const blockDirections = new Set(
    blocks.map((block) => pairKey(block.blockerUserId, block.blockedUserId)),
  )
  const publicOtherIds = users
    .filter((user) => user.favoritesPublic === true)
    .map((user) => user._id)
  const sharedFavorites =
    includeSharedContext && actorFavoriteIds.length > 0 && publicOtherIds.length > 0
      ? await Favorite.find({
          userId: { $in: publicOtherIds },
          tmdbId: { $in: actorFavoriteIds },
        })
          .select('userId tmdbId')
          .sort({ tmdbId: 1 })
          .lean()
      : []
  const sharedByUser = new Map<string, number[]>()
  for (const favorite of sharedFavorites) {
    const key = favorite.userId.toString()
    const values = sharedByUser.get(key) ?? []
    values.push(favorite.tmdbId)
    sharedByUser.set(key, values)
  }
  const unreadIds = await unreadConversationIds(conversations, statesByConversation, actorUserId)

  return conversations.map((conversation) => {
    const otherId = counterpartId(conversation, actorUserId)
    const otherIdValue = otherId.toString()
    const actorIdValue = actorUserId.toString()
    const counterpart = usersById.get(otherIdValue) ?? null
    const sharedMovieIds = sharedByUser.get(otherIdValue) ?? []
    const context: ContactAuthorizationContext = {
      actorUserId: actorIdValue,
      targetUserId: otherIdValue,
      targetExists: counterpart !== null,
      actorBlocksTarget: blockDirections.has(pairKey(actorUserId, otherId)),
      targetBlocksActor: blockDirections.has(pairKey(otherId, actorUserId)),
      actorFollowsTarget: followsByDirection.has(pairKey(actorUserId, otherId)),
      targetFollowsActor: followsByDirection.has(pairKey(otherId, actorUserId)),
      targetMessageRequestPreference: counterpart
        ? normalizeMessageRequestPreference(counterpart.messageRequestPreference)
        : 'invalid',
      conversation: {
        state: conversation.state,
        initiatedByUserId: conversation.initiatedByUserId.toString(),
      },
    }
    return {
      conversation,
      counterpart,
      state: statesByConversation.get(conversation._id.toString()) ?? null,
      classification: classifyDirectConversationRead(context, sharedMovieIds.length > 0),
      hasUnread: unreadIds.has(conversation._id.toString()),
      sharedMovieIds,
    }
  })
}

const requireLastMessage = (conversation: any) => {
  if (!conversation.lastMessage) {
    throw new Error('Direct Conversation read invariant failed: lastMessage is required')
  }
  return conversation.lastMessage
}

const serializeExplicit = (value: EnrichedConversation) => {
  if (!value.counterpart) throw notFound()
  const lastMessage = requireLastMessage(value.conversation)
  const shouldRender = value.classification.shouldRenderSharedContext
  return {
    id: value.conversation._id.toString(),
    counterpart: {
      id: value.counterpart._id.toString(),
      displayName: value.counterpart.displayName?.trim() || value.counterpart.account,
      username: value.counterpart.account,
      ...(value.counterpart.avatar ? { avatarUrl: value.counterpart.avatar } : {}),
    },
    interactionState: value.classification.interactionState,
    capabilities: value.classification.capabilities,
    lastMessage: {
      id: lastMessage.messageId.toString(),
      senderId: lastMessage.senderId.toString(),
      content: lastMessage.preview,
      sentAt: new Date(lastMessage.createdAt).toISOString(),
    },
    ...(value.classification.bucket === 'ended' ? {} : { hasUnread: value.hasUnread }),
    sharedContext: {
      shouldRender,
      ...(shouldRender ? { movies: value.sharedMovieIds.map((tmdbId) => ({ tmdbId })) } : {}),
    },
    updatedAt: new Date(value.conversation.updatedAt).toISOString(),
  }
}

const serializeExplicitDetail = (value: EnrichedConversation) => ({
  ...serializeExplicit(value),
  bucket: value.classification.bucket,
})

const serializeLegacy = (value: EnrichedConversation, actorUserId: Types.ObjectId) => {
  const lastMessage = requireLastMessage(value.conversation)
  return {
    id: value.conversation._id.toString(),
    otherUser: value.counterpart
      ? {
          id: value.counterpart._id.toString(),
          account: value.counterpart.account,
          displayName: value.counterpart.displayName ?? null,
          avatar: value.counterpart.avatar ?? null,
        }
      : null,
    state:
      value.conversation.state === 'unlocked'
        ? 'unlocked'
        : value.conversation.initiatedByUserId.equals(actorUserId)
          ? 'pending_outgoing'
          : 'pending_incoming',
    lastMessage: {
      messageId: lastMessage.messageId.toString(),
      senderId: lastMessage.senderId.toString(),
      preview: lastMessage.preview,
      createdAt: lastMessage.createdAt,
    },
    hasUnread: value.hasUnread,
    readBoundary: value.state?.lastReadMessageId
      ? {
          messageId: value.state.lastReadMessageId.toString(),
          createdAt: value.state.lastReadMessageCreatedAt,
        }
      : null,
  }
}

const viewState = (view: DirectConversationView) =>
  view === 'conversations' ? 'unlocked' : view === 'requests' ? 'pending' : null

export const listDirectConversationRead = async (
  actorUserIdValue: string,
  query: Readonly<{ view?: unknown; cursor?: unknown; limit?: unknown }>,
) => {
  const actorUserId = new Types.ObjectId(actorUserIdValue)
  const view = parseView(query.view)
  const blocks = await loadActorBlocks(actorUserId)
  const blockedIds = blockTargetIds(actorUserId, blocks)

  if (!view) {
    const conditions: Record<string, unknown>[] = [
      { participantIds: actorUserId, state: { $in: ['pending', 'unlocked'] } },
    ]
    if (blockedIds.length > 0) conditions.push({ participantIds: { $nin: blockedIds } })
    const conversations = await DirectConversation.find({ $and: conditions })
      .sort({ 'lastMessage.createdAt': -1, _id: -1 })
      .lean()
    const enriched = await enrichConversations(conversations, actorUserId, blocks, false)
    return {
      conversations: enriched.map((value) => serializeLegacy(value, actorUserId)),
      nextCursor: null,
    }
  }

  const limit = parseReadLimit(query.limit)
  const cursor = decodeReadCursor(query.cursor, `direct:${view}`)
  const sortField = view === 'ended' ? 'updatedAt' : 'lastMessage.createdAt'
  const conditions: Record<string, unknown>[] = [{ participantIds: actorUserId }]
  const activeState = viewState(view)
  if (activeState) {
    conditions.push({ state: activeState })
    if (blockedIds.length > 0) conditions.push({ participantIds: { $nin: blockedIds } })
  } else {
    const endedConditions: Record<string, unknown>[] = [{ state: { $in: ['declined', 'revoked'] } }]
    if (blockedIds.length > 0) endedConditions.push({ participantIds: { $in: blockedIds } })
    conditions.push({ $or: endedConditions })
  }
  if (cursor) conditions.push(descendingReadCursorFilter(sortField, cursor))
  const conversations = await DirectConversation.find({ $and: conditions })
    .sort({ [sortField]: -1, _id: -1 })
    .limit(limit + 1)
    .lean()
  const hasMore = conversations.length > limit
  const page = hasMore ? conversations.slice(0, limit) : conversations
  const enriched = await enrichConversations(page, actorUserId, blocks, true)
  const last = page.at(-1)
  const sortAt = last
    ? new Date(view === 'ended' ? last.updatedAt : requireLastMessage(last).createdAt)
    : null
  return {
    conversations: enriched.map(serializeExplicit),
    nextCursor:
      hasMore && last && sortAt ? encodeReadCursor(`direct:${view}`, sortAt, last._id) : null,
  }
}

export const getDirectConversationRead = async (
  actorUserIdValue: string,
  conversationIdValue: unknown,
) => {
  if (typeof conversationIdValue !== 'string' || !isObjectIdOrHexString(conversationIdValue)) {
    throw invalidInput('conversationId')
  }
  const actorUserId = new Types.ObjectId(actorUserIdValue)
  const conversation = await DirectConversation.findOne({
    _id: conversationIdValue,
    participantIds: actorUserId,
  }).lean()
  if (!conversation) throw notFound()
  const blocks = await loadActorBlocks(actorUserId)
  const [enriched] = await enrichConversations([conversation], actorUserId, blocks, true)
  if (!enriched) throw notFound()
  return { conversation: serializeExplicitDetail(enriched) }
}

export const getDirectInboxRead = async (actorUserIdValue: string) => {
  const actorUserId = new Types.ObjectId(actorUserIdValue)
  const blocks = await loadActorBlocks(actorUserId)
  const blockedIds = blockTargetIds(actorUserId, blocks)
  const conditions: Record<string, unknown>[] = [
    { participantIds: actorUserId, state: { $in: ['pending', 'unlocked'] } },
  ]
  if (blockedIds.length > 0) conditions.push({ participantIds: { $nin: blockedIds } })
  const conversations = await DirectConversation.find({ $and: conditions }).lean()
  const enriched = await enrichConversations(conversations, actorUserId, blocks, false)
  return {
    messagesHasUnread: enriched.some(
      (value) => value.classification.bucket !== 'ended' && value.hasUnread,
    ),
    pendingIncomingRequestCount: enriched.filter(
      (value) => value.classification.isActionableIncomingRequest,
    ).length,
  }
}

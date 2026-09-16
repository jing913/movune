import mongoose, { type ClientSession, Types } from 'mongoose'
import { DirectConversation, type DirectState } from '../models/directConversationModel.js'
import { Follow } from '../models/followModel.js'
import { UserBlock } from '../models/userBlockModel.js'
import { User } from '../models/userModel.js'
import { evaluateContactAuthorization } from '../utils/contactAuthorizationPolicy.js'
import { ApiProblem, participantKey, requireObjectId } from '../utils/messagingPolicy.js'
import {
  getContactAuthorizationContext,
  getContactAuthorizationContextInSession,
} from './contactAuthorizationContextService.js'
import { writeContactPairGuard } from './contactPairGuardService.js'
import {
  serializeContactInteraction,
  type ContactInteractionDto,
} from './contactInteractionSerialization.js'

const { connection } = mongoose

type FailurePoint =
  | 'after-block'
  | 'after-first-follow-removal'
  | 'after-follow-removals'
  | 'after-conversation'
  | 'after-follow'

const stateConflict = (currentState?: DirectState) =>
  new ApiProblem(409, 'DIRECT_STATE_CONFLICT', 'Conversation state changed', {
    ...(currentState ? { currentState } : {}),
  })

const unavailable = () =>
  new ApiProblem(403, 'DIRECT_UNAVAILABLE', 'Direct interaction is unavailable')

const notFound = () => new ApiProblem(404, 'RESOURCE_NOT_FOUND', 'Resource not found')

const requireDistinctUsers = (actorUserIdValue: string, targetUserIdValue: unknown) => {
  const actorUserId = requireObjectId(actorUserIdValue, 'user id')
  const targetUserId = requireObjectId(targetUserIdValue, 'target user id')
  return { actorUserId, targetUserId }
}

const loadContactInteraction = async (
  actorUserId: Types.ObjectId,
  targetUserId: Types.ObjectId,
): Promise<ContactInteractionDto> => {
  const context = await getContactAuthorizationContext(
    actorUserId.toString(),
    targetUserId.toString(),
  )
  const decision = evaluateContactAuthorization(context)
  if (!context.conversation) return serializeContactInteraction(decision)
  const conversation = await DirectConversation.findOne({
    participantKey: participantKey(actorUserId.toString(), targetUserId.toString()),
  })
    .select('_id')
    .lean()
  return serializeContactInteraction(
    decision,
    conversation
      ? { id: conversation._id.toString(), state: context.conversation.state }
      : undefined,
  )
}

const lifecycleUpdate = (
  state: 'unlocked' | 'declined' | 'revoked',
  now: Date,
  reason?: 'accept' | 'follow' | 'reply' | 'block',
) => {
  if (state === 'unlocked') {
    return {
      $set: { state, unlockedAt: now, unlockReason: reason },
      $unset: { declinedAt: 1, revokedAt: 1, revocationReason: 1 },
    }
  }
  if (state === 'declined') {
    return {
      $set: { state, declinedAt: now },
      $unset: { unlockedAt: 1, unlockReason: 1, revokedAt: 1, revocationReason: 1 },
    }
  }
  return {
    $set: { state, revokedAt: now, revocationReason: reason },
    $unset: { unlockedAt: 1, unlockReason: 1 },
  }
}

const loadConversationForActor = async (
  conversationId: Types.ObjectId,
  actorUserId: Types.ObjectId,
  session: ClientSession,
) => {
  const conversation = await DirectConversation.findOne({
    _id: conversationId,
    participantIds: actorUserId,
  }).session(session)
  if (!conversation) throw notFound()
  const targetUserId = conversation.participantIds.find((id) => !id.equals(actorUserId))
  if (!targetUserId) throw notFound()
  return { conversation, targetUserId }
}

export const resolvePendingContact = async (
  actorUserIdValue: string,
  conversationIdValue: unknown,
  resolution: 'accept' | 'decline',
) => {
  const actorUserId = requireObjectId(actorUserIdValue, 'user id')
  const conversationId = requireObjectId(conversationIdValue, 'conversation id')
  let resolvedConversation: unknown

  await connection.transaction(async (session) => {
    const { conversation, targetUserId } = await loadConversationForActor(
      conversationId,
      actorUserId,
      session,
    )
    const context = await getContactAuthorizationContextInSession(
      actorUserId.toString(),
      targetUserId.toString(),
      session,
    )
    const decision = evaluateContactAuthorization(context)
    const capability =
      resolution === 'accept' ? decision.capabilities.canAccept : decision.capabilities.canDecline
    if (!capability) {
      if (conversation.state !== 'pending') throw stateConflict(conversation.state)
      if (decision.isEffectivelyBlocked) throw unavailable()
      throw new ApiProblem(
        403,
        'DIRECT_NOT_REQUEST_RECIPIENT',
        'Only the request recipient may resolve it',
      )
    }

    const now = new Date()
    resolvedConversation = await DirectConversation.findOneAndUpdate(
      {
        _id: conversation._id,
        state: 'pending',
        initiatedByUserId: { $ne: actorUserId },
      },
      resolution === 'accept'
        ? lifecycleUpdate('unlocked', now, 'accept')
        : lifecycleUpdate('declined', now),
      { returnDocument: 'after', session },
    ).lean()
    if (!resolvedConversation) throw stateConflict()
  })

  return { conversation: resolvedConversation }
}

export const acceptMessageRequest = (actorUserId: string, conversationId: unknown) =>
  resolvePendingContact(actorUserId, conversationId, 'accept')

export const declineMessageRequest = (actorUserId: string, conversationId: unknown) =>
  resolvePendingContact(actorUserId, conversationId, 'decline')

export const followContact = async (
  actorUserIdValue: string,
  targetUserIdValue: unknown,
  failurePoint?: FailurePoint,
) => {
  const { actorUserId, targetUserId } = requireDistinctUsers(actorUserIdValue, targetUserIdValue)
  if (actorUserId.equals(targetUserId)) {
    throw new ApiProblem(400, 'FOLLOW_SELF_INVALID', 'You cannot follow yourself')
  }
  let result: { follow: unknown; unlockedConversation: unknown | null } | undefined

  await connection.transaction(async (session) => {
    await writeContactPairGuard(actorUserId.toString(), targetUserId.toString(), session)
    const context = await getContactAuthorizationContextInSession(
      actorUserId.toString(),
      targetUserId.toString(),
      session,
    )
    if (!context.targetExists) throw notFound()
    const decision = evaluateContactAuthorization(context)
    if (decision.isEffectivelyBlocked) throw unavailable()
    if (!decision.capabilities.canFollow) {
      throw new ApiProblem(409, 'FOLLOW_ALREADY_EXISTS', 'Already following this user')
    }

    const created = await Follow.create([{ followerId: actorUserId, followingId: targetUserId }], {
      session,
    })
    const follow = created[0]
    if (!follow) throw new Error('Follow creation failed')
    if (failurePoint === 'after-follow') throw new Error('Injected failure after follow')

    let unlockedConversation: unknown | null = null
    if (
      context.conversation?.state === 'pending' &&
      context.conversation.initiatedByUserId === targetUserId.toString()
    ) {
      unlockedConversation = await DirectConversation.findOneAndUpdate(
        {
          participantKey: participantKey(actorUserId.toString(), targetUserId.toString()),
          initiatedByUserId: targetUserId,
          state: 'pending',
        },
        lifecycleUpdate('unlocked', new Date(), 'follow'),
        { returnDocument: 'after', session },
      ).lean()
      if (!unlockedConversation) throw stateConflict()
    }
    result = { follow, unlockedConversation }
  })

  if (!result) throw new Error('Follow transaction produced no result')
  return result
}

export const unfollowContact = async (actorUserIdValue: string, targetUserIdValue: unknown) => {
  const { actorUserId, targetUserId } = requireDistinctUsers(actorUserIdValue, targetUserIdValue)
  if (actorUserId.equals(targetUserId)) return { deleted: false }
  let deleted = false
  await connection.transaction(async (session) => {
    await writeContactPairGuard(actorUserId.toString(), targetUserId.toString(), session)
    const result = await Follow.deleteOne(
      { followerId: actorUserId, followingId: targetUserId },
      { session },
    )
    deleted = result.deletedCount === 1
  })
  return { deleted }
}

export const blockContact = async (
  actorUserIdValue: string,
  targetUserIdValue: unknown,
  failurePoint?: FailurePoint,
) => {
  const { actorUserId, targetUserId } = requireDistinctUsers(actorUserIdValue, targetUserIdValue)
  if (actorUserId.equals(targetUserId)) {
    throw new ApiProblem(400, 'BLOCK_SELF_INVALID', 'You cannot block yourself')
  }
  let result:
    { created: boolean; conversation: unknown | null; lifecycleChanged: boolean } | undefined

  await connection.transaction(async (session) => {
    await writeContactPairGuard(actorUserId.toString(), targetUserId.toString(), session)
    if (!(await User.exists({ _id: targetUserId }).session(session))) throw notFound()

    const blockResult = await UserBlock.updateOne(
      { blockerUserId: actorUserId, blockedUserId: targetUserId },
      { $setOnInsert: { blockerUserId: actorUserId, blockedUserId: targetUserId } },
      { upsert: true, session },
    )
    if (failurePoint === 'after-block') throw new Error('Injected failure after block')
    await Follow.deleteOne({ followerId: actorUserId, followingId: targetUserId }, { session })
    if (failurePoint === 'after-first-follow-removal') {
      throw new Error('Injected failure after first follow removal')
    }
    await Follow.deleteOne({ followerId: targetUserId, followingId: actorUserId }, { session })
    if (failurePoint === 'after-follow-removals') {
      throw new Error('Injected failure after follow removals')
    }

    const key = participantKey(actorUserId.toString(), targetUserId.toString())
    const current = await DirectConversation.findOne({ participantKey: key }).session(session)
    let conversation: unknown | null = current
    const lifecycleChanged = Boolean(
      current && (current.state === 'pending' || current.state === 'unlocked'),
    )
    if (current && (current.state === 'pending' || current.state === 'unlocked')) {
      conversation = await DirectConversation.findOneAndUpdate(
        { _id: current._id, state: current.state },
        lifecycleUpdate('revoked', new Date(), 'block'),
        { returnDocument: 'after', session },
      ).lean()
      if (!conversation) throw stateConflict()
    }
    if (failurePoint === 'after-conversation') {
      throw new Error('Injected failure after conversation')
    }
    result = { created: blockResult.upsertedCount === 1, conversation, lifecycleChanged }
  })

  if (!result) throw new Error('Block transaction produced no result')
  return {
    ...result,
    contactInteraction: await loadContactInteraction(actorUserId, targetUserId),
  }
}

export const unblockContact = async (actorUserIdValue: string, targetUserIdValue: unknown) => {
  const { actorUserId, targetUserId } = requireDistinctUsers(actorUserIdValue, targetUserIdValue)
  if (actorUserId.equals(targetUserId)) {
    throw new ApiProblem(400, 'BLOCK_SELF_INVALID', 'You cannot unblock yourself')
  }

  await connection.transaction(async (session) => {
    await writeContactPairGuard(actorUserId.toString(), targetUserId.toString(), session)
    const deleted = await UserBlock.deleteOne(
      { blockerUserId: actorUserId, blockedUserId: targetUserId },
      { session },
    )
    if (deleted.deletedCount !== 1) {
      throw new ApiProblem(409, 'BLOCK_NOT_OWNED', 'You do not own this Block')
    }
  })

  return {
    unblocked: true,
    contactInteraction: await loadContactInteraction(actorUserId, targetUserId),
  }
}

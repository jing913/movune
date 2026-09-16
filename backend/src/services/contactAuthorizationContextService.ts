import type { ClientSession } from 'mongoose'
import { DirectConversation } from '../models/directConversationModel.js'
import { Follow } from '../models/followModel.js'
import { UserBlock } from '../models/userBlockModel.js'
import { User } from '../models/userModel.js'
import {
  type ContactAuthorizationContext,
  type MessageRequestPreference,
  type NormalizedMessageRequestPreference,
} from '../utils/contactAuthorizationPolicy.js'
import { participantKey } from '../utils/messagingPolicy.js'

type BlockRecord = Readonly<{
  blockerUserId: string
  blockedUserId: string
}>

type ConversationRecord = ContactAuthorizationContext['conversation']

type TargetRecord = Readonly<{
  messageRequestPreference?: unknown
}>

export type ContactAuthorizationReaders = Readonly<{
  findBlocks: (actorUserId: string, targetUserId: string) => Promise<readonly BlockRecord[]>
  findConversation: (key: string) => Promise<ConversationRecord>
  hasFollow: (followerUserId: string, followingUserId: string) => Promise<boolean>
  findTarget: (targetUserId: string) => Promise<TargetRecord | null>
}>

export const normalizeMessageRequestPreference = (
  value: unknown,
): NormalizedMessageRequestPreference => {
  if (value === undefined) return 'all_members'
  if (value === 'all_members' || value === 'followed_members') return value
  return 'invalid'
}

const createMongooseReaders = (session?: ClientSession): ContactAuthorizationReaders => ({
  findBlocks: async (actorUserId, targetUserId) => {
    const query = UserBlock.find({
      $or: [
        { blockerUserId: actorUserId, blockedUserId: targetUserId },
        { blockerUserId: targetUserId, blockedUserId: actorUserId },
      ],
    })
      .select('blockerUserId blockedUserId')
      .lean()
    if (session) query.session(session)
    const blocks = await query
    return blocks.map((block) => ({
      blockerUserId: block.blockerUserId.toString(),
      blockedUserId: block.blockedUserId.toString(),
    }))
  },
  findConversation: async (key) => {
    const query = DirectConversation.findOne({ participantKey: key })
      .select('state initiatedByUserId')
      .lean()
    if (session) query.session(session)
    const conversation = await query
    return conversation
      ? {
          state: conversation.state,
          initiatedByUserId: conversation.initiatedByUserId.toString(),
        }
      : null
  },
  hasFollow: async (followerUserId, followingUserId) => {
    const query = Follow.exists({ followerId: followerUserId, followingId: followingUserId })
    if (session) query.session(session)
    return Boolean(await query)
  },
  findTarget: async (targetUserId) => {
    const query = User.findById(targetUserId).select('messageRequestPreference').lean()
    if (session) query.session(session)
    const target = await query
    return target
      ? { messageRequestPreference: target.messageRequestPreference as MessageRequestPreference }
      : null
  },
})

export const getContactAuthorizationContext = async (
  actorUserId: string,
  targetUserId: string,
  readers: ContactAuthorizationReaders = createMongooseReaders(),
): Promise<ContactAuthorizationContext> => {
  if (actorUserId === targetUserId) {
    return {
      actorUserId,
      targetUserId,
      targetExists: true,
      actorBlocksTarget: false,
      targetBlocksActor: false,
      actorFollowsTarget: false,
      targetFollowsActor: false,
      targetMessageRequestPreference: 'invalid',
      conversation: null,
    }
  }

  const key = participantKey(actorUserId, targetUserId)
  // Keep these reads serial so this loader is safe to use with a MongoDB transaction session.
  const blocks = await readers.findBlocks(actorUserId, targetUserId)
  const conversation = await readers.findConversation(key)
  const actorFollowsTarget = await readers.hasFollow(actorUserId, targetUserId)
  const targetFollowsActor = await readers.hasFollow(targetUserId, actorUserId)
  const target = await readers.findTarget(targetUserId)

  return {
    actorUserId,
    targetUserId,
    targetExists: target !== null,
    actorBlocksTarget: blocks.some(
      (block) => block.blockerUserId === actorUserId && block.blockedUserId === targetUserId,
    ),
    targetBlocksActor: blocks.some(
      (block) => block.blockerUserId === targetUserId && block.blockedUserId === actorUserId,
    ),
    actorFollowsTarget,
    targetFollowsActor,
    targetMessageRequestPreference:
      target === null
        ? 'invalid'
        : normalizeMessageRequestPreference(target.messageRequestPreference),
    conversation,
  }
}

export const getContactAuthorizationContextInSession = (
  actorUserId: string,
  targetUserId: string,
  session: ClientSession,
) => getContactAuthorizationContext(actorUserId, targetUserId, createMongooseReaders(session))

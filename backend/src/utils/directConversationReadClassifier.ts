import type { DirectState } from '../models/directConversationModel.js'
import {
  evaluateContactAuthorization,
  type ContactAuthorizationContext,
} from './contactAuthorizationPolicy.js'

export type DirectConversationReadBucket = 'conversations' | 'requests' | 'ended'

export type DirectConversationReadClassification = Readonly<{
  interactionState: ReturnType<typeof evaluateContactAuthorization>['interactionState']
  bucket: DirectConversationReadBucket
  capabilities: Readonly<{
    canSendMessage: boolean
    canCreateMessageRequest: boolean
    canAccept: boolean
    canDecline: boolean
    canFollowUser: boolean
    canBlockUser: boolean
    canUnblockUser: boolean
  }>
  shouldRenderSharedContext: boolean
  isActionableIncomingRequest: boolean
}>

const lifecycleBucket = (state: DirectState): DirectConversationReadBucket => {
  if (state === 'unlocked') return 'conversations'
  if (state === 'pending') return 'requests'
  return 'ended'
}

export const classifyDirectConversationRead = (
  context: ContactAuthorizationContext,
  hasDisclosureSafeSharedContext: boolean,
): DirectConversationReadClassification => {
  if (!context.conversation) {
    throw new Error('Direct Conversation read classification requires a persisted conversation')
  }
  const decision = evaluateContactAuthorization(context)
  const bucket = decision.isEffectivelyBlocked
    ? 'ended'
    : lifecycleBucket(context.conversation.state)

  return {
    interactionState: decision.interactionState,
    bucket,
    capabilities: {
      canSendMessage: decision.capabilities.canSendMessage,
      canCreateMessageRequest: decision.capabilities.canCreateMessageRequest,
      canAccept: decision.capabilities.canAccept,
      canDecline: decision.capabilities.canDecline,
      canFollowUser: decision.capabilities.canFollow,
      canBlockUser: decision.capabilities.canBlock,
      canUnblockUser: decision.capabilities.canUnblock,
    },
    shouldRenderSharedContext:
      !decision.isEffectivelyBlocked &&
      (context.conversation.state === 'pending' || context.conversation.state === 'unlocked') &&
      hasDisclosureSafeSharedContext,
    isActionableIncomingRequest:
      bucket === 'requests' &&
      decision.interactionState === 'pending_incoming' &&
      decision.capabilities.canAccept &&
      decision.capabilities.canDecline,
  }
}

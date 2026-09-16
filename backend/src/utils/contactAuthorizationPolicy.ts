import type { DirectState } from '../models/directConversationModel.js'

export type MessageRequestPreference = 'all_members' | 'followed_members'
export type NormalizedMessageRequestPreference = MessageRequestPreference | 'invalid'

export type ContactInteractionState =
  | 'none'
  | 'direct_allowed'
  | 'request_allowed'
  | 'pending_outgoing'
  | 'pending_incoming'
  | 'declined'
  | 'unlocked'
  | 'blocked'
  | 'revoked_unavailable'

export type ContactAuthorizationReason =
  | 'self_target_invalid'
  | 'target_unavailable'
  | 'blocked'
  | 'existing_unlocked'
  | 'receiver_follows_actor'
  | 'receiver_allows_requests'
  | 'receiver_restricts_requests'
  | 'invalid_preference_fail_closed'
  | 'pending_initiator_waiting'
  | 'pending_receiver_can_resolve'
  | 'declined_request_suppressed'
  | 'revoked_requires_reauthorization'
  | 'already_following'
  | 'follow_available'
  | 'actor_owned_block'
  | 'block_available'
  | 'not_block_owner'
  | 'report_allowed'
  | 'direct_social_allowed'
  | 'distribution_allowed'

export type ContactAuthorizationContext = Readonly<{
  actorUserId: string
  targetUserId: string
  targetExists: boolean
  actorBlocksTarget: boolean
  targetBlocksActor: boolean
  actorFollowsTarget: boolean
  targetFollowsActor: boolean
  targetMessageRequestPreference: NormalizedMessageRequestPreference
  conversation: Readonly<{
    state: DirectState
    initiatedByUserId: string
  }> | null
}>

export type ContactAuthorizationCapabilities = Readonly<{
  canSendMessage: boolean
  canCreateMessageRequest: boolean
  canAccept: boolean
  canDecline: boolean
  canFollow: boolean
  canBlock: boolean
  canUnblock: boolean
  canReportUser: boolean
  mayAccessDirectSocialSurface: boolean
  mayDistributeUser: boolean
}>

export type ContactAuthorizationDecision = Readonly<{
  interactionState: ContactInteractionState
  reason: ContactAuthorizationReason
  isFollowing: boolean
  actorBlocksTarget: boolean
  targetBlocksActor: boolean
  isEffectivelyBlocked: boolean
  capabilities: ContactAuthorizationCapabilities
  capabilityReasons: Readonly<{
    follow: ContactAuthorizationReason
    block: ContactAuthorizationReason
    unblock: ContactAuthorizationReason
    reportUser: ContactAuthorizationReason
    directSocialSurface: ContactAuthorizationReason
    distribution: ContactAuthorizationReason
  }>
}>

type InteractionDecision = {
  interactionState: ContactInteractionState
  reason: ContactAuthorizationReason
  canSendMessage: boolean
  canCreateMessageRequest: boolean
  canAccept: boolean
  canDecline: boolean
}

const deniedInteraction = (
  interactionState: ContactInteractionState,
  reason: ContactAuthorizationReason,
): InteractionDecision => ({
  interactionState,
  reason,
  canSendMessage: false,
  canCreateMessageRequest: false,
  canAccept: false,
  canDecline: false,
})

const directAllowed = (): InteractionDecision => ({
  interactionState: 'direct_allowed',
  reason: 'receiver_follows_actor',
  canSendMessage: true,
  canCreateMessageRequest: false,
  canAccept: false,
  canDecline: false,
})

const evaluateNewContactPermission = (
  context: ContactAuthorizationContext,
  unavailableState: 'none' | 'revoked_unavailable',
): InteractionDecision => {
  if (context.targetFollowsActor) return directAllowed()
  if (context.targetMessageRequestPreference === 'all_members') {
    return {
      interactionState: 'request_allowed',
      reason: 'receiver_allows_requests',
      canSendMessage: false,
      canCreateMessageRequest: true,
      canAccept: false,
      canDecline: false,
    }
  }
  if (context.targetMessageRequestPreference === 'invalid') {
    return deniedInteraction(unavailableState, 'invalid_preference_fail_closed')
  }
  return deniedInteraction(
    unavailableState,
    unavailableState === 'revoked_unavailable'
      ? 'revoked_requires_reauthorization'
      : 'receiver_restricts_requests',
  )
}

const evaluateInteraction = (context: ContactAuthorizationContext): InteractionDecision => {
  const conversation = context.conversation
  if (!conversation) return evaluateNewContactPermission(context, 'none')

  if (conversation.state === 'unlocked') {
    return {
      interactionState: 'unlocked',
      reason: 'existing_unlocked',
      canSendMessage: true,
      canCreateMessageRequest: false,
      canAccept: false,
      canDecline: false,
    }
  }

  if (conversation.state === 'pending') {
    const isInitiator = conversation.initiatedByUserId === context.actorUserId
    if (isInitiator) {
      return {
        interactionState: 'pending_outgoing',
        reason: context.targetFollowsActor ? 'receiver_follows_actor' : 'pending_initiator_waiting',
        canSendMessage: context.targetFollowsActor,
        canCreateMessageRequest: false,
        canAccept: false,
        canDecline: false,
      }
    }
    return {
      interactionState: 'pending_incoming',
      reason: 'pending_receiver_can_resolve',
      canSendMessage: true,
      canCreateMessageRequest: false,
      canAccept: true,
      canDecline: true,
    }
  }

  if (conversation.state === 'declined') {
    const isOriginalInitiator = conversation.initiatedByUserId === context.actorUserId
    return isOriginalInitiator && context.targetFollowsActor
      ? directAllowed()
      : deniedInteraction('declined', 'declined_request_suppressed')
  }

  return evaluateNewContactPermission(context, 'revoked_unavailable')
}

export const evaluateContactAuthorization = (
  context: ContactAuthorizationContext,
): ContactAuthorizationDecision => {
  const isSelfTarget = context.actorUserId === context.targetUserId
  const isEffectivelyBlocked = context.actorBlocksTarget || context.targetBlocksActor

  if (isSelfTarget || !context.targetExists || isEffectivelyBlocked) {
    const reason: ContactAuthorizationReason = isSelfTarget
      ? 'self_target_invalid'
      : !context.targetExists
        ? 'target_unavailable'
        : 'blocked'
    const interactionState: ContactInteractionState = isEffectivelyBlocked ? 'blocked' : 'none'
    const canReportUser = !isSelfTarget && context.targetExists
    const canBlock = !isSelfTarget && context.targetExists && !context.actorBlocksTarget
    const canUnblock = !isSelfTarget && context.actorBlocksTarget

    return {
      interactionState,
      reason,
      isFollowing: context.actorFollowsTarget,
      actorBlocksTarget: context.actorBlocksTarget,
      targetBlocksActor: context.targetBlocksActor,
      isEffectivelyBlocked,
      capabilities: {
        canSendMessage: false,
        canCreateMessageRequest: false,
        canAccept: false,
        canDecline: false,
        canFollow: false,
        canBlock,
        canUnblock,
        canReportUser,
        mayAccessDirectSocialSurface: false,
        mayDistributeUser: false,
      },
      capabilityReasons: {
        follow: reason,
        block: canBlock ? 'block_available' : reason,
        unblock: canUnblock ? 'actor_owned_block' : 'not_block_owner',
        reportUser: canReportUser ? 'report_allowed' : reason,
        directSocialSurface: reason,
        distribution: reason,
      },
    }
  }

  const interaction = evaluateInteraction(context)
  const canFollow = !context.actorFollowsTarget

  return {
    interactionState: interaction.interactionState,
    reason: interaction.reason,
    isFollowing: context.actorFollowsTarget,
    actorBlocksTarget: false,
    targetBlocksActor: false,
    isEffectivelyBlocked: false,
    capabilities: {
      canSendMessage: interaction.canSendMessage,
      canCreateMessageRequest: interaction.canCreateMessageRequest,
      canAccept: interaction.canAccept,
      canDecline: interaction.canDecline,
      canFollow,
      canBlock: true,
      canUnblock: false,
      canReportUser: true,
      mayAccessDirectSocialSurface: true,
      mayDistributeUser: true,
    },
    capabilityReasons: {
      follow: canFollow ? 'follow_available' : 'already_following',
      block: 'block_available',
      unblock: 'not_block_owner',
      reportUser: 'report_allowed',
      directSocialSurface: 'direct_social_allowed',
      distribution: 'distribution_allowed',
    },
  }
}

export type DirectMessageReportContext = Readonly<{
  actorUserId: string
  messageSenderUserId: string
  hasEligibleDirectHistory: boolean
}>

export const mayReportDirectMessage = (
  context: DirectMessageReportContext,
): Readonly<{
  allowed: boolean
  reason: 'report_allowed' | 'self_authored_message' | 'message_history_unavailable'
}> => {
  if (context.actorUserId === context.messageSenderUserId) {
    return { allowed: false, reason: 'self_authored_message' }
  }
  if (!context.hasEligibleDirectHistory) {
    return { allowed: false, reason: 'message_history_unavailable' }
  }
  return { allowed: true, reason: 'report_allowed' }
}

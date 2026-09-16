import type {
  ContactAuthorizationDecision,
  ContactInteractionState,
} from '../utils/contactAuthorizationPolicy.js'
import type { DirectState } from '../models/directConversationModel.js'

export type ContactInteractionDto = Readonly<{
  interactionState: ContactInteractionState
  capabilities: Readonly<{
    canSendMessage: boolean
    canCreateMessageRequest: boolean
    canFollowUser: boolean
    canBlockUser: boolean
    canUnblockUser: boolean
    canReportUser: boolean
  }>
  conversation?: Readonly<{
    id: string
    state: DirectState
  }>
}>

type ConversationProjection = Readonly<{
  id: string
  state: DirectState
}>

export const serializeContactInteraction = (
  decision: ContactAuthorizationDecision,
  conversation?: ConversationProjection,
): ContactInteractionDto => ({
  interactionState: decision.interactionState,
  capabilities: {
    canSendMessage: decision.capabilities.canSendMessage,
    canCreateMessageRequest: decision.capabilities.canCreateMessageRequest,
    canFollowUser: decision.capabilities.canFollow,
    canBlockUser: decision.capabilities.canBlock,
    canUnblockUser: decision.capabilities.canUnblock,
    canReportUser: decision.capabilities.canReportUser,
  },
  ...(conversation ? { conversation: { id: conversation.id, state: conversation.state } } : {}),
})

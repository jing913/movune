import type { ContactAuthorizationContext } from '../utils/contactAuthorizationPolicy.js'
import { evaluateContactAuthorization } from '../utils/contactAuthorizationPolicy.js'
import { ApiProblem } from '../utils/messagingPolicy.js'
import { UserBlock } from '../models/userBlockModel.js'
import { getContactAuthorizationContext } from './contactAuthorizationContextService.js'

type ContactContextLoader = (
  viewerUserId: string,
  targetUserId: string,
) => Promise<ContactAuthorizationContext>

type BlockRecord = Readonly<{
  blockerUserId: { toString(): string }
  blockedUserId: { toString(): string }
}>

type EffectiveBlockLoader = (viewerUserId: string) => Promise<readonly BlockRecord[]>

const findEffectiveBlocks: EffectiveBlockLoader = (viewerUserId) =>
  UserBlock.find({
    $or: [{ blockerUserId: viewerUserId }, { blockedUserId: viewerUserId }],
  })
    .select('blockerUserId blockedUserId')
    .lean()

export const loadEffectiveBlockedUserIds = async (
  viewerUserId: { toString(): string },
  loadBlocks: EffectiveBlockLoader = findEffectiveBlocks,
) => {
  const viewerId = viewerUserId.toString()
  const counterpartIds = new Set<string>()

  for (const block of await loadBlocks(viewerId)) {
    const blockerId = block.blockerUserId.toString()
    const blockedId = block.blockedUserId.toString()
    if (blockerId === viewerId && blockedId !== viewerId) counterpartIds.add(blockedId)
    if (blockedId === viewerId && blockerId !== viewerId) counterpartIds.add(blockerId)
  }

  return counterpartIds
}

export const memberSocialResourceNotFound = () =>
  new ApiProblem(404, 'RESOURCE_NOT_FOUND', 'Resource not found')

export const assertMemberSocialPairAccess = async (
  viewerUserId: string,
  targetUserId: string,
  loadContext: ContactContextLoader = getContactAuthorizationContext,
) => {
  if (viewerUserId === targetUserId) return

  const context = await loadContext(viewerUserId, targetUserId)
  const decision = evaluateContactAuthorization(context)
  if (!context.targetExists || !decision.capabilities.mayAccessDirectSocialSurface) {
    throw memberSocialResourceNotFound()
  }
}

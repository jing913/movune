import type { NextFunction, Request, Response } from 'express'
import { isObjectIdOrHexString } from 'mongoose'
import { blockContact, unblockContact } from '../services/contactMutationService.js'
import { publishDirectUpdated, publishRelationshipUpdated } from '../services/realtimeService.js'
import { invalidInput } from '../utils/messagingPolicy.js'

type BlockParams = {
  userId: string
}

const actorId = (req: Request) => {
  if (!req.user) throw new Error('Authentication middleware invariant failed')
  return req.user._id.toString()
}

const targetId = (req: Request<BlockParams>) => {
  if (!isObjectIdOrHexString(req.params.userId)) throw invalidInput('userId')
  return req.params.userId
}

const handler =
  (
    mutation: (
      actorUserId: string,
      targetUserId: string,
    ) => Promise<{
      contactInteraction: unknown
      lifecycleChanged?: boolean
      conversation?: unknown | null
    }>,
  ) =>
  async (req: Request<BlockParams>, res: Response, next: NextFunction) => {
    try {
      const actorUserId = actorId(req)
      const targetUserId = targetId(req)
      const result = await mutation(actorUserId, targetUserId)
      publishRelationshipUpdated(actorUserId, targetUserId)
      if (result.lifecycleChanged && result.conversation) {
        const conversation = result.conversation as {
          _id: { toString(): string }
          participantIds: Array<{ toString(): string }>
        }
        publishDirectUpdated(
          conversation.participantIds.map((participantId) => participantId.toString()),
          conversation._id.toString(),
        )
      }
      const { contactInteraction } = result
      return res.status(200).json({ contactInteraction })
    } catch (error) {
      next(error)
    }
  }

export const blockUser = handler(blockContact)
export const unblockUser = handler(unblockContact)

import type { ClientSession } from 'mongoose'
import { ContactPairGuard } from '../models/contactPairGuardModel.js'
import { participantKey } from '../utils/messagingPolicy.js'

export const writeContactPairGuard = async (
  firstUserId: string,
  secondUserId: string,
  session: ClientSession,
) => {
  const key = participantKey(firstUserId, secondUserId)
  const guard = await ContactPairGuard.findOneAndUpdate(
    { participantKey: key },
    {
      $inc: { revision: 1 },
      $setOnInsert: { participantKey: key },
    },
    {
      upsert: true,
      returnDocument: 'after',
      setDefaultsOnInsert: true,
      session,
    },
  ).lean()

  if (!guard) throw new Error('Contact pair coordination failed')
  return { participantKey: key, revision: guard.revision }
}

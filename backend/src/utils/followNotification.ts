import { Notification } from '../models/notificationModel.js'
import type { Types } from 'mongoose'

type FollowNotificationInput = {
  recipientId: string | Types.ObjectId
  actorId: string | Types.ObjectId
  type: 'follow'
}

type PersistedNotification = { _id: { toString(): string } }
type CreateNotification = (input: FollowNotificationInput) => Promise<unknown>
type ReportFailure = (error: unknown) => void

const createNotification: CreateNotification = (input) => Notification.create(input)
const reportFailure: ReportFailure = (error) => {
  console.error('Failed to persist Follow notification', error)
}

export async function persistFollowNotification(
  input: FollowNotificationInput,
  create: CreateNotification = createNotification,
  report: ReportFailure = reportFailure,
): Promise<PersistedNotification | null> {
  try {
    const notification = await create(input)
    if (
      typeof notification === 'object' &&
      notification !== null &&
      '_id' in notification &&
      notification._id &&
      typeof (notification._id as { toString?: unknown }).toString === 'function'
    ) {
      return notification as PersistedNotification
    }
  } catch (error) {
    report(error)
  }
  return null
}

import { isObjectIdOrHexString, Types } from 'mongoose'

export const NOTIFICATION_DEFAULT_LIMIT = 20
export const NOTIFICATION_MAX_LIMIT = 50
export const notificationSort = { createdAt: -1, _id: -1 } as const

export class NotificationInputError extends Error {}

export type NotificationCursor = {
  createdAt: Date
  id: string
}

export const parseNotificationLimit = (value: unknown) => {
  if (value === undefined) return NOTIFICATION_DEFAULT_LIMIT
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new NotificationInputError('Invalid notification limit')
  }

  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > NOTIFICATION_MAX_LIMIT) {
    throw new NotificationInputError('Notification limit must be between 1 and 50')
  }

  return limit
}

export const encodeNotificationCursor = (cursor: NotificationCursor) =>
  Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url')

export const decodeNotificationCursor = (value: unknown): NotificationCursor | null => {
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new NotificationInputError('Invalid notification cursor')
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('createdAt' in parsed) ||
      !('id' in parsed) ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      !isObjectIdOrHexString(parsed.id)
    ) {
      throw new NotificationInputError('Invalid notification cursor')
    }

    const createdAt = new Date(parsed.createdAt)
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== parsed.createdAt) {
      throw new NotificationInputError('Invalid notification cursor')
    }

    return { createdAt, id: parsed.id }
  } catch (error) {
    if (error instanceof NotificationInputError) throw error
    throw new NotificationInputError('Invalid notification cursor')
  }
}

export const buildNotificationCursorFilter = (cursor: NotificationCursor | null) =>
  cursor
    ? {
        $or: [
          { createdAt: { $lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, _id: { $lt: new Types.ObjectId(cursor.id) } },
        ],
      }
    : {}

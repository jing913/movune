import { isObjectIdOrHexString, Types } from 'mongoose'
import {
  ANNOUNCEMENT_CATEGORIES,
  type AnnouncementCategory,
} from '../policies/announcementLifecyclePolicy.js'
import { ApiProblem } from './messagingPolicy.js'

export const ANNOUNCEMENT_PUBLIC_DEFAULT_LIMIT = 20
export const ANNOUNCEMENT_PUBLIC_MAX_LIMIT = 50
export const announcementPublicSort = { publishedAt: -1, _id: -1 } as const

export type AnnouncementPublicCursor = Readonly<{
  publishedAt: Date
  id: string
}>

const problem = (code: string, message: string) => new ApiProblem(400, code, message)

export const parseAnnouncementCategory = (value: unknown): AnnouncementCategory | undefined => {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    !(ANNOUNCEMENT_CATEGORIES as readonly string[]).includes(value)
  ) {
    throw problem('ANNOUNCEMENT_CATEGORY_INVALID', 'Announcement category is invalid')
  }
  return value as AnnouncementCategory
}

export const parseAnnouncementPublicLimit = (value: unknown) => {
  if (value === undefined) return ANNOUNCEMENT_PUBLIC_DEFAULT_LIMIT
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw problem('ANNOUNCEMENT_LIMIT_INVALID', 'Announcement limit is invalid')
  }
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > ANNOUNCEMENT_PUBLIC_MAX_LIMIT) {
    throw problem('ANNOUNCEMENT_LIMIT_INVALID', 'Announcement limit is invalid')
  }
  return limit
}

export const encodeAnnouncementPublicCursor = (cursor: AnnouncementPublicCursor) =>
  Buffer.from(
    JSON.stringify({ publishedAt: cursor.publishedAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url')

export const decodeAnnouncementPublicCursor = (value: unknown): AnnouncementPublicCursor | null => {
  if (value === undefined) return null
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw problem('ANNOUNCEMENT_CURSOR_INVALID', 'Announcement cursor is invalid')
  }

  try {
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) throw new Error()
    const parsed: unknown = JSON.parse(decoded.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error()
    const keys = Object.keys(parsed)
    if (
      keys.length !== 2 ||
      !keys.includes('publishedAt') ||
      !keys.includes('id') ||
      !('publishedAt' in parsed) ||
      !('id' in parsed) ||
      typeof parsed.publishedAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      !isObjectIdOrHexString(parsed.id)
    ) {
      throw new Error()
    }
    const publishedAt = new Date(parsed.publishedAt)
    if (
      !Number.isFinite(publishedAt.valueOf()) ||
      publishedAt.toISOString() !== parsed.publishedAt
    ) {
      throw new Error()
    }
    return { publishedAt, id: new Types.ObjectId(parsed.id).toHexString() }
  } catch (error) {
    if (error instanceof ApiProblem) throw error
    throw problem('ANNOUNCEMENT_CURSOR_INVALID', 'Announcement cursor is invalid')
  }
}

export const buildAnnouncementPublicCursorFilter = (cursor: AnnouncementPublicCursor | null) =>
  cursor
    ? {
        $or: [
          { publishedAt: { $lt: cursor.publishedAt } },
          {
            publishedAt: cursor.publishedAt,
            _id: { $lt: new Types.ObjectId(cursor.id) },
          },
        ],
      }
    : {}

export const parseAnnouncementPublicId = (value: unknown) => {
  if (typeof value !== 'string' || !isObjectIdOrHexString(value)) {
    throw problem('ANNOUNCEMENT_ID_INVALID', 'Announcement id is invalid')
  }
  return new Types.ObjectId(value).toHexString()
}

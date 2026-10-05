import { isObjectIdOrHexString, Types } from 'mongoose'
import { ApiProblem } from './messagingPolicy.js'

export const ANNOUNCEMENT_ADMIN_DEFAULT_LIMIT = 20
export const ANNOUNCEMENT_ADMIN_MAX_LIMIT = 50
export const announcementAdminSort = { updatedAt: -1, _id: -1 } as const

export type AnnouncementAdminCursor = Readonly<{ updatedAt: Date; id: string }>

export type AnnouncementCreateRequest = Readonly<{ category: unknown; priority: unknown }>
export type AnnouncementSaveRequest = Readonly<{
  expectedRevision: number
  category: unknown
  priority: unknown
  title?: unknown
  body?: unknown
  maintenance?: unknown
}>
export type AnnouncementDeleteRequest = Readonly<{ expectedRevision: number }>

const problem = (
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => new ApiProblem(status, code, message, details)

const requestProblem = () =>
  problem(400, 'ANNOUNCEMENT_REQUEST_INVALID', 'Announcement request is invalid')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactAllowedKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
) =>
  Object.keys(value).every((key) => allowed.includes(key)) &&
  required.every((key) => Object.hasOwn(value, key))

const requireRevision = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw requestProblem()
  return value
}

const normalizeMaintenanceDates = (value: unknown) => {
  if (!isRecord(value)) return value
  const normalized = { ...value }
  for (const field of ['startsAt', 'endsAt', 'actualCompletionTime'] as const) {
    if (typeof normalized[field] === 'string') {
      const date = new Date(normalized[field])
      if (Number.isFinite(date.valueOf()) && date.toISOString() === normalized[field]) {
        normalized[field] = date
      }
    }
  }
  return normalized
}

export const parseAnnouncementCreateRequest = (value: unknown): AnnouncementCreateRequest => {
  const allowed = ['category', 'priority'] as const
  if (!isRecord(value) || !hasExactAllowedKeys(value, allowed, allowed)) throw requestProblem()
  return { category: value.category, priority: value.priority }
}

export const parseAnnouncementSaveRequest = (value: unknown): AnnouncementSaveRequest => {
  const allowed = [
    'expectedRevision',
    'category',
    'priority',
    'title',
    'body',
    'maintenance',
  ] as const
  if (
    !isRecord(value) ||
    !hasExactAllowedKeys(value, allowed, ['expectedRevision', 'category', 'priority'])
  ) {
    throw requestProblem()
  }
  return {
    expectedRevision: requireRevision(value.expectedRevision),
    category: value.category,
    priority: value.priority,
    ...(Object.hasOwn(value, 'title') ? { title: value.title } : {}),
    ...(Object.hasOwn(value, 'body') ? { body: value.body } : {}),
    ...(Object.hasOwn(value, 'maintenance')
      ? { maintenance: normalizeMaintenanceDates(value.maintenance) }
      : {}),
  }
}

export const parseAnnouncementDeleteRequest = (value: unknown): AnnouncementDeleteRequest => {
  if (!isRecord(value) || !hasExactAllowedKeys(value, ['expectedRevision'], ['expectedRevision'])) {
    throw requestProblem()
  }
  return { expectedRevision: requireRevision(value.expectedRevision) }
}

export const parseAnnouncementAdminLimit = (value: unknown) => {
  if (value === undefined) return ANNOUNCEMENT_ADMIN_DEFAULT_LIMIT
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw problem(400, 'ANNOUNCEMENT_ADMIN_LIMIT_INVALID', 'Announcement admin limit is invalid')
  }
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > ANNOUNCEMENT_ADMIN_MAX_LIMIT) {
    throw problem(400, 'ANNOUNCEMENT_ADMIN_LIMIT_INVALID', 'Announcement admin limit is invalid')
  }
  return limit
}

export const encodeAnnouncementAdminCursor = (cursor: AnnouncementAdminCursor) =>
  Buffer.from(
    JSON.stringify({ updatedAt: cursor.updatedAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url')

export const decodeAnnouncementAdminCursor = (value: unknown): AnnouncementAdminCursor | null => {
  if (value === undefined) return null
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw problem(400, 'ANNOUNCEMENT_ADMIN_CURSOR_INVALID', 'Announcement admin cursor is invalid')
  }
  try {
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) throw new Error()
    const parsed: unknown = JSON.parse(decoded.toString('utf8'))
    if (!isRecord(parsed) || Object.keys(parsed).length !== 2) throw new Error()
    if (
      !Object.hasOwn(parsed, 'updatedAt') ||
      !Object.hasOwn(parsed, 'id') ||
      typeof parsed.updatedAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      !isObjectIdOrHexString(parsed.id)
    ) {
      throw new Error()
    }
    const updatedAt = new Date(parsed.updatedAt)
    if (!Number.isFinite(updatedAt.valueOf()) || updatedAt.toISOString() !== parsed.updatedAt) {
      throw new Error()
    }
    return { updatedAt, id: new Types.ObjectId(parsed.id).toHexString() }
  } catch {
    throw problem(400, 'ANNOUNCEMENT_ADMIN_CURSOR_INVALID', 'Announcement admin cursor is invalid')
  }
}

export const parseAnnouncementAdminQuery = (value: unknown) => {
  if (!isRecord(value) || Object.keys(value).some((key) => !['limit', 'cursor'].includes(key))) {
    throw requestProblem()
  }
  return {
    limit: parseAnnouncementAdminLimit(value.limit),
    cursor: decodeAnnouncementAdminCursor(value.cursor),
  }
}

export const buildAnnouncementAdminCursorFilter = (cursor: AnnouncementAdminCursor | null) =>
  cursor
    ? {
        $or: [
          { updatedAt: { $lt: cursor.updatedAt } },
          { updatedAt: cursor.updatedAt, _id: { $lt: new Types.ObjectId(cursor.id) } },
        ],
      }
    : {}

export const parseAnnouncementAdminId = (value: unknown) => {
  if (typeof value !== 'string' || !isObjectIdOrHexString(value)) {
    throw problem(400, 'ANNOUNCEMENT_ID_INVALID', 'Announcement id is invalid')
  }
  return new Types.ObjectId(value).toHexString()
}

export const announcementPermissionDenied = () =>
  problem(403, 'ANNOUNCEMENT_PERMISSION_DENIED', 'Announcement permission denied')

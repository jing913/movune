import { Types, isObjectIdOrHexString } from 'mongoose'

export const MESSAGE_MAX_LENGTH = 1000
export const MESSAGE_PAGE_SIZE = 30
export const MESSAGE_PAGE_MAX = 100

export class ApiProblem extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export const invalidInput = (field: string) =>
  new ApiProblem(400, 'INVALID_INPUT', 'Invalid request input.', { field })

export const participantKey = (first: string, second: string) =>
  [first, second].map(String).sort().join(':')

export const requireObjectId = (value: unknown, name = 'id') => {
  if (typeof value !== 'string' || !isObjectIdOrHexString(value)) {
    throw new ApiProblem(400, 'MESSAGE_INVALID', `Invalid ${name}`)
  }
  return new Types.ObjectId(value)
}

export const normalizeMessageContent = (value: unknown) => {
  if (typeof value !== 'string')
    throw new ApiProblem(400, 'MESSAGE_INVALID', 'Message must be text')
  const content = value.replace(/\r\n/g, '\n').trim()
  if (!content) throw new ApiProblem(400, 'MESSAGE_EMPTY', 'Message cannot be empty')
  if ([...content].length > MESSAGE_MAX_LENGTH) {
    throw new ApiProblem(
      400,
      'MESSAGE_TOO_LONG',
      `Message cannot exceed ${MESSAGE_MAX_LENGTH} characters`,
    )
  }
  return content
}

export type MessageCursor = { createdAt: Date; id: Types.ObjectId }

export const encodeMessageCursor = (cursor: MessageCursor) =>
  Buffer.from(JSON.stringify([cursor.createdAt.toISOString(), cursor.id.toString()])).toString(
    'base64url',
  )

export const decodeMessageCursor = (value: unknown): MessageCursor | null => {
  if (value === undefined) return null
  if (typeof value !== 'string') throw new ApiProblem(400, 'MESSAGE_INVALID', 'Invalid cursor')
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string')
      throw new Error()
    const createdAt = new Date(parsed[0])
    if (Number.isNaN(createdAt.valueOf()) || !isObjectIdOrHexString(parsed[1])) throw new Error()
    return { createdAt, id: new Types.ObjectId(String(parsed[1])) }
  } catch {
    throw new ApiProblem(400, 'MESSAGE_INVALID', 'Invalid cursor')
  }
}

export const cursorFilter = (cursor: MessageCursor, direction: 'before' | 'after') => {
  const operator = direction === 'before' ? '$lt' : '$gt'
  return {
    $or: [
      { createdAt: { [operator]: cursor.createdAt } },
      { createdAt: cursor.createdAt, _id: { [operator]: cursor.id } },
    ],
  }
}

export const parseLimit = (value: unknown) => {
  if (value === undefined) return MESSAGE_PAGE_SIZE
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MESSAGE_PAGE_MAX) {
    throw new ApiProblem(400, 'MESSAGE_INVALID', 'Invalid limit')
  }
  return limit
}

export const isAfter = (
  candidate: { createdAt: Date; id: Types.ObjectId },
  current?: { createdAt?: Date | null; id?: Types.ObjectId | null },
) =>
  !current?.createdAt ||
  candidate.createdAt > current.createdAt ||
  (candidate.createdAt.valueOf() === current.createdAt.valueOf() &&
    (!current.id || candidate.id.toString() > current.id.toString()))

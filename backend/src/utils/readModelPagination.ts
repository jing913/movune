import { Types, isObjectIdOrHexString } from 'mongoose'
import { invalidInput } from './messagingPolicy.js'

export const READ_MODEL_PAGE_SIZE = 20
export const READ_MODEL_PAGE_MAX = 50

export type ReadCursor = Readonly<{
  sortAt: Date
  id: Types.ObjectId
}>

export const parseReadLimit = (value: unknown) => {
  if (value === undefined) return READ_MODEL_PAGE_SIZE
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw invalidInput('limit')
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > READ_MODEL_PAGE_MAX) {
    throw invalidInput('limit')
  }
  return limit
}

export const encodeReadCursor = (scope: string, sortAt: Date, id: Types.ObjectId) =>
  Buffer.from(JSON.stringify([scope, sortAt.toISOString(), id.toString()])).toString('base64url')

export const decodeReadCursor = (value: unknown, scope: string): ReadCursor | null => {
  if (value === undefined) return null
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw invalidInput('cursor')
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 3 ||
      parsed[0] !== scope ||
      typeof parsed[1] !== 'string' ||
      !isObjectIdOrHexString(parsed[2])
    ) {
      throw new Error('Invalid cursor')
    }
    const sortAt = new Date(parsed[1])
    if (Number.isNaN(sortAt.valueOf()) || sortAt.toISOString() !== parsed[1]) {
      throw new Error('Invalid cursor timestamp')
    }
    return { sortAt, id: new Types.ObjectId(String(parsed[2])) }
  } catch {
    throw invalidInput('cursor')
  }
}

export const descendingReadCursorFilter = (sortField: string, cursor: ReadCursor) => ({
  $or: [
    { [sortField]: { $lt: cursor.sortAt } },
    { [sortField]: cursor.sortAt, _id: { $lt: cursor.id } },
  ],
})

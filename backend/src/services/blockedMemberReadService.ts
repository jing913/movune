/* eslint-disable @typescript-eslint/no-explicit-any -- Lean projections are narrowed at the DTO boundary. */
import { Types } from 'mongoose'
import { UserBlock } from '../models/userBlockModel.js'
import { User } from '../models/userModel.js'
import {
  decodeReadCursor,
  descendingReadCursorFilter,
  encodeReadCursor,
  parseReadLimit,
} from '../utils/readModelPagination.js'

const CURSOR_SCOPE = 'blocked-users'

export const listBlockedMembers = async (
  actorUserIdValue: string,
  query: Readonly<{ cursor?: unknown; limit?: unknown }>,
) => {
  const actorUserId = new Types.ObjectId(actorUserIdValue)
  const limit = parseReadLimit(query.limit)
  const cursor = decodeReadCursor(query.cursor, CURSOR_SCOPE)
  const conditions: Record<string, unknown>[] = [{ blockerUserId: actorUserId }]
  if (cursor) conditions.push(descendingReadCursorFilter('createdAt', cursor))
  const blocks = await UserBlock.find({ $and: conditions })
    .select('blockedUserId createdAt')
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean()
  const hasMore = blocks.length > limit
  const page = hasMore ? blocks.slice(0, limit) : blocks
  const users = await User.find({ _id: { $in: page.map((block) => block.blockedUserId) } })
    .select('account displayName avatar')
    .lean()
  const usersById = new Map(users.map((user) => [user._id.toString(), user]))
  const blockedUsers = page.map((block: any) => {
    const id = block.blockedUserId.toString()
    const user = usersById.get(id)
    return {
      user: user
        ? {
            id,
            displayName: user.displayName?.trim() || user.account,
            username: user.account,
            ...(user.avatar ? { avatarUrl: user.avatar } : {}),
          }
        : {
            id,
            displayName: '無法使用的會員',
            unavailable: true as const,
          },
      blockedAt: new Date(block.createdAt).toISOString(),
    }
  })
  const last = page.at(-1) as any
  return {
    blockedUsers,
    nextCursor:
      hasMore && last ? encodeReadCursor(CURSOR_SCOPE, new Date(last.createdAt), last._id) : null,
  }
}

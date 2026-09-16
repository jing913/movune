import { Types } from 'mongoose'
import { Follow } from '../models/followModel.js'
import type { IUser } from '../models/userModel.js'

export type UserListItem = Pick<IUser, 'account' | 'displayName' | 'avatar' | 'bio'> & {
  _id: Types.ObjectId
}

export type PeopleSocialMetadata = {
  isFollowing: boolean
  followerCount: number
  followingCount: number
}

export const loadPeopleSocialMetadata = async (
  userIds: Types.ObjectId[],
  viewerId: Types.ObjectId,
) => {
  if (userIds.length === 0) return new Map<string, PeopleSocialMetadata>()

  const [followingRecords, followerCounts, followingCounts] = await Promise.all([
    Follow.find({ followerId: viewerId, followingId: { $in: userIds } })
      .select('followingId')
      .lean(),
    Follow.aggregate<{ _id: unknown; count: number }>([
      { $match: { followingId: { $in: userIds } } },
      { $group: { _id: '$followingId', count: { $sum: 1 } } },
    ]),
    Follow.aggregate<{ _id: unknown; count: number }>([
      { $match: { followerId: { $in: userIds } } },
      { $group: { _id: '$followerId', count: { $sum: 1 } } },
    ]),
  ])

  const followingIds = new Set(followingRecords.map((follow) => follow.followingId.toString()))
  const followerCountById = new Map(followerCounts.map((entry) => [String(entry._id), entry.count]))
  const followingCountById = new Map(
    followingCounts.map((entry) => [String(entry._id), entry.count]),
  )

  return new Map(
    userIds.map((userId) => {
      const id = userId.toString()
      return [
        id,
        {
          isFollowing: followingIds.has(id),
          followerCount: followerCountById.get(id) ?? 0,
          followingCount: followingCountById.get(id) ?? 0,
        },
      ]
    }),
  )
}

export const buildPeopleSummaries = async (users: UserListItem[], viewerId: Types.ObjectId) => {
  const userIds = users.map((user) => user._id)
  const socialMetadataByUserId = await loadPeopleSocialMetadata(userIds, viewerId)

  return users.map((user) => {
    const userId = user._id.toString()
    const socialMetadata = socialMetadataByUserId.get(userId) ?? {
      isFollowing: false,
      followerCount: 0,
      followingCount: 0,
    }
    return {
      _id: user._id,
      account: user.account,
      displayName: user.displayName?.trim() || user.account,
      avatar: user.avatar,
      bio: user.bio,
      ...socialMetadata,
    }
  })
}

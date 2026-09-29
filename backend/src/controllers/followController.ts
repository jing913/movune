import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { isObjectIdOrHexString } from 'mongoose'
import { Follow } from '../models/followModel.js'
import { findUserById, User } from '../models/userModel.js'
import type { UserListItem } from '../services/peopleService.js'
import {
  loadFollowerPeople,
  loadFollowingPeople,
  type VisibilityAwareContextualPersonProfile,
} from '../services/contextualPeopleService.js'
import { persistFollowNotification } from '../utils/followNotification.js'
import { isSelfFollow } from '../utils/followPolicy.js'
import {
  publishDirectUpdated,
  publishRelationshipUpdated,
  publishToUser,
} from '../services/realtimeService.js'
import { followContact, unfollowContact } from '../services/contactMutationService.js'
import {
  assertMemberSocialPairAccess,
  memberSocialResourceNotFound,
} from '../services/memberSocialAccessService.js'

type FollowParams = {
  userId: string
}

const isDuplicateKeyError = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000

const isAlreadyFollowingError = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === 'FOLLOW_ALREADY_EXISTS'

export const followUser = async (req: Request<FollowParams>, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  const followingId = req.params.userId
  if (!isObjectIdOrHexString(followingId)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Invalid user id' })
  }

  if (isSelfFollow(req.user._id, followingId)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'You cannot follow yourself' })
  }

  try {
    const followingUser = await findUserById(followingId)
    if (!followingUser) {
      return res.status(StatusCodes.NOT_FOUND).json({ message: 'User not found' })
    }

    const { follow, unlockedConversation } = await followContact(
      req.user._id.toString(),
      followingId,
    )

    const notification = await persistFollowNotification({
      recipientId: followingId,
      actorId: req.user._id,
      type: 'follow',
    })
    if (notification)
      publishToUser(followingId, 'notification.created', {
        notificationId: notification._id.toString(),
      })

    publishRelationshipUpdated(req.user._id.toString(), followingId)

    if (unlockedConversation) {
      const conversation = unlockedConversation as {
        _id: { toString(): string }
        participantIds: Array<{ toString(): string }>
        unlockedAt?: Date
      }
      publishDirectUpdated(
        conversation.participantIds.map((participantId) => participantId.toString()),
        conversation._id.toString(),
      )
    }

    return res.status(StatusCodes.CREATED).json({ follow })
  } catch (error) {
    if (isDuplicateKeyError(error) || isAlreadyFollowingError(error)) {
      return res.status(StatusCodes.CONFLICT).json({ message: 'Already following this user' })
    }

    next(error)
  }
}

export const unfollowUser = async (
  req: Request<FollowParams>,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  const followingId = req.params.userId
  if (!isObjectIdOrHexString(followingId)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Invalid user id' })
  }

  try {
    const { deleted } = await unfollowContact(req.user._id.toString(), followingId)

    if (!deleted) {
      return res.status(StatusCodes.NOT_FOUND).json({ message: 'Follow relationship not found' })
    }

    publishRelationshipUpdated(req.user._id.toString(), followingId)

    return res.status(StatusCodes.NO_CONTENT).send()
  } catch (error) {
    next(error)
  }
}

export const getFollowSummary = async (
  req: Request<FollowParams>,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  const userId = req.params.userId
  if (!isObjectIdOrHexString(userId)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Invalid user id' })
  }

  try {
    await assertMemberSocialPairAccess(req.user._id.toString(), userId)
    const user = await findUserById(userId)
    if (!user) throw memberSocialResourceNotFound()

    const [followerCount, followingCount, currentFollow] = await Promise.all([
      Follow.countDocuments({ followingId: userId }),
      Follow.countDocuments({ followerId: userId }),
      Follow.findOne({ followerId: req.user._id, followingId: userId }).select('_id').lean(),
    ])

    return res.status(StatusCodes.OK).json({
      followerCount,
      followingCount,
      isFollowing: Boolean(currentFollow),
      isSelf: isSelfFollow(req.user._id, userId),
    })
  } catch (error) {
    next(error)
  }
}

export const getMyFollowing = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  try {
    const follows = await Follow.find({ followerId: req.user._id })
      .select('followingId createdAt')
      .sort({ createdAt: -1 })
      .lean()

    return res.status(StatusCodes.OK).json({ follows })
  } catch (error) {
    next(error)
  }
}

const getMyNetworkUsers = async (
  req: Request,
  res: Response,
  next: NextFunction,
  direction: 'following' | 'followers',
) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  try {
    const relationFilter =
      direction === 'following' ? { followerId: req.user._id } : { followingId: req.user._id }
    const idField = direction === 'following' ? 'followingId' : 'followerId'
    const relations = await Follow.find(relationFilter)
      .select(`${idField} createdAt`)
      .sort({ createdAt: -1 })
      .lean()
    const orderedIds = relations.map((relation) => relation[idField].toString())
    const selectedUserFields =
      direction === 'following'
        ? 'account displayName avatar bio favoritesPublic'
        : 'account displayName avatar bio'
    const users = await User.find({ _id: { $in: orderedIds } })
      .select(selectedUserFields)
      .lean()
    const userById = new Map(users.map((user) => [user._id.toString(), user]))
    const orderedUsers = orderedIds.flatMap((id) => {
      const user = userById.get(id)
      return user ? [user] : []
    })
    const summaries =
      direction === 'following'
        ? await loadFollowingPeople(
            orderedUsers as VisibilityAwareContextualPersonProfile[],
            req.user._id,
          )
        : await loadFollowerPeople(orderedUsers as UserListItem[], req.user._id)

    return res.status(StatusCodes.OK).json({ users: summaries })
  } catch (error) {
    next(error)
  }
}

export const getMyFollowingUsers = (req: Request, res: Response, next: NextFunction) =>
  getMyNetworkUsers(req, res, next, 'following')

export const getMyFollowerUsers = (req: Request, res: Response, next: NextFunction) =>
  getMyNetworkUsers(req, res, next, 'followers')

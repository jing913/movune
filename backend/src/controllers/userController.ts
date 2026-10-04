import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { isObjectIdOrHexString, Types, type QueryFilter } from 'mongoose'
import { Favorite } from '../models/favoriteModel.js'
import { Follow } from '../models/followModel.js'
import { findUserById, User, type IUser } from '../models/userModel.js'
import { listPublicCollectionsForOwner } from '../services/collectionService.js'
import { loadMovieDetailPeople } from '../services/contextualPeopleService.js'
import { listEncounterCandidates } from '../services/encounterService.js'
import { buildPeopleSummaries, type UserListItem } from '../services/peopleService.js'
import {
  getFavoritesVisibility,
  setFavoritesVisibility,
} from '../services/favoritesVisibilityService.js'
import { loadVisibleFavorites } from '../utils/favoritesDisclosurePolicy.js'
import { PUBLIC_FAVORITES_PERSISTENCE_MATCH } from '../utils/favoriteVisibility.js'
import { parseProfileUpdate } from '../utils/profilePolicy.js'
import { buildPeopleSortStages, isPeopleSort } from '../utils/peopleSort.js'
import {
  parseEncounterCooldownIds,
  parseEncounterSessionExclusionIds,
} from '../utils/encounterPolicy.js'
import { listBlockedMembers } from '../services/blockedMemberReadService.js'
import {
  readMessagingPrivacy,
  updateMessagingPrivacy,
} from '../services/messagingPrivacyService.js'
import { deriveAnnouncementCapabilities } from '../policies/announcementAuthorizationPolicy.js'
import {
  assertMemberSocialPairAccess,
  loadEffectiveBlockedUserIds,
  memberSocialResourceNotFound,
} from '../services/memberSocialAccessService.js'

type UserParams = {
  id: string
}

type FavoriteVisibilityBody = {
  favoritesPublic?: unknown
}

type UpdateProfileBody = {
  displayName?: unknown
  bio?: unknown
}

type UsersQuery = {
  page?: string
  limit?: string
  search?: string
  following?: string
  genreId?: string
  genreIds?: string
  sharedFavorites?: string
  sort?: string
}

type MoviePeopleParams = {
  tmdbId: string
}

type MoviePeopleQuery = {
  page?: string
  limit?: string
}

type EncounterBody = {
  sessionExcludedIds?: unknown
  cooldownIds?: unknown
}

export const serializeUser = (user: Express.User) => ({
  _id: user._id,
  account: user.account,
  displayName: user.displayName?.trim() || user.account,
  avatar: user.avatar,
  bio: user.bio,
  favoritesPublic: getFavoritesVisibility(user) === 'public',
  capabilities: deriveAnnouncementCapabilities(user),
})

const serializePublicUser = (user: Express.User) => ({
  _id: user._id,
  account: user.account,
  displayName: user.displayName?.trim() || user.account,
  avatar: user.avatar,
  bio: user.bio,
})

export const getUser = async (req: Request<UserParams>, res: Response, next: NextFunction) => {
  const id = req.params.id
  if (!isObjectIdOrHexString(id)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Invalid user id' })
  }

  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  try {
    await assertMemberSocialPairAccess(req.user._id.toString(), id)
    const user = await findUserById(id)
    if (!user) throw memberSocialResourceNotFound()

    return res.status(StatusCodes.OK).json({
      user: serializePublicUser(user),
    })
  } catch (error) {
    next(error)
  }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const getUsers = async (
  req: Request<Record<string, never>, unknown, unknown, UsersQuery>,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  const page = Number(req.query.page ?? 1)
  const limit = Number(req.query.limit ?? 12)
  const search = req.query.search?.trim() ?? ''
  const following = req.query.following ?? 'all'
  const genreId = req.query.genreId === undefined ? undefined : Number(req.query.genreId)
  const genreIds = (req.query.genreIds ?? '').split(',').filter(Boolean).map(Number)
  if (genreId !== undefined) genreIds.push(genreId)
  const uniqueGenreIds = [...new Set(genreIds)]
  const sharedFavorites = req.query.sharedFavorites === 'true'
  const sort = req.query.sort ?? 'recent'

  if (
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 30 ||
    search.length > 50 ||
    !['all', 'following', 'not-following'].includes(following) ||
    uniqueGenreIds.some((value) => !Number.isInteger(value) || value <= 0) ||
    !isPeopleSort(sort) ||
    (req.query.sharedFavorites !== undefined &&
      !['true', 'false'].includes(req.query.sharedFavorites))
  ) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Invalid users query' })
  }

  const filter: QueryFilter<IUser> = {
    _id: { $ne: req.user._id },
  }
  if (search) {
    filter.account = { $regex: escapeRegExp(search), $options: 'i' }
  }

  try {
    const idConstraints: QueryFilter<IUser>[] = []
    const blockedUserIds = await loadEffectiveBlockedUserIds(req.user._id)
    if (blockedUserIds.size > 0) {
      idConstraints.push({
        _id: { $nin: [...blockedUserIds].map((userId) => new Types.ObjectId(userId)) },
      })
    }

    if (following !== 'all') {
      const followingIds = await Follow.distinct('followingId', { followerId: req.user._id })
      idConstraints.push({
        _id: following === 'following' ? { $in: followingIds } : { $nin: followingIds },
      })
    }

    if (uniqueGenreIds.length > 0) {
      const genreUserIds = await Favorite.distinct('userId', {
        genreIds: { $in: uniqueGenreIds },
      })
      idConstraints.push({ _id: { $in: genreUserIds }, ...PUBLIC_FAVORITES_PERSISTENCE_MATCH })
    }

    if (sharedFavorites) {
      const viewerTmdbIds = await Favorite.distinct('tmdbId', { userId: req.user._id })
      const sharedFavoriteUserIds = viewerTmdbIds.length
        ? await Favorite.distinct('userId', {
            userId: { $ne: req.user._id },
            tmdbId: { $in: viewerTmdbIds },
          })
        : []
      idConstraints.push({
        _id: { $in: sharedFavoriteUserIds },
        ...PUBLIC_FAVORITES_PERSISTENCE_MATCH,
      })
    }

    if (idConstraints.length > 0) filter.$and = idConstraints

    const [users, total] = await Promise.all([
      User.aggregate<UserListItem>([
        { $match: filter },
        ...buildPeopleSortStages(),
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $project: {
            account: 1,
            displayName: 1,
            avatar: 1,
            bio: 1,
          },
        },
      ]),
      User.countDocuments(filter),
    ])
    const summaries = await buildPeopleSummaries(users, req.user._id)

    return res.status(StatusCodes.OK).json({
      users: summaries,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    next(error)
  }
}

export const getMoviePeople = async (
  req: Request<MoviePeopleParams, unknown, unknown, MoviePeopleQuery>,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  const tmdbId = Number(req.params.tmdbId)
  const page = Number(req.query.page ?? 1)
  const limit = Number(req.query.limit ?? 6)
  if (
    !Number.isInteger(tmdbId) ||
    tmdbId <= 0 ||
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 12
  ) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Invalid movie people query' })
  }

  try {
    const favoriteOwnerIds = await Favorite.distinct('userId', { tmdbId })
    const blockedUserIds = await loadEffectiveBlockedUserIds(req.user._id)
    const filter: QueryFilter<IUser> = {
      _id: {
        $in: favoriteOwnerIds,
        $ne: req.user._id,
        ...(blockedUserIds.size > 0 ? { $nin: [...blockedUserIds] } : {}),
      },
      ...PUBLIC_FAVORITES_PERSISTENCE_MATCH,
    }
    const [users, total] = await Promise.all([
      User.find(filter)
        .select('account displayName avatar bio')
        .sort({ account: 1, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ])
    const people = await loadMovieDetailPeople(users as UserListItem[], req.user._id)

    return res.status(StatusCodes.OK).json({
      users: people,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    next(error)
  }
}

export const getEncounterCandidates = async (
  req: Request<Record<string, never>, unknown, EncounterBody>,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  const sessionExcludedIds = parseEncounterSessionExclusionIds(req.body.sessionExcludedIds)
  const cooldownIds = parseEncounterCooldownIds(req.body.cooldownIds)
  if (!sessionExcludedIds || !cooldownIds) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Invalid encounter exclusions' })
  }

  try {
    const result = await listEncounterCandidates(req.user._id, sessionExcludedIds, cooldownIds)
    return res.status(StatusCodes.OK).json(result)
  } catch (error) {
    next(error)
  }
}

export const getMe = (req: Request, res: Response) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  res.status(StatusCodes.OK).json({
    user: serializeUser(req.user),
  })
}

export const getMessagingPrivacy = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  try {
    return res.status(StatusCodes.OK).json(readMessagingPrivacy(req.user))
  } catch (error) {
    next(error)
  }
}

export const patchMessagingPrivacy = async (
  req: Request<Record<string, never>, unknown, unknown>,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  try {
    return res.status(StatusCodes.OK).json(await updateMessagingPrivacy(req.user, req.body))
  } catch (error) {
    next(error)
  }
}

export const getBlockedUsers = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }
  try {
    return res.status(StatusCodes.OK).json(
      await listBlockedMembers(req.user._id.toString(), {
        cursor: req.query.cursor,
        limit: req.query.limit,
      }),
    )
  } catch (error) {
    next(error)
  }
}

export const updateFavoriteVisibility = async (
  req: Request<Record<string, never>, unknown, FavoriteVisibilityBody>,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  if (typeof req.body.favoritesPublic !== 'boolean') {
    return res.status(StatusCodes.BAD_REQUEST).json({
      message: 'favoritesPublic must be a boolean',
    })
  }

  try {
    await setFavoritesVisibility(req.user, req.body.favoritesPublic ? 'public' : 'private')

    return res.status(StatusCodes.OK).json({
      user: serializeUser(req.user),
    })
  } catch (error) {
    next(error)
  }
}

export const updateProfile = async (
  req: Request<Record<string, never>, unknown, UpdateProfileBody>,
  res: Response,
  next: NextFunction,
) => {
  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  try {
    const profile = await parseProfileUpdate(req.body)
    req.user.displayName = profile.displayName
    req.user.bio = profile.bio
    await req.user.save()

    return res.status(StatusCodes.OK).json({ user: serializeUser(req.user) })
  } catch (error) {
    next(error)
  }
}

export const getMovieSpace = async (
  req: Request<UserParams>,
  res: Response,
  next: NextFunction,
) => {
  const id = req.params.id
  if (!isObjectIdOrHexString(id)) {
    return res.status(StatusCodes.BAD_REQUEST).json({ message: 'Invalid user id' })
  }

  if (!req.user) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ message: 'Unauthorized' })
  }

  try {
    await assertMemberSocialPairAccess(req.user._id.toString(), id)
    const user = await findUserById(id)
    if (!user) throw memberSocialResourceNotFound()

    const visibility = getFavoritesVisibility(user)
    const [favorites, collections] = await Promise.all([
      loadVisibleFavorites(user._id, req.user._id, visibility, () =>
        Favorite.find({ userId: user._id }).select('tmdbId genreIds createdAt updatedAt').lean(),
      ),
      listPublicCollectionsForOwner(user._id),
    ])
    const response = {
      user: serializePublicUser(user),
      collections,
    }

    if (!favorites) {
      return res.status(StatusCodes.OK).json(response)
    }

    return res.status(StatusCodes.OK).json({
      ...response,
      favorites,
    })
  } catch (error) {
    next(error)
  }
}

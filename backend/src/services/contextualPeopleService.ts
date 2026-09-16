import type { Types } from 'mongoose'
import { Favorite } from '../models/favoriteModel.js'
import type { IUser } from '../models/userModel.js'
import type { UserListItem, PeopleSocialMetadata } from './peopleService.js'
import { loadPeopleSocialMetadata } from './peopleService.js'
import { loadFavoritesForMatch } from '../utils/favoritesProcessingPolicy.js'
import { getFavoritesVisibility } from './favoritesVisibilityService.js'
import {
  calculateCanonicalMatchExplanation,
  type SharedDnaGenre,
} from './matchExplanationService.js'
import type { MatchV1Favorite } from './matchV1Service.js'

type IdValue = {
  toString(): string
}

export type ContextualPersonProfile = UserListItem

export type VisibilityAwareContextualPersonProfile = ContextualPersonProfile &
  Pick<IUser, 'favoritesPublic'>

export type ContextualFavorite = MatchV1Favorite & {
  userId?: IdValue
}

export type ContextualPerson = {
  _id: IdValue
  account: string
  displayName: string
  avatar?: string
  bio?: string
} & PeopleSocialMetadata

export type MovieDetailPerson = ContextualPerson & {
  alsoFavorited: true
}

export type FollowingPerson = ContextualPerson & {
  sharedDnaGenres: SharedDnaGenre[]
}

export type FollowerPerson = ContextualPerson

type FollowingPeopleInput = {
  viewerId: IdValue
  viewerFavorites: ContextualFavorite[]
  candidates: VisibilityAwareContextualPersonProfile[]
  candidateFavorites: ContextualFavorite[]
  socialMetadataByUserId: Map<string, PeopleSocialMetadata>
}

const shapeContextualPerson = (
  user: ContextualPersonProfile,
  socialMetadataByUserId: Map<string, PeopleSocialMetadata>,
): ContextualPerson => ({
  _id: user._id,
  account: user.account,
  displayName: user.displayName?.trim() || user.account,
  ...(user.avatar ? { avatar: user.avatar } : {}),
  ...(user.bio ? { bio: user.bio } : {}),
  ...(socialMetadataByUserId.get(user._id.toString()) ?? {
    isFollowing: false,
    followerCount: 0,
    followingCount: 0,
  }),
})

export const shapeMovieDetailPeople = (
  users: ContextualPersonProfile[],
  socialMetadataByUserId: Map<string, PeopleSocialMetadata>,
): MovieDetailPerson[] =>
  users.map((user) => ({
    ...shapeContextualPerson(user, socialMetadataByUserId),
    alsoFavorited: true,
  }))

export const shapeFollowerPeople = (
  users: ContextualPersonProfile[],
  socialMetadataByUserId: Map<string, PeopleSocialMetadata>,
): FollowerPerson[] => users.map((user) => shapeContextualPerson(user, socialMetadataByUserId))

export const buildFollowingPeople = ({
  viewerId,
  viewerFavorites,
  candidates,
  candidateFavorites,
  socialMetadataByUserId,
}: FollowingPeopleInput): FollowingPerson[] => {
  const favoritesByUserId = new Map<string, ContextualFavorite[]>()
  for (const favorite of candidateFavorites) {
    if (!favorite.userId) continue
    const userId = favorite.userId.toString()
    const favorites = favoritesByUserId.get(userId) ?? []
    favorites.push(favorite)
    favoritesByUserId.set(userId, favorites)
  }

  return candidates.map((candidate) => {
    const canonicalResult = calculateCanonicalMatchExplanation(
      viewerFavorites,
      favoritesByUserId.get(candidate._id.toString()) ?? [],
      {
        viewerId,
        otherUserId: candidate._id,
        otherUserFavoritesVisibility: getFavoritesVisibility(candidate),
      },
    )

    return {
      ...shapeContextualPerson(candidate, socialMetadataByUserId),
      sharedDnaGenres: canonicalResult.matchExplanation?.sharedDnaGenres.slice(0, 2) ?? [],
    }
  })
}

export const loadMovieDetailPeople = async (
  users: ContextualPersonProfile[],
  viewerId: Types.ObjectId,
) => {
  const socialMetadataByUserId = await loadPeopleSocialMetadata(
    users.map((user) => user._id),
    viewerId,
  )
  return shapeMovieDetailPeople(users, socialMetadataByUserId)
}

export const loadFollowingPeople = async (
  users: VisibilityAwareContextualPersonProfile[],
  viewerId: Types.ObjectId,
) => {
  const userIds = users.map((user) => user._id)
  const [socialMetadataByUserId, viewerFavorites, candidateFavorites] = await Promise.all([
    loadPeopleSocialMetadata(userIds, viewerId),
    loadFavoritesForMatch(() =>
      Favorite.find({ userId: viewerId }).select('tmdbId genreIds').lean(),
    ),
    loadFavoritesForMatch(() =>
      Favorite.find({ userId: { $in: userIds } })
        .select('userId tmdbId genreIds')
        .lean(),
    ),
  ])

  return buildFollowingPeople({
    viewerId,
    viewerFavorites: viewerFavorites ?? [],
    candidates: users,
    candidateFavorites: candidateFavorites ?? [],
    socialMetadataByUserId,
  })
}

export const loadFollowerPeople = async (
  users: ContextualPersonProfile[],
  viewerId: Types.ObjectId,
) => {
  const socialMetadataByUserId = await loadPeopleSocialMetadata(
    users.map((user) => user._id),
    viewerId,
  )
  return shapeFollowerPeople(users, socialMetadataByUserId)
}

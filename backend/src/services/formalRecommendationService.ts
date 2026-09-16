import type { Types } from 'mongoose'
import { Favorite } from '../models/favoriteModel.js'
import { User } from '../models/userModel.js'
import { getFavoritesVisibility } from './favoritesVisibilityService.js'
import {
  calculateCanonicalMatchExplanation,
  type SharedDnaGenre,
} from './matchExplanationService.js'
import { calculateMatchV1, type MatchV1Favorite } from './matchV1Service.js'
import { loadPeopleSocialMetadata, type PeopleSocialMetadata } from './peopleService.js'
import { loadFavoritesForMatch } from '../utils/favoritesProcessingPolicy.js'

type IdValue = {
  toString(): string
}

export type FormalRecommendationCandidate = {
  _id: IdValue
  account: string
  displayName?: string
  avatar?: string
  bio?: string
  favoritesPublic?: boolean
}

export type FormalRecommendationFavorite = MatchV1Favorite & {
  userId?: IdValue
}

type FormalRecommendationMatchItem = {
  _id: IdValue
  account: string
  displayName: string
  avatar?: string
  bio?: string
  sharedDnaGenres: SharedDnaGenre[]
  revealableSharedFavoriteTmdbIds: number[]
}

export type FormalRecommendationItem = FormalRecommendationMatchItem & PeopleSocialMetadata

type FormalRecommendationsEnvelope<Item> = {
  status: 'eligible' | 'insufficient_signal'
  items: Item[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export type FormalRecommendationsResult = FormalRecommendationsEnvelope<FormalRecommendationItem>
type FormalRecommendationMatchResult = FormalRecommendationsEnvelope<FormalRecommendationMatchItem>

type BuildFormalRecommendationsInput = {
  viewerId: IdValue
  viewerFavorites: FormalRecommendationFavorite[]
  candidates: FormalRecommendationCandidate[]
  candidateFavorites: FormalRecommendationFavorite[]
  page: number
  limit: number
}

const emptyResult = <Item>(
  status: FormalRecommendationsResult['status'],
  page: number,
  limit: number,
): FormalRecommendationsEnvelope<Item> => ({
  status,
  items: [],
  pagination: { page, limit, total: 0, totalPages: 0 },
})

export const hasFormalRecommendationSignal = (favorites: FormalRecommendationFavorite[]) =>
  calculateMatchV1(favorites, favorites).matchEligibility === 'eligible'

export const buildFormalRecommendations = ({
  viewerId,
  viewerFavorites,
  candidates,
  candidateFavorites,
  page,
  limit,
}: BuildFormalRecommendationsInput): FormalRecommendationMatchResult => {
  if (!hasFormalRecommendationSignal(viewerFavorites)) {
    return emptyResult<FormalRecommendationMatchItem>('insufficient_signal', page, limit)
  }

  const favoritesByUserId = new Map<string, FormalRecommendationFavorite[]>()
  for (const favorite of candidateFavorites) {
    if (!favorite.userId) continue
    const userId = favorite.userId.toString()
    const favorites = favoritesByUserId.get(userId) ?? []
    favorites.push(favorite)
    favoritesByUserId.set(userId, favorites)
  }

  const rankedCandidates = candidates.flatMap((candidate) => {
    const canonicalResult = calculateCanonicalMatchExplanation(
      viewerFavorites,
      favoritesByUserId.get(candidate._id.toString()) ?? [],
      {
        viewerId,
        otherUserId: candidate._id,
        otherUserFavoritesVisibility: getFavoritesVisibility(candidate),
      },
    )

    if (canonicalResult.matchExplanation === null) return []

    return [
      {
        candidate,
        matchScore: canonicalResult.matchV1.matchScore,
        explanation: canonicalResult.matchExplanation,
      },
    ]
  })

  rankedCandidates.sort(
    (first, second) =>
      second.matchScore - first.matchScore ||
      first.candidate._id.toString().localeCompare(second.candidate._id.toString()),
  )

  const total = rankedCandidates.length
  const items = rankedCandidates
    .slice((page - 1) * limit, page * limit)
    .map(({ candidate, explanation }) => ({
      _id: candidate._id,
      account: candidate.account,
      displayName: candidate.displayName?.trim() || candidate.account,
      ...(candidate.avatar ? { avatar: candidate.avatar } : {}),
      ...(candidate.bio ? { bio: candidate.bio } : {}),
      sharedDnaGenres: explanation.sharedDnaGenres,
      revealableSharedFavoriteTmdbIds: explanation.revealableSharedFavorites.map(
        ({ tmdbId }) => tmdbId,
      ),
    }))

  return {
    status: 'eligible',
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  }
}

export const attachFormalRecommendationSocialMetadata = (
  result: FormalRecommendationMatchResult,
  socialMetadataByUserId: Map<string, PeopleSocialMetadata>,
): FormalRecommendationsResult => ({
  ...result,
  items: result.items.map((item) => ({
    ...item,
    ...(socialMetadataByUserId.get(item._id.toString()) ?? {
      isFollowing: false,
      followerCount: 0,
      followingCount: 0,
    }),
  })),
})

export const listFormalRecommendations = async (
  viewerId: Types.ObjectId,
  page: number,
  limit: number,
) => {
  const viewerFavorites =
    (await loadFavoritesForMatch(() =>
      Favorite.find({ userId: viewerId }).select('tmdbId genreIds').lean(),
    )) ?? []

  if (!hasFormalRecommendationSignal(viewerFavorites)) {
    return emptyResult<FormalRecommendationItem>('insufficient_signal', page, limit)
  }

  const candidates = await User.find({ _id: { $ne: viewerId } })
    .select('account displayName avatar bio favoritesPublic')
    .lean()
  const candidateFavorites =
    (await loadFavoritesForMatch(() =>
      Favorite.find({ userId: { $in: candidates.map((candidate) => candidate._id) } })
        .select('userId tmdbId genreIds')
        .lean(),
    )) ?? []

  const canonicalResult = buildFormalRecommendations({
    viewerId,
    viewerFavorites,
    candidates,
    candidateFavorites,
    page,
    limit,
  })
  const socialMetadataByUserId = await loadPeopleSocialMetadata(
    canonicalResult.items.map((item) => item._id as Types.ObjectId),
    viewerId,
  )

  return attachFormalRecommendationSocialMetadata(canonicalResult, socialMetadataByUserId)
}

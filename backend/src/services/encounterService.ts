import type { Types } from 'mongoose'
import { Favorite } from '../models/favoriteModel.js'
import { User } from '../models/userModel.js'
import { ENCOUNTER_ROUND_LIMIT } from '../utils/encounterPolicy.js'
import { loadFavoritesForMatch } from '../utils/favoritesProcessingPolicy.js'
import { getFavoritesVisibility } from './favoritesVisibilityService.js'
import {
  calculateCanonicalMatchExplanation,
  type SharedDnaGenre,
} from './matchExplanationService.js'
import { calculateMatchV1, type MatchV1Favorite } from './matchV1Service.js'
import { loadEffectiveBlockedUserIds } from './memberSocialAccessService.js'
import { loadPeopleSocialMetadata, type PeopleSocialMetadata } from './peopleService.js'
import { SOCIAL_DISCOVERY_ELIGIBILITY_MATCH } from './socialDiscoveryEligibility.js'

type IdValue = {
  toString(): string
}

export type EncounterCandidateProfile = {
  _id: IdValue
  account: string
  displayName?: string
  avatar?: string
  bio?: string
  favoritesPublic?: boolean
}

export type EncounterFavorite = MatchV1Favorite & {
  userId?: IdValue
}

export type EncounterMatchCandidate = {
  _id: IdValue
  account: string
  displayName: string
  avatar?: string
  bio?: string
  sharedDnaGenres: SharedDnaGenre[]
  revealableSharedFavoriteTmdbIds: number[]
}

export type EncounterCandidate = EncounterMatchCandidate & PeopleSocialMetadata

export type EncounterRoundResult<Item = EncounterCandidate> = {
  status: 'eligible' | 'insufficient_signal'
  candidates: Item[]
}

type WeightedCandidate = {
  candidate: EncounterCandidateProfile
  matchScore: number
  sharedDnaGenres: SharedDnaGenre[]
  revealableSharedFavoriteTmdbIds: number[]
}

type BuildEncounterRoundInput = {
  viewerId: IdValue
  viewerFavorites: EncounterFavorite[]
  candidates: EncounterCandidateProfile[]
  candidateFavorites: EncounterFavorite[]
  sessionExcludedIds?: string[]
  cooldownIds?: string[]
  random?: () => number
}

export const calculateEncounterWeight = (matchScore: number) => 0.5 + matchScore

export const weightedSampleWithoutReplacement = <Item>(
  items: Item[],
  weightFor: (item: Item) => number,
  limit: number,
  random: () => number = Math.random,
) => {
  const remaining = [...items]
  const selected: Item[] = []
  const selectionLimit = Math.min(Math.max(0, limit), remaining.length)

  while (selected.length < selectionLimit) {
    const weights = remaining.map((item) => Math.max(0, weightFor(item)))
    const totalWeight = weights.reduce((total, weight) => total + weight, 0)
    if (totalWeight <= 0) break

    const randomValue = random()
    const normalizedRandom = Number.isFinite(randomValue)
      ? Math.min(1 - Number.EPSILON, Math.max(0, randomValue))
      : 0
    const threshold = normalizedRandom * totalWeight
    let cumulativeWeight = 0
    let selectedIndex = remaining.length - 1

    for (let index = 0; index < remaining.length; index += 1) {
      cumulativeWeight += weights[index]!
      if (threshold < cumulativeWeight) {
        selectedIndex = index
        break
      }
    }

    selected.push(remaining[selectedIndex]!)
    remaining.splice(selectedIndex, 1)
  }

  return selected
}

export const buildEncounterRound = ({
  viewerId,
  viewerFavorites,
  candidates,
  candidateFavorites,
  sessionExcludedIds = [],
  cooldownIds = [],
  random = Math.random,
}: BuildEncounterRoundInput): EncounterRoundResult<EncounterMatchCandidate> => {
  if (calculateMatchV1(viewerFavorites, viewerFavorites).matchEligibility !== 'eligible') {
    return { status: 'insufficient_signal', candidates: [] }
  }

  const unavailableIds = new Set([viewerId.toString(), ...sessionExcludedIds, ...cooldownIds])
  const favoritesByUserId = new Map<string, EncounterFavorite[]>()

  for (const favorite of candidateFavorites) {
    if (!favorite.userId) continue
    const userId = favorite.userId.toString()
    const favorites = favoritesByUserId.get(userId) ?? []
    favorites.push(favorite)
    favoritesByUserId.set(userId, favorites)
  }

  const eligibleCandidates = candidates.flatMap<WeightedCandidate>((candidate) => {
    if (unavailableIds.has(candidate._id.toString())) return []

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
        sharedDnaGenres: canonicalResult.matchExplanation.sharedDnaGenres,
        revealableSharedFavoriteTmdbIds:
          canonicalResult.matchExplanation.revealableSharedFavorites.map(({ tmdbId }) => tmdbId),
      },
    ]
  })

  const selected = weightedSampleWithoutReplacement(
    eligibleCandidates,
    ({ matchScore }) => calculateEncounterWeight(matchScore),
    ENCOUNTER_ROUND_LIMIT,
    random,
  )

  return {
    status: 'eligible',
    candidates: selected.map(({ candidate, sharedDnaGenres, revealableSharedFavoriteTmdbIds }) => ({
      _id: candidate._id,
      account: candidate.account,
      displayName: candidate.displayName?.trim() || candidate.account,
      ...(candidate.avatar ? { avatar: candidate.avatar } : {}),
      ...(candidate.bio ? { bio: candidate.bio } : {}),
      sharedDnaGenres,
      revealableSharedFavoriteTmdbIds,
    })),
  }
}

export const listEncounterCandidates = async (
  viewerId: Types.ObjectId,
  sessionExcludedIds: string[],
  cooldownIds: string[],
) => {
  const viewerFavorites =
    (await loadFavoritesForMatch(() =>
      Favorite.find({ userId: viewerId }).select('tmdbId genreIds').lean(),
    )) ?? []

  if (calculateMatchV1(viewerFavorites, viewerFavorites).matchEligibility !== 'eligible') {
    return { status: 'insufficient_signal', candidates: [] } satisfies EncounterRoundResult
  }

  const blockedUserIds = await loadEffectiveBlockedUserIds(viewerId)
  const candidates = await User.find({
    ...SOCIAL_DISCOVERY_ELIGIBILITY_MATCH,
    _id: {
      $ne: viewerId,
      ...(blockedUserIds.size > 0 ? { $nin: [...blockedUserIds] } : {}),
    },
  })
    .select('account displayName avatar bio favoritesPublic')
    .lean()
  const candidateFavorites =
    (await loadFavoritesForMatch(() =>
      Favorite.find({ userId: { $in: candidates.map((candidate) => candidate._id) } })
        .select('userId tmdbId genreIds')
        .lean(),
    )) ?? []

  const round = buildEncounterRound({
    viewerId,
    viewerFavorites,
    candidates,
    candidateFavorites,
    sessionExcludedIds,
    cooldownIds,
  })
  const socialMetadataByUserId = await loadPeopleSocialMetadata(
    round.candidates.map((candidate) => candidate._id as Types.ObjectId),
    viewerId,
  )

  return {
    ...round,
    candidates: round.candidates.map((candidate) => ({
      ...candidate,
      ...(socialMetadataByUserId.get(candidate._id.toString()) ?? {
        isFollowing: false,
        followerCount: 0,
        followingCount: 0,
      }),
    })),
  } satisfies EncounterRoundResult
}

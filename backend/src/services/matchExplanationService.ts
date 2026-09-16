import { canViewFavorites } from '../utils/favoritesDisclosurePolicy.js'
import type { FavoritesVisibility } from '../utils/favoriteVisibility.js'
import {
  calculateMatchV1,
  deriveFavoriteSet,
  deriveGenreSet,
  type EligibleMatchV1Result,
  type InsufficientSignalMatchV1Result,
  type MatchV1Favorite,
} from './matchV1Service.js'
import { calculateMovieDna } from './movieDnaService.js'

type IdValue = {
  toString(): string
}

export type MatchExplanationDisclosureContext = {
  viewerId: IdValue | null | undefined
  otherUserId: IdValue
  otherUserFavoritesVisibility: FavoritesVisibility
}

export type SharedDnaGenre = {
  genreId: number
  sharedGenreStrength: number
}

export type RevealableSharedFavorite = {
  tmdbId: number
}

export type CanonicalMatchExplanation = {
  sharedDnaGenres: SharedDnaGenre[]
  revealableSharedFavorites: RevealableSharedFavorite[]
}

export type EligibleCanonicalMatchExplanationResult = {
  matchV1: EligibleMatchV1Result
  matchExplanation: CanonicalMatchExplanation
}

export type InsufficientSignalCanonicalMatchExplanationResult = {
  matchV1: InsufficientSignalMatchV1Result
  matchExplanation: null
}

export type CanonicalMatchExplanationResult =
  EligibleCanonicalMatchExplanationResult | InsufficientSignalCanonicalMatchExplanationResult

const deriveSharedDnaGenres = (
  viewerFavorites: MatchV1Favorite[],
  otherUserFavorites: MatchV1Favorite[],
) => {
  const viewerGenreSet = deriveGenreSet(viewerFavorites)
  const otherUserGenreSet = deriveGenreSet(otherUserFavorites)
  const viewerStrengthByGenre = new Map(
    calculateMovieDna(viewerFavorites).genres.map(({ genreId, percentage }) => [
      genreId,
      percentage,
    ]),
  )
  const otherUserStrengthByGenre = new Map(
    calculateMovieDna(otherUserFavorites).genres.map(({ genreId, percentage }) => [
      genreId,
      percentage,
    ]),
  )

  return [...viewerGenreSet]
    .filter((genreId) => otherUserGenreSet.has(genreId))
    .map((genreId) => ({
      genreId,
      sharedGenreStrength: Math.min(
        viewerStrengthByGenre.get(genreId) ?? 0,
        otherUserStrengthByGenre.get(genreId) ?? 0,
      ),
    }))
    .sort(
      (first, second) =>
        second.sharedGenreStrength - first.sharedGenreStrength || first.genreId - second.genreId,
    )
    .slice(0, 3)
}

const deriveRevealableSharedFavorites = (
  viewerFavorites: MatchV1Favorite[],
  otherUserFavorites: MatchV1Favorite[],
  disclosureContext: MatchExplanationDisclosureContext,
) => {
  const otherUserFavoriteSet = deriveFavoriteSet(otherUserFavorites)

  return [...deriveFavoriteSet(viewerFavorites)]
    .filter(
      (tmdbId) =>
        otherUserFavoriteSet.has(tmdbId) &&
        canViewFavorites(
          disclosureContext.otherUserId,
          disclosureContext.viewerId,
          disclosureContext.otherUserFavoritesVisibility,
        ),
    )
    .sort((first, second) => first - second)
    .map((tmdbId) => ({ tmdbId }))
}

export const calculateCanonicalMatchExplanation = (
  viewerFavorites: MatchV1Favorite[],
  otherUserFavorites: MatchV1Favorite[],
  disclosureContext: MatchExplanationDisclosureContext,
): CanonicalMatchExplanationResult => {
  const matchV1 = calculateMatchV1(viewerFavorites, otherUserFavorites)

  if (matchV1.matchEligibility === 'insufficient_signal') {
    return {
      matchV1,
      matchExplanation: null,
    }
  }

  return {
    matchV1,
    matchExplanation: {
      sharedDnaGenres: deriveSharedDnaGenres(viewerFavorites, otherUserFavorites),
      revealableSharedFavorites: deriveRevealableSharedFavorites(
        viewerFavorites,
        otherUserFavorites,
        disclosureContext,
      ),
    },
  }
}

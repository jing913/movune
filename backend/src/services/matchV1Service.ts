import { normalizeGenreIds } from './movieDnaService.js'

export const MATCH_V1_MINIMUM_VALID_FAVORITES = 3
export const MATCH_V1_GENRE_WEIGHT = 0.7
export const MATCH_V1_FAVORITE_WEIGHT = 0.3

export type MatchV1Favorite = {
  tmdbId?: unknown
  genreIds?: unknown
}

export type EligibleMatchV1Result = {
  matchEligibility: 'eligible'
  genreSimilarity: number
  favoriteSimilarity: number
  matchScore: number
}

export type InsufficientSignalMatchV1Result = {
  matchEligibility: 'insufficient_signal'
  genreSimilarity: null
  favoriteSimilarity: null
  matchScore: null
}

export type MatchV1Result = EligibleMatchV1Result | InsufficientSignalMatchV1Result

const canonicalFavoriteTmdbId = (favorite: MatchV1Favorite) =>
  typeof favorite.tmdbId === 'number' && Number.isInteger(favorite.tmdbId) && favorite.tmdbId > 0
    ? favorite.tmdbId
    : undefined

export const validFavoriteCount = (favorites: MatchV1Favorite[]) =>
  favorites.filter(
    (favorite) =>
      canonicalFavoriteTmdbId(favorite) !== undefined &&
      normalizeGenreIds(favorite.genreIds).length > 0,
  ).length

export const deriveGenreSet = (favorites: MatchV1Favorite[]) =>
  new Set(
    favorites.flatMap((favorite) =>
      canonicalFavoriteTmdbId(favorite) === undefined ? [] : normalizeGenreIds(favorite.genreIds),
    ),
  )

export const deriveFavoriteSet = (favorites: MatchV1Favorite[]) =>
  new Set(
    favorites.flatMap((favorite) => {
      const tmdbId = canonicalFavoriteTmdbId(favorite)
      return tmdbId === undefined ? [] : [tmdbId]
    }),
  )

export const jaccardSimilarity = <Value>(first: Set<Value>, second: Set<Value>) => {
  const union = new Set([...first, ...second])
  if (union.size === 0) return 0

  let intersectionSize = 0
  for (const value of first) {
    if (second.has(value)) intersectionSize += 1
  }

  return intersectionSize / union.size
}

const withinSimilarityRange = (value: number) => Math.min(1, Math.max(0, value))

export const calculateMatchV1 = (
  currentUserFavorites: MatchV1Favorite[],
  candidateFavorites: MatchV1Favorite[],
): MatchV1Result => {
  if (
    validFavoriteCount(currentUserFavorites) < MATCH_V1_MINIMUM_VALID_FAVORITES ||
    validFavoriteCount(candidateFavorites) < MATCH_V1_MINIMUM_VALID_FAVORITES
  ) {
    return {
      matchEligibility: 'insufficient_signal',
      genreSimilarity: null,
      favoriteSimilarity: null,
      matchScore: null,
    }
  }

  const genreSimilarity = withinSimilarityRange(
    jaccardSimilarity(deriveGenreSet(currentUserFavorites), deriveGenreSet(candidateFavorites)),
  )
  const favoriteSimilarity = withinSimilarityRange(
    jaccardSimilarity(
      deriveFavoriteSet(currentUserFavorites),
      deriveFavoriteSet(candidateFavorites),
    ),
  )
  const matchScore = withinSimilarityRange(
    MATCH_V1_GENRE_WEIGHT * genreSimilarity + MATCH_V1_FAVORITE_WEIGHT * favoriteSimilarity,
  )

  return {
    matchEligibility: 'eligible',
    genreSimilarity,
    favoriteSimilarity,
    matchScore,
  }
}

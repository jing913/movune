import { calculateMatchV1, type MatchV1Result } from './matchV1Service.js'
import {
  calculateCanonicalMatchExplanation,
  type CanonicalMatchExplanationResult,
  type MatchExplanationDisclosureContext,
  type SharedDnaGenre,
} from './matchExplanationService.js'

type FavoriteSignal = {
  tmdbId?: unknown
  genreIds?: unknown
}

export interface DnaMatchResult {
  status: 'eligible' | 'insufficient_signal'
  sharedDnaGenres: SharedDnaGenre[]
  revealableSharedFavoriteTmdbIds: number[]
}

export interface DnaMatchProcessingResult {
  matchV1: MatchV1Result
  canonicalMatchExplanation?: CanonicalMatchExplanationResult
}

export const processDnaMatch = (
  viewerFavorites: FavoriteSignal[],
  otherUserFavorites: FavoriteSignal[],
  explanationContext?: MatchExplanationDisclosureContext,
): DnaMatchProcessingResult => {
  const canonicalMatchExplanation = explanationContext
    ? calculateCanonicalMatchExplanation(viewerFavorites, otherUserFavorites, explanationContext)
    : undefined

  return {
    matchV1:
      canonicalMatchExplanation?.matchV1 ?? calculateMatchV1(viewerFavorites, otherUserFavorites),
    ...(canonicalMatchExplanation ? { canonicalMatchExplanation } : {}),
  }
}

export const shapeDnaMatchForViewer = (
  processedMatch: DnaMatchProcessingResult,
): DnaMatchResult => {
  const canonicalResult = processedMatch.canonicalMatchExplanation
  if (!canonicalResult) {
    throw new Error('Canonical Match Explanation is required for the public DNA Match response')
  }

  if (canonicalResult.matchExplanation === null) {
    return {
      status: 'insufficient_signal',
      sharedDnaGenres: [],
      revealableSharedFavoriteTmdbIds: [],
    }
  }

  return {
    status: 'eligible',
    sharedDnaGenres: canonicalResult.matchExplanation.sharedDnaGenres,
    revealableSharedFavoriteTmdbIds: canonicalResult.matchExplanation.revealableSharedFavorites.map(
      ({ tmdbId }) => tmdbId,
    ),
  }
}

export const calculateDnaMatch = (
  viewerFavorites: FavoriteSignal[],
  otherUserFavorites: FavoriteSignal[],
  explanationContext: MatchExplanationDisclosureContext,
): DnaMatchResult =>
  shapeDnaMatchForViewer(processDnaMatch(viewerFavorites, otherUserFavorites, explanationContext))

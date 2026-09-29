import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  calculateDnaMatch,
  processDnaMatch,
  shapeDnaMatchForViewer,
} from '../dist/services/dnaMatchService.js'

const viewerId = '64b64c0a4f4c6a2e9c6d1001'
const otherUserId = '64b64c0a4f4c6a2e9c6d1002'
const disclosure = (otherUserFavoritesVisibility) => ({
  viewerId,
  otherUserId,
  otherUserFavoritesVisibility,
})

const viewerFavorites = [
  { tmdbId: 550, genreIds: [18, 28] },
  { tmdbId: 155, genreIds: [18, 35] },
  { tmdbId: 278, genreIds: [53] },
]

const otherFavorites = [
  { tmdbId: 550, genreIds: [18, 28] },
  { tmdbId: 13, genreIds: [18, 35] },
  { tmdbId: 680, genreIds: [53] },
]

const forbiddenPublicFields = [
  'strategy',
  'strategyStatus',
  'sharedGenres',
  'favoriteComparisonAvailable',
  'sharedFavoriteTmdbIds',
  'favoritesPublic',
  'visibility',
  'matchV1',
  'matchScore',
  'genreSimilarity',
  'favoriteSimilarity',
  'internalSharedFavorites',
  'internalSharedFavoriteCount',
  'diagnostics',
]

describe('canonical public DNA Match response', () => {
  it('exposes canonical Shared DNA Genres in canonical order and authorized Favorite IDs only', () => {
    const result = calculateDnaMatch(viewerFavorites, otherFavorites, disclosure('public'))

    assert.deepEqual(result, {
      status: 'eligible',
      sharedDnaGenres: [
        { genreId: 18, sharedGenreStrength: 40 },
        { genreId: 28, sharedGenreStrength: 20 },
        { genreId: 35, sharedGenreStrength: 20 },
      ],
      revealableSharedFavoriteTmdbIds: [550],
    })
    for (const field of forbiddenPublicFields) assert.equal(field in result, false)
  })

  it('keeps private Favorites processable while exposing no private overlap fact', () => {
    const result = calculateDnaMatch(viewerFavorites, otherFavorites, disclosure('private'))

    assert.deepEqual(result, {
      status: 'eligible',
      sharedDnaGenres: [
        { genreId: 18, sharedGenreStrength: 40 },
        { genreId: 28, sharedGenreStrength: 20 },
        { genreId: 35, sharedGenreStrength: 20 },
      ],
      revealableSharedFavoriteTmdbIds: [],
    })
    for (const field of forbiddenPublicFields) assert.equal(field in result, false)
  })

  it('keeps an eligible zero score distinct from insufficient signal', () => {
    const zeroScore = calculateDnaMatch(
      [
        { tmdbId: 1, genreIds: [12] },
        { tmdbId: 2, genreIds: [14] },
        { tmdbId: 3, genreIds: [16] },
      ],
      [
        { tmdbId: 4, genreIds: [18] },
        { tmdbId: 5, genreIds: [28] },
        { tmdbId: 6, genreIds: [35] },
      ],
      disclosure('private'),
    )
    const insufficientSignal = calculateDnaMatch(
      viewerFavorites.slice(0, 2),
      otherFavorites,
      disclosure('public'),
    )

    assert.deepEqual(zeroScore, {
      status: 'eligible',
      sharedDnaGenres: [],
      revealableSharedFavoriteTmdbIds: [],
    })
    assert.deepEqual(insufficientSignal, {
      status: 'insufficient_signal',
      sharedDnaGenres: [],
      revealableSharedFavoriteTmdbIds: [],
    })
  })

  it('requires the CP9 canonical result instead of recalculating explanation in the shaper', () => {
    const withoutExplanation = processDnaMatch(viewerFavorites, otherFavorites)

    assert.throws(
      () => shapeDnaMatchForViewer(withoutExplanation),
      /Canonical Match Explanation is required/,
    )
  })
})

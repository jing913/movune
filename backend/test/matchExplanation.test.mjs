import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { calculateCanonicalMatchExplanation } from '../dist/services/matchExplanationService.js'
import { calculateMatchV1 } from '../dist/services/matchV1Service.js'
import { calculateMovieDna } from '../dist/services/movieDnaService.js'

const viewerId = '64b64c0a4f4c6a2e9c6d1001'
const otherUserId = '64b64c0a4f4c6a2e9c6d1002'

const disclosure = (otherUserFavoritesVisibility) => ({
  viewerId,
  otherUserId,
  otherUserFavoritesVisibility,
})

const favorites = (...entries) => entries.map(([tmdbId, genreIds]) => ({ tmdbId, genreIds }))

const calculate = (viewerFavorites, otherUserFavorites, visibility = 'public') =>
  calculateCanonicalMatchExplanation(viewerFavorites, otherUserFavorites, disclosure(visibility))

describe('Canonical Match Explanation Shared DNA Genres', () => {
  it('uses the exact canonical GenreSet intersection without non-shared fill or duplicates', () => {
    const result = calculate(
      favorites([1, [18, 18, 28]], [2, [18, 35]], [3, [53]]),
      favorites([4, [18, 18, 28]], [5, [28, 12]], [6, [14]]),
    )

    assert.equal(result.matchV1.matchEligibility, 'eligible')
    assert.deepEqual(
      result.matchExplanation.sharedDnaGenres.map(({ genreId }) => genreId),
      [18, 28],
    )
  })

  it('reuses canonical Movie DNA percentage and takes the lower strength', () => {
    const viewerFavorites = favorites([1, [18, 28]], [2, [18]], [3, [18]], [7, [18]])
    const otherFavorites = favorites([4, [18, 28]], [5, [28]], [6, [35]])
    const viewerDna = calculateMovieDna(viewerFavorites)
    const otherDna = calculateMovieDna(otherFavorites)
    const result = calculate(viewerFavorites, otherFavorites)

    assert.deepEqual(result.matchExplanation.sharedDnaGenres, [
      {
        genreId: 18,
        sharedGenreStrength: Math.min(
          viewerDna.genres.find(({ genreId }) => genreId === 18).percentage,
          otherDna.genres.find(({ genreId }) => genreId === 18).percentage,
        ),
      },
      {
        genreId: 28,
        sharedGenreStrength: Math.min(
          viewerDna.genres.find(({ genreId }) => genreId === 28).percentage,
          otherDna.genres.find(({ genreId }) => genreId === 28).percentage,
        ),
      },
    ])
  })

  it('orders by strength descending, caps at three, and breaks exact ties by genreId', () => {
    const result = calculate(
      favorites([1, [18, 28, 35, 53]], [2, [18, 28, 35]], [3, [18, 28]], [4, [18]]),
      favorites([5, [18, 28, 35, 53]], [6, [18, 28, 35]], [7, [18, 28]], [8, [18]]),
    )

    assert.deepEqual(result.matchExplanation.sharedDnaGenres, [
      { genreId: 18, sharedGenreStrength: 40 },
      { genreId: 28, sharedGenreStrength: 30 },
      { genreId: 35, sharedGenreStrength: 20 },
    ])

    const tied = calculate(
      favorites([11, [53, 18]], [12, [35, 28]], [13, [12]]),
      favorites([21, [53, 18]], [22, [35, 28]], [23, [14]]),
    )
    assert.deepEqual(
      tied.matchExplanation.sharedDnaGenres.map(({ genreId }) => genreId),
      [18, 28, 35],
    )
  })

  it('returns exact empty, one-item, and two-item explanations without filling', () => {
    const cases = [
      [favorites([1, [18]], [2, [28]], [3, [35]]), favorites([4, [12]], [5, [14]], [6, [16]]), []],
      [
        favorites([1, [18]], [2, [28]], [3, [35]]),
        favorites([4, [18]], [5, [14]], [6, [16]]),
        [18],
      ],
      [
        favorites([1, [18]], [2, [28]], [3, [35]]),
        favorites([4, [18]], [5, [28]], [6, [16]]),
        [18, 28],
      ],
    ]

    for (const [viewerFavorites, otherFavorites, expectedGenreIds] of cases) {
      const result = calculate(viewerFavorites, otherFavorites)
      assert.deepEqual(
        result.matchExplanation.sharedDnaGenres.map(({ genreId }) => genreId),
        expectedGenreIds,
      )
    }
  })

  it('is independent from Favorites visibility and Collection membership', () => {
    const viewerFavorites = favorites([1, [18]], [2, [28]], [3, [35]])
    const otherFavorites = favorites([4, [18]], [5, [28]], [6, [53]])
    const collectionMemberships = [{ tmdbId: 999, genreIds: [12] }]
    const publicResult = calculate(viewerFavorites, otherFavorites, 'public')
    const privateResult = calculate(viewerFavorites, otherFavorites, 'private')

    assert.equal(collectionMemberships.length, 1)
    assert.deepEqual(
      privateResult.matchExplanation.sharedDnaGenres,
      publicResult.matchExplanation.sharedDnaGenres,
    )
  })

  it('does not alter GenreSimilarity or MatchScore through strength or presentation ordering', () => {
    const viewerFavorites = favorites(
      [1, [18, 28, 35, 53]],
      [2, [18, 28, 35]],
      [3, [18, 28]],
      [4, [18]],
    )
    const otherFavorites = favorites(
      [5, [18, 28, 35, 53]],
      [6, [18, 28, 35]],
      [7, [18, 28]],
      [8, [18]],
    )
    const baseline = calculateMatchV1(viewerFavorites, otherFavorites)
    const explained = calculate(viewerFavorites, otherFavorites)

    assert.equal(explained.matchV1.genreSimilarity, baseline.genreSimilarity)
    assert.equal(explained.matchV1.favoriteSimilarity, baseline.favoriteSimilarity)
    assert.equal(explained.matchV1.matchScore, baseline.matchScore)
    assert.equal(explained.matchExplanation.sharedDnaGenres.length, 3)
  })
})

describe('Canonical Match Explanation Revealable Shared Favorites', () => {
  const viewerFavorites = favorites([1, [18]], [2, [28]], [3, [35]])
  const otherFavorites = favorites([1, [18]], [4, [28]], [5, [35]])

  it('reveals internally shared identities only through Favorites disclosure policy', () => {
    assert.deepEqual(calculate(viewerFavorites, otherFavorites, 'public').matchExplanation, {
      sharedDnaGenres: [
        { genreId: 18, sharedGenreStrength: 33.3 },
        { genreId: 28, sharedGenreStrength: 33.3 },
        { genreId: 35, sharedGenreStrength: 33.3 },
      ],
      revealableSharedFavorites: [{ tmdbId: 1 }],
    })
    assert.deepEqual(
      calculate(viewerFavorites, otherFavorites, 'private').matchExplanation
        .revealableSharedFavorites,
      [],
    )
  })

  it('keeps private overlap in FavoriteSimilarity without leaking identity, count, or existence', () => {
    const result = calculate(viewerFavorites, otherFavorites, 'private')

    assert.equal(result.matchV1.favoriteSimilarity, 1 / 5)
    assert.deepEqual(result.matchExplanation.revealableSharedFavorites, [])
    assert.deepEqual(Object.keys(result.matchExplanation).sort(), [
      'revealableSharedFavorites',
      'sharedDnaGenres',
    ])
  })

  it('lets visibility transitions change disclosure only, not Match v1 or Shared DNA Genres', () => {
    const privateResult = calculate(viewerFavorites, otherFavorites, 'private')
    const publicResult = calculate(viewerFavorites, otherFavorites, 'public')

    assert.deepEqual(privateResult.matchV1, publicResult.matchV1)
    assert.deepEqual(
      privateResult.matchExplanation.sharedDnaGenres,
      publicResult.matchExplanation.sharedDnaGenres,
    )
    assert.deepEqual(privateResult.matchExplanation.revealableSharedFavorites, [])
    assert.deepEqual(publicResult.matchExplanation.revealableSharedFavorites, [{ tmdbId: 1 }])
  })

  it('does not accept Public Collection membership as Favorite disclosure authorization', () => {
    const privateResult = calculate(viewerFavorites, otherFavorites, 'private')
    const publicCollectionMemberships = [{ tmdbId: 1, visibility: 'public' }]

    assert.equal(publicCollectionMemberships.length, 1)
    assert.deepEqual(privateResult.matchExplanation.revealableSharedFavorites, [])
  })

  it('keeps zero revealable overlap valid for eligible zero-score and positive-score pairs', () => {
    const privateOverlap = calculate(viewerFavorites, otherFavorites, 'private')
    const zeroScore = calculate(
      favorites([11, [12]], [12, [14]], [13, [16]]),
      favorites([21, [18]], [22, [28]], [23, [35]]),
      'private',
    )

    assert.equal(privateOverlap.matchV1.matchEligibility, 'eligible')
    assert.equal(privateOverlap.matchV1.favoriteSimilarity > 0, true)
    assert.deepEqual(privateOverlap.matchExplanation.revealableSharedFavorites, [])
    assert.equal(zeroScore.matchV1.matchEligibility, 'eligible')
    assert.equal(zeroScore.matchV1.matchScore, 0)
    assert.deepEqual(zeroScore.matchExplanation, {
      sharedDnaGenres: [],
      revealableSharedFavorites: [],
    })
  })

  it('does not fabricate formal explanation for insufficient signal', () => {
    const result = calculate(viewerFavorites.slice(0, 2), otherFavorites, 'public')

    assert.equal(result.matchV1.matchEligibility, 'insufficient_signal')
    assert.equal(result.matchV1.matchScore, null)
    assert.equal(result.matchExplanation, null)
  })
})

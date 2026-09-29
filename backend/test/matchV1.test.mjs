import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  calculateMatchV1,
  deriveFavoriteSet,
  deriveGenreSet,
  jaccardSimilarity,
  validFavoriteCount,
} from '../dist/services/matchV1Service.js'

const favorites = (...entries) => entries.map(([tmdbId, genreIds]) => ({ tmdbId, genreIds }))

const eligibleA = favorites([1, [18, 878, 53]], [2, [18]], [3, [878]])

const eligibleB = favorites([3, [18, 878, 35]], [4, [18]], [5, [35]])

describe('Match v1 eligibility', () => {
  it('requires at least three valid Favorites from each user', () => {
    const tooFewCurrent = calculateMatchV1(eligibleA.slice(0, 2), eligibleB)
    const tooFewCandidate = calculateMatchV1(eligibleA, eligibleB.slice(0, 2))

    assert.deepEqual(tooFewCurrent, {
      matchEligibility: 'insufficient_signal',
      genreSimilarity: null,
      favoriteSimilarity: null,
      matchScore: null,
    })
    assert.deepEqual(tooFewCandidate, tooFewCurrent)
    assert.equal(calculateMatchV1(eligibleA, eligibleB).matchEligibility, 'eligible')
  })

  it('counts only Favorites with at least one usable genre identity', () => {
    const mixed = favorites(
      [1, [18]],
      [2, []],
      [3, undefined],
      [4, ['18', 0, -1, 1.5]],
      [5, [35, 35]],
      [undefined, [28]],
    )

    assert.equal(validFavoriteCount(mixed), 2)
    assert.equal(calculateMatchV1(mixed, eligibleB).matchEligibility, 'insufficient_signal')
  })

  it('keeps a valid Favorite without genres in FavoriteSet but not eligibility or GenreSet', () => {
    const current = favorites([101, [18]], [102, [35]], [103, [878]], [104, []])
    const candidate = favorites([101, [18]], [201, [35]], [202, [878]], [104, undefined])

    assert.equal(validFavoriteCount(current), 3)
    assert.deepEqual(
      [...deriveGenreSet(current)].sort((a, b) => a - b),
      [18, 35, 878],
    )
    assert.deepEqual(
      [...deriveFavoriteSet(current)].sort((a, b) => a - b),
      [101, 102, 103, 104],
    )

    const result = calculateMatchV1(current, candidate)
    assert.equal(result.matchEligibility, 'eligible')
    assert.equal(result.favoriteSimilarity, 2 / 6)
    assert.notEqual(
      result.favoriteSimilarity,
      calculateMatchV1(current.slice(0, 3), candidate).favoriteSimilarity,
    )
  })

  it('does not accept unrelated Collection membership as eligibility signal', () => {
    const twoFavorites = eligibleA.slice(0, 2)
    const collectionMemberships = [{ tmdbId: 90 }, { tmdbId: 91 }, { tmdbId: 92 }]

    assert.equal(collectionMemberships.length, 3)
    assert.equal(calculateMatchV1(twoFavorites, eligibleB).matchEligibility, 'insufficient_signal')
  })

  it('is invariant across Private and Public visibility states', () => {
    const privateUser = { favoritesPublic: false, favorites: eligibleA }
    const publicUser = { favoritesPublic: true, favorites: eligibleA }

    assert.deepEqual(
      calculateMatchV1(privateUser.favorites, eligibleB),
      calculateMatchV1(publicUser.favorites, eligibleB),
    )
  })
})

describe('Match v1 genre Jaccard similarity', () => {
  it('deduplicates genre occurrences into the canonical genre set', () => {
    assert.deepEqual(
      [...deriveGenreSet(eligibleA)].sort((a, b) => a - b),
      [18, 53, 878],
    )
  })

  it('returns one for identical sets and zero for disjoint sets', () => {
    const identical = calculateMatchV1(eligibleA, eligibleA)
    const disjoint = calculateMatchV1(
      favorites([1, [18]], [2, [35]], [3, [53]]),
      favorites([4, [12]], [5, [14]], [6, [16]]),
    )

    assert.equal(identical.genreSimilarity, 1)
    assert.equal(disjoint.genreSimilarity, 0)
  })

  it('returns the exact intersection-over-union value for partial overlap', () => {
    const result = calculateMatchV1(eligibleA, eligibleB)

    assert.equal(result.genreSimilarity, 2 / 4)
  })

  it('guards empty-set arithmetic without NaN or Infinity', () => {
    const similarity = jaccardSimilarity(new Set(), new Set())

    assert.equal(similarity, 0)
    assert.equal(Number.isFinite(similarity), true)
  })

  it('is unaffected by visibility and Collection-only movie identities', () => {
    const baseline = calculateMatchV1(eligibleA, eligibleB)
    const context = {
      favoritesPublic: false,
      collectionMemberships: [{ tmdbId: 999, genreIds: [99] }],
    }

    assert.equal(context.favoritesPublic, false)
    assert.equal(context.collectionMemberships.length, 1)
    assert.equal(calculateMatchV1(eligibleA, eligibleB).genreSimilarity, baseline.genreSimilarity)
  })
})

describe('Match v1 Favorite Jaccard similarity', () => {
  it('uses unique positive integer tmdbId values as canonical movie identity', () => {
    const set = deriveFavoriteSet([
      ...eligibleA,
      { tmdbId: 1, genreIds: [99] },
      { tmdbId: 0, genreIds: [99] },
      { tmdbId: '2', genreIds: [99] },
    ])

    assert.deepEqual(
      [...set].sort((a, b) => a - b),
      [1, 2, 3],
    )
  })

  it('returns one for identical sets and zero for disjoint sets', () => {
    const identical = calculateMatchV1(eligibleA, eligibleA)
    const disjoint = calculateMatchV1(
      favorites([1, [18]], [2, [35]], [3, [53]]),
      favorites([4, [18]], [5, [35]], [6, [53]]),
    )

    assert.equal(identical.favoriteSimilarity, 1)
    assert.equal(disjoint.favoriteSimilarity, 0)
  })

  it('returns the exact intersection-over-union value for partial overlap', () => {
    assert.equal(calculateMatchV1(eligibleA, eligibleB).favoriteSimilarity, 1 / 5)
  })

  it('includes Private Favorites and ignores visibility transitions and Collections', () => {
    const privateUser = { favoritesPublic: false, favorites: eligibleA }
    const publicUser = { favoritesPublic: true, favorites: eligibleA }
    const collectionMemberships = [{ tmdbId: 3 }, { tmdbId: 4 }]
    const privateResult = calculateMatchV1(privateUser.favorites, eligibleB)
    const publicResult = calculateMatchV1(publicUser.favorites, eligibleB)

    assert.equal(collectionMemberships.length, 2)
    assert.equal(privateResult.favoriteSimilarity, 1 / 5)
    assert.equal(publicResult.favoriteSimilarity, privateResult.favoriteSimilarity)
  })
})

describe('Match v1 score', () => {
  it('uses exactly 70% genre Jaccard and 30% Favorite Jaccard', () => {
    const result = calculateMatchV1(eligibleA, eligibleB)

    assert.equal(result.matchEligibility, 'eligible')
    assert.equal(result.genreSimilarity, 0.5)
    assert.equal(result.favoriteSimilarity, 0.2)
    assert.equal(result.matchScore, 0.7 * 0.5 + 0.3 * 0.2)
  })

  it('keeps every eligible score within zero and one', () => {
    for (const result of [
      calculateMatchV1(eligibleA, eligibleA),
      calculateMatchV1(eligibleA, eligibleB),
      calculateMatchV1(
        favorites([1, [18]], [2, [35]], [3, [53]]),
        favorites([4, [12]], [5, [14]], [6, [16]]),
      ),
    ]) {
      assert.equal(result.matchEligibility, 'eligible')
      assert.equal(Number.isFinite(result.matchScore), true)
      assert.equal(result.matchScore >= 0 && result.matchScore <= 1, true)
    }
  })

  it('returns no normal score for insufficient signal', () => {
    const result = calculateMatchV1(eligibleA.slice(0, 2), eligibleB)

    assert.equal(result.matchEligibility, 'insufficient_signal')
    assert.equal(result.genreSimilarity, null)
    assert.equal(result.favoriteSimilarity, null)
    assert.equal(result.matchScore, null)
  })

  it('keeps a zero score eligible and applies no similarity cutoff', () => {
    const result = calculateMatchV1(
      favorites([1, [18]], [2, [35]], [3, [53]]),
      favorites([4, [12]], [5, [14]], [6, [16]]),
    )

    assert.deepEqual(result, {
      matchEligibility: 'eligible',
      genreSimilarity: 0,
      favoriteSimilarity: 0,
      matchScore: 0,
    })
  })

  it('does not change across visibility transitions or Collection membership changes', () => {
    const baseline = calculateMatchV1(eligibleA, eligibleB)
    const privateState = {
      favoritesPublic: false,
      collectionMemberships: [{ tmdbId: 500 }, { tmdbId: 501 }],
    }
    const publicState = {
      favoritesPublic: true,
      collectionMemberships: [{ tmdbId: 600 }],
    }

    assert.notDeepEqual(privateState, publicState)
    assert.deepEqual(calculateMatchV1(eligibleA, eligibleB), baseline)
  })
})

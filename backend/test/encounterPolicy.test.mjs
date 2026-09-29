import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ENCOUNTER_COOLDOWN_EXCLUSION_LIMIT,
  ENCOUNTER_ROUND_LIMIT,
  ENCOUNTER_SESSION_EXCLUSION_LIMIT,
  parseEncounterCooldownIds,
  parseEncounterExclusionIds,
  parseEncounterSessionExclusionIds,
} from '../dist/utils/encounterPolicy.js'
import {
  buildEncounterRound,
  calculateEncounterWeight,
  weightedSampleWithoutReplacement,
} from '../dist/services/encounterService.js'

const favorites = (userId, ...entries) =>
  entries.map(([tmdbId, genreIds]) => ({ userId, tmdbId, genreIds }))

const profile = (id, favoritesPublic = false, extra = {}) => ({
  _id: id,
  account: `user-${id}`,
  displayName: `User ${id}`,
  favoritesPublic,
  ...extra,
})

const viewerFavorites = favorites('viewer', [1, [18, 878]], [2, [18, 28]], [3, [53]])

describe('Encounter session policy', () => {
  it('locks each round to a maximum of five candidates', () => {
    assert.equal(ENCOUNTER_ROUND_LIMIT, 5)
  })

  it('accepts an omitted exclusion list and deduplicates valid ids', () => {
    const id = '507f1f77bcf86cd799439011'
    assert.deepEqual(parseEncounterExclusionIds(undefined), [])
    assert.deepEqual(parseEncounterExclusionIds([id, id]), [id])
    assert.deepEqual(parseEncounterSessionExclusionIds([id, id]), [id])
    assert.deepEqual(parseEncounterCooldownIds([id, id]), [id])
  })

  it('rejects malformed or unbounded session exclusions', () => {
    assert.equal(parseEncounterExclusionIds('507f1f77bcf86cd799439011'), null)
    assert.equal(parseEncounterExclusionIds(['not-an-object-id']), null)
    assert.equal(
      parseEncounterExclusionIds(
        Array.from(
          { length: ENCOUNTER_SESSION_EXCLUSION_LIMIT + 1 },
          () => '507f1f77bcf86cd799439011',
        ),
      ),
      null,
    )
    assert.equal(
      parseEncounterCooldownIds(
        Array.from(
          { length: ENCOUNTER_COOLDOWN_EXCLUSION_LIMIT + 1 },
          () => '507f1f77bcf86cd799439011',
        ),
      ),
      null,
    )
  })
})

describe('Encounter canonical candidate policy', () => {
  it('uses exactly 0.5 + MatchScore and keeps a zero score selectable', () => {
    assert.equal(calculateEncounterWeight(0), 0.5)
    assert.equal(calculateEncounterWeight(0.35), 0.85)
    assert.equal(calculateEncounterWeight(1), 1.5)

    const candidateFavorites = favorites('zero', [10, [12]], [11, [14]], [12, [16]])
    const result = buildEncounterRound({
      viewerId: 'viewer',
      viewerFavorites,
      candidates: [profile('zero')],
      candidateFavorites,
      random: () => 0,
    })

    assert.equal(result.status, 'eligible')
    assert.deepEqual(
      result.candidates.map(({ _id }) => _id),
      ['zero'],
    )
    assert.deepEqual(result.candidates[0].sharedDnaGenres, [])
    assert.deepEqual(result.candidates[0].revealableSharedFavoriteTmdbIds, [])
  })

  it('samples without replacement, caps at five, and preserves a smaller pool', () => {
    const values = [0, 0.99, 0.4, 0.7, 0.2]
    const selected = weightedSampleWithoutReplacement(
      ['a', 'b', 'c', 'd', 'e', 'f'],
      () => 1,
      ENCOUNTER_ROUND_LIMIT,
      () => values.shift() ?? 0,
    )

    assert.equal(selected.length, 5)
    assert.equal(new Set(selected).size, selected.length)
    assert.deepEqual(
      weightedSampleWithoutReplacement(
        ['a', 'b'],
        () => 1,
        ENCOUNTER_ROUND_LIMIT,
        () => 0,
      ),
      ['a', 'b'],
    )
  })

  it('uses canonical eligibility without exact overlap, visibility, or Collection signals', () => {
    const privateEligibleFavorites = favorites('private', [10, [18]], [11, [28]], [12, [53]])
    const publicCollectionOnly = profile('collection-only', true, {
      collections: [{ tmdbIds: [1, 2, 3] }],
    })
    const belowMinimumFavorites = favorites('below', [20, [18]], [21, [28]])
    const result = buildEncounterRound({
      viewerId: 'viewer',
      viewerFavorites,
      candidates: [profile('private', false), publicCollectionOnly, profile('below', true)],
      candidateFavorites: [...privateEligibleFavorites, ...belowMinimumFavorites],
      random: () => 0,
    })

    assert.equal(result.status, 'eligible')
    assert.deepEqual(
      result.candidates.map(({ _id }) => _id),
      ['private'],
    )
    assert.deepEqual(result.candidates[0].revealableSharedFavoriteTmdbIds, [])
  })

  it('returns an explicit insufficient state for a viewer below canonical minimum signal', () => {
    const result = buildEncounterRound({
      viewerId: 'viewer',
      viewerFavorites: viewerFavorites.slice(0, 2),
      candidates: [profile('candidate')],
      candidateFavorites: favorites('candidate', [10, [18]], [11, [28]], [12, [53]]),
    })

    assert.deepEqual(result, { status: 'insufficient_signal', candidates: [] })
  })

  it('applies persistent session exclusions and exactly request-scoped cooldown exclusions', () => {
    const candidateFavorites = [
      ...favorites('revealed', [10, [18]], [11, [28]], [12, [53]]),
      ...favorites('cooldown', [20, [18]], [21, [28]], [22, [53]]),
      ...favorites('available', [30, [18]], [31, [28]], [32, [53]]),
    ]
    const candidates = [profile('revealed'), profile('cooldown'), profile('available')]
    const cooledRound = buildEncounterRound({
      viewerId: 'viewer',
      viewerFavorites,
      candidates,
      candidateFavorites,
      sessionExcludedIds: ['revealed'],
      cooldownIds: ['cooldown'],
      random: () => 0,
    })
    const nextRound = buildEncounterRound({
      viewerId: 'viewer',
      viewerFavorites,
      candidates,
      candidateFavorites,
      sessionExcludedIds: ['revealed'],
      cooldownIds: ['available'],
      random: () => 0,
    })

    assert.deepEqual(
      cooledRound.candidates.map(({ _id }) => _id),
      ['available'],
    )
    assert.deepEqual(
      nextRound.candidates.map(({ _id }) => _id),
      ['cooldown'],
    )
  })

  it('returns canonical explanations in order and reveals shared movies only when authorized', () => {
    const sharedFavorites = favorites('candidate', [1, [18, 878]], [4, [18]], [5, [28]], [6, [53]])
    const privateResult = buildEncounterRound({
      viewerId: 'viewer',
      viewerFavorites,
      candidates: [profile('candidate', false)],
      candidateFavorites: sharedFavorites,
      random: () => 0,
    })
    const publicResult = buildEncounterRound({
      viewerId: 'viewer',
      viewerFavorites,
      candidates: [profile('candidate', true)],
      candidateFavorites: sharedFavorites,
      random: () => 0,
    })

    assert.deepEqual(
      privateResult.candidates[0].sharedDnaGenres.map(({ genreId }) => genreId),
      [18, 28, 53],
    )
    assert.deepEqual(privateResult.candidates[0].revealableSharedFavoriteTmdbIds, [])
    assert.deepEqual(publicResult.candidates[0].revealableSharedFavoriteTmdbIds, [1])
  })

  it('emits a fact-minimized public DTO without processing or legacy fields', () => {
    const result = buildEncounterRound({
      viewerId: 'viewer',
      viewerFavorites,
      candidates: [profile('candidate', true)],
      candidateFavorites: favorites('candidate', [1, [18]], [4, [28]], [5, [53]]),
      random: () => 0,
    })
    const candidate = result.candidates[0]

    for (const forbiddenField of [
      'matchScore',
      'genreSimilarity',
      'favoriteSimilarity',
      'encounterWeight',
      'probability',
      'favoritesPublic',
      'sharedFavoriteCount',
      'sharedFavoriteTmdbIds',
      'movieDnaGenreIds',
      'favoriteSet',
      'diagnostics',
    ]) {
      assert.equal(Object.hasOwn(candidate, forbiddenField), false, forbiddenField)
    }
  })
})

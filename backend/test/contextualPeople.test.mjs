import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import {
  buildFollowingPeople,
  shapeFollowerPeople,
  shapeMovieDetailPeople,
} from '../dist/services/contextualPeopleService.js'

const profile = (id, overrides = {}) => ({
  _id: id,
  account: `user-${id}`,
  displayName: `User ${id}`,
  favoritesPublic: false,
  ...overrides,
})

const favorites = (userId, ...entries) =>
  entries.map(([tmdbId, genreIds]) => ({ userId, tmdbId, genreIds }))

const metadata = (...ids) =>
  new Map(
    ids.map((id, index) => [
      id,
      {
        isFollowing: index === 0,
        followerCount: index + 2,
        followingCount: index + 4,
      },
    ]),
  )

describe('Movie Detail contextual people contract', () => {
  it('returns only identity, social metadata, and the authorized current-movie fact', () => {
    const [person] = shapeMovieDetailPeople([profile('movie')], metadata('movie'))

    assert.deepEqual(Object.keys(person).sort(), [
      '_id',
      'account',
      'alsoFavorited',
      'displayName',
      'followerCount',
      'followingCount',
      'isFollowing',
    ])
    assert.equal(person.alsoFavorited, true)
  })

  it('keeps direct movie authorization, ordering, and pagination in the controller', async () => {
    const source = await readFile(
      new URL('../src/controllers/userController.ts', import.meta.url),
      'utf8',
    )
    const start = source.indexOf('export const getMoviePeople')
    const end = source.indexOf('export const getEncounterCandidates')
    const moviePeopleSource = source.slice(start, end)

    assert.match(moviePeopleSource, /Favorite\.distinct\('userId', \{ tmdbId \}\)/)
    assert.match(moviePeopleSource, /PUBLIC_FAVORITES_PERSISTENCE_MATCH/)
    assert.match(moviePeopleSource, /\.sort\(\{ account: 1, _id: 1 \}\)/)
    assert.match(moviePeopleSource, /\.skip\(\(page - 1\) \* limit\)/)
    assert.match(moviePeopleSource, /\.limit\(limit\)/)
    assert.doesNotMatch(moviePeopleSource, /buildPeopleSummaries/)
  })
})

describe('Following canonical shared-DNA contract', () => {
  const viewerFavorites = favorites('viewer', [1, [18, 878]], [2, [18, 28]], [3, [53]])

  it('uses private Favorites internally and projects at most two genres in canonical order', () => {
    const candidate = profile('following', {
      favoritesPublic: false,
      collections: [{ visibility: 'public', tmdbIds: [1, 2, 3] }],
    })
    const [person] = buildFollowingPeople({
      viewerId: 'viewer',
      viewerFavorites,
      candidates: [candidate],
      candidateFavorites: favorites('following', [10, [18, 878]], [11, [18, 53]], [12, [28]]),
      socialMetadataByUserId: metadata('following'),
    })

    assert.deepEqual(
      person.sharedDnaGenres.map(({ genreId }) => genreId),
      [18, 28],
    )
    assert.equal(person.sharedDnaGenres.length, 2)
    for (const field of [
      'favoritesPublic',
      'sharedGenreIds',
      'sharedFavoriteCount',
      'sharedFavoriteTmdbIds',
      'revealableSharedFavoriteTmdbIds',
      'matchScore',
      'genreSimilarity',
      'favoriteSimilarity',
      'collections',
    ]) {
      assert.equal(Object.hasOwn(person, field), false, field)
    }
  })

  it('returns no fabricated evidence for disjoint or insufficient canonical signals', () => {
    const disjoint = profile('disjoint')
    const insufficient = profile('insufficient')
    const result = buildFollowingPeople({
      viewerId: 'viewer',
      viewerFavorites,
      candidates: [disjoint, insufficient],
      candidateFavorites: [
        ...favorites('disjoint', [20, [12]], [21, [14]], [22, [16]]),
        ...favorites('insufficient', [30, [18]], [31, [28]]),
      ],
      socialMetadataByUserId: metadata('disjoint', 'insufficient'),
    })

    assert.deepEqual(
      result.map(({ sharedDnaGenres }) => sharedDnaGenres),
      [[], []],
    )
  })

  it('uses two bulk Favorite queries rather than one query per followed person', async () => {
    const source = await readFile(
      new URL('../src/services/contextualPeopleService.ts', import.meta.url),
      'utf8',
    )
    const followingLoader = source.slice(
      source.indexOf('export const loadFollowingPeople'),
      source.indexOf('export const loadFollowerPeople'),
    )

    assert.equal(followingLoader.match(/Favorite\.find\(/g)?.length, 2)
    assert.match(followingLoader, /userId: \{ \$in: userIds \}/)
    assert.doesNotMatch(followingLoader, /for \([^)]*\)[\s\S]*Favorite\.find/)
  })
})

describe('Followers relationship-only contract', () => {
  it('preserves order and social metadata without any Match presentation fields', () => {
    const people = shapeFollowerPeople(
      [profile('newest'), profile('older')],
      metadata('newest', 'older'),
    )

    assert.deepEqual(
      people.map(({ _id }) => _id),
      ['newest', 'older'],
    )
    assert.equal(people[0].isFollowing, true)
    for (const person of people) {
      for (const field of [
        'favoritesPublic',
        'sharedGenreIds',
        'sharedFavoriteCount',
        'sharedFavoriteTmdbIds',
        'sharedDnaGenres',
        'revealableSharedFavoriteTmdbIds',
        'matchScore',
      ]) {
        assert.equal(Object.hasOwn(person, field), false, field)
      }
    }
  })

  it('keeps both network directions in Follow createdAt descending order', async () => {
    const source = await readFile(
      new URL('../src/controllers/followController.ts', import.meta.url),
      'utf8',
    )
    const start = source.indexOf('const getMyNetworkUsers')
    const networkSource = source.slice(start)

    assert.match(networkSource, /\.sort\(\{ createdAt: -1 \}\)/)
    assert.match(networkSource, /direction === 'following'/)
    assert.match(networkSource, /loadFollowingPeople/)
    assert.match(networkSource, /loadFollowerPeople/)
    assert.match(
      networkSource,
      /direction === 'following'[\s\S]*\? 'account displayName avatar bio favoritesPublic'[\s\S]*: 'account displayName avatar bio'/,
    )
    assert.match(networkSource, /\.select\(selectedUserFields\)/)
  })
})

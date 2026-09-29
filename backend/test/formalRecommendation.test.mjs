import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import mongoose from 'mongoose'
import { getFormalRecommendations } from '../dist/controllers/formalRecommendationController.js'
import { Favorite } from '../dist/models/favoriteModel.js'
import { Follow } from '../dist/models/followModel.js'
import { User } from '../dist/models/userModel.js'
import userRouter from '../dist/routes/user.js'
import {
  attachFormalRecommendationSocialMetadata,
  buildFormalRecommendations,
  listFormalRecommendations,
} from '../dist/services/formalRecommendationService.js'
import { calculateMatchV1 } from '../dist/services/matchV1Service.js'

const id = (value) => value.toString(16).padStart(24, '0')
const candidate = (value, overrides = {}) => ({
  _id: id(value),
  account: `candidate-${value}`,
  displayName: `Candidate ${value}`,
  favoritesPublic: false,
  ...overrides,
})
const favorites = (...entries) => entries.map(([tmdbId, genreIds]) => ({ tmdbId, genreIds }))
const candidateFavorites = (userId, ...entries) =>
  entries.map(([tmdbId, genreIds]) => ({ userId, tmdbId, genreIds }))

const viewerId = id(100)
const viewerFavorites = favorites([1, [18]], [2, [28]], [3, [35]])

const build = ({
  currentFavorites = viewerFavorites,
  candidates = [],
  allCandidateFavorites = [],
  page = 1,
  limit = 12,
} = {}) => {
  const canonicalResult = buildFormalRecommendations({
    viewerId,
    viewerFavorites: currentFavorites,
    candidates,
    candidateFavorites: allCandidateFavorites,
    page,
    limit,
  })
  const socialMetadata = new Map(
    candidates.map((person) => [
      person._id.toString(),
      {
        isFollowing: person.isFollowing ?? false,
        followerCount: person.followerCount ?? 0,
        followingCount: person.followingCount ?? 0,
      },
    ]),
  )

  return attachFormalRecommendationSocialMetadata(canonicalResult, socialMetadata)
}

const forbiddenItemFields = [
  'favoritesPublic',
  'matchScore',
  'genreSimilarity',
  'favoriteSimilarity',
  'internalSharedFavorites',
  'internalSharedFavoriteCount',
  'favoriteComparisonAvailable',
  'visibility',
  'diagnostics',
]

describe('formal recommendation viewer and candidate eligibility', () => {
  it('distinguishes insufficient viewer signal from an eligible viewer with no candidates', () => {
    assert.deepEqual(build({ currentFavorites: viewerFavorites.slice(0, 2) }), {
      status: 'insufficient_signal',
      items: [],
      pagination: { page: 1, limit: 12, total: 0, totalPages: 0 },
    })
    assert.deepEqual(
      build({
        candidates: [candidate(1)],
        allCandidateFavorites: candidateFavorites(id(1), [10, [18]], [11, [28]]),
      }),
      {
        status: 'eligible',
        items: [],
        pagination: { page: 1, limit: 12, total: 0, totalPages: 0 },
      },
    )
  })

  it('includes Private, 0.35-boundary, and zero-score eligible candidates without a cutoff', () => {
    const exact = candidate(1, { favoritesPublic: true })
    const thresholdBoundary = candidate(2, { favoritesPublic: true })
    const zeroScorePrivate = candidate(3, { favoritesPublic: false })
    const insufficient = candidate(4, { favoritesPublic: true })
    const result = build({
      candidates: [zeroScorePrivate, insufficient, thresholdBoundary, exact],
      allCandidateFavorites: [
        ...candidateFavorites(exact._id, [1, [18]], [2, [28]], [3, [35]]),
        ...candidateFavorites(thresholdBoundary._id, [10, [18]], [11, [28]], [12, [53]]),
        ...candidateFavorites(zeroScorePrivate._id, [20, [12]], [21, [14]], [22, [16]]),
        ...candidateFavorites(insufficient._id, [30, [18]], [31, [28]]),
      ],
    })

    assert.equal(
      calculateMatchV1(viewerFavorites, favorites([10, [18]], [11, [28]], [12, [53]])).matchScore,
      0.35,
    )

    assert.equal(result.status, 'eligible')
    assert.deepEqual(
      result.items.map((item) => item._id),
      [exact._id, thresholdBoundary._id, zeroScorePrivate._id],
    )
    assert.deepEqual(result.items[2].sharedDnaGenres, [])
    assert.deepEqual(result.items[2].revealableSharedFavoriteTmdbIds, [])
    assert.equal(
      result.items.some((item) => item._id === insufficient._id),
      false,
    )
  })

  it('uses canonical FavoriteSet behavior for genre-less valid Favorites', () => {
    const withGenreLessOverlap = candidate(1)
    const withoutGenreLessOverlap = candidate(2)
    const currentFavorites = [...viewerFavorites, { tmdbId: 99, genreIds: [] }]
    const result = build({
      currentFavorites,
      candidates: [withoutGenreLessOverlap, withGenreLessOverlap],
      allCandidateFavorites: [
        ...candidateFavorites(
          withGenreLessOverlap._id,
          [10, [18]],
          [11, [28]],
          [12, [35]],
          [99, []],
        ),
        ...candidateFavorites(withoutGenreLessOverlap._id, [10, [18]], [11, [28]], [12, [35]]),
      ],
    })

    assert.deepEqual(
      result.items.map((item) => item._id),
      [withGenreLessOverlap._id, withoutGenreLessOverlap._id],
    )
  })
})

describe('formal recommendation ranking and pagination', () => {
  it('ranks the complete eligible pool by MatchScore before pagination', () => {
    const lower = candidate(1)
    const higher = candidate(2)
    const allCandidateFavorites = [
      ...candidateFavorites(lower._id, [10, [18]], [11, [28]], [12, [53]]),
      ...candidateFavorites(higher._id, [1, [18]], [2, [28]], [3, [35]]),
    ]

    assert.deepEqual(
      build({ candidates: [lower, higher], allCandidateFavorites, page: 1, limit: 1 }).items.map(
        (item) => item._id,
      ),
      [higher._id],
    )
    assert.deepEqual(
      build({ candidates: [lower, higher], allCandidateFavorites, page: 2, limit: 1 }).items.map(
        (item) => item._id,
      ),
      [lower._id],
    )
  })

  it('uses ObjectId ascending only for technical stability on exact score ties', () => {
    const first = candidate(1, {
      favoritesPublic: false,
      createdAt: new Date('2030-01-01'),
      publicFavoriteCount: 0,
      sharedFavoriteCount: 0,
    })
    const second = candidate(2, {
      favoritesPublic: true,
      createdAt: new Date('2020-01-01'),
      publicFavoriteCount: 999,
      sharedFavoriteCount: 999,
    })
    const identicalSignals = (userId) =>
      candidateFavorites(userId, [10, [18]], [11, [28]], [12, [35]])
    const result = build({
      candidates: [second, first],
      allCandidateFavorites: [...identicalSignals(second._id), ...identicalSignals(first._id)],
    })

    assert.deepEqual(
      result.items.map((item) => item._id),
      [first._id, second._id],
    )
  })

  it('keeps ranking invariant across visibility and unrelated Collection state', () => {
    const first = candidate(1, { favoritesPublic: false, collections: [{ tmdbId: 999 }] })
    const second = candidate(2, { favoritesPublic: true, collections: [] })
    const allCandidateFavorites = [
      ...candidateFavorites(first._id, [1, [18]], [4, [28]], [5, [53]]),
      ...candidateFavorites(second._id, [10, [18]], [11, [28]], [12, [53]]),
    ]
    const before = build({ candidates: [first, second], allCandidateFavorites })
    const after = build({
      candidates: [
        { ...first, favoritesPublic: true, collections: [] },
        { ...second, favoritesPublic: false, collections: [{ tmdbId: 1 }] },
      ],
      allCandidateFavorites,
    })

    assert.deepEqual(
      after.items.map((item) => item._id),
      before.items.map((item) => item._id),
    )
    assert.deepEqual(
      after.items.map((item) => item.sharedDnaGenres),
      before.items.map((item) => item.sharedDnaGenres),
    )
    assert.deepEqual(
      before.items.map((item) => item.revealableSharedFavoriteTmdbIds),
      [[], []],
    )
    assert.deepEqual(
      after.items.map((item) => item.revealableSharedFavoriteTmdbIds),
      [[1], []],
    )
  })
})

describe('formal recommendation public boundary', () => {
  it('returns only minimized identity and canonical explanation fields', () => {
    const person = candidate(1, {
      favoritesPublic: false,
      avatar: 'avatar.png',
      bio: 'bio',
    })
    const result = build({
      candidates: [person],
      allCandidateFavorites: candidateFavorites(person._id, [1, [18]], [4, [28]], [5, [35]]),
    })
    const item = result.items[0]

    assert.deepEqual(Object.keys(item).sort(), [
      '_id',
      'account',
      'avatar',
      'bio',
      'displayName',
      'followerCount',
      'followingCount',
      'isFollowing',
      'revealableSharedFavoriteTmdbIds',
      'sharedDnaGenres',
    ])
    for (const field of forbiddenItemFields) assert.equal(field in item, false)
  })

  it('registers the authenticated formal controller before dynamic routes', () => {
    const routes = userRouter.stack.flatMap((layer) => (layer.route ? [layer.route] : []))
    const generalIndex = routes.findIndex((route) => route.path === '/')
    const formalIndex = routes.findIndex((route) => route.path === '/recommendations')
    const dynamicIndex = routes.findIndex((route) => route.path === '/:id')
    const formalRoute = routes[formalIndex]

    assert.equal(generalIndex >= 0, true)
    assert.equal(formalIndex > generalIndex, true)
    assert.equal(dynamicIndex > formalIndex, true)
    assert.equal(formalRoute.methods.get, true)
    assert.deepEqual(
      formalRoute.stack.map((layer) => layer.handle.name),
      ['authenticate', 'getFormalRecommendations'],
    )
    assert.equal('isFallback' in build(), false)
  })

  it('requires authentication and validates pagination as normal request errors', async () => {
    const invoke = async ({ user, query = {} } = {}) => {
      const response = { status: 200, body: undefined }
      const res = {
        status(value) {
          response.status = value
          return this
        },
        json(value) {
          response.body = value
          return this
        },
      }
      await getFormalRecommendations({ user, query }, res, (error) => {
        throw error
      })
      return response
    }

    assert.deepEqual(await invoke(), { status: 401, body: { message: 'Unauthorized' } })
    assert.deepEqual(await invoke({ user: { _id: viewerId }, query: { limit: '31' } }), {
      status: 400,
      body: { message: 'Invalid recommendations query' },
    })
  })
})

async function databaseUrl() {
  if (process.env.DB_URL) return process.env.DB_URL
  const env = await readFile(new URL('../.env', import.meta.url), 'utf8')
  const line = env.split(/\r?\n/).find((entry) => entry.startsWith('DB_URL='))
  return line?.slice('DB_URL='.length)
}

describe('formal recommendation social metadata', { timeout: 60_000 }, () => {
  let viewer
  let higherMatch
  let lowerMatch
  let ineligible
  let otherUsers
  let userIds

  before(async () => {
    const url = await databaseUrl()
    if (!url) throw new Error('DB_URL is required for formal recommendation social tests')
    await mongoose.connect(url)

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    ;[viewer, higherMatch, lowerMatch, ineligible, ...otherUsers] = await User.create(
      ['viewer', 'higher', 'lower', 'ineligible', 'other-a', 'other-b', 'other-c'].map(
        (account) => ({
          account: `p7-formal-${account}-${suffix}`,
          email: `p7-formal-${account}-${suffix}@test.invalid`,
          password: 'not-used',
          role: 'user',
          favoritesPublic: false,
        }),
      ),
    )
    userIds = [viewer, higherMatch, lowerMatch, ineligible, ...otherUsers].map((user) => user._id)

    await Favorite.insertMany([
      ...candidateFavorites(viewer._id, [1, [18]], [2, [28]], [3, [35]]),
      ...candidateFavorites(higherMatch._id, [1, [18]], [2, [28]], [3, [35]]),
      ...candidateFavorites(lowerMatch._id, [10, [18]], [11, [28]], [12, [53]]),
      ...candidateFavorites(ineligible._id, [20, [18]], [21, [28]]),
    ])
    await Follow.insertMany([
      { followerId: viewer._id, followingId: higherMatch._id },
      { followerId: viewer._id, followingId: ineligible._id },
      ...otherUsers.map((user) => ({ followerId: user._id, followingId: lowerMatch._id })),
      { followerId: higherMatch._id, followingId: otherUsers[0]._id },
      { followerId: higherMatch._id, followingId: otherUsers[1]._id },
    ])
  })

  after(async () => {
    await Follow.deleteMany({
      $or: [{ followerId: { $in: userIds } }, { followingId: { $in: userIds } }],
    })
    await Favorite.deleteMany({ userId: { $in: userIds } })
    await User.deleteMany({ _id: { $in: userIds } })
    await mongoose.disconnect()
  })

  it('bulk-loads viewer-relative follow state and correctly directed counts', async () => {
    const result = await listFormalRecommendations(viewer._id, 1, 30)
    const resultIds = result.items.map((item) => item._id.toString())
    const higherItem = result.items.find(
      (item) => item._id.toString() === higherMatch._id.toString(),
    )
    const lowerItem = result.items.find((item) => item._id.toString() === lowerMatch._id.toString())

    assert.equal(
      resultIds.indexOf(higherMatch._id.toString()) < resultIds.indexOf(lowerMatch._id.toString()),
      true,
    )
    assert.deepEqual(
      {
        isFollowing: higherItem?.isFollowing,
        followerCount: higherItem?.followerCount,
        followingCount: higherItem?.followingCount,
      },
      { isFollowing: true, followerCount: 1, followingCount: 2 },
    )
    assert.deepEqual(
      {
        isFollowing: lowerItem?.isFollowing,
        followerCount: lowerItem?.followerCount,
        followingCount: lowerItem?.followingCount,
      },
      { isFollowing: false, followerCount: 3, followingCount: 0 },
    )
    assert.equal(
      result.items.some((item) => item._id.toString() === ineligible._id.toString()),
      false,
    )
  })

  it('keeps canonical ordering unchanged when viewer follow state changes', async () => {
    const before = await listFormalRecommendations(viewer._id, 1, 30)
    await Follow.deleteOne({ followerId: viewer._id, followingId: higherMatch._id })
    await Follow.create({ followerId: viewer._id, followingId: lowerMatch._id })
    const after = await listFormalRecommendations(viewer._id, 1, 30)

    assert.deepEqual(
      after.items.map((item) => item._id.toString()),
      before.items.map((item) => item._id.toString()),
    )
    assert.deepEqual(
      [higherMatch, lowerMatch].map(
        (candidate) =>
          after.items.find((item) => item._id.toString() === candidate._id.toString())?.isFollowing,
      ),
      [false, true],
    )
  })
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import mongoose from 'mongoose'
import { getEncounterCandidates } from '../dist/controllers/userController.js'
import { Favorite } from '../dist/models/favoriteModel.js'
import { UserBlock } from '../dist/models/userBlockModel.js'
import { User } from '../dist/models/userModel.js'
import { calculateEncounterWeight } from '../dist/services/encounterService.js'
import {
  MATCH_V1_FAVORITE_WEIGHT,
  MATCH_V1_GENRE_WEIGHT,
  calculateMatchV1,
} from '../dist/services/matchV1Service.js'

async function databaseUrl() {
  if (process.env.DB_URL) return process.env.DB_URL
  const env = await readFile(new URL('../.env', import.meta.url), 'utf8')
  return env
    .split(/\r?\n/)
    .find((line) => line.startsWith('DB_URL='))
    ?.slice('DB_URL='.length)
}

async function invoke(user, body = {}) {
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
  await getEncounterCandidates({ user, body }, res, (error) => {
    throw error
  })
  return response
}

async function captureQueries(operation) {
  const previousDebug = mongoose.get('debug')
  const queries = []
  mongoose.set('debug', (collection, method, ...args) => {
    queries.push({ collection, method, args })
  })
  try {
    return { result: await operation(), queries }
  } finally {
    mongoose.set('debug', previousDebug)
  }
}

const ids = (items) => items.map((item) => item._id.toString())

describe('Stage 11 Batch 3 Encounter distribution', { timeout: 120_000 }, () => {
  let viewer
  let insufficientViewer
  let candidates
  let preexistingIds
  let fixtureIds
  let tmdbBase

  before(async () => {
    const url = await databaseUrl()
    if (!url) throw new Error('DB_URL is required for Stage 11 Encounter tests')
    await mongoose.connect(url)

    preexistingIds = (await User.distinct('_id')).map(String)
    assert.ok(preexistingIds.length <= 900, 'fixture isolation exceeds Encounter exclusion limit')

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    tmdbBase = 8_500_000 + Math.floor(Math.random() * 100_000)
    viewer = await User.create({
      account: `p8s11b3-viewer-${suffix}`,
      email: `p8s11b3-viewer-${suffix}@test.invalid`,
      password: 'not-used',
      role: 'user',
      favoritesPublic: true,
    })
    insufficientViewer = await User.create({
      account: `p8s11b3-short-${suffix}`,
      email: `p8s11b3-short-${suffix}@test.invalid`,
      password: 'not-used',
      role: 'user',
      favoritesPublic: true,
    })
    candidates = await User.create(
      Array.from({ length: 7 }, (_, index) => ({
        account: `p8s11b3-${index}-${suffix}`,
        displayName: `Encounter candidate ${index}`,
        email: `p8s11b3-${index}-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
        favoritesPublic: index === 0,
      })),
    )
    fixtureIds = [viewer._id, insufficientViewer._id, ...candidates.map(({ _id }) => _id)]

    const viewerFavorites = [
      { tmdbId: tmdbBase, genreIds: [18, 878] },
      { tmdbId: tmdbBase + 1, genreIds: [28] },
      { tmdbId: tmdbBase + 2, genreIds: [35] },
    ]
    await Favorite.insertMany([
      ...viewerFavorites.map((favorite) => ({ userId: viewer._id, ...favorite })),
      ...viewerFavorites.slice(0, 2).map((favorite) => ({
        userId: insufficientViewer._id,
        ...favorite,
      })),
      ...candidates.flatMap((candidate, index) =>
        (index === 0
          ? viewerFavorites
          : [
              { tmdbId: tmdbBase + 100 + index * 3, genreIds: [18] },
              { tmdbId: tmdbBase + 101 + index * 3, genreIds: [28] },
              { tmdbId: tmdbBase + 102 + index * 3, genreIds: [53] },
            ]
        ).map((favorite) => ({ userId: candidate._id, ...favorite })),
      ),
    ])
    await UserBlock.create([
      { blockerUserId: viewer._id, blockedUserId: candidates[0]._id },
      { blockerUserId: candidates[1]._id, blockedUserId: viewer._id },
    ])
  })

  after(async () => {
    await UserBlock.deleteMany({
      $or: [{ blockerUserId: { $in: fixtureIds } }, { blockedUserId: { $in: fixtureIds } }],
    })
    await Favorite.deleteMany({ userId: { $in: fixtureIds } })
    await User.deleteMany({ _id: { $in: fixtureIds } })
    await mongoose.disconnect()
  })

  it('excludes both Block directions before Favorite loading and fills a 7/2/5 round', async () => {
    const sessionExcludedIds = [...preexistingIds, insufficientViewer._id.toString()]
    const { result: response, queries } = await captureQueries(() =>
      invoke(viewer, { sessionExcludedIds, cooldownIds: [] }),
    )

    assert.equal(response.status, 200)
    assert.equal(response.body.status, 'eligible')
    assert.equal(response.body.candidates.length, 5)
    const distributedIds = ids(response.body.candidates)
    assert.equal(distributedIds.includes(candidates[0]._id.toString()), false)
    assert.equal(distributedIds.includes(candidates[1]._id.toString()), false)
    assert.deepEqual(new Set(distributedIds), new Set(ids(candidates.slice(2))))
    assert.equal(
      queries.filter(({ collection, method }) => collection === 'userblocks' && method === 'find')
        .length,
      1,
    )

    const favoriteQuery = queries.find(
      ({ collection, method, args }) =>
        collection === 'favorites' && method === 'find' && args[0]?.userId?.$in,
    )
    assert.ok(favoriteQuery)
    const loadedFavoriteOwnerIds = new Set(favoriteQuery.args[0].userId.$in.map(String))
    assert.equal(loadedFavoriteOwnerIds.has(candidates[0]._id.toString()), false)
    assert.equal(loadedFavoriteOwnerIds.has(candidates[1]._id.toString()), false)
    assert.equal(
      JSON.stringify(response.body).match(/blocker|blockedBy|blockDirection|isBlocked/g),
      null,
    )
  })

  it('preserves session consumption and one-request cooldown without manufacturing exclusions', async () => {
    const consumedId = candidates[2]._id.toString()
    const cooldownId = candidates[3]._id.toString()
    const sessionExcludedIds = [...preexistingIds, insufficientViewer._id.toString(), consumedId]
    const cooldownIds = [cooldownId]
    const response = await invoke(viewer, { sessionExcludedIds, cooldownIds })

    assert.equal(response.status, 200)
    assert.equal(response.body.candidates.length, 3)
    assert.equal(ids(response.body.candidates).includes(consumedId), false)
    assert.equal(ids(response.body.candidates).includes(cooldownId), false)
    assert.deepEqual(sessionExcludedIds.at(-1), consumedId)
    assert.deepEqual(cooldownIds, [cooldownId])
  })

  it('returns four naturally when exactly four distributable candidates remain', async () => {
    const response = await invoke(viewer, {
      sessionExcludedIds: [
        ...preexistingIds,
        insufficientViewer._id.toString(),
        candidates[2]._id.toString(),
      ],
      cooldownIds: [],
    })
    assert.equal(response.body.status, 'eligible')
    assert.equal(response.body.candidates.length, 4)
  })

  it('performs no Block lookup when viewer signal is insufficient', async () => {
    const { result: response, queries } = await captureQueries(() =>
      invoke(insufficientViewer, { sessionExcludedIds: preexistingIds, cooldownIds: [] }),
    )
    assert.deepEqual(response.body, { status: 'insufficient_signal', candidates: [] })
    assert.equal(
      queries.filter(({ collection, method }) => collection === 'userblocks' && method === 'find')
        .length,
      0,
    )
  })

  it('returns neutral empty when every otherwise eligible candidate is blocked', async () => {
    await UserBlock.create(
      candidates
        .slice(2)
        .map((candidate, index) =>
          index % 2
            ? { blockerUserId: candidate._id, blockedUserId: viewer._id }
            : { blockerUserId: viewer._id, blockedUserId: candidate._id },
        ),
    )
    const response = await invoke(viewer, {
      sessionExcludedIds: [...preexistingIds, insufficientViewer._id.toString()],
      cooldownIds: [],
    })
    assert.deepEqual(response.body, { status: 'eligible', candidates: [] })
  })

  it('recomputes ordinary eligibility after Unblock without changing disclosure or formulas', async () => {
    await UserBlock.deleteOne({ blockerUserId: viewer._id, blockedUserId: candidates[0]._id })
    const response = await invoke(viewer, {
      sessionExcludedIds: [...preexistingIds, insufficientViewer._id.toString()],
      cooldownIds: [],
    })
    assert.equal(response.body.candidates.length, 1)
    assert.equal(response.body.candidates[0]._id.toString(), candidates[0]._id.toString())
    assert.deepEqual(response.body.candidates[0].revealableSharedFavoriteTmdbIds, [
      tmdbBase,
      tmdbBase + 1,
      tmdbBase + 2,
    ])
    assert.equal(MATCH_V1_GENRE_WEIGHT, 0.7)
    assert.equal(MATCH_V1_FAVORITE_WEIGHT, 0.3)
    assert.equal(calculateEncounterWeight(1), 1.5)
    assert.equal(
      calculateMatchV1(
        [
          { tmdbId: 1, genreIds: [18] },
          { tmdbId: 2, genreIds: [28] },
          { tmdbId: 3, genreIds: [35] },
        ],
        [
          { tmdbId: 1, genreIds: [18] },
          { tmdbId: 2, genreIds: [28] },
          { tmdbId: 3, genreIds: [35] },
        ],
      ).matchScore,
      1,
    )
  })
})

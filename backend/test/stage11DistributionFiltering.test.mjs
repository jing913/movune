import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import mongoose from 'mongoose'
import { getMoviePeople, getUsers } from '../dist/controllers/userController.js'
import { Favorite } from '../dist/models/favoriteModel.js'
import { UserBlock } from '../dist/models/userBlockModel.js'
import { User } from '../dist/models/userModel.js'
import { listFormalRecommendations } from '../dist/services/formalRecommendationService.js'
import { calculateMatchV1 } from '../dist/services/matchV1Service.js'

async function databaseUrl() {
  if (process.env.DB_URL) return process.env.DB_URL
  const env = await readFile(new URL('../.env', import.meta.url), 'utf8')
  return env
    .split(/\r?\n/)
    .find((line) => line.startsWith('DB_URL='))
    ?.slice('DB_URL='.length)
}

async function invoke(controller, { user, query = {}, params = {} }) {
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
  await controller({ user, query, params }, res, (error) => {
    throw error
  })
  return response
}

const ids = (items) => items.map((item) => item._id.toString())

describe('Stage 11 Batch 2 distribution filtering', { timeout: 120_000 }, () => {
  let viewer
  let candidates
  let userIds
  let movieTmdbId
  let accountPrefix
  let blockedIds
  let recommendationBeforeBlock

  before(async () => {
    const url = await databaseUrl()
    if (!url) throw new Error('DB_URL is required for Stage 11 distribution tests')
    await mongoose.connect(url)

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    accountPrefix = `p8s11b2-${suffix}`
    movieTmdbId = 8_000_000 + Math.floor(Math.random() * 100_000)
    viewer = await User.create({
      account: `${accountPrefix}-viewer`,
      email: `${accountPrefix}-viewer@test.invalid`,
      password: 'not-used',
      role: 'user',
      favoritesPublic: true,
    })
    candidates = await User.create(
      Array.from({ length: 25 }, (_, index) => ({
        account: `${accountPrefix}-${String(index).padStart(2, '0')}`,
        displayName: `Distribution candidate ${index}`,
        email: `${accountPrefix}-${index}@test.invalid`,
        password: 'not-used',
        role: 'user',
        favoritesPublic: true,
      })),
    )
    userIds = [viewer._id, ...candidates.map((candidate) => candidate._id)]

    const viewerSignals = [
      { tmdbId: movieTmdbId, genreIds: [18] },
      { tmdbId: movieTmdbId + 1, genreIds: [28] },
      { tmdbId: movieTmdbId + 2, genreIds: [35] },
    ]
    await Favorite.insertMany([
      ...viewerSignals.map((favorite) => ({ userId: viewer._id, ...favorite })),
      ...candidates.flatMap((candidate, index) => {
        const signals =
          index === 0
            ? viewerSignals
            : index === 6
              ? [
                  { tmdbId: movieTmdbId, genreIds: [18] },
                  { tmdbId: movieTmdbId + 100 + index, genreIds: [28] },
                  { tmdbId: movieTmdbId + 200 + index, genreIds: [53] },
                ]
              : [
                  { tmdbId: movieTmdbId, genreIds: [100 + index] },
                  { tmdbId: movieTmdbId + 100 + index, genreIds: [200 + index] },
                  { tmdbId: movieTmdbId + 200 + index, genreIds: [300 + index] },
                ]
        return signals.map((favorite) => ({ userId: candidate._id, ...favorite }))
      }),
    ])

    recommendationBeforeBlock = await listFormalRecommendations(viewer._id, 1, 1_000)
    blockedIds = new Set([0, 6, 12, 18].map((index) => candidates[index]._id.toString()))
    await UserBlock.create([
      { blockerUserId: viewer._id, blockedUserId: candidates[0]._id },
      { blockerUserId: candidates[6]._id, blockedUserId: viewer._id },
      { blockerUserId: viewer._id, blockedUserId: candidates[12]._id },
      { blockerUserId: candidates[18]._id, blockedUserId: viewer._id },
    ])
  })

  after(async () => {
    await UserBlock.deleteMany({
      $or: [{ blockerUserId: { $in: userIds } }, { blockedUserId: { $in: userIds } }],
    })
    await Favorite.deleteMany({ userId: { $in: userIds } })
    await User.deleteMany({ _id: { $in: userIds } })
    await mongoose.disconnect()
  })

  it('excludes both Block directions before Explore pagination and count', async () => {
    const pages = []
    for (const page of [1, 2, 3]) {
      const response = await invoke(getUsers, {
        user: viewer,
        query: { search: accountPrefix, page: String(page), limit: '10' },
      })
      assert.equal(response.status, 200)
      pages.push(response.body)
    }

    assert.equal(pages[0].users.length, 10)
    assert.equal(pages[1].users.length, 10)
    assert.equal(pages[2].users.length, 1)
    assert.deepEqual(
      pages.map((page) => page.pagination),
      [1, 2, 3].map((page) => ({ page, limit: 10, total: 21, totalPages: 3 })),
    )
    const distributedIds = pages.flatMap((page) => ids(page.users))
    assert.equal(new Set(distributedIds).size, 21)
    assert.equal(
      distributedIds.some((id) => blockedIds.has(id)),
      false,
    )
    assert.equal(JSON.stringify(pages).match(/blocker|blockedBy|blockDirection|isBlocked/g), null)
  })

  it('preserves movie eligibility while filtering before movie pagination and count', async () => {
    const pages = []
    for (const page of [1, 2, 3]) {
      const response = await invoke(getMoviePeople, {
        user: viewer,
        params: { tmdbId: String(movieTmdbId) },
        query: { page: String(page), limit: '10' },
      })
      assert.equal(response.status, 200)
      pages.push(response.body)
    }

    assert.deepEqual(
      pages.map((page) => page.users.length),
      [10, 10, 1],
    )
    assert.deepEqual(
      pages.map((page) => page.pagination.total),
      [21, 21, 21],
    )
    const distributedIds = pages.flatMap((page) => ids(page.users))
    assert.equal(new Set(distributedIds).size, 21)
    assert.equal(
      distributedIds.some((id) => blockedIds.has(id)),
      false,
    )
    assert.equal(
      pages.flatMap((page) => page.users).every((person) => person.alsoFavorited),
      true,
    )
  })

  it('omits blocked top and middle recommendations without changing allowed ranking', async () => {
    const afterBlock = await listFormalRecommendations(viewer._id, 1, 1_000)
    const beforeIds = ids(recommendationBeforeBlock.items)
    const afterIds = ids(afterBlock.items)
    const expectedAllowedOrder = beforeIds.filter((id) => !blockedIds.has(id))

    assert.equal(beforeIds[0], candidates[0]._id.toString())
    const middleId = candidates[12]._id.toString()
    assert.ok(beforeIds.indexOf(middleId) > 0)
    assert.ok(beforeIds.indexOf(middleId) < beforeIds.length - 1)
    assert.deepEqual(afterIds, expectedAllowedOrder)
    assert.equal(afterBlock.pagination.total, recommendationBeforeBlock.pagination.total - 4)
    assert.equal(
      afterIds.some((id) => blockedIds.has(id)),
      false,
    )
    assert.equal(
      JSON.stringify(afterBlock).match(/matchScore|blocker|blockedBy|blockDirection/g),
      null,
    )

    const viewerFavorites = [
      { tmdbId: movieTmdbId, genreIds: [18] },
      { tmdbId: movieTmdbId + 1, genreIds: [28] },
      { tmdbId: movieTmdbId + 2, genreIds: [35] },
    ]
    const allowedFavorites = [
      { tmdbId: movieTmdbId, genreIds: [101] },
      { tmdbId: movieTmdbId + 101, genreIds: [201] },
      { tmdbId: movieTmdbId + 201, genreIds: [301] },
    ]
    assert.equal(calculateMatchV1(viewerFavorites, allowedFavorites).matchScore, 0.06)
  })

  it('re-evaluates current eligibility after Unblock instead of restoring history', async () => {
    const target = candidates[0]
    await Favorite.deleteMany({ userId: target._id })
    await UserBlock.deleteOne({ blockerUserId: viewer._id, blockedUserId: target._id })

    const afterUnblock = await listFormalRecommendations(viewer._id, 1, 1_000)
    assert.equal(
      afterUnblock.items.some((item) => item._id.toString() === target._id.toString()),
      false,
    )
  })
})

import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import express from 'express'
import jsonwebtoken from 'jsonwebtoken'
import mongoose from 'mongoose'
import { getMyCollectionMembershipsForMovieController } from '../dist/controllers/collectionController.js'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import { Collection } from '../dist/models/collectionModel.js'
import { CollectionMembership } from '../dist/models/collectionMembershipModel.js'
import { Favorite } from '../dist/models/favoriteModel.js'
import { User } from '../dist/models/userModel.js'

process.env.JWT_SECRET ??= 'collection-membership-lookup-test-secret'
await import('../dist/configs/passport.js')
const { default: collectionRouter } = await import('../dist/routes/collection.js')

async function databaseUrl() {
  if (process.env.DB_URL) return process.env.DB_URL
  const env = await readFile(new URL('../.env', import.meta.url), 'utf8')
  const line = env.split(/\r?\n/).find((entry) => entry.startsWith('DB_URL='))
  return line?.slice('DB_URL='.length)
}

async function invoke(controller, { user, query = {} } = {}) {
  const req = { user, query }
  const result = { status: 200, body: undefined }
  const res = {
    status(status) {
      result.status = status
      return this
    },
    json(bodyValue) {
      result.body = bodyValue
      return this
    },
  }
  let controllerError

  await controller(req, res, (error) => {
    controllerError = error
  })
  if (controllerError) errorHandler(controllerError, req, res, () => {})

  return result
}

const startServer = async () => {
  const app = express()
  app.use('/api/collections', collectionRouter)
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

const requestJson = (server, path, token) =>
  new Promise((resolve, reject) => {
    const address = server.address()
    assert(address && typeof address === 'object')
    const request = http.get(
      {
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString()
          try {
            resolve({ status: response.statusCode, body: JSON.parse(body) })
          } catch {
            resolve({ status: response.statusCode, body })
          }
        })
      },
    )
    request.on('error', reject)
  })

describe('movie-relative owner Collection membership read API', { timeout: 60_000 }, () => {
  let owner
  let otherUser
  let ownerPrivate
  let ownerPublic
  let ownerNonMatching
  let ownerDeleted
  let otherUserCollection
  const collectionIds = []
  const targetTmdbId = 550

  before(async () => {
    const url = await databaseUrl()
    if (!url) throw new Error('DB_URL is required for Collection membership lookup tests')

    await mongoose.connect(url)
    await Promise.all([Collection.syncIndexes(), CollectionMembership.syncIndexes()])
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    ;[owner, otherUser] = await User.create([
      {
        account: `p7-membership-lookup-owner-${suffix}`,
        email: `p7-membership-lookup-owner-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      },
      {
        account: `p7-membership-lookup-other-${suffix}`,
        email: `p7-membership-lookup-other-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      },
    ])

    ;[ownerPrivate, ownerPublic, ownerNonMatching, ownerDeleted, otherUserCollection] =
      await Collection.create([
        { ownerId: owner._id, name: 'Owner Private' },
        { ownerId: owner._id, name: 'Owner Public', visibility: 'public' },
        { ownerId: owner._id, name: 'Owner Non-matching' },
        {
          ownerId: owner._id,
          name: 'Owner Deleted',
          lifecycleState: 'deleted',
          deletedAt: new Date(),
        },
        { ownerId: otherUser._id, name: 'Other User', visibility: 'public' },
      ])
    collectionIds.push(
      ownerPrivate._id,
      ownerPublic._id,
      ownerNonMatching._id,
      ownerDeleted._id,
      otherUserCollection._id,
    )
    await CollectionMembership.create([
      { collectionId: ownerPrivate._id, tmdbId: targetTmdbId, position: 0 },
      { collectionId: ownerPublic._id, tmdbId: targetTmdbId, position: 0 },
      { collectionId: ownerNonMatching._id, tmdbId: 551, position: 0 },
      { collectionId: ownerDeleted._id, tmdbId: targetTmdbId, position: 0 },
      { collectionId: otherUserCollection._id, tmdbId: targetTmdbId, position: 0 },
    ])
  })

  after(async () => {
    await CollectionMembership.deleteMany({ collectionId: { $in: collectionIds } })
    await Collection.deleteMany({ _id: { $in: collectionIds } })
    await Favorite.deleteMany({ userId: { $in: [owner?._id, otherUser?._id].filter(Boolean) } })
    await User.deleteMany({ _id: { $in: [owner?._id, otherUser?._id].filter(Boolean) } })
    await mongoose.disconnect()
  })

  it('returns an exact empty projection when no active owner Collection contains the movie', async () => {
    assert.deepEqual(
      await invoke(getMyCollectionMembershipsForMovieController, {
        user: owner,
        query: { tmdbId: '999' },
      }),
      { status: 200, body: { collectionIds: [] } },
    )
  })

  it('returns matching active Private and Public owner Collections only', async () => {
    const response = await invoke(getMyCollectionMembershipsForMovieController, {
      user: owner,
      query: { tmdbId: String(targetTmdbId) },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(
      new Set(response.body.collectionIds),
      new Set([ownerPrivate._id.toString(), ownerPublic._id.toString()]),
    )
    assert.deepEqual(Object.keys(response.body), ['collectionIds'])
  })

  it('does not disclose another user, a deleted Collection, or a non-matching Collection', async () => {
    const response = await invoke(getMyCollectionMembershipsForMovieController, {
      user: owner,
      query: { tmdbId: String(targetTmdbId) },
    })
    const serialized = JSON.stringify(response.body)

    assert.equal(serialized.includes(otherUserCollection._id.toString()), false)
    assert.equal(serialized.includes(ownerDeleted._id.toString()), false)
    assert.equal(serialized.includes(ownerNonMatching._id.toString()), false)
    assert.equal(serialized.includes('Other User'), false)
  })

  it('returns Collection membership without requiring a Favorite', async () => {
    assert.equal(await Favorite.countDocuments({ userId: owner._id, tmdbId: targetTmdbId }), 0)
    const response = await invoke(getMyCollectionMembershipsForMovieController, {
      user: owner,
      query: { tmdbId: String(targetTmdbId) },
    })
    assert.equal(response.body.collectionIds.includes(ownerPrivate._id.toString()), true)
  })

  it('rejects missing, empty, zero, negative, decimal, non-numeric, and array tmdbId values', async () => {
    for (const tmdbId of [undefined, '', '0', '-1', '1.5', 'NaN', 'movie', ['550']]) {
      const response = await invoke(getMyCollectionMembershipsForMovieController, {
        user: owner,
        query: tmdbId === undefined ? {} : { tmdbId },
      })
      assert.equal(response.status, 400)
      assert.deepEqual(response.body, { message: 'A valid tmdbId is required' })
    }
  })

  it('registers the authenticated static route before the existing detail route', async () => {
    const server = await startServer()
    const token = jsonwebtoken.sign({ userId: owner._id.toString() }, process.env.JWT_SECRET)

    try {
      const membershipResponse = await requestJson(
        server,
        `/api/collections/memberships?tmdbId=${targetTmdbId}`,
        token,
      )
      assert.equal(membershipResponse.status, 200)
      assert.equal(
        membershipResponse.body.collectionIds.includes(ownerPrivate._id.toString()),
        true,
      )

      const detailResponse = await requestJson(
        server,
        `/api/collections/${ownerPrivate._id}`,
        token,
      )
      assert.equal(detailResponse.status, 200)
      assert.equal(detailResponse.body.collection._id, ownerPrivate._id.toString())
    } finally {
      server.close()
      await once(server, 'close')
    }
  })

  it('retains existing authentication failure behavior for unauthenticated requests', async () => {
    const server = await startServer()

    try {
      const response = await requestJson(
        server,
        `/api/collections/memberships?tmdbId=${targetTmdbId}`,
      )
      assert.equal(response.status, 401)
    } finally {
      server.close()
      await once(server, 'close')
    }
  })
})

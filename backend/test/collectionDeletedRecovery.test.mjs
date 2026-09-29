import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import express from 'express'
import jsonwebtoken from 'jsonwebtoken'
import mongoose, { Types } from 'mongoose'
import {
  getCollectionController,
  listMyCollectionsController,
  listMyDeletedCollectionsController,
  restoreCollectionController,
} from '../dist/controllers/collectionController.js'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import { Collection } from '../dist/models/collectionModel.js'
import { CollectionMembership } from '../dist/models/collectionMembershipModel.js'
import { Favorite } from '../dist/models/favoriteModel.js'
import { User } from '../dist/models/userModel.js'

const jwtSecret = 'collection-deleted-recovery-test-secret'
process.env.JWT_SECRET ??= jwtSecret
await import('../dist/configs/passport.js')
const { default: collectionRouter } = await import('../dist/routes/collection.js')

async function databaseUrl() {
  if (process.env.DB_URL) return process.env.DB_URL
  const env = await readFile(new URL('../.env', import.meta.url), 'utf8')
  const line = env.split(/\r?\n/).find((entry) => entry.startsWith('DB_URL='))
  return line?.slice('DB_URL='.length)
}

async function invoke(controller, { user, params = {} } = {}) {
  const req = { user, params }
  const result = { status: 200, body: undefined }
  const res = {
    status(status) {
      result.status = status
      return this
    },
    json(body) {
      result.body = body
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

const neutralReadNotFound = {
  status: 404,
  body: {
    error: {
      code: 'RESOURCE_NOT_FOUND',
      message: 'Resource not found',
      details: undefined,
    },
  },
}

describe('deleted Collection recovery read API', { timeout: 60_000 }, () => {
  let owner
  let otherOwner
  let server
  let baseUrl
  const collectionIds = []

  const track = (collection) => {
    collectionIds.push(collection._id)
    return collection
  }

  before(async () => {
    const url = await databaseUrl()
    if (!url) throw new Error('DB_URL is required for deleted Collection recovery tests')
    await mongoose.connect(url)

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    ;[owner, otherOwner] = await User.create([
      {
        account: `p7-recovery-owner-${suffix}`,
        email: `p7-recovery-owner-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      },
      {
        account: `p7-recovery-other-${suffix}`,
        email: `p7-recovery-other-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      },
    ])

    const app = express()
    app.use(express.json())
    app.use('/api/collections', collectionRouter)
    app.use(errorHandler)
    server = app.listen(0)
    await new Promise((resolve) => server.once('listening', resolve))
    const address = server.address()
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    await CollectionMembership.deleteMany({ collectionId: { $in: collectionIds } })
    await Collection.deleteMany({ _id: { $in: collectionIds } })
    await Favorite.deleteMany({ userId: { $in: [owner?._id, otherOwner?._id].filter(Boolean) } })
    await User.deleteMany({ _id: { $in: [owner?._id, otherOwner?._id].filter(Boolean) } })
    await mongoose.disconnect()
  })

  it('returns an exact empty list for an authenticated owner with no deleted Collections', async () => {
    assert.deepEqual(await invoke(listMyDeletedCollectionsController, { user: owner }), {
      status: 200,
      body: { collections: [] },
    })
  })

  it('uses the authenticated static route and preserves the existing auth failure convention', async () => {
    const unauthenticated = await fetch(`${baseUrl}/api/collections/deleted`)
    assert.equal(unauthenticated.status, 401)

    const token = jsonwebtoken.sign({ userId: owner._id.toString() }, process.env.JWT_SECRET)
    const authenticated = await fetch(`${baseUrl}/api/collections/deleted`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(authenticated.status, 200)
    assert.deepEqual(await authenticated.json(), { collections: [] })

    const routePaths = collectionRouter.stack
      .filter((layer) => layer.route)
      .map((layer) => layer.route.path)
    assert.ok(routePaths.indexOf('/deleted') < routePaths.indexOf('/:collectionId'))
  })

  it('returns only minimized owner deleted Collections in deterministic recovery order', async () => {
    const tieLowId = new Types.ObjectId('700000000000000000000001')
    const tieHighId = new Types.ObjectId('700000000000000000000002')
    const [newestPrivate, tieLow, tieHigh, olderPublic, legacyNull, active, otherDeleted] =
      await Collection.create([
        {
          ownerId: owner._id,
          name: 'Newest private',
          description: 'Identify this Collection',
          lifecycleState: 'deleted',
          deletedAt: new Date('2026-04-01T00:00:00.000Z'),
        },
        {
          _id: tieLowId,
          ownerId: owner._id,
          name: 'Tie low',
          lifecycleState: 'deleted',
          deletedAt: new Date('2026-03-01T00:00:00.000Z'),
        },
        {
          _id: tieHighId,
          ownerId: owner._id,
          name: 'Tie high',
          visibility: 'public',
          lifecycleState: 'deleted',
          deletedAt: new Date('2026-03-01T00:00:00.000Z'),
        },
        {
          ownerId: owner._id,
          name: 'Older public',
          visibility: 'public',
          lifecycleState: 'deleted',
          deletedAt: new Date('2026-02-01T00:00:00.000Z'),
        },
        {
          ownerId: owner._id,
          name: 'Legacy null deletion',
          lifecycleState: 'deleted',
          deletedAt: null,
        },
        { ownerId: owner._id, name: 'Active owner Collection' },
        {
          ownerId: otherOwner._id,
          name: 'Other owner deleted',
          lifecycleState: 'deleted',
          deletedAt: new Date('2026-05-01T00:00:00.000Z'),
        },
      ])
    ;[newestPrivate, tieLow, tieHigh, olderPublic, legacyNull, active, otherDeleted].forEach(track)
    await CollectionMembership.create([
      { collectionId: olderPublic._id, tmdbId: 155, position: 1 },
      { collectionId: olderPublic._id, tmdbId: 550, position: 0 },
    ])
    await Favorite.create({ userId: owner._id, tmdbId: 550, genreIds: [18] })

    const response = await invoke(listMyDeletedCollectionsController, { user: owner })
    assert.equal(response.status, 200)
    assert.deepEqual(
      response.body.collections.map((collection) => collection._id.toString()),
      [newestPrivate._id, tieHigh._id, tieLow._id, olderPublic._id, legacyNull._id].map((id) =>
        id.toString(),
      ),
    )
    assert.deepEqual(response.body.collections[0], {
      _id: newestPrivate._id,
      name: 'Newest private',
      description: 'Identify this Collection',
      deletedAt: new Date('2026-04-01T00:00:00.000Z'),
    })
    for (const collection of response.body.collections) {
      assert.deepEqual(
        Object.keys(collection).sort(),
        collection.description === undefined
          ? ['_id', 'deletedAt', 'name']
          : ['_id', 'deletedAt', 'description', 'name'],
      )
      for (const forbiddenField of [
        'ownerId',
        'visibility',
        'lifecycleState',
        'memberships',
        'movieCount',
        'previewMovies',
        'favorites',
        'matchScore',
        'createdAt',
        'updatedAt',
        '__v',
      ]) {
        assert.equal(forbiddenField in collection, false)
      }
    }
    assert.equal(
      response.body.collections.some(({ _id }) => _id.equals(active._id)),
      false,
    )
    assert.equal(
      response.body.collections.some(({ _id }) => _id.equals(otherDeleted._id)),
      false,
    )
  })

  it('preserves deleted-detail non-disclosure and restore visibility, memberships, and order', async () => {
    const deleted = await Collection.findOne({ ownerId: owner._id, name: 'Older public' })
    const deletedId = deleted._id.toString()

    for (const user of [owner, otherOwner]) {
      assert.deepEqual(
        await invoke(getCollectionController, { user, params: { collectionId: deletedId } }),
        neutralReadNotFound,
      )
    }

    const activeBeforeRestore = await invoke(listMyCollectionsController, { user: owner })
    assert.equal(
      activeBeforeRestore.body.collections.some(({ _id }) => _id.toString() === deletedId),
      false,
    )

    const restored = await invoke(restoreCollectionController, {
      user: owner,
      params: { collectionId: deletedId },
    })
    assert.equal(restored.status, 200)
    assert.equal(restored.body.collection.visibility, 'public')
    assert.equal(restored.body.collection.lifecycleState, 'active')
    assert.equal(restored.body.collection.deletedAt, null)

    const detail = await invoke(getCollectionController, {
      user: owner,
      params: { collectionId: deletedId },
    })
    assert.deepEqual(detail.body.collection.memberships, [
      { tmdbId: 550, position: 0 },
      { tmdbId: 155, position: 1 },
    ])
    const activeAfterRestore = await invoke(listMyCollectionsController, { user: owner })
    assert.equal(
      activeAfterRestore.body.collections.some(({ _id }) => _id.toString() === deletedId),
      true,
    )
    const deletedAfterRestore = await invoke(listMyDeletedCollectionsController, { user: owner })
    assert.equal(
      deletedAfterRestore.body.collections.some(({ _id }) => _id.toString() === deletedId),
      false,
    )
    assert.equal(await Favorite.countDocuments({ userId: owner._id, tmdbId: 550 }), 1)
  })
})

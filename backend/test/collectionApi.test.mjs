import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import mongoose, { Types } from 'mongoose'
import {
  createCollectionController,
  deleteCollectionController,
  getCollectionController,
  listMyCollectionsController,
  restoreCollectionController,
  updateCollectionController,
} from '../dist/controllers/collectionController.js'
import { getMovieSpace } from '../dist/controllers/userController.js'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import { Collection } from '../dist/models/collectionModel.js'
import { CollectionMembership } from '../dist/models/collectionMembershipModel.js'
import { Favorite } from '../dist/models/favoriteModel.js'
import { User } from '../dist/models/userModel.js'
import {
  canManageCollection,
  canRecoverCollection,
  canViewCollection,
  canViewCollectionMembership,
} from '../dist/utils/collectionAuthorizationPolicy.js'

async function databaseUrl() {
  if (process.env.DB_URL) return process.env.DB_URL
  const env = await readFile(new URL('../.env', import.meta.url), 'utf8')
  const line = env.split(/\r?\n/).find((entry) => entry.startsWith('DB_URL='))
  return line?.slice('DB_URL='.length)
}

async function invoke(controller, { user, params = {}, body = {} } = {}) {
  const req = { user, params, body }
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
  if (controllerError) {
    errorHandler(controllerError, req, res, () => {})
  }

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

describe('Collection authorization policy', () => {
  const ownerId = new Types.ObjectId()
  const visitorId = new Types.ObjectId()
  const activePrivate = { ownerId, visibility: 'private', lifecycleState: 'active' }
  const activePublic = { ownerId, visibility: 'public', lifecycleState: 'active' }
  const deletedPublic = { ownerId, visibility: 'public', lifecycleState: 'deleted' }

  it('separates owner management from active Collection visibility', () => {
    assert.equal(canViewCollection(activePrivate, ownerId), true)
    assert.equal(canManageCollection(activePrivate, ownerId), true)
    assert.equal(canViewCollectionMembership(activePrivate, ownerId), true)
    assert.equal(canManageCollection(activePublic, visitorId), false)
    assert.equal(canManageCollection(activePublic, undefined), false)
  })

  it('allows public reads but denies private and deleted reads to visitors', () => {
    assert.equal(canViewCollection(activePublic, visitorId), true)
    assert.equal(canViewCollection(activePublic, undefined), true)
    assert.equal(canViewCollectionMembership(activePublic, visitorId), true)
    assert.equal(canViewCollection(activePrivate, visitorId), false)
    assert.equal(canViewCollectionMembership(activePrivate, visitorId), false)
    assert.equal(canViewCollection(deletedPublic, visitorId), false)
  })

  it('reserves deleted Collection recovery for the owner', () => {
    assert.equal(canViewCollection(deletedPublic, ownerId), false)
    assert.equal(canManageCollection(deletedPublic, ownerId), false)
    assert.equal(canRecoverCollection(deletedPublic, ownerId), true)
    assert.equal(canRecoverCollection(deletedPublic, visitorId), false)
  })
})

describe('Collection resource API boundary', { timeout: 60_000 }, () => {
  let owner
  let visitor
  const collectionIds = []

  before(async () => {
    const url = await databaseUrl()
    if (!url) throw new Error('DB_URL is required for Collection API tests')

    await mongoose.connect(url)
    await Promise.all([Collection.syncIndexes(), CollectionMembership.syncIndexes()])
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    ;[owner, visitor] = await User.create([
      {
        account: `p7-api-owner-${suffix}`,
        email: `p7-api-owner-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      },
      {
        account: `p7-api-visitor-${suffix}`,
        email: `p7-api-visitor-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      },
    ])
  })

  after(async () => {
    await CollectionMembership.deleteMany({ collectionId: { $in: collectionIds } })
    await Collection.deleteMany({ _id: { $in: collectionIds } })
    await Favorite.deleteMany({ userId: { $in: [owner?._id, visitor?._id].filter(Boolean) } })
    await User.deleteMany({ _id: { $in: [owner?._id, visitor?._id].filter(Boolean) } })
    await mongoose.disconnect()
  })

  const track = (collection) => {
    collectionIds.push(collection._id)
    return collection
  }

  it('creates from authenticated ownership with private default and strict metadata validation', async () => {
    const attemptedOwnerId = visitor._id.toString()
    const created = await invoke(createCollectionController, {
      user: owner,
      body: {
        name: '  Private by default  ',
        description: '  Owner-curated films  ',
        ownerId: attemptedOwnerId,
        lifecycleState: 'deleted',
        deletedAt: new Date().toISOString(),
      },
    })

    assert.equal(created.status, 201)
    assert.equal(created.body.collection.name, 'Private by default')
    assert.equal(created.body.collection.description, 'Owner-curated films')
    assert.equal(created.body.collection.visibility, 'private')
    assert.equal(created.body.collection.lifecycleState, 'active')
    assert.equal(created.body.collection.deletedAt, null)
    const stored = track(await Collection.findById(created.body.collection._id))
    assert.equal(stored.ownerId.toString(), owner._id.toString())

    for (const body of [
      { description: 'missing name' },
      { name: '' },
      { name: '   ' },
      { name: 'Invalid visibility', visibility: 'friends' },
    ]) {
      const rejected = await invoke(createCollectionController, { user: owner, body })
      assert.equal(rejected.status, 400)
    }
  })

  it('lists only the authenticated owner active Collections in deterministic order', async () => {
    const older = track(
      await Collection.create({
        ownerId: owner._id,
        name: 'Older active',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      }),
    )
    const newer = track(
      await Collection.create({
        ownerId: owner._id,
        name: 'Newer active',
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
    )
    track(
      await Collection.create({
        ownerId: owner._id,
        name: 'Deleted owner Collection',
        lifecycleState: 'deleted',
        deletedAt: new Date(),
      }),
    )
    track(await Collection.create({ ownerId: visitor._id, name: 'Other user Collection' }))

    const response = await invoke(listMyCollectionsController, { user: owner })
    const listedIds = response.body.collections.map((collection) => collection._id.toString())

    assert.equal(response.status, 200)
    assert.ok(listedIds.includes(older._id.toString()))
    assert.ok(listedIds.includes(newer._id.toString()))
    assert.ok(listedIds.indexOf(newer._id.toString()) < listedIds.indexOf(older._id.toString()))
    assert.equal(
      response.body.collections.some(
        (collection) => collection.name === 'Deleted owner Collection',
      ),
      false,
    )
    assert.equal(
      response.body.collections.some((collection) => collection.name === 'Other user Collection'),
      false,
    )
  })

  it('returns minimized owner and public summaries with bounded canonical previews', async () => {
    const [emptyPrivate, onePublic, twoPublic, threePrivate, fourPublic] = await Collection.create([
      { ownerId: owner._id, name: 'Summary empty private' },
      { ownerId: owner._id, name: 'Summary one public', visibility: 'public' },
      {
        ownerId: owner._id,
        name: 'Summary two public',
        description: 'Two preview movies',
        visibility: 'public',
      },
      { ownerId: owner._id, name: 'Summary three private' },
      { ownerId: owner._id, name: 'Summary four public', visibility: 'public' },
    ])
    ;[emptyPrivate, onePublic, twoPublic, threePrivate, fourPublic].forEach(track)
    const firstTieId = new Types.ObjectId()
    const secondTieId = new Types.ObjectId()
    await CollectionMembership.create([
      { collectionId: onePublic._id, tmdbId: 11, position: 0 },
      { collectionId: twoPublic._id, tmdbId: 22, position: 1 },
      { collectionId: twoPublic._id, tmdbId: 21, position: 0 },
      { collectionId: threePrivate._id, tmdbId: 33, position: 2 },
      { collectionId: threePrivate._id, tmdbId: 31, position: 0 },
      { collectionId: threePrivate._id, tmdbId: 32, position: 1 },
      { collectionId: fourPublic._id, tmdbId: 44, position: 3 },
      { _id: firstTieId, collectionId: fourPublic._id, tmdbId: 42, position: 1 },
      { collectionId: fourPublic._id, tmdbId: 41, position: 0 },
      { _id: secondTieId, collectionId: fourPublic._id, tmdbId: 43, position: 1 },
    ])
    await Favorite.create({ userId: owner._id, tmdbId: 41, genreIds: [18] })

    const ownerResponse = await invoke(listMyCollectionsController, { user: owner })
    const ownerSummaries = new Map(
      ownerResponse.body.collections.map((collection) => [collection.name, collection]),
    )

    assert.deepEqual(ownerSummaries.get('Summary empty private'), {
      _id: emptyPrivate._id,
      name: 'Summary empty private',
      visibility: 'private',
      movieCount: 0,
      previewMovies: [],
    })
    assert.deepEqual(ownerSummaries.get('Summary one public').previewMovies, [{ tmdbId: 11 }])
    assert.deepEqual(ownerSummaries.get('Summary two public'), {
      _id: twoPublic._id,
      name: 'Summary two public',
      description: 'Two preview movies',
      visibility: 'public',
      movieCount: 2,
      previewMovies: [{ tmdbId: 21 }, { tmdbId: 22 }],
    })
    assert.deepEqual(ownerSummaries.get('Summary three private').previewMovies, [
      { tmdbId: 31 },
      { tmdbId: 32 },
      { tmdbId: 33 },
    ])
    assert.equal(ownerSummaries.get('Summary four public').movieCount, 4)
    assert.deepEqual(ownerSummaries.get('Summary four public').previewMovies, [
      { tmdbId: 41 },
      { tmdbId: 42 },
      { tmdbId: 43 },
    ])

    const visitorResponse = await invoke(getMovieSpace, {
      user: visitor,
      params: { id: owner._id.toString() },
    })
    const publicSummaries = new Map(
      visitorResponse.body.collections.map((collection) => [collection.name, collection]),
    )
    assert.equal(publicSummaries.has('Summary empty private'), false)
    assert.equal(publicSummaries.has('Summary three private'), false)
    assert.deepEqual(publicSummaries.get('Summary four public'), {
      _id: fourPublic._id,
      name: 'Summary four public',
      movieCount: 4,
      previewMovies: [{ tmdbId: 41 }, { tmdbId: 42 }, { tmdbId: 43 }],
    })
    assert.equal('favorites' in visitorResponse.body, false)

    for (const summary of publicSummaries.values()) {
      for (const forbiddenField of [
        'ownerId',
        'visibility',
        'lifecycleState',
        'deletedAt',
        'createdAt',
        'updatedAt',
        '__v',
        'favorite',
        'isFavorite',
        'favoritesPublic',
        'matchScore',
        'sharedDnaGenres',
        'revealableSharedFavoriteTmdbIds',
      ]) {
        assert.equal(forbiddenField in summary, false)
      }
      for (const previewMovie of summary.previewMovies) {
        assert.deepEqual(Object.keys(previewMovie), ['tmdbId'])
      }
    }
  })

  it('serves owner Private detail and minimal authenticated visitor Public detail', async () => {
    const privateCollection = track(
      await Collection.create({ ownerId: owner._id, name: 'Owner private' }),
    )
    const publicCollection = track(
      await Collection.create({
        ownerId: owner._id,
        name: 'Public detail',
        description: 'Visible curation',
        visibility: 'public',
      }),
    )
    await CollectionMembership.create([
      { collectionId: privateCollection._id, tmdbId: 550, position: 0 },
      { collectionId: publicCollection._id, tmdbId: 155, position: 1 },
      { collectionId: publicCollection._id, tmdbId: 13, position: 0 },
    ])

    const ownerResponse = await invoke(getCollectionController, {
      user: owner,
      params: { collectionId: privateCollection._id.toString() },
    })
    assert.equal(ownerResponse.status, 200)
    assert.equal(ownerResponse.body.collection.visibility, 'private')
    assert.deepEqual(ownerResponse.body.collection.memberships, [{ tmdbId: 550, position: 0 }])

    const publicResponse = await invoke(getCollectionController, {
      user: visitor,
      params: { collectionId: publicCollection._id.toString() },
    })
    assert.equal(publicResponse.status, 200)
    assert.equal(publicResponse.body.collection.name, 'Public detail')
    assert.deepEqual(publicResponse.body.collection.memberships, [
      { tmdbId: 13, position: 0 },
      { tmdbId: 155, position: 1 },
    ])
    for (const hiddenField of [
      'ownerId',
      'visibility',
      'lifecycleState',
      'deletedAt',
      'createdAt',
      'updatedAt',
    ]) {
      assert.equal(hiddenField in publicResponse.body.collection, false)
    }
    assert.deepEqual(Object.keys(publicResponse.body.collection.memberships[0]).sort(), [
      'position',
      'tmdbId',
    ])
  })

  it('uses identical non-disclosure responses for private, deleted, and nonexistent detail', async () => {
    const privateCollection = track(
      await Collection.create({ ownerId: owner._id, name: 'Hidden private' }),
    )
    const deletedCollection = track(
      await Collection.create({
        ownerId: owner._id,
        name: 'Hidden deleted',
        visibility: 'public',
        lifecycleState: 'deleted',
        deletedAt: new Date(),
      }),
    )
    await CollectionMembership.create([
      { collectionId: privateCollection._id, tmdbId: 550, position: 0 },
      { collectionId: deletedCollection._id, tmdbId: 155, position: 0 },
    ])

    const responses = await Promise.all(
      [privateCollection._id, deletedCollection._id, new Types.ObjectId()].map((id) =>
        invoke(getCollectionController, {
          user: visitor,
          params: { collectionId: id.toString() },
        }),
      ),
    )

    assert.deepEqual(responses, [neutralReadNotFound, neutralReadNotFound, neutralReadNotFound])

    assert.deepEqual(
      await invoke(getCollectionController, {
        user: visitor,
        params: { collectionId: 'not-an-object-id' },
      }),
      { status: 400, body: { message: 'Invalid Collection id' } },
    )
  })

  it('updates only owner-authorized metadata and supports explicit visibility changes', async () => {
    const collection = track(
      await Collection.create({ ownerId: owner._id, name: 'Before update', visibility: 'public' }),
    )

    const denied = await invoke(updateCollectionController, {
      user: visitor,
      params: { collectionId: collection._id.toString() },
      body: { name: 'Visitor edit' },
    })
    assert.deepEqual(denied, { status: 404, body: { message: 'Collection not found' } })

    for (const body of [{ name: '   ' }, { visibility: 'friends' }, { ownerId: visitor._id }]) {
      const rejected = await invoke(updateCollectionController, {
        user: owner,
        params: { collectionId: collection._id.toString() },
        body,
      })
      assert.equal(rejected.status, 400)
    }

    const madePrivate = await invoke(updateCollectionController, {
      user: owner,
      params: { collectionId: collection._id.toString() },
      body: {
        name: '  Owner edit  ',
        description: '  Updated description  ',
        visibility: 'private',
        ownerId: visitor._id,
        lifecycleState: 'deleted',
        deletedAt: new Date(),
      },
    })
    assert.equal(madePrivate.status, 200)
    assert.equal(madePrivate.body.collection.name, 'Owner edit')
    assert.equal(madePrivate.body.collection.description, 'Updated description')
    assert.equal(madePrivate.body.collection.visibility, 'private')
    assert.equal(madePrivate.body.collection.lifecycleState, 'active')
    assert.equal(madePrivate.body.collection.deletedAt, null)

    const stored = await Collection.findById(collection._id).lean()
    assert.equal(stored.ownerId.toString(), owner._id.toString())
    assert.equal(stored.lifecycleState, 'active')
    assert.equal(stored.deletedAt, null)

    const madePublic = await invoke(updateCollectionController, {
      user: owner,
      params: { collectionId: collection._id.toString() },
      body: { visibility: 'public' },
    })
    assert.equal(madePublic.status, 200)
    assert.equal(madePublic.body.collection.visibility, 'public')
  })

  it('soft deletes and restores atomically without changing memberships, Favorites, or peers', async () => {
    const collection = track(
      await Collection.create({ ownerId: owner._id, name: 'Recover me', visibility: 'public' }),
    )
    const otherCollection = track(
      await Collection.create({ ownerId: owner._id, name: 'Leave me active' }),
    )
    await CollectionMembership.create([
      { collectionId: collection._id, tmdbId: 550, position: 1 },
      { collectionId: collection._id, tmdbId: 155, position: 0 },
      { collectionId: otherCollection._id, tmdbId: 550, position: 0 },
    ])
    await Favorite.create({ userId: owner._id, tmdbId: 550, genreIds: [18] })

    const nonOwnerDelete = await invoke(deleteCollectionController, {
      user: visitor,
      params: { collectionId: collection._id.toString() },
    })
    assert.deepEqual(nonOwnerDelete, {
      status: 404,
      body: { message: 'Collection not found' },
    })

    const deleted = await invoke(deleteCollectionController, {
      user: owner,
      params: { collectionId: collection._id.toString() },
    })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.body.collection.lifecycleState, 'deleted')
    assert.ok(deleted.body.collection.deletedAt)
    const storedDeleted = await Collection.findById(collection._id).lean()
    assert.equal(storedDeleted.lifecycleState, 'deleted')
    assert.ok(storedDeleted.deletedAt)
    assert.deepEqual(
      (
        await CollectionMembership.find({ collectionId: collection._id })
          .sort({ position: 1, _id: 1 })
          .lean()
      ).map(({ tmdbId, position }) => ({ tmdbId, position })),
      [
        { tmdbId: 155, position: 0 },
        { tmdbId: 550, position: 1 },
      ],
    )
    assert.equal(await Favorite.countDocuments({ userId: owner._id, tmdbId: 550 }), 1)
    assert.equal((await Collection.findById(otherCollection._id).lean()).lifecycleState, 'active')

    const deletedUpdate = await invoke(updateCollectionController, {
      user: owner,
      params: { collectionId: collection._id.toString() },
      body: { name: 'Must remain deleted' },
    })
    assert.deepEqual(deletedUpdate, {
      status: 404,
      body: { message: 'Collection not found' },
    })

    for (const user of [owner, visitor]) {
      const hidden = await invoke(getCollectionController, {
        user,
        params: { collectionId: collection._id.toString() },
      })
      assert.deepEqual(hidden, neutralReadNotFound)
    }

    const nonOwnerRestore = await invoke(restoreCollectionController, {
      user: visitor,
      params: { collectionId: collection._id.toString() },
    })
    assert.deepEqual(nonOwnerRestore, {
      status: 404,
      body: { message: 'Collection not found' },
    })

    const restored = await invoke(restoreCollectionController, {
      user: owner,
      params: { collectionId: collection._id.toString() },
    })
    assert.equal(restored.status, 200)
    assert.equal(restored.body.collection.lifecycleState, 'active')
    assert.equal(restored.body.collection.deletedAt, null)
    assert.equal(await CollectionMembership.countDocuments({ collectionId: collection._id }), 2)
    assert.equal(await Favorite.countDocuments({ userId: owner._id, tmdbId: 550 }), 1)
    assert.equal(
      await CollectionMembership.countDocuments({ collectionId: otherCollection._id }),
      1,
    )
  })
})

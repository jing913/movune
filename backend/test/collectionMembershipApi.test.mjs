import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import mongoose, { Types } from 'mongoose'
import {
  addCollectionMembershipController,
  deleteCollectionController,
  getCollectionController,
  removeCollectionMembershipController,
  reorderCollectionMembershipsController,
  restoreCollectionController,
} from '../dist/controllers/collectionController.js'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import { Collection } from '../dist/models/collectionModel.js'
import { CollectionMembership } from '../dist/models/collectionMembershipModel.js'
import { Favorite } from '../dist/models/favoriteModel.js'
import { User } from '../dist/models/userModel.js'
import { processDnaMatch } from '../dist/services/dnaMatchService.js'
import { calculateMovieDna } from '../dist/services/movieDnaService.js'

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
  if (controllerError) errorHandler(controllerError, req, res, () => {})

  return result
}

describe('Collection membership mutation API', { timeout: 60_000 }, () => {
  let owner
  let visitor
  const collectionIds = []

  before(async () => {
    const url = await databaseUrl()
    if (!url) throw new Error('DB_URL is required for Collection membership API tests')

    await mongoose.connect(url)
    await Promise.all([Collection.syncIndexes(), CollectionMembership.syncIndexes()])
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    ;[owner, visitor] = await User.create([
      {
        account: `p7-membership-owner-${suffix}`,
        email: `p7-membership-owner-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      },
      {
        account: `p7-membership-visitor-${suffix}`,
        email: `p7-membership-visitor-${suffix}@test.invalid`,
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

  const createCollection = async (values = {}) => {
    const collection = await Collection.create({
      ownerId: owner._id,
      name: `Membership test ${collectionIds.length}`,
      ...values,
    })
    collectionIds.push(collection._id)
    return collection
  }

  const seedMemberships = (collection, tmdbIds, positions = tmdbIds.map((_, index) => index)) =>
    CollectionMembership.create(
      tmdbIds.map((tmdbId, index) => ({
        collectionId: collection._id,
        tmdbId,
        position: positions[index],
      })),
    )

  const storedOrder = async (collection) =>
    (
      await CollectionMembership.find({ collectionId: collection._id })
        .sort({ position: 1, _id: 1 })
        .lean()
    ).map(({ tmdbId, position }) => ({ tmdbId, position }))

  it('lets the owner append a valid movie and normalizes the canonical order', async () => {
    const collection = await createCollection()
    await seedMemberships(collection, [11, 22], [2, 8])

    const response = await invoke(addCollectionMembershipController, {
      user: owner,
      params: { collectionId: collection._id.toString() },
      body: {
        tmdbId: 33,
        collectionId: new Types.ObjectId(),
        ownerId: visitor._id,
        position: 99,
        visibility: 'public',
        _id: new Types.ObjectId(),
      },
    })

    assert.equal(response.status, 201)
    assert.deepEqual(response.body.memberships, [
      { tmdbId: 11, position: 0 },
      { tmdbId: 22, position: 1 },
      { tmdbId: 33, position: 2 },
    ])
    assert.deepEqual(await storedOrder(collection), response.body.memberships)
    assert.equal(await Favorite.countDocuments({ userId: owner._id }), 0)
  })

  it('rejects a duplicate in one Collection while allowing the movie in another', async () => {
    const first = await createCollection()
    const second = await createCollection()
    await seedMemberships(first, [44])

    const duplicate = await invoke(addCollectionMembershipController, {
      user: owner,
      params: { collectionId: first._id.toString() },
      body: { tmdbId: 44 },
    })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.error.code, 'COLLECTION_MEMBERSHIP_EXISTS')

    const otherCollection = await invoke(addCollectionMembershipController, {
      user: owner,
      params: { collectionId: second._id.toString() },
      body: { tmdbId: 44 },
    })
    assert.equal(otherCollection.status, 201)
    assert.deepEqual(await storedOrder(first), [{ tmdbId: 44, position: 0 }])
    assert.deepEqual(await storedOrder(second), [{ tmdbId: 44, position: 0 }])
  })

  it('denies add to non-owners, Public visitor writes, and deleted Collections', async () => {
    const publicCollection = await createCollection({ visibility: 'public' })
    const deletedCollection = await createCollection({
      lifecycleState: 'deleted',
      deletedAt: new Date(),
    })

    for (const [collection, user] of [
      [publicCollection, visitor],
      [deletedCollection, owner],
    ]) {
      const response = await invoke(addCollectionMembershipController, {
        user,
        params: { collectionId: collection._id.toString() },
        body: { tmdbId: 55 },
      })
      assert.deepEqual(response, { status: 404, body: { message: 'Collection not found' } })
    }
    assert.equal(await CollectionMembership.countDocuments({ tmdbId: 55 }), 0)
  })

  it('rejects invalid Collection and movie identifiers before mutation', async () => {
    const collection = await createCollection()

    for (const tmdbId of [undefined, null, 0, -1, 1.5, '66']) {
      const response = await invoke(addCollectionMembershipController, {
        user: owner,
        params: { collectionId: collection._id.toString() },
        body: { tmdbId },
      })
      assert.equal(response.status, 400)
    }
    const invalidCollection = await invoke(addCollectionMembershipController, {
      user: owner,
      params: { collectionId: 'invalid' },
      body: { tmdbId: 66 },
    })
    assert.deepEqual(invalidCollection, {
      status: 400,
      body: { message: 'Invalid Collection id' },
    })
    assert.equal(await CollectionMembership.countDocuments({ collectionId: collection._id }), 0)
  })

  it('removes only the requested relationship and normalizes remaining positions', async () => {
    const collection = await createCollection()
    const peer = await createCollection()
    await seedMemberships(collection, [71, 72, 73], [0, 1, 2])
    await seedMemberships(peer, [72])
    await Favorite.create({ userId: owner._id, tmdbId: 72, genreIds: [18] })

    const response = await invoke(removeCollectionMembershipController, {
      user: owner,
      params: { collectionId: collection._id.toString(), tmdbId: '72' },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(response.body.memberships, [
      { tmdbId: 71, position: 0 },
      { tmdbId: 73, position: 1 },
    ])
    assert.deepEqual(await storedOrder(collection), response.body.memberships)
    assert.deepEqual(await storedOrder(peer), [{ tmdbId: 72, position: 0 }])
    assert.equal(await Favorite.countDocuments({ userId: owner._id, tmdbId: 72 }), 1)
  })

  it('denies unauthorized or deleted removal and returns a stable missing-member error', async () => {
    const collection = await createCollection({ visibility: 'public' })
    const deletedCollection = await createCollection({
      lifecycleState: 'deleted',
      deletedAt: new Date(),
    })
    await seedMemberships(collection, [81])
    await seedMemberships(deletedCollection, [82])

    const denied = await invoke(removeCollectionMembershipController, {
      user: visitor,
      params: { collectionId: collection._id.toString(), tmdbId: '81' },
    })
    const deleted = await invoke(removeCollectionMembershipController, {
      user: owner,
      params: { collectionId: deletedCollection._id.toString(), tmdbId: '82' },
    })
    assert.deepEqual(denied, { status: 404, body: { message: 'Collection not found' } })
    assert.deepEqual(deleted, { status: 404, body: { message: 'Collection not found' } })

    const missing = await invoke(removeCollectionMembershipController, {
      user: owner,
      params: { collectionId: collection._id.toString(), tmdbId: '999' },
    })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'COLLECTION_MEMBERSHIP_NOT_FOUND')
    assert.deepEqual(await storedOrder(collection), [{ tmdbId: 81, position: 0 }])
    assert.deepEqual(await storedOrder(deletedCollection), [{ tmdbId: 82, position: 0 }])
  })

  it('applies a complete resulting order and returns it identically on re-read', async () => {
    const collection = await createCollection({ visibility: 'public' })
    const peer = await createCollection()
    await seedMemberships(collection, [91, 92, 93])
    await seedMemberships(peer, [91, 93])

    const response = await invoke(reorderCollectionMembershipsController, {
      user: owner,
      params: { collectionId: collection._id.toString() },
      body: { tmdbIds: [93, 91, 92], position: 10 },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(response.body.memberships, [
      { tmdbId: 93, position: 0 },
      { tmdbId: 91, position: 1 },
      { tmdbId: 92, position: 2 },
    ])

    const reread = await invoke(getCollectionController, {
      user: owner,
      params: { collectionId: collection._id.toString() },
    })
    assert.deepEqual(reread.body.collection.memberships, response.body.memberships)
    assert.deepEqual(await storedOrder(peer), [
      { tmdbId: 91, position: 0 },
      { tmdbId: 93, position: 1 },
    ])
  })

  it('rejects incomplete, duplicate, unknown, and invalid orders without partial changes', async () => {
    const collection = await createCollection()
    await seedMemberships(collection, [101, 102, 103])
    const original = await storedOrder(collection)

    for (const body of [
      { tmdbIds: [101, 102] },
      { tmdbIds: [101, 102, 999] },
      { tmdbIds: [101, 101, 103] },
      { tmdbIds: '101,102,103' },
      { tmdbIds: [101, 0, 103] },
      { tmdbIds: [101, 1.5, 103] },
    ]) {
      const response = await invoke(reorderCollectionMembershipsController, {
        user: owner,
        params: { collectionId: collection._id.toString() },
        body,
      })
      assert.equal(response.status, 400)
      assert.deepEqual(await storedOrder(collection), original)
    }
  })

  it('denies reorder to non-owners and on deleted Collections', async () => {
    const publicCollection = await createCollection({ visibility: 'public' })
    const deletedCollection = await createCollection({
      lifecycleState: 'deleted',
      deletedAt: new Date(),
    })
    await seedMemberships(publicCollection, [111, 112])
    await seedMemberships(deletedCollection, [113, 114])

    const visitorResponse = await invoke(reorderCollectionMembershipsController, {
      user: visitor,
      params: { collectionId: publicCollection._id.toString() },
      body: { tmdbIds: [112, 111] },
    })
    const deletedResponse = await invoke(reorderCollectionMembershipsController, {
      user: owner,
      params: { collectionId: deletedCollection._id.toString() },
      body: { tmdbIds: [114, 113] },
    })
    assert.deepEqual(visitorResponse, {
      status: 404,
      body: { message: 'Collection not found' },
    })
    assert.deepEqual(deletedResponse, {
      status: 404,
      body: { message: 'Collection not found' },
    })
    assert.deepEqual(await storedOrder(publicCollection), [
      { tmdbId: 111, position: 0 },
      { tmdbId: 112, position: 1 },
    ])
    assert.deepEqual(await storedOrder(deletedCollection), [
      { tmdbId: 113, position: 0 },
      { tmdbId: 114, position: 1 },
    ])
  })

  it('accepts exact empty and one-item canonical orders', async () => {
    const empty = await createCollection()
    const single = await createCollection()
    await seedMemberships(single, [121], [9])

    const emptyResponse = await invoke(reorderCollectionMembershipsController, {
      user: owner,
      params: { collectionId: empty._id.toString() },
      body: { tmdbIds: [] },
    })
    const singleResponse = await invoke(reorderCollectionMembershipsController, {
      user: owner,
      params: { collectionId: single._id.toString() },
      body: { tmdbIds: [121] },
    })
    assert.deepEqual(emptyResponse, { status: 200, body: { memberships: [] } })
    assert.deepEqual(singleResponse, {
      status: 200,
      body: { memberships: [{ tmdbId: 121, position: 0 }] },
    })
    assert.deepEqual(await storedOrder(single), [{ tmdbId: 121, position: 0 }])
  })

  it('preserves fact-minimized Public reads and non-disclosure for Private Collections', async () => {
    const publicCollection = await createCollection({ visibility: 'public' })
    const privateCollection = await createCollection()
    await seedMemberships(publicCollection, [131])
    await seedMemberships(privateCollection, [132])

    const publicResponse = await invoke(getCollectionController, {
      user: visitor,
      params: { collectionId: publicCollection._id.toString() },
    })
    assert.equal(publicResponse.status, 200)
    assert.deepEqual(publicResponse.body.collection.memberships, [{ tmdbId: 131, position: 0 }])
    assert.deepEqual(Object.keys(publicResponse.body.collection.memberships[0]).sort(), [
      'position',
      'tmdbId',
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

    const privateResponse = await invoke(getCollectionController, {
      user: visitor,
      params: { collectionId: privateCollection._id.toString() },
    })
    const nonexistentResponse = await invoke(getCollectionController, {
      user: visitor,
      params: { collectionId: new Types.ObjectId().toString() },
    })
    assert.deepEqual(privateResponse, nonexistentResponse)
  })

  it('retains canonical memberships through soft delete and restore without normal mutation access', async () => {
    const collection = await createCollection({ visibility: 'public' })
    await seedMemberships(collection, [141, 142])

    const deleted = await invoke(deleteCollectionController, {
      user: owner,
      params: { collectionId: collection._id.toString() },
    })
    assert.equal(deleted.status, 200)
    assert.deepEqual(await storedOrder(collection), [
      { tmdbId: 141, position: 0 },
      { tmdbId: 142, position: 1 },
    ])

    const blocked = await invoke(addCollectionMembershipController, {
      user: owner,
      params: { collectionId: collection._id.toString() },
      body: { tmdbId: 143 },
    })
    assert.deepEqual(blocked, { status: 404, body: { message: 'Collection not found' } })

    const restored = await invoke(restoreCollectionController, {
      user: owner,
      params: { collectionId: collection._id.toString() },
    })
    assert.equal(restored.status, 200)
    const reread = await invoke(getCollectionController, {
      user: owner,
      params: { collectionId: collection._id.toString() },
    })
    assert.deepEqual(reread.body.collection.memberships, [
      { tmdbId: 141, position: 0 },
      { tmdbId: 142, position: 1 },
    ])
  })

  it('does not change Favorites visibility, Movie DNA, or Match inputs', async () => {
    const collection = await createCollection()
    owner.favoritesPublic = false
    await owner.save()
    await Favorite.create([
      { userId: owner._id, tmdbId: 151, genreIds: [18] },
      { userId: owner._id, tmdbId: 152, genreIds: [28] },
    ])
    const favoritesBefore = await Favorite.find({ userId: owner._id }).sort({ tmdbId: 1 }).lean()
    const dnaBefore = calculateMovieDna(favoritesBefore)
    const matchBefore = processDnaMatch(favoritesBefore, [{ tmdbId: 151, genreIds: [18] }])

    await invoke(addCollectionMembershipController, {
      user: owner,
      params: { collectionId: collection._id.toString() },
      body: { tmdbId: 151 },
    })
    await invoke(addCollectionMembershipController, {
      user: owner,
      params: { collectionId: collection._id.toString() },
      body: { tmdbId: 999 },
    })
    await invoke(removeCollectionMembershipController, {
      user: owner,
      params: { collectionId: collection._id.toString(), tmdbId: '151' },
    })

    const favoritesAfter = await Favorite.find({ userId: owner._id }).sort({ tmdbId: 1 }).lean()
    const refreshedOwner = await User.findById(owner._id).lean()
    assert.deepEqual(
      favoritesAfter.map(({ tmdbId, genreIds }) => ({ tmdbId, genreIds })),
      favoritesBefore.map(({ tmdbId, genreIds }) => ({ tmdbId, genreIds })),
    )
    assert.equal(refreshedOwner.favoritesPublic, false)
    assert.deepEqual(calculateMovieDna(favoritesAfter), dnaBefore)
    assert.deepEqual(
      processDnaMatch(favoritesAfter, [{ tmdbId: 151, genreIds: [18] }]),
      matchBefore,
    )
  })
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import mongoose, { Types } from 'mongoose'
import { Collection } from '../dist/models/collectionModel.js'
import { CollectionMembership } from '../dist/models/collectionMembershipModel.js'
import { Favorite } from '../dist/models/favoriteModel.js'
import { User } from '../dist/models/userModel.js'

async function databaseUrl() {
  if (process.env.DB_URL) return process.env.DB_URL
  const env = await readFile(new URL('../.env', import.meta.url), 'utf8')
  const line = env.split(/\r?\n/).find((entry) => entry.startsWith('DB_URL='))
  return line?.slice('DB_URL='.length)
}

describe('Collection schema', () => {
  const ownerId = new Types.ObjectId()

  it('defaults new Collections to private and active', async () => {
    const collection = new Collection({ ownerId, name: 'Weekend picks' })
    await collection.validate()

    assert.equal(collection.visibility, 'private')
    assert.equal(collection.lifecycleState, 'active')
    assert.equal(collection.deletedAt, null)
  })

  it('accepts only private or public visibility', async () => {
    await assert.doesNotReject(() =>
      new Collection({ ownerId, name: 'Public picks', visibility: 'public' }).validate(),
    )
    await assert.rejects(
      () => new Collection({ ownerId, name: 'Invalid', visibility: 'friends' }).validate(),
      (error) => error?.errors.visibility?.kind === 'enum',
    )
  })

  it('requires an owner and a non-empty name while supporting an optional description', async () => {
    await assert.rejects(
      () => new Collection({ name: 'Missing owner' }).validate(),
      (error) => error?.errors.ownerId?.kind === 'required',
    )
    await assert.rejects(
      () => new Collection({ ownerId }).validate(),
      (error) => error?.errors.name?.kind === 'required',
    )
    await assert.rejects(
      () => new Collection({ ownerId, name: '   ' }).validate(),
      (error) => error?.errors.name?.kind === 'required',
    )
    await assert.doesNotReject(() =>
      new Collection({
        ownerId,
        name: 'Drama',
        description: 'Character-driven films',
      }).validate(),
    )
  })
})

describe('Collection persistence invariants', { timeout: 60_000 }, () => {
  it('keeps Collection membership, ordering, lifecycle, and Favorites independent', async (t) => {
    const url = await databaseUrl()
    if (!url) return t.skip('DB_URL is not configured')

    await mongoose.connect(url)
    await Promise.all([Collection.syncIndexes(), CollectionMembership.syncIndexes()])

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const user = await User.create({
      account: `p7-collection-${suffix}`,
      email: `p7-collection-${suffix}@test.invalid`,
      password: 'not-used',
      role: 'user',
    })
    const collectionIds = []

    try {
      const firstCollection = await Collection.create({
        ownerId: user._id,
        name: 'First Collection',
        description: 'Recoverable collection state',
      })
      const secondCollection = await Collection.create({
        ownerId: user._id,
        name: 'Second Collection',
        visibility: 'public',
      })
      collectionIds.push(firstCollection._id, secondCollection._id)

      await CollectionMembership.create({
        collectionId: firstCollection._id,
        tmdbId: 550,
        position: 1,
      })
      await assert.rejects(
        () =>
          CollectionMembership.create({
            collectionId: firstCollection._id,
            tmdbId: 550,
            position: 2,
          }),
        (error) => error?.code === 11000,
      )

      await CollectionMembership.create([
        { collectionId: firstCollection._id, tmdbId: 155, position: 0 },
        { collectionId: secondCollection._id, tmdbId: 550, position: 0 },
      ])

      assert.deepEqual(
        (
          await CollectionMembership.find({ collectionId: firstCollection._id })
            .sort({ position: 1, _id: 1 })
            .lean()
        ).map(({ tmdbId, position }) => ({ tmdbId, position })),
        [
          { tmdbId: 155, position: 0 },
          { tmdbId: 550, position: 1 },
        ],
      )
      assert.equal(
        await CollectionMembership.countDocuments({
          collectionId: secondCollection._id,
          tmdbId: 550,
        }),
        1,
      )
      assert.equal(await Favorite.countDocuments({ userId: user._id }), 0)

      await Favorite.create({ userId: user._id, tmdbId: 550, genreIds: [18] })
      const deletedAt = new Date()
      await Collection.updateOne(
        { _id: firstCollection._id },
        { $set: { lifecycleState: 'deleted', deletedAt } },
      )

      assert.equal(
        await Collection.countDocuments({
          _id: firstCollection._id,
          lifecycleState: 'active',
        }),
        0,
      )
      const recoverableCollection = await Collection.findById(firstCollection._id).lean()
      assert.equal(recoverableCollection.lifecycleState, 'deleted')
      assert.equal(recoverableCollection.deletedAt.getTime(), deletedAt.getTime())
      assert.equal(recoverableCollection.name, 'First Collection')
      assert.equal(recoverableCollection.description, 'Recoverable collection state')
      assert.equal(
        await CollectionMembership.countDocuments({ collectionId: firstCollection._id }),
        2,
      )
      assert.equal(await Favorite.countDocuments({ userId: user._id, tmdbId: 550 }), 1)

      await Collection.updateOne(
        { _id: firstCollection._id },
        { $set: { lifecycleState: 'active', deletedAt: null } },
      )
      assert.equal(
        await CollectionMembership.countDocuments({ collectionId: firstCollection._id }),
        2,
      )

      await CollectionMembership.deleteOne({
        collectionId: firstCollection._id,
        tmdbId: 550,
      })
      assert.equal(await Favorite.countDocuments({ userId: user._id, tmdbId: 550 }), 1)
      assert.equal(
        await CollectionMembership.countDocuments({
          collectionId: secondCollection._id,
          tmdbId: 550,
        }),
        1,
      )
    } finally {
      await CollectionMembership.deleteMany({ collectionId: { $in: collectionIds } })
      await Collection.deleteMany({ _id: { $in: collectionIds } })
      await Favorite.deleteMany({ userId: user._id })
      await User.deleteOne({ _id: user._id })
      await mongoose.disconnect()
    }
  })
})

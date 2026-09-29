import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import express from 'express'
import jsonwebtoken from 'jsonwebtoken'
import mongoose, { Types } from 'mongoose'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import { Collection } from '../dist/models/collectionModel.js'
import { CollectionMembership } from '../dist/models/collectionMembershipModel.js'
import { DirectConversation } from '../dist/models/directConversationModel.js'
import { Favorite } from '../dist/models/favoriteModel.js'
import { Follow } from '../dist/models/followModel.js'
import { UserBlock } from '../dist/models/userBlockModel.js'
import { User } from '../dist/models/userModel.js'

process.env.JWT_SECRET ??= 'phase8-stage11-cross-surface-test-secret'
await import('../dist/configs/passport.js')
const { default: collectionRouter } = await import('../dist/routes/collection.js')
const { default: followRouter } = await import('../dist/routes/follow.js')
const { default: userRouter } = await import('../dist/routes/user.js')

async function databaseUrl() {
  if (process.env.DB_URL) return process.env.DB_URL
  const env = await readFile(new URL('../.env', import.meta.url), 'utf8')
  return env
    .split(/\r?\n/)
    .find((line) => line.startsWith('DB_URL='))
    ?.slice('DB_URL='.length)
}

const tokenFor = (user) =>
  jsonwebtoken.sign({ userId: user._id.toString() }, process.env.JWT_SECRET)

const request = (baseUrl, path, { method = 'GET', token } = {}) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

const json = async (response) => ({ status: response.status, body: await response.json() })

const neutral = {
  status: 404,
  body: { error: { code: 'RESOURCE_NOT_FOUND', message: 'Resource not found' } },
}

describe('Stage 11 Batch 1 cross-surface Block integration', { timeout: 120_000 }, () => {
  let actor
  let target
  let actorToken
  let targetToken
  let actorPublicCollection
  let targetPublicCollection
  let targetPrivateCollection
  let conversation
  let server
  let baseUrl
  const userIds = []
  const collectionIds = []

  before(async () => {
    const url = await databaseUrl()
    if (!url) throw new Error('DB_URL is required for Stage 11 integration tests')
    await mongoose.connect(url)
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    ;[actor, target] = await User.create([
      {
        account: `p8s11-actor-${suffix}`,
        displayName: 'Stage 11 actor',
        email: `p8s11-actor-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
        favoritesPublic: true,
      },
      {
        account: `p8s11-target-${suffix}`,
        displayName: 'Stage 11 target',
        email: `p8s11-target-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
        favoritesPublic: false,
      },
    ])
    userIds.push(actor._id, target._id)
    actorToken = tokenFor(actor)
    targetToken = tokenFor(target)
    await Favorite.create([
      { userId: actor._id, tmdbId: 101, genreIds: [18, 28] },
      { userId: target._id, tmdbId: 101, genreIds: [18, 28] },
      { userId: target._id, tmdbId: 202, genreIds: [35] },
    ])
    ;[actorPublicCollection, targetPublicCollection, targetPrivateCollection] =
      await Collection.create([
        { ownerId: actor._id, name: 'Actor public', visibility: 'public' },
        { ownerId: target._id, name: 'Target public', visibility: 'public' },
        { ownerId: target._id, name: 'Target private', visibility: 'private' },
      ])
    collectionIds.push(
      actorPublicCollection._id,
      targetPublicCollection._id,
      targetPrivateCollection._id,
    )
    await CollectionMembership.create([
      { collectionId: actorPublicCollection._id, tmdbId: 101, position: 0 },
      { collectionId: targetPublicCollection._id, tmdbId: 202, position: 0 },
      { collectionId: targetPrivateCollection._id, tmdbId: 101, position: 0 },
    ])
    await Follow.create([
      { followerId: actor._id, followingId: target._id },
      { followerId: target._id, followingId: actor._id },
    ])
    conversation = await DirectConversation.create({
      participantIds: [actor._id, target._id],
      participantKey: [actor._id.toString(), target._id.toString()].sort().join(':'),
      initiatedByUserId: actor._id,
      state: 'unlocked',
      unlockedAt: new Date(),
      unlockReason: 'follow',
    })

    const app = express()
    app.use(express.json())
    app.use('/api/users', userRouter)
    app.use('/api/follows', followRouter)
    app.use('/api/collections', collectionRouter)
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    await CollectionMembership.deleteMany({ collectionId: { $in: collectionIds } })
    await Collection.deleteMany({ _id: { $in: collectionIds } })
    await Favorite.deleteMany({ userId: { $in: userIds } })
    await DirectConversation.deleteMany({ _id: conversation?._id })
    await Follow.deleteMany({
      $or: [{ followerId: { $in: userIds } }, { followingId: { $in: userIds } }],
    })
    await UserBlock.deleteMany({
      $or: [{ blockerUserId: { $in: userIds } }, { blockedUserId: { $in: userIds } }],
    })
    await User.deleteMany({ _id: { $in: userIds } })
    await mongoose.disconnect()
  })

  it('authenticates Profile and Collection detail before parsing IDs', async () => {
    for (const path of [
      `/api/users/${target._id}`,
      '/api/users/not-an-id',
      `/api/collections/${targetPublicCollection._id}`,
      '/api/collections/not-an-id',
    ]) {
      assert.equal((await request(baseUrl, path)).status, 401)
    }
    assert.equal(
      (await request(baseUrl, '/api/users/not-an-id', { token: actorToken })).status,
      400,
    )
    assert.equal(
      (await request(baseUrl, '/api/collections/not-an-id', { token: actorToken })).status,
      400,
    )
  })

  it('preserves self, owner, unrelated, Phase 7, and success DTO behavior', async () => {
    const selfProfile = await json(
      await request(baseUrl, `/api/users/${actor._id}`, { token: actorToken }),
    )
    assert.equal(selfProfile.status, 200)
    assert.deepEqual(Object.keys(selfProfile.body), ['user'])

    for (const path of [
      `/api/users/${actor._id}/movie-space`,
      `/api/users/${actor._id}/movie-dna`,
      `/api/follows/${actor._id}`,
    ]) {
      assert.equal((await request(baseUrl, path, { token: actorToken })).status, 200)
    }

    const ownerPrivate = await json(
      await request(baseUrl, `/api/collections/${targetPrivateCollection._id}`, {
        token: targetToken,
      }),
    )
    assert.equal(ownerPrivate.status, 200)
    assert.equal(ownerPrivate.body.collection.visibility, 'private')

    const ownerPublic = await json(
      await request(baseUrl, `/api/collections/${targetPublicCollection._id}`, {
        token: targetToken,
      }),
    )
    assert.equal(ownerPublic.status, 200)
    assert.equal(ownerPublic.body.collection.visibility, 'public')

    for (const path of [
      `/api/users/${target._id}`,
      `/api/users/${target._id}/movie-dna`,
      `/api/users/${target._id}/dna-match`,
      `/api/follows/${target._id}`,
    ]) {
      assert.equal((await request(baseUrl, path, { token: actorToken })).status, 200)
    }

    const unrelatedPrivateMovieSpace = await json(
      await request(baseUrl, `/api/users/${target._id}/movie-space`, { token: actorToken }),
    )
    assert.equal(unrelatedPrivateMovieSpace.status, 200)
    assert.equal('favorites' in unrelatedPrivateMovieSpace.body, false)
    assert.equal(unrelatedPrivateMovieSpace.body.collections.length, 1)

    target.favoritesPublic = true
    await target.save()
    const unrelatedPublicMovieSpace = await json(
      await request(baseUrl, `/api/users/${target._id}/movie-space`, { token: actorToken }),
    )
    assert.deepEqual(
      unrelatedPublicMovieSpace.body.favorites.map(({ tmdbId }) => tmdbId).sort(),
      [101, 202],
    )

    const dnaMatch = await json(
      await request(baseUrl, `/api/users/${target._id}/dna-match`, { token: actorToken }),
    )
    assert.equal(dnaMatch.status, 200)
    assert.equal('matchScore' in dnaMatch.body.dnaMatch, false)
    assert.deepEqual(Object.keys(dnaMatch.body), ['dnaMatch'])

    const visitorCollection = await json(
      await request(baseUrl, `/api/collections/${targetPublicCollection._id}`, {
        token: actorToken,
      }),
    )
    assert.equal(visitorCollection.status, 200)
    assert.equal('ownerId' in visitorCollection.body.collection, false)
    assert.equal('visibility' in visitorCollection.body.collection, false)
    assert.deepEqual(visitorCollection.body.collection.memberships, [{ tmdbId: 202, position: 0 }])
    assert.deepEqual(
      await json(
        await request(baseUrl, `/api/collections/${targetPrivateCollection._id}`, {
          token: actorToken,
        }),
      ),
      neutral,
    )
  })

  it('neutralizes both Block directions across all six resource families', async () => {
    const block = await request(baseUrl, `/api/users/${target._id}/block`, {
      method: 'PUT',
      token: actorToken,
    })
    assert.equal(block.status, 200)

    const actorToTarget = [
      `/api/users/${target._id}`,
      `/api/users/${target._id}/movie-space`,
      `/api/users/${target._id}/movie-dna`,
      `/api/users/${target._id}/dna-match`,
      `/api/follows/${target._id}`,
      `/api/collections/${targetPublicCollection._id}`,
    ]
    const targetToActor = [
      `/api/users/${actor._id}`,
      `/api/users/${actor._id}/movie-space`,
      `/api/users/${actor._id}/movie-dna`,
      `/api/users/${actor._id}/dna-match`,
      `/api/follows/${actor._id}`,
      `/api/collections/${actorPublicCollection._id}`,
    ]
    for (const [paths, token] of [
      [actorToTarget, actorToken],
      [targetToActor, targetToken],
    ]) {
      for (const path of paths) {
        const result = await json(await request(baseUrl, path, { token }))
        assert.deepEqual(result, neutral)
        const serialized = JSON.stringify(result)
        for (const forbidden of [
          'blocker',
          'blockedBy',
          'actorBlocksTarget',
          'targetBlocksActor',
        ]) {
          assert.equal(serialized.includes(forbidden), false)
        }
      }
    }

    const missingUser = new Types.ObjectId()
    for (const path of [
      `/api/users/${missingUser}`,
      `/api/users/${missingUser}/movie-space`,
      `/api/users/${missingUser}/movie-dna`,
      `/api/users/${missingUser}/dna-match`,
      `/api/follows/${missingUser}`,
    ]) {
      assert.deepEqual(await json(await request(baseUrl, path, { token: actorToken })), neutral)
    }
    assert.deepEqual(
      await json(
        await request(baseUrl, `/api/collections/${new Types.ObjectId()}`, { token: actorToken }),
      ),
      neutral,
    )
  })

  it('re-evaluates access after Unblock without restoring Follow or Direct state', async () => {
    const unblock = await request(baseUrl, `/api/users/${target._id}/block`, {
      method: 'DELETE',
      token: actorToken,
    })
    assert.equal(unblock.status, 200)
    assert.equal(
      (await request(baseUrl, `/api/users/${target._id}/movie-space`, { token: actorToken }))
        .status,
      200,
    )
    assert.equal(await Follow.countDocuments({ followerId: { $in: userIds } }), 0)
    const storedConversation = await DirectConversation.findById(conversation._id).lean()
    assert.equal(storedConversation.state, 'revoked')
    assert.equal(storedConversation.revocationReason, 'block')
  })
})

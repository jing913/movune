import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import express from 'express'
import jsonwebtoken from 'jsonwebtoken'
import mongoose, { Types } from 'mongoose'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import { ContactPairGuard } from '../dist/models/contactPairGuardModel.js'
import { DirectConversation } from '../dist/models/directConversationModel.js'
import { DirectConversationState } from '../dist/models/directConversationStateModel.js'
import { Follow } from '../dist/models/followModel.js'
import { Message } from '../dist/models/messageModel.js'
import { UserBlock } from '../dist/models/userBlockModel.js'
import { User } from '../dist/models/userModel.js'

const jwtSecret = 'block-api-test-secret'
process.env.JWT_SECRET ??= jwtSecret
await import('../dist/configs/passport.js')
const { default: userRouter } = await import('../dist/routes/user.js')
const { directRouter } = await import('../dist/routes/messaging.js')

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

const request = (baseUrl, path, { method = 'GET', token, body } = {}) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

const assertContactInteractionShape = (value, { conversation = true } = {}) => {
  assert.deepEqual(
    Object.keys(value).sort(),
    conversation
      ? ['capabilities', 'conversation', 'interactionState']
      : ['capabilities', 'interactionState'],
  )
  assert.deepEqual(Object.keys(value.capabilities).sort(), [
    'canBlockUser',
    'canCreateMessageRequest',
    'canFollowUser',
    'canReportUser',
    'canSendMessage',
    'canUnblockUser',
  ])
  if (conversation) assert.deepEqual(Object.keys(value.conversation).sort(), ['id', 'state'])
  const serialized = JSON.stringify(value)
  for (const forbidden of [
    'actorBlocksTarget',
    'targetBlocksActor',
    'effectiveBlockDirection',
    'blockedBy',
    'blockerUserId',
    'blockedUserId',
    'messageRequestPreference',
    'initiatedByUserId',
    'revocationReason',
    'mayDistributeUser',
    'mayAccessDirectSocialSurface',
    'canAccept',
    'canDecline',
    'reason',
    '__v',
  ]) {
    assert.equal(serialized.includes(forbidden), false)
  }
}

describe('Block API authorization boundary', { timeout: 90_000 }, () => {
  let actor
  let target
  let noConversationTarget
  let server
  let baseUrl
  let actorToken
  let targetToken
  const userIds = []

  before(async () => {
    const url = await databaseUrl()
    if (!url) throw new Error('DB_URL is required for Block API integration tests')
    await mongoose.connect(url)
    for (const model of [
      ContactPairGuard,
      DirectConversation,
      DirectConversationState,
      Follow,
      UserBlock,
    ]) {
      await model.syncIndexes()
    }

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    ;[actor, target, noConversationTarget] = await User.create([
      {
        account: `block-actor-${suffix}`,
        email: `block-actor-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      },
      {
        account: `block-target-${suffix}`,
        email: `block-target-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      },
      {
        account: `block-empty-${suffix}`,
        email: `block-empty-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      },
    ])
    userIds.push(actor._id, target._id, noConversationTarget._id)
    actorToken = tokenFor(actor)
    targetToken = tokenFor(target)

    const app = express()
    app.use(express.json())
    app.use('/api/users', userRouter)
    app.use('/api/direct-conversations', directRouter)
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    await Message.deleteMany({ senderId: { $in: userIds } })
    await DirectConversationState.deleteMany({ userId: { $in: userIds } })
    await DirectConversation.deleteMany({ participantIds: { $in: userIds } })
    await Follow.deleteMany({
      $or: [{ followerId: { $in: userIds } }, { followingId: { $in: userIds } }],
    })
    await UserBlock.deleteMany({
      $or: [{ blockerUserId: { $in: userIds } }, { blockedUserId: { $in: userIds } }],
    })
    const guards = await ContactPairGuard.find({}).select('_id participantKey').lean()
    const ownedGuardIds = guards
      .filter((guard) => userIds.some((id) => guard.participantKey.includes(id.toString())))
      .map((guard) => guard._id)
    await ContactPairGuard.deleteMany({ _id: { $in: ownedGuardIds } })
    await User.deleteMany({ _id: { $in: userIds } })
    await mongoose.disconnect()
  })

  it('requires existing authentication for Block and Unblock', async () => {
    for (const method of ['PUT', 'DELETE']) {
      const response = await request(baseUrl, `/api/users/${target._id}/block`, { method })
      assert.equal(response.status, 401)
    }
  })

  it('uses additive INVALID_INPUT without changing existing error contracts', async () => {
    const malformed = 'malformed-raw-user-id'
    for (const method of ['PUT', 'DELETE']) {
      const response = await request(baseUrl, `/api/users/${malformed}/block`, {
        method,
        token: actorToken,
      })
      assert.equal(response.status, 400)
      const body = await response.json()
      assert.deepEqual(body, {
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid request input.',
          details: { field: 'userId' },
        },
      })
      assert.equal(JSON.stringify(body).includes(malformed), false)
    }

    const messaging = await request(baseUrl, '/api/direct-conversations/resolve', {
      method: 'POST',
      token: actorToken,
      body: { otherUserId: malformed },
    })
    assert.equal(messaging.status, 400)
    assert.equal((await messaging.json()).error.code, 'MESSAGE_INVALID')

    const legacyUser = await request(baseUrl, `/api/users/${malformed}`)
    assert.equal(legacyUser.status, 400)
    assert.deepEqual(await legacyUser.json(), { message: 'Invalid user id' })
  })

  it('returns idempotent authoritative Block responses with an exact safe allowlist', async () => {
    await Follow.create([
      { followerId: actor._id, followingId: target._id },
      { followerId: target._id, followingId: actor._id },
    ])
    const conversation = await DirectConversation.create({
      participantIds: [actor._id, target._id],
      participantKey: [actor._id.toString(), target._id.toString()].sort().join(':'),
      initiatedByUserId: actor._id,
      state: 'unlocked',
      unlockedAt: new Date(),
      unlockReason: 'follow',
    })
    await DirectConversationState.create([
      { conversationId: conversation._id, userId: actor._id },
      { conversationId: conversation._id, userId: target._id },
    ])

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request(baseUrl, `/api/users/${target._id}/block`, {
        method: 'PUT',
        token: actorToken,
      })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.deepEqual(Object.keys(body), ['contactInteraction'])
      assertContactInteractionShape(body.contactInteraction)
      assert.equal(body.contactInteraction.interactionState, 'blocked')
      assert.equal(body.contactInteraction.capabilities.canUnblockUser, true)
      assert.equal(body.contactInteraction.capabilities.canReportUser, true)
      assert.deepEqual(body.contactInteraction.conversation, {
        id: conversation._id.toString(),
        state: 'revoked',
      })
    }

    assert.equal(
      await UserBlock.countDocuments({ blockerUserId: actor._id, blockedUserId: target._id }),
      1,
    )
    assert.equal(
      await Follow.countDocuments({
        $or: [
          { followerId: actor._id, followingId: target._id },
          { followerId: target._id, followingId: actor._id },
        ],
      }),
      0,
    )
    assert.equal((await DirectConversation.findById(conversation._id).lean()).state, 'revoked')
  })

  it('omits conversation when none exists', async () => {
    const response = await request(baseUrl, `/api/users/${noConversationTarget._id}/block`, {
      method: 'PUT',
      token: actorToken,
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assertContactInteractionShape(body.contactInteraction, { conversation: false })
    assert.equal(body.contactInteraction.interactionState, 'blocked')
  })

  it('derives the current authorization after a successful Unblock', async () => {
    const response = await request(baseUrl, `/api/users/${noConversationTarget._id}/block`, {
      method: 'DELETE',
      token: actorToken,
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(Object.keys(body), ['contactInteraction'])
    assertContactInteractionShape(body.contactInteraction, { conversation: false })
    assert.equal(body.contactInteraction.interactionState, 'request_allowed')
    assert.deepEqual(body.contactInteraction.capabilities, {
      canSendMessage: false,
      canCreateMessageRequest: true,
      canFollowUser: true,
      canBlockUser: true,
      canUnblockUser: false,
      canReportUser: true,
    })
  })

  it('enforces self and neutral missing-target errors', async () => {
    const self = await request(baseUrl, `/api/users/${actor._id}/block`, {
      method: 'PUT',
      token: actorToken,
    })
    assert.equal(self.status, 400)
    assert.equal((await self.json()).error.code, 'BLOCK_SELF_INVALID')

    const missing = await request(baseUrl, `/api/users/${new Types.ObjectId()}/block`, {
      method: 'PUT',
      token: actorToken,
    })
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), {
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'Resource not found',
      },
    })
  })

  it('Unblocks only actor ownership and keeps reciprocal ownership neutral', async () => {
    const reciprocal = await request(baseUrl, `/api/users/${actor._id}/block`, {
      method: 'PUT',
      token: targetToken,
    })
    assert.equal(reciprocal.status, 200)

    const removed = await request(baseUrl, `/api/users/${target._id}/block`, {
      method: 'DELETE',
      token: actorToken,
    })
    assert.equal(removed.status, 200)
    const body = await removed.json()
    assert.deepEqual(Object.keys(body), ['contactInteraction'])
    assertContactInteractionShape(body.contactInteraction)
    assert.equal(body.contactInteraction.interactionState, 'blocked')
    assert.equal(body.contactInteraction.capabilities.canUnblockUser, false)
    assert.equal(
      await UserBlock.countDocuments({ blockerUserId: target._id, blockedUserId: actor._id }),
      1,
    )

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const notOwned = await request(baseUrl, `/api/users/${target._id}/block`, {
        method: 'DELETE',
        token: actorToken,
      })
      assert.equal(notOwned.status, 409)
      assert.equal((await notOwned.json()).error.code, 'BLOCK_NOT_OWNED')
    }
  })
})

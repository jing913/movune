import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import express from 'express'
import jsonwebtoken from 'jsonwebtoken'
import mongoose from 'mongoose'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import { ContactPairGuard } from '../dist/models/contactPairGuardModel.js'
import { DirectConversation } from '../dist/models/directConversationModel.js'
import { DirectConversationState } from '../dist/models/directConversationStateModel.js'
import { Follow } from '../dist/models/followModel.js'
import { Message } from '../dist/models/messageModel.js'
import { UserBlock } from '../dist/models/userBlockModel.js'
import { User } from '../dist/models/userModel.js'
import { getContactAuthorizationContext } from '../dist/services/contactAuthorizationContextService.js'
import { sendFirstDirect } from '../dist/services/messagingService.js'
import { evaluateContactAuthorization } from '../dist/utils/contactAuthorizationPolicy.js'
import { participantKey } from '../dist/utils/messagingPolicy.js'

process.env.JWT_SECRET ??= 'phase8-stage7-privacy-test-secret'
await import('../dist/configs/passport.js')
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

const noBody = Symbol('no-body')
const request = (baseUrl, path, { method = 'GET', token, body = noBody } = {}) => {
  const hasBody = body !== noBody
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  })
}

const privacyDto = (messageRequestPreference) => ({
  privacy: { messageRequestPreference },
})

const assertProblem = async (response, { status, code, field, absent }) => {
  assert.equal(response.status, status)
  const body = await response.json()
  assert.deepEqual(body, {
    error: {
      code,
      message:
        code === 'INVALID_INPUT'
          ? 'Invalid request input.'
          : 'Messaging privacy preference is invalid.',
      ...(field ? { details: { field } } : {}),
    },
  })
  if (absent) assert.equal(JSON.stringify(body).includes(absent), false)
}

describe('Official Phase 8 Stage 7 Messaging Preference API', { timeout: 120_000 }, () => {
  let server
  let baseUrl
  let actor
  let legacy
  let corrupt
  let sender
  let otherSender
  let actorToken
  const userIds = []

  const createConversation = async (other, state) => {
    const conversation = await DirectConversation.create({
      participantIds: [other._id, actor._id],
      participantKey: participantKey(other._id.toString(), actor._id.toString()),
      initiatedByUserId: other._id,
      state,
      ...(state === 'unlocked' ? { unlockedAt: new Date(), unlockReason: 'accept' } : {}),
      ...(state === 'declined' ? { declinedAt: new Date() } : {}),
      ...(state === 'revoked' ? { revokedAt: new Date(), revocationReason: 'block' } : {}),
    })
    await DirectConversationState.create([
      { conversationId: conversation._id, userId: other._id },
      { conversationId: conversation._id, userId: actor._id },
    ])
    return conversation
  }

  before(async () => {
    const url = await databaseUrl()
    if (!url) throw new Error('DB_URL is required for Stage 7 Messaging Preference API tests')
    await mongoose.connect(url)
    for (const model of [
      ContactPairGuard,
      DirectConversation,
      DirectConversationState,
      Follow,
      Message,
      UserBlock,
    ]) {
      await model.syncIndexes()
    }

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    ;[actor, legacy, corrupt, sender, otherSender] = await User.create(
      ['actor', 'legacy', 'corrupt', 'sender', 'other-sender'].map((name) => ({
        account: `p8s7-${name}-${suffix}`,
        displayName: `Stage 7 ${name}`,
        email: `p8s7-${name}-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
        favoritesPublic: true,
      })),
    )
    userIds.push(actor._id, legacy._id, corrupt._id, sender._id, otherSender._id)
    actorToken = tokenFor(actor)
    await User.collection.updateOne(
      { _id: legacy._id },
      { $unset: { messageRequestPreference: '' } },
    )
    await User.collection.updateOne(
      { _id: corrupt._id },
      { $set: { messageRequestPreference: 'corrupt-never-echo' } },
    )

    const app = express()
    app.use(express.json())
    app.use('/api/users', userRouter)
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
    const guardIds = guards
      .filter((guard) => userIds.some((id) => guard.participantKey.includes(id.toString())))
      .map((guard) => guard._id)
    await ContactPairGuard.deleteMany({ _id: { $in: guardIds } })
    await User.deleteMany({ _id: { $in: userIds } })
    await mongoose.disconnect()
  })

  it('requires authentication for GET and PATCH', async () => {
    for (const method of ['GET', 'PATCH']) {
      const response = await request(baseUrl, '/api/users/me/privacy', {
        method,
        ...(method === 'PATCH' ? { body: { messageRequestPreference: 'all_members' } } : {}),
      })
      assert.equal(response.status, 401)
    }
  })

  it('GET returns the exact privacy allowlist for both canonical values', async () => {
    for (const value of ['all_members', 'followed_members']) {
      await User.updateOne({ _id: actor._id }, { $set: { messageRequestPreference: value } })
      const response = await request(baseUrl, '/api/users/me/privacy', { token: actorToken })
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.deepEqual(body, privacyDto(value))
      assert.deepEqual(Object.keys(body), ['privacy'])
      assert.deepEqual(Object.keys(body.privacy), ['messageRequestPreference'])
      for (const forbidden of ['favoritesPublic', 'email', 'password', 'account', '_id', '__v']) {
        assert.equal(JSON.stringify(body).includes(forbidden), false)
      }
    }
  })

  it('GET normalizes a missing legacy value without backfilling it', async () => {
    const response = await request(baseUrl, '/api/users/me/privacy', { token: tokenFor(legacy) })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), privacyDto('all_members'))
    const stored = await User.collection.findOne(
      { _id: legacy._id },
      { projection: { messageRequestPreference: 1 } },
    )
    assert.equal(Object.hasOwn(stored, 'messageRequestPreference'), false)
  })

  it('GET fails safely for corrupt persisted data without exposing or repairing it', async () => {
    const response = await request(baseUrl, '/api/users/me/privacy', { token: tokenFor(corrupt) })
    await assertProblem(response, {
      status: 500,
      code: 'PRIVACY_PREFERENCE_INVALID',
      absent: 'corrupt-never-echo',
    })
    const stored = await User.collection.findOne(
      { _id: corrupt._id },
      { projection: { messageRequestPreference: 1 } },
    )
    assert.equal(stored.messageRequestPreference, 'corrupt-never-echo')
  })

  it('PATCH persists both values, returns authoritative DTO, and is idempotent', async () => {
    const before = await User.findById(actor._id).lean()
    for (const value of ['all_members', 'followed_members', 'followed_members']) {
      const response = await request(baseUrl, '/api/users/me/privacy', {
        method: 'PATCH',
        token: actorToken,
        body: { messageRequestPreference: value },
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), privacyDto(value))
      assert.equal((await User.findById(actor._id).lean()).messageRequestPreference, value)
    }
    const after = await User.findById(actor._id).lean()
    for (const field of ['account', 'displayName', 'email', 'role', 'favoritesPublic']) {
      assert.deepEqual(after[field], before[field])
    }
  })

  it('rejects missing, unknown, and non-object bodies as structural INVALID_INPUT', async () => {
    const missingBodyResponse = await request(baseUrl, '/api/users/me/privacy', {
      method: 'PATCH',
      token: actorToken,
    })
    await assertProblem(missingBodyResponse, {
      status: 400,
      code: 'INVALID_INPUT',
      field: 'messageRequestPreference',
    })

    const cases = [
      [{}, 'messageRequestPreference', undefined],
      [null, 'messageRequestPreference', undefined],
      [[], 'messageRequestPreference', undefined],
      ['primitive-never-echo', 'messageRequestPreference', 'primitive-never-echo'],
      [42, 'messageRequestPreference', undefined],
      [true, 'messageRequestPreference', undefined],
      [{ unknownNeverEcho: true }, 'body', 'unknownNeverEcho'],
      [
        { messageRequestPreference: 'all_members', unknownNeverEcho: true },
        'body',
        'unknownNeverEcho',
      ],
    ]
    for (const [body, field, absent] of cases) {
      const response = await request(baseUrl, '/api/users/me/privacy', {
        method: 'PATCH',
        token: actorToken,
        body,
      })
      await assertProblem(response, { status: 400, code: 'INVALID_INPUT', field, absent })
    }
  })

  it('rejects invalid domain values without echoing them', async () => {
    const values = ['domain-never-echo', false, 17, null, ['all_members'], { value: 'all_members' }]
    for (const value of values) {
      const response = await request(baseUrl, '/api/users/me/privacy', {
        method: 'PATCH',
        token: actorToken,
        body: { messageRequestPreference: value },
      })
      await assertProblem(response, {
        status: 400,
        code: 'PRIVACY_PREFERENCE_INVALID',
        field: 'messageRequestPreference',
        ...(typeof value === 'string' ? { absent: value } : {}),
      })
    }
  })

  it('PATCH changes no Follow or Block relationship', async () => {
    await Follow.create({ followerId: actor._id, followingId: otherSender._id })
    await UserBlock.create({ blockerUserId: otherSender._id, blockedUserId: actor._id })
    const before = {
      follows: await Follow.countDocuments({
        $or: [
          { followerId: actor._id, followingId: otherSender._id },
          { followerId: otherSender._id, followingId: actor._id },
        ],
      }),
      blocks: await UserBlock.countDocuments({
        $or: [
          { blockerUserId: actor._id, blockedUserId: otherSender._id },
          { blockerUserId: otherSender._id, blockedUserId: actor._id },
        ],
      }),
    }

    const response = await request(baseUrl, '/api/users/me/privacy', {
      method: 'PATCH',
      token: actorToken,
      body: { messageRequestPreference: 'all_members' },
    })
    assert.equal(response.status, 200)
    assert.equal(
      await Follow.countDocuments({
        $or: [
          { followerId: actor._id, followingId: otherSender._id },
          { followerId: otherSender._id, followingId: actor._id },
        ],
      }),
      before.follows,
    )
    assert.equal(
      await UserBlock.countDocuments({
        $or: [
          { blockerUserId: actor._id, blockedUserId: otherSender._id },
          { blockerUserId: otherSender._id, blockedUserId: actor._id },
        ],
      }),
      before.blocks,
    )
  })

  it('preserves Pending, Unlocked, Declined, and Revoked lifecycle while capabilities re-evaluate', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const lifecycleUsers = await User.create(
      ['pending', 'unlocked', 'declined', 'revoked'].map((state) => ({
        account: `p8s7-lifecycle-${state}-${suffix}`,
        email: `p8s7-lifecycle-${state}-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      })),
    )
    userIds.push(...lifecycleUsers.map((user) => user._id))
    const conversations = new Map()
    for (let index = 0; index < lifecycleUsers.length; index += 1) {
      const state = ['pending', 'unlocked', 'declined', 'revoked'][index]
      conversations.set(state, await createConversation(lifecycleUsers[index], state))
    }

    await request(baseUrl, '/api/users/me/privacy', {
      method: 'PATCH',
      token: actorToken,
      body: { messageRequestPreference: 'followed_members' },
    })
    for (const state of ['pending', 'unlocked', 'declined', 'revoked']) {
      assert.equal(
        (await DirectConversation.findById(conversations.get(state)._id).lean()).state,
        state,
      )
    }
    const unlockedContext = await getContactAuthorizationContext(
      lifecycleUsers[1]._id.toString(),
      actor._id.toString(),
    )
    assert.equal(evaluateContactAuthorization(unlockedContext).capabilities.canSendMessage, true)
    const declinedContext = await getContactAuthorizationContext(
      lifecycleUsers[2]._id.toString(),
      actor._id.toString(),
    )
    assert.equal(evaluateContactAuthorization(declinedContext).interactionState, 'declined')
    const revokedClosed = await getContactAuthorizationContext(
      lifecycleUsers[3]._id.toString(),
      actor._id.toString(),
    )
    assert.equal(
      evaluateContactAuthorization(revokedClosed).interactionState,
      'revoked_unavailable',
    )

    await request(baseUrl, '/api/users/me/privacy', {
      method: 'PATCH',
      token: actorToken,
      body: { messageRequestPreference: 'all_members' },
    })
    const revokedOpen = await getContactAuthorizationContext(
      lifecycleUsers[3]._id.toString(),
      actor._id.toString(),
    )
    assert.equal(evaluateContactAuthorization(revokedOpen).interactionState, 'request_allowed')
    assert.equal(
      (await DirectConversation.findById(conversations.get('revoked')._id).lean()).state,
      'revoked',
    )
  })

  it('preserves receiver-Follow direction, Declined suppression, and Block precedence', async () => {
    await DirectConversation.deleteMany({
      participantKey: participantKey(sender._id.toString(), actor._id.toString()),
    })
    await Follow.deleteMany({
      $or: [
        { followerId: sender._id, followingId: actor._id },
        { followerId: actor._id, followingId: sender._id },
      ],
    })
    await User.updateOne(
      { _id: actor._id },
      { $set: { messageRequestPreference: 'followed_members' } },
    )

    await Follow.create({ followerId: sender._id, followingId: actor._id })
    let context = await getContactAuthorizationContext(sender._id.toString(), actor._id.toString())
    assert.equal(evaluateContactAuthorization(context).capabilities.canCreateMessageRequest, false)
    await Follow.create({ followerId: actor._id, followingId: sender._id })
    context = await getContactAuthorizationContext(sender._id.toString(), actor._id.toString())
    assert.equal(evaluateContactAuthorization(context).interactionState, 'direct_allowed')

    await Follow.deleteMany({
      $or: [
        { followerId: sender._id, followingId: actor._id },
        { followerId: actor._id, followingId: sender._id },
      ],
    })
    const declined = await createConversation(sender, 'declined')
    await User.updateOne({ _id: actor._id }, { $set: { messageRequestPreference: 'all_members' } })
    context = await getContactAuthorizationContext(sender._id.toString(), actor._id.toString())
    assert.equal(evaluateContactAuthorization(context).interactionState, 'declined')
    assert.equal((await DirectConversation.findById(declined._id).lean()).state, 'declined')

    await DirectConversation.deleteOne({ _id: declined._id })
    await UserBlock.create({ blockerUserId: actor._id, blockedUserId: sender._id })
    context = await getContactAuthorizationContext(sender._id.toString(), actor._id.toString())
    assert.equal(evaluateContactAuthorization(context).interactionState, 'blocked')
    assert.equal(evaluateContactAuthorization(context).capabilities.canCreateMessageRequest, false)
  })

  it('uses the preference persisted before a subsequently started first-send', async () => {
    await UserBlock.deleteMany({
      $or: [
        { blockerUserId: actor._id, blockedUserId: otherSender._id },
        { blockerUserId: otherSender._id, blockedUserId: actor._id },
      ],
    })
    await Follow.deleteMany({
      $or: [
        { followerId: actor._id, followingId: otherSender._id },
        { followerId: otherSender._id, followingId: actor._id },
      ],
    })
    await DirectConversation.deleteMany({
      participantKey: participantKey(otherSender._id.toString(), actor._id.toString()),
    })
    await request(baseUrl, '/api/users/me/privacy', {
      method: 'PATCH',
      token: actorToken,
      body: { messageRequestPreference: 'all_members' },
    })
    let context = await getContactAuthorizationContext(
      otherSender._id.toString(),
      actor._id.toString(),
    )
    assert.equal(evaluateContactAuthorization(context).interactionState, 'request_allowed')

    const patchResponse = await request(baseUrl, '/api/users/me/privacy', {
      method: 'PATCH',
      token: actorToken,
      body: { messageRequestPreference: 'followed_members' },
    })
    assert.equal(patchResponse.status, 200)
    await assert.rejects(
      () =>
        sendFirstDirect(
          otherSender._id.toString(),
          actor._id.toString(),
          `stage7-fresh-${Date.now()}`,
          'must use current preference',
        ),
      { code: 'MESSAGE_REQUEST_NOT_ALLOWED' },
    )
    assert.equal(
      await DirectConversation.countDocuments({
        participantKey: participantKey(otherSender._id.toString(), actor._id.toString()),
      }),
      0,
    )
    assert.equal(
      await Message.countDocuments({
        senderId: otherSender._id,
        content: 'must use current preference',
      }),
      0,
    )
  })
})

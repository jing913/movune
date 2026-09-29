import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import express from 'express'
import jsonwebtoken from 'jsonwebtoken'
import mongoose, { Types } from 'mongoose'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import { DirectConversation } from '../dist/models/directConversationModel.js'
import { DirectConversationState } from '../dist/models/directConversationStateModel.js'
import { Favorite } from '../dist/models/favoriteModel.js'
import { Follow } from '../dist/models/followModel.js'
import { Message } from '../dist/models/messageModel.js'
import { UserBlock } from '../dist/models/userBlockModel.js'
import { User } from '../dist/models/userModel.js'
import { listDirectConversationRead } from '../dist/services/directConversationReadService.js'

const jwtSecret = 'phase8-stage6-read-model-test-secret'
process.env.JWT_SECRET ??= jwtSecret
await import('../dist/configs/passport.js')
const { default: userRouter } = await import('../dist/routes/user.js')
const { directRouter, inboxRouter } = await import('../dist/routes/messaging.js')

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

const request = (baseUrl, path, token) =>
  fetch(`${baseUrl}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

const summaryKeys = [
  'capabilities',
  'counterpart',
  'hasUnread',
  'id',
  'interactionState',
  'lastMessage',
  'sharedContext',
  'updatedAt',
]

describe('Official Phase 8 Stage 6 Read Model API', { timeout: 90_000 }, () => {
  let actor
  let targets
  let server
  let baseUrl
  let token
  const userIds = []
  const conversationIds = []
  const unavailableId = new Types.ObjectId()
  const byName = new Map()

  const createConversation = async ({
    name,
    target,
    state,
    initiator = actor,
    sender = target,
    at,
    read = false,
  }) => {
    const conversationId = new Types.ObjectId()
    const messageId = new Types.ObjectId()
    const createdAt = new Date(at)
    await Message.create({
      _id: messageId,
      senderId: sender._id,
      clientMessageId: `stage6-${name}-${conversationId}`,
      contextType: 'direct',
      contextId: conversationId,
      content: `${name} content`,
      createdAt,
      updatedAt: createdAt,
    })
    const conversation = await DirectConversation.create({
      _id: conversationId,
      participantIds: [actor._id, target._id],
      participantKey: [actor._id.toString(), target._id.toString()].sort().join(':'),
      initiatedByUserId: initiator._id,
      state,
      lastMessage: {
        messageId,
        senderId: sender._id,
        preview: `${name} content`,
        createdAt,
      },
      createdAt,
      updatedAt: createdAt,
    })
    await DirectConversationState.create([
      {
        conversationId,
        userId: actor._id,
        ...(read ? { lastReadMessageId: messageId, lastReadMessageCreatedAt: createdAt } : {}),
      },
      { conversationId, userId: target._id },
    ])
    conversationIds.push(conversationId)
    byName.set(name, conversation)
    return conversation
  }

  before(async () => {
    const url = await databaseUrl()
    if (!url) throw new Error('DB_URL is required for Stage 6 Read Model API tests')
    await mongoose.connect(url)
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const users = await User.create(
      [
        'actor',
        'unlocked',
        'outgoing',
        'incoming',
        'declined',
        'revoked',
        'blocked',
        'private',
        'other-blocker',
      ].map((name) => ({
        account: `p8s6-${name}-${suffix}`,
        displayName: `Stage 6 ${name}`,
        email: `p8s6-${name}-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
        favoritesPublic: name === 'unlocked',
        messageRequestPreference: 'all_members',
      })),
    )
    ;[actor, ...targets] = users
    userIds.push(...users.map((user) => user._id))
    token = tokenFor(actor)
    const [unlocked, outgoing, incoming, declined, revoked, blocked, privateTarget, otherBlocker] =
      targets
    await createConversation({
      name: 'unlocked',
      target: unlocked,
      state: 'unlocked',
      at: '2026-08-01T00:00:00.000Z',
    })
    const tieAt = '2026-08-02T00:00:00.000Z'
    await createConversation({
      name: 'outgoing',
      target: outgoing,
      state: 'pending',
      initiator: actor,
      sender: actor,
      at: tieAt,
    })
    await createConversation({
      name: 'incoming',
      target: incoming,
      state: 'pending',
      initiator: incoming,
      sender: incoming,
      at: tieAt,
      read: true,
    })
    await createConversation({
      name: 'private',
      target: privateTarget,
      state: 'pending',
      initiator: privateTarget,
      sender: privateTarget,
      at: tieAt,
    })
    await createConversation({
      name: 'declined',
      target: declined,
      state: 'declined',
      initiator: actor,
      sender: actor,
      at: '2026-08-03T00:00:00.000Z',
    })
    await createConversation({
      name: 'revoked',
      target: revoked,
      state: 'revoked',
      at: '2026-08-04T00:00:00.000Z',
    })
    await createConversation({
      name: 'blocked',
      target: blocked,
      state: 'unlocked',
      at: '2026-08-05T00:00:00.000Z',
    })
    await Favorite.create([
      { userId: actor._id, tmdbId: 101 },
      { userId: unlocked._id, tmdbId: 101 },
      { userId: privateTarget._id, tmdbId: 101 },
    ])
    await UserBlock.create([
      { blockerUserId: actor._id, blockedUserId: blocked._id },
      { blockerUserId: blocked._id, blockedUserId: actor._id },
      { blockerUserId: otherBlocker._id, blockedUserId: actor._id },
      { blockerUserId: actor._id, blockedUserId: unavailableId },
    ])
    await Follow.create({ followerId: declined._id, followingId: actor._id })

    const app = express()
    app.use(express.json())
    app.use('/api/users', userRouter)
    app.use('/api/direct-conversations', directRouter)
    app.use('/api/inbox', inboxRouter)
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${server.address().port}/api/direct-conversations`
  })

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    await Message.deleteMany({ contextId: { $in: conversationIds } })
    await DirectConversationState.deleteMany({ conversationId: { $in: conversationIds } })
    await DirectConversation.deleteMany({ _id: { $in: conversationIds } })
    await Favorite.deleteMany({ userId: { $in: userIds } })
    await Follow.deleteMany({
      $or: [{ followerId: { $in: userIds } }, { followingId: { $in: userIds } }],
    })
    await UserBlock.deleteMany({
      $or: [{ blockerUserId: { $in: userIds } }, { blockedUserId: { $in: userIds } }],
    })
    await User.deleteMany({ _id: { $in: userIds } })
    await mongoose.disconnect()
  })

  it('serves exact explicit views with Block overlay and the frozen DTO allowlist', async () => {
    const conversations = await request(baseUrl, '?view=conversations', token)
    assert.equal(conversations.status, 200)
    const conversationsBody = await conversations.json()
    assert.deepEqual(
      conversationsBody.conversations.map((item) => item.id),
      [byName.get('unlocked')._id.toString()],
    )
    const active = conversationsBody.conversations[0]
    assert.deepEqual(Object.keys(active).sort(), summaryKeys)
    assert.equal(active.interactionState, 'unlocked')
    assert.deepEqual(active.sharedContext, { shouldRender: true, movies: [{ tmdbId: 101 }] })
    assert.deepEqual(Object.keys(active.counterpart).sort(), ['displayName', 'id', 'username'])
    assert.deepEqual(Object.keys(active.lastMessage).sort(), [
      'content',
      'id',
      'senderId',
      'sentAt',
    ])

    const requests = await request(baseUrl, '?view=requests', token)
    const requestBody = await requests.json()
    assert.deepEqual(
      new Set(requestBody.conversations.map((item) => item.interactionState)),
      new Set(['pending_incoming', 'pending_outgoing']),
    )
    assert.equal(requestBody.conversations.length, 3)
    const privateItem = requestBody.conversations.find(
      (item) => item.id === byName.get('private')._id.toString(),
    )
    assert.deepEqual(privateItem.sharedContext, { shouldRender: false })
    assert.equal(JSON.stringify(requestBody).includes('title'), false)

    const ended = await request(baseUrl, '?view=ended', token)
    const endedBody = await ended.json()
    assert.deepEqual(
      new Set(endedBody.conversations.map((item) => item.id)),
      new Set(['declined', 'revoked', 'blocked'].map((name) => byName.get(name)._id.toString())),
    )
    const blocked = endedBody.conversations.find(
      (item) => item.id === byName.get('blocked')._id.toString(),
    )
    assert.equal(blocked.interactionState, 'blocked')
    assert.deepEqual(blocked.sharedContext, { shouldRender: false })
    for (const item of endedBody.conversations) {
      assert.equal(Object.hasOwn(item, 'hasUnread'), false)
      assert.deepEqual(
        Object.keys(item).sort(),
        summaryKeys.filter((key) => key !== 'hasUnread'),
      )
    }
    const serialized = JSON.stringify(endedBody)
    for (const forbidden of [
      'initiatedByUserId',
      'revocationReason',
      'messageRequestPreference',
      'actorBlocksTarget',
      'targetBlocksActor',
      'readBoundary',
      'canReportUser',
    ]) {
      assert.equal(serialized.includes(forbidden), false)
    }
  })

  it('preserves omitted-view legacy shape while excluding Ended and blocked rows', async () => {
    const response = await request(baseUrl, '', token)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.nextCursor, null)
    assert.deepEqual(
      new Set(body.conversations.map((item) => item.id)),
      new Set(
        ['unlocked', 'outgoing', 'incoming', 'private'].map((name) =>
          byName.get(name)._id.toString(),
        ),
      ),
    )
    assert.deepEqual(Object.keys(body.conversations[0]).sort(), [
      'hasUnread',
      'id',
      'lastMessage',
      'otherUser',
      'readBoundary',
      'state',
    ])
  })

  it('uses opaque deterministic cursor pagination without duplicate or skipped ties', async () => {
    const seen = []
    let cursor = null
    do {
      const response = await request(
        baseUrl,
        `?view=requests&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        token,
      )
      assert.equal(response.status, 200)
      const body = await response.json()
      seen.push(...body.conversations.map((item) => item.id))
      cursor = body.nextCursor
    } while (cursor)
    assert.equal(seen.length, 3)
    assert.equal(new Set(seen).size, 3)
    assert.deepEqual(
      new Set(seen),
      new Set(['outgoing', 'incoming', 'private'].map((name) => byName.get(name)._id.toString())),
    )
    const empty = await request(baseUrl, '?view=requests', tokenFor(targets[0]))
    assert.equal(empty.status, 200)
    assert.deepEqual(await empty.json(), { conversations: [], nextCursor: null })
  })

  it('uses INVALID_INPUT for malformed list/detail transport input without echoing it', async () => {
    for (const [path, field] of [
      ['?view=wrong-view', 'view'],
      ['?view=requests&cursor=malformed-raw-cursor', 'cursor'],
      ['?view=requests&limit=51', 'limit'],
      ['?view=requests&limit=1&limit=2', 'limit'],
      ['/malformed-raw-conversation-id', 'conversationId'],
    ]) {
      const response = await request(baseUrl, path, token)
      assert.equal(response.status, 400)
      const body = await response.json()
      assert.deepEqual(body, {
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid request input.',
          details: { field },
        },
      })
      assert.equal(JSON.stringify(body).includes('malformed-raw'), false)
    }
    for (const limit of [1, 50]) {
      assert.equal((await request(baseUrl, `?view=requests&limit=${limit}`, token)).status, 200)
    }
  })

  it('returns authoritative detail buckets and neutral missing/nonparticipant errors', async () => {
    const expectedBuckets = new Map([
      ['unlocked', 'conversations'],
      ['outgoing', 'requests'],
      ['incoming', 'requests'],
      ['declined', 'ended'],
      ['revoked', 'ended'],
      ['blocked', 'ended'],
    ])
    for (const [name, bucket] of expectedBuckets) {
      const id = byName.get(name)._id.toString()
      const response = await request(baseUrl, `/${id}`, token)
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.conversation.bucket, bucket)
      if (bucket === 'ended') assert.equal(body.conversation.sharedContext.shouldRender, false)
      if (name === 'blocked') assert.equal(body.conversation.interactionState, 'blocked')
      if (name === 'declined') assert.equal(body.conversation.interactionState, 'direct_allowed')
      if (name === 'revoked') assert.equal(body.conversation.interactionState, 'request_allowed')
    }
    const ended = await request(baseUrl, '?view=ended', token)
    for (const conversation of (await ended.json()).conversations)
      assert.equal(Object.hasOwn(conversation, 'bucket'), false)
    for (const missing of [new Types.ObjectId(), byName.get('declined')._id]) {
      const actorToken = missing.equals(byName.get('declined')._id) ? tokenFor(targets[0]) : token
      const result = await request(baseUrl, `/${missing}`, actorToken)
      assert.equal(result.status, 404)
      assert.equal((await result.json()).error.code, 'RESOURCE_NOT_FOUND')
    }
  })

  it('keeps unread separate from actionable incoming request attention', async () => {
    const response = await request(
      baseUrl.replace('/api/direct-conversations', '/api/inbox'),
      '/summary',
      token,
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(Object.keys(body).sort(), [
      'discussionsHasUnread',
      'inboxHasUnread',
      'inboxNeedsAttention',
      'messagesHasUnread',
      'notificationsHasUnread',
      'pendingIncomingRequestCount',
    ])
    assert.equal(body.messagesHasUnread, true)
    assert.equal(body.pendingIncomingRequestCount, 2)
    assert.equal(body.inboxHasUnread, true)
    assert.equal(body.inboxNeedsAttention, true)

    for (const name of ['unlocked', 'outgoing', 'incoming', 'private']) {
      const conversation = byName.get(name)
      await DirectConversationState.updateOne(
        { conversationId: conversation._id, userId: actor._id },
        {
          $set: {
            lastReadMessageId: conversation.lastMessage.messageId,
            lastReadMessageCreatedAt: conversation.lastMessage.createdAt,
          },
        },
      )
    }
    const readResponse = await request(
      baseUrl.replace('/api/direct-conversations', '/api/inbox'),
      '/summary',
      token,
    )
    const readBody = await readResponse.json()
    assert.equal(readBody.messagesHasUnread, false)
    assert.equal(readBody.pendingIncomingRequestCount, 2)
    assert.equal(readBody.inboxHasUnread, false)
    assert.equal(readBody.inboxNeedsAttention, true)
  })

  it('keeps explicit list query count bounded as page row count grows', async () => {
    let queryCount = 0
    mongoose.set('debug', () => {
      queryCount += 1
    })
    try {
      const oneRow = await listDirectConversationRead(actor._id.toString(), {
        view: 'conversations',
      })
      assert.equal(oneRow.conversations.length, 1)
      const oneRowQueries = queryCount
      queryCount = 0
      const threeRows = await listDirectConversationRead(actor._id.toString(), {
        view: 'requests',
      })
      assert.equal(threeRows.conversations.length, 3)
      const threeRowQueries = queryCount
      assert.ok(oneRowQueries <= 8)
      assert.ok(threeRowQueries <= 8)
    } finally {
      mongoose.set('debug', false)
    }
  })

  it('lists only caller-owned Blocks with privacy-safe unavailable fallback and pagination', async () => {
    const usersBase = baseUrl.replace('/api/direct-conversations', '/api/users')
    assert.equal((await request(usersBase, '/me/blocked-users')).status, 401)
    const complete = await request(usersBase, '/me/blocked-users', token)
    assert.equal(complete.status, 200)
    assert.equal((await complete.json()).blockedUsers.length, 2)
    const empty = await request(usersBase, '/me/blocked-users', tokenFor(targets[0]))
    assert.deepEqual(await empty.json(), { blockedUsers: [], nextCursor: null })
    const first = await request(usersBase, '/me/blocked-users?limit=1', token)
    assert.equal(first.status, 200)
    const firstBody = await first.json()
    assert.equal(firstBody.blockedUsers.length, 1)
    assert.ok(firstBody.nextCursor)
    const second = await request(
      usersBase,
      `/me/blocked-users?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      token,
    )
    const secondBody = await second.json()
    const rows = [...firstBody.blockedUsers, ...secondBody.blockedUsers]
    assert.equal(rows.length, 2)
    assert.equal(new Set(rows.map((row) => row.user.id)).size, 2)
    const unavailable = rows.find((row) => row.user.id === unavailableId.toString())
    assert.deepEqual(unavailable.user, {
      id: unavailableId.toString(),
      displayName: '無法使用的會員',
      unavailable: true,
    })
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ['blockedAt', 'user'])
      assert.equal(Object.hasOwn(row.user, 'effectiveBlock'), false)
    }
    assert.equal((await request(usersBase, '/me/blocked-users?limit=50', token)).status, 200)
    for (const [path, field] of [
      ['/me/blocked-users?limit=51', 'limit'],
      ['/me/blocked-users?cursor=bad', 'cursor'],
    ]) {
      const response = await request(usersBase, path, token)
      assert.equal(response.status, 400)
      assert.equal((await response.json()).error.details.field, field)
    }
  })
})

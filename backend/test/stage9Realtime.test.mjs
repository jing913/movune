import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { after, afterEach, before, describe, it } from 'node:test'
import express from 'express'
import jsonwebtoken from 'jsonwebtoken'
import mongoose from 'mongoose'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import { ContactPairGuard } from '../dist/models/contactPairGuardModel.js'
import { DirectConversation } from '../dist/models/directConversationModel.js'
import { DirectConversationState } from '../dist/models/directConversationStateModel.js'
import { Follow } from '../dist/models/followModel.js'
import { Message } from '../dist/models/messageModel.js'
import { Notification } from '../dist/models/notificationModel.js'
import { Report } from '../dist/models/reportModel.js'
import { UserBlock } from '../dist/models/userBlockModel.js'
import { User } from '../dist/models/userModel.js'
import { submitProfileReport } from '../dist/services/reportService.js'
import {
  publishDirectUpdated,
  publishRelationshipUpdated,
  publishToUser,
  setRealtimeServer,
} from '../dist/services/realtimeService.js'
import { persistFollowNotification } from '../dist/utils/followNotification.js'

process.env.JWT_SECRET ??= 'phase8-stage9-realtime-test-secret'
await import('../dist/configs/passport.js')
const { default: followRouter } = await import('../dist/routes/follow.js')
const { directRouter } = await import('../dist/routes/messaging.js')
const { default: notificationRouter } = await import('../dist/routes/notification.js')
const { default: userRouter } = await import('../dist/routes/user.js')

const installRecorder = ({ fail = false } = {}) => {
  const deliveries = []
  setRealtimeServer({
    to(room) {
      return {
        emit(event, payload) {
          if (fail) throw new Error('socket unavailable')
          deliveries.push({ room, event, payload })
        },
      }
    },
  })
  return deliveries
}

afterEach(() => setRealtimeServer(null))

describe('Official Phase 8 Stage 9 realtime contracts', () => {
  it('publishes exact direct and actor-relative relationship payloads to both users', () => {
    const deliveries = installRecorder()
    publishDirectUpdated(['actor', 'counterpart'], 'conversation')
    publishRelationshipUpdated('actor', 'counterpart')
    assert.deepEqual(deliveries, [
      {
        room: 'user:actor',
        event: 'direct.updated',
        payload: { conversationId: 'conversation' },
      },
      {
        room: 'user:counterpart',
        event: 'direct.updated',
        payload: { conversationId: 'conversation' },
      },
      {
        room: 'user:actor',
        event: 'relationship.updated',
        payload: { userId: 'counterpart' },
      },
      {
        room: 'user:counterpart',
        event: 'relationship.updated',
        payload: { userId: 'actor' },
      },
    ])
  })

  it('publishes owner-only notification and discriminated same-user read payloads', () => {
    const deliveries = installRecorder()
    publishToUser('owner', 'notification.created', { notificationId: 'notification' })
    publishToUser('owner', 'read.updated', { resource: 'notification', id: 'notification' })
    publishToUser('owner', 'read.updated', { resource: 'notifications' })
    assert.deepEqual(deliveries, [
      {
        room: 'user:owner',
        event: 'notification.created',
        payload: { notificationId: 'notification' },
      },
      {
        room: 'user:owner',
        event: 'read.updated',
        payload: { resource: 'notification', id: 'notification' },
      },
      {
        room: 'user:owner',
        event: 'read.updated',
        payload: { resource: 'notifications' },
      },
    ])
  })

  it('isolates synchronous socket publication failures from successful mutations', () => {
    installRecorder({ fail: true })
    assert.doesNotThrow(() => publishDirectUpdated(['actor', 'counterpart'], 'conversation'))
    assert.doesNotThrow(() => publishRelationshipUpdated('actor', 'counterpart'))
  })

  it('returns the persisted Follow notification and returns null on persistence failure', async () => {
    const input = { recipientId: 'recipient', actorId: 'actor', type: 'follow' }
    const persisted = { _id: { toString: () => 'notification' } }
    assert.equal(await persistFollowNotification(input, async () => persisted), persisted)
    assert.equal(
      await persistFollowNotification(
        input,
        async () => {
          throw new Error('notification unavailable')
        },
        () => {},
      ),
      null,
    )
  })

  it('keeps lifecycle, relationship, notification, and read emission sites bounded', async () => {
    const [messaging, follow, block, report, notification] = await Promise.all([
      readFile(new URL('../src/controllers/messagingController.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/controllers/followController.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/controllers/blockController.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/services/reportService.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/controllers/notificationController.ts', import.meta.url), 'utf8'),
    ])
    assert.match(messaging, /if \(result\.lifecycleChanged\)[\s\S]*publishDirectUpdated/)
    assert.doesNotMatch(messaging, /direct\.updated'[\s\S]{0,200}\bstate:/)
    assert.match(follow, /if \(notification\)[\s\S]*notification\.created/)
    assert.match(follow, /publishRelationshipUpdated/)
    assert.match(block, /publishRelationshipUpdated/)
    assert.match(block, /result\.lifecycleChanged[\s\S]*publishDirectUpdated/)
    assert.match(report, /createNotification[\s\S]*notification\.created/)
    assert.match(notification, /resource: 'notification'/)
    assert.match(notification, /resource: 'notifications'/)
  })
})

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

describe('Stage 9 persisted mutation emission integration', { timeout: 120_000 }, () => {
  let server
  let baseUrl
  let deliveries = []
  const userIds = []

  const recordRealtime = ({ fail = false } = {}) => {
    deliveries = []
    setRealtimeServer({
      to(room) {
        return {
          emit(event, payload) {
            if (fail) throw new Error('socket unavailable')
            deliveries.push({ room, event, payload })
          },
        }
      },
    })
  }

  const createUsers = async (...labels) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const users = await User.create(
      labels.map((label) => ({
        account: `p8s9-${label}-${suffix}`,
        displayName: `Stage 9 ${label}`,
        email: `p8s9-${label}-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      })),
    )
    userIds.push(...users.map((user) => user._id))
    return users
  }

  const sendFirst = async (sender, recipient, label) => {
    const response = await request(baseUrl, '/api/direct-conversations/messages', {
      method: 'POST',
      token: tokenFor(sender),
      body: {
        otherUserId: recipient._id.toString(),
        clientMessageId: `${label}-${new mongoose.Types.ObjectId()}`,
        content: label,
      },
    })
    assert.equal(response.status, 201)
    return response.json()
  }

  before(async () => {
    const url = await databaseUrl()
    if (!url) throw new Error('DB_URL is required for Stage 9 realtime integration tests')
    await mongoose.connect(url)
    const app = express()
    app.use(express.json())
    app.use('/api/direct-conversations', directRouter)
    app.use('/api/follows', followRouter)
    app.use('/api/notifications', notificationRouter)
    app.use('/api/users', userRouter)
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    setRealtimeServer(null)
    if (server) await new Promise((resolve) => server.close(resolve))
    await Notification.deleteMany({ recipientId: { $in: userIds } })
    await Report.deleteMany({ reporterUserId: { $in: userIds } })
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

  it('emits direct invalidation only for lifecycle creation and transition', async () => {
    const [initiator, recipient] = await createUsers('direct-a', 'direct-b')
    recordRealtime()
    const first = await sendFirst(initiator, recipient, 'pending')
    assert.deepEqual(
      deliveries.filter(({ event }) => event === 'direct.updated'),
      [initiator, recipient].map((user) => ({
        room: `user:${user._id}`,
        event: 'direct.updated',
        payload: { conversationId: first.conversation.id },
      })),
    )

    recordRealtime()
    const reply = await request(
      baseUrl,
      `/api/direct-conversations/${first.conversation.id}/messages`,
      {
        method: 'POST',
        token: tokenFor(recipient),
        body: {
          clientMessageId: `reply-${new mongoose.Types.ObjectId()}`,
          content: 'reply',
        },
      },
    )
    assert.equal(reply.status, 201)
    assert.equal(deliveries.filter(({ event }) => event === 'direct.updated').length, 2)

    recordRealtime()
    const ordinary = await request(
      baseUrl,
      `/api/direct-conversations/${first.conversation.id}/messages`,
      {
        method: 'POST',
        token: tokenFor(initiator),
        body: {
          clientMessageId: `ordinary-${new mongoose.Types.ObjectId()}`,
          content: 'ordinary',
        },
      },
    )
    assert.equal(ordinary.status, 201)
    assert.equal(
      deliveries.some(({ event }) => event === 'direct.updated'),
      false,
    )

    const [acceptInitiator, acceptRecipient] = await createUsers('accept-a', 'accept-b')
    const pendingAccept = await sendFirst(acceptInitiator, acceptRecipient, 'accept-pending')
    recordRealtime()
    const accept = await request(
      baseUrl,
      `/api/direct-conversations/${pendingAccept.conversation.id}/accept`,
      { method: 'POST', token: tokenFor(acceptRecipient) },
    )
    assert.equal(accept.status, 200)
    assert.equal(deliveries.filter(({ event }) => event === 'direct.updated').length, 2)

    const [declineInitiator, declineRecipient] = await createUsers('decline-a', 'decline-b')
    const pendingDecline = await sendFirst(declineInitiator, declineRecipient, 'decline-pending')
    recordRealtime()
    const decline = await request(
      baseUrl,
      `/api/direct-conversations/${pendingDecline.conversation.id}/decline`,
      { method: 'POST', token: tokenFor(declineRecipient) },
    )
    assert.equal(decline.status, 200)
    assert.equal(deliveries.filter(({ event }) => event === 'direct.updated').length, 2)

    recordRealtime()
    const block = await request(baseUrl, `/api/users/${recipient._id}/block`, {
      method: 'PUT',
      token: tokenFor(initiator),
    })
    assert.equal(block.status, 200)
    assert.equal(deliveries.filter(({ event }) => event === 'direct.updated').length, 2)

    await request(baseUrl, `/api/users/${recipient._id}/block`, {
      method: 'DELETE',
      token: tokenFor(initiator),
    })
    recordRealtime()
    const newCycle = await sendFirst(initiator, recipient, 'revoked-new-cycle')
    assert.equal(newCycle.conversation.interactionState, 'pending_outgoing')
    assert.equal(deliveries.filter(({ event }) => event === 'direct.updated').length, 2)
  })

  it('composes Follow/Unfollow and Block/Unblock relationship invalidations safely', async () => {
    const [actor, target] = await createUsers('relationship-a', 'relationship-b')
    recordRealtime()
    const follow = await request(baseUrl, `/api/follows/${target._id}`, {
      method: 'POST',
      token: tokenFor(actor),
    })
    assert.equal(follow.status, 201)
    assert.deepEqual(
      deliveries.filter(({ event }) => event === 'relationship.updated'),
      [
        {
          room: `user:${actor._id}`,
          event: 'relationship.updated',
          payload: { userId: target._id.toString() },
        },
        {
          room: `user:${target._id}`,
          event: 'relationship.updated',
          payload: { userId: actor._id.toString() },
        },
      ],
    )
    assert.deepEqual(
      deliveries.filter(({ event }) => event === 'notification.created'),
      [
        {
          room: `user:${target._id}`,
          event: 'notification.created',
          payload: {
            notificationId: deliveries.find(({ event }) => event === 'notification.created').payload
              .notificationId,
          },
        },
      ],
    )

    for (const [method, path] of [
      ['DELETE', `/api/follows/${target._id}`],
      ['PUT', `/api/users/${target._id}/block`],
      ['DELETE', `/api/users/${target._id}/block`],
    ]) {
      recordRealtime()
      const response = await request(baseUrl, path, { method, token: tokenFor(actor) })
      assert.ok(response.ok)
      assert.equal(deliveries.filter(({ event }) => event === 'relationship.updated').length, 2)
      for (const delivery of deliveries.filter(({ event }) => event === 'relationship.updated'))
        assert.deepEqual(Object.keys(delivery.payload), ['userId'])
    }

    const [requester, receiver] = await createUsers('follow-unlock-a', 'follow-unlock-b')
    const pending = await sendFirst(requester, receiver, 'follow-unlock-pending')
    recordRealtime()
    const unlock = await request(baseUrl, `/api/follows/${requester._id}`, {
      method: 'POST',
      token: tokenFor(receiver),
    })
    assert.equal(unlock.status, 201)
    assert.deepEqual(Object.keys(await unlock.json()), ['follow'])
    assert.equal(deliveries.filter(({ event }) => event === 'relationship.updated').length, 2)
    assert.deepEqual(
      deliveries.filter(({ event }) => event === 'direct.updated'),
      [requester, receiver].map((user) => ({
        room: `user:${user._id}`,
        event: 'direct.updated',
        payload: { conversationId: pending.conversation.id },
      })),
    )
  })

  it('emits report confirmation only to the reporter and read invalidations only to the owner', async () => {
    const [reporter, target] = await createUsers('reporter', 'reported')
    recordRealtime()
    const report = await request(baseUrl, `/api/users/${target._id}/report`, {
      method: 'POST',
      token: tokenFor(reporter),
      body: { reason: 'other' },
    })
    assert.equal(report.status, 201)
    const created = deliveries.filter(({ event }) => event === 'notification.created')
    assert.equal(created.length, 1)
    assert.equal(created[0].room, `user:${reporter._id}`)
    assert.deepEqual(Object.keys(created[0].payload), ['notificationId'])
    assert.notEqual(created[0].room, `user:${target._id}`)

    recordRealtime()
    const read = await request(
      baseUrl,
      `/api/notifications/${created[0].payload.notificationId}/read`,
      { method: 'PATCH', token: tokenFor(reporter) },
    )
    assert.equal(read.status, 200)
    assert.deepEqual(deliveries, [
      {
        room: `user:${reporter._id}`,
        event: 'read.updated',
        payload: { resource: 'notification', id: created[0].payload.notificationId },
      },
    ])

    recordRealtime()
    const all = await request(baseUrl, '/api/notifications/read-all', {
      method: 'PATCH',
      token: tokenFor(reporter),
    })
    assert.equal(all.status, 200)
    assert.deepEqual(deliveries, [
      {
        room: `user:${reporter._id}`,
        event: 'read.updated',
        payload: { resource: 'notifications' },
      },
    ])
  })

  it('does not emit notification.created when Report confirmation persistence fails', async () => {
    const [reporter, target] = await createUsers('report-failure-a', 'report-failure-b')
    recordRealtime()
    const before = await Report.countDocuments({ reporterUserId: reporter._id })
    await submitProfileReport(
      reporter._id.toString(),
      target._id.toString(),
      { reason: 'other' },
      {
        createNotification: async () => {
          throw new Error('notification unavailable')
        },
        reportSecondaryFailure: () => {},
      },
    )
    assert.equal(await Report.countDocuments({ reporterUserId: reporter._id }), before + 1)
    assert.equal(
      deliveries.some(({ event }) => event === 'notification.created'),
      false,
    )
  })

  it('contains publication failures after authoritative persistence succeeds', async () => {
    const [actor, target] = await createUsers('failure-a', 'failure-b')
    recordRealtime({ fail: true })
    const response = await request(baseUrl, `/api/users/${target._id}/block`, {
      method: 'PUT',
      token: tokenFor(actor),
    })
    assert.equal(response.status, 200)
    assert.ok(await UserBlock.exists({ blockerUserId: actor._id, blockedUserId: target._id }))
  })
})

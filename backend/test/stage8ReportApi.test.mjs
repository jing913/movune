import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import express from 'express'
import jsonwebtoken from 'jsonwebtoken'
import mongoose, { Types } from 'mongoose'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import { DirectConversation } from '../dist/models/directConversationModel.js'
import { Follow } from '../dist/models/followModel.js'
import { Message } from '../dist/models/messageModel.js'
import { Notification } from '../dist/models/notificationModel.js'
import { Report } from '../dist/models/reportModel.js'
import { UserBlock } from '../dist/models/userBlockModel.js'
import { User } from '../dist/models/userModel.js'
import { submitProfileReport } from '../dist/services/reportService.js'

process.env.JWT_SECRET ??= 'phase8-stage8-report-api-test-secret'
await import('../dist/configs/passport.js')
const { default: userRouter } = await import('../dist/routes/user.js')
const { directRouter, inboxRouter, messageRouter } = await import('../dist/routes/messaging.js')
const { default: notificationRouter } = await import('../dist/routes/notification.js')

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
const request = (baseUrl, path, { method = 'GET', token, body = noBody, rawBody } = {}) => {
  const hasBody = body !== noBody || rawBody !== undefined
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(hasBody ? { body: rawBody ?? JSON.stringify(body) } : {}),
  })
}

const assertProblem = async (response, status, code, field) => {
  assert.equal(response.status, status)
  const body = await response.json()
  const messages = {
    INVALID_INPUT: 'Invalid request input.',
    REPORT_INVALID_REASON: 'Report reason is invalid.',
    REPORT_NOT_ALLOWED: 'This report action is not allowed.',
    RESOURCE_NOT_FOUND: 'Resource not found.',
  }
  assert.deepEqual(body, {
    error: {
      code,
      message: messages[code],
      ...(field ? { details: { field } } : {}),
    },
  })
  return body
}

describe('Official Phase 8 Stage 8 Report and Notification API', { timeout: 120_000 }, () => {
  let server
  let baseUrl
  let reporter
  let target
  let outsider
  let reporterToken
  let targetToken
  const userIds = []

  const conversation = async (state = 'unlocked') =>
    DirectConversation.create({
      participantIds: [reporter._id, target._id],
      participantKey: [reporter._id.toString(), target._id.toString()].sort().join(':'),
      initiatedByUserId: reporter._id,
      state,
      ...(state === 'unlocked' ? { unlockedAt: new Date(), unlockReason: 'accept' } : {}),
      ...(state === 'declined' ? { declinedAt: new Date() } : {}),
      ...(state === 'revoked' ? { revokedAt: new Date(), revocationReason: 'block' } : {}),
    })

  const message = (conversationId, sender = target, content = 'authoritative evidence') =>
    Message.create({
      senderId: sender._id,
      clientMessageId: `p8s8-${new Types.ObjectId()}`,
      contextType: 'direct',
      contextId: conversationId,
      content,
    })

  before(async () => {
    const url = await databaseUrl()
    if (!url) throw new Error('DB_URL is required for Stage 8 Report API tests')
    await mongoose.connect(url)
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    ;[reporter, target, outsider] = await User.create(
      ['reporter', 'target', 'outsider'].map((name) => ({
        account: `p8s8-${name}-${suffix}`,
        displayName: `P8S8 ${name}`,
        email: `p8s8-${name}-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      })),
    )
    userIds.push(reporter._id, target._id, outsider._id)
    reporterToken = tokenFor(reporter)
    targetToken = tokenFor(target)

    const app = express()
    app.use(express.json())
    app.use('/api/users', userRouter)
    app.use('/api/direct-conversations', directRouter)
    app.use('/api/messages', messageRouter)
    app.use('/api/notifications', notificationRouter)
    app.use('/api/inbox', inboxRouter)
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve))
    await Notification.deleteMany({ recipientId: { $in: userIds } })
    await Report.deleteMany({ reporterUserId: { $in: userIds } })
    await Message.deleteMany({ senderId: { $in: userIds } })
    await DirectConversation.deleteMany({ participantIds: { $in: userIds } })
    await Follow.deleteMany({
      $or: [{ followerId: { $in: userIds } }, { followingId: { $in: userIds } }],
    })
    await UserBlock.deleteMany({
      $or: [{ blockerUserId: { $in: userIds } }, { blockedUserId: { $in: userIds } }],
    })
    await User.deleteMany({ _id: { $in: userIds } })
    await mongoose.disconnect()
  })

  it('requires authentication on all three Report endpoints', async () => {
    for (const path of [
      `/api/users/${target._id}/report`,
      `/api/direct-conversations/${new Types.ObjectId()}/report-user`,
      `/api/messages/${new Types.ObjectId()}/report`,
    ]) {
      assert.equal(
        (await request(baseUrl, path, { method: 'POST', body: { reason: 'other' } })).status,
        401,
      )
    }
  })

  it('validates body and identifiers with exact non-echoing ApiProblems', async () => {
    const path = `/api/users/${target._id}/report`
    await assertProblem(
      await request(baseUrl, path, { method: 'POST', token: reporterToken, body: {} }),
      400,
      'INVALID_INPUT',
      'reason',
    )
    const rawReason = 'invalid-reason-never-echo'
    const invalid = await request(baseUrl, path, {
      method: 'POST',
      token: reporterToken,
      body: { reason: rawReason },
    })
    assert.equal(
      JSON.stringify(await assertProblem(invalid, 400, 'REPORT_INVALID_REASON', 'reason')).includes(
        rawReason,
      ),
      false,
    )
    await assertProblem(
      await request(baseUrl, path, {
        method: 'POST',
        token: reporterToken,
        body: { reason: 'other', status: 'forged' },
      }),
      400,
      'INVALID_INPUT',
      'body',
    )
    await assertProblem(
      await request(baseUrl, path, { method: 'POST', token: reporterToken, rawBody: 'null' }),
      400,
      'INVALID_INPUT',
      'reason',
    )
    for (const [pathValue, field] of [
      ['/api/users/malformed-user/report', 'userId'],
      ['/api/direct-conversations/malformed-conversation/report-user', 'conversationId'],
      ['/api/messages/malformed-message/report', 'messageId'],
    ]) {
      const body = await assertProblem(
        await request(baseUrl, pathValue, {
          method: 'POST',
          token: reporterToken,
          body: { reason: 'other' },
        }),
        400,
        'INVALID_INPUT',
        field,
      )
      assert.equal(JSON.stringify(body).includes('malformed-'), false)
    }
  })

  it('creates minimal profile Reports for every reason, normalizes description, and allows Block', async () => {
    await UserBlock.create({ blockerUserId: target._id, blockedUserId: reporter._id })
    for (const reason of ['harassment_or_uncomfortable', 'spam_or_suspicious', 'other']) {
      const response = await request(baseUrl, `/api/users/${target._id}/report`, {
        method: 'POST',
        token: reporterToken,
        body: { reason, description: reason === 'other' ? '  context  ' : '   ' },
      })
      assert.equal(response.status, 201)
      const payload = await response.json()
      assert.deepEqual(Object.keys(payload.report).sort(), ['id', 'sourceType', 'submittedAt'])
      assert.equal(payload.report.sourceType, 'public_profile')
      const stored = await Report.findById(payload.report.id).lean()
      assert.equal(stored.reporterUserId.toString(), reporter._id.toString())
      assert.equal(stored.reportedUserId.toString(), target._id.toString())
      assert.equal(stored.description, reason === 'other' ? 'context' : undefined)
      assert.equal(stored.conversationId, undefined)
      assert.equal(stored.messageEvidence, undefined)
    }
    assert.equal(
      await UserBlock.countDocuments({ blockerUserId: target._id, blockedUserId: reporter._id }),
      1,
    )
  })

  it('neutralizes absent resources and nonparticipants and forbids legitimate self targets', async () => {
    await assertProblem(
      await request(baseUrl, `/api/users/${reporter._id}/report`, {
        method: 'POST',
        token: reporterToken,
        body: { reason: 'other' },
      }),
      403,
      'REPORT_NOT_ALLOWED',
    )
    await assertProblem(
      await request(baseUrl, `/api/users/${new Types.ObjectId()}/report`, {
        method: 'POST',
        token: reporterToken,
        body: { reason: 'other' },
      }),
      404,
      'RESOURCE_NOT_FOUND',
    )
    const hidden = await DirectConversation.create({
      participantIds: [target._id, outsider._id],
      participantKey: [target._id.toString(), outsider._id.toString()].sort().join(':'),
      initiatedByUserId: target._id,
      state: 'pending',
    })
    for (const id of [hidden._id, new Types.ObjectId()]) {
      await assertProblem(
        await request(baseUrl, `/api/direct-conversations/${id}/report-user`, {
          method: 'POST',
          token: reporterToken,
          body: { reason: 'other' },
        }),
        404,
        'RESOURCE_NOT_FOUND',
      )
    }
    const hiddenMessage = await message(hidden._id, target, 'hidden')
    for (const id of [hiddenMessage._id, new Types.ObjectId()]) {
      await assertProblem(
        await request(baseUrl, `/api/messages/${id}/report`, {
          method: 'POST',
          token: reporterToken,
          body: { reason: 'other' },
        }),
        404,
        'RESOURCE_NOT_FOUND',
      )
    }
    const inconsistentMessage = await message(new Types.ObjectId(), target, 'orphaned')
    await assertProblem(
      await request(baseUrl, `/api/messages/${inconsistentMessage._id}/report`, {
        method: 'POST',
        token: reporterToken,
        body: { reason: 'other' },
      }),
      404,
      'RESOURCE_NOT_FOUND',
    )
  })

  it('reports all direct lifecycle states without mutating them or adding message evidence', async () => {
    const reportIds = []
    for (const state of ['pending', 'unlocked', 'declined', 'revoked']) {
      await DirectConversation.deleteMany({ participantIds: { $all: [reporter._id, target._id] } })
      const direct = await conversation(state)
      const response = await request(
        baseUrl,
        `/api/direct-conversations/${direct._id}/report-user`,
        {
          method: 'POST',
          token: reporterToken,
          body: { reason: 'other' },
        },
      )
      assert.equal(response.status, 201)
      const payload = await response.json()
      reportIds.push(payload.report.id)
      const stored = await Report.findById(payload.report.id).lean()
      assert.equal(stored.sourceType, 'direct_conversation')
      assert.equal(stored.reportedUserId.toString(), target._id.toString())
      assert.equal(stored.conversationId.toString(), direct._id.toString())
      assert.equal(stored.messageId, undefined)
      assert.equal(stored.messageEvidence, undefined)
      assert.equal((await DirectConversation.findById(direct._id).lean()).state, state)
    }

    const list = await request(baseUrl, '/api/notifications?limit=50', { token: reporterToken })
    assert.equal(list.status, 200)
    const notifications = (await list.json()).notifications
    for (const reportId of reportIds) {
      const dto = notifications.find((item) => item.report?.reportId === reportId)
      assert.ok(dto)
      assert.equal('message' in dto.report, false)
    }
  })

  it('snapshots only an authoritative other-user message, including after Block', async () => {
    await DirectConversation.deleteMany({ participantIds: { $all: [reporter._id, target._id] } })
    const direct = await conversation('revoked')
    await UserBlock.updateOne(
      { blockerUserId: reporter._id, blockedUserId: target._id },
      { $setOnInsert: { blockerUserId: reporter._id, blockedUserId: target._id } },
      { upsert: true },
    )
    const otherMessage = await message(direct._id, target, 'preserve exactly this')
    await message(direct._id, target, 'neighbor must not be copied')
    const response = await request(baseUrl, `/api/messages/${otherMessage._id}/report`, {
      method: 'POST',
      token: reporterToken,
      body: { reason: 'other', description: ' evidence ', reportedUserId: reporter._id },
    })
    await assertProblem(response, 400, 'INVALID_INPUT', 'body')

    const allowed = await request(baseUrl, `/api/messages/${otherMessage._id}/report`, {
      method: 'POST',
      token: reporterToken,
      body: { reason: 'other', description: ' evidence ' },
    })
    assert.equal(allowed.status, 201)
    const payload = await allowed.json()
    const stored = await Report.findById(payload.report.id).lean()
    assert.equal(stored.reportedUserId.toString(), target._id.toString())
    assert.equal(stored.conversationId.toString(), direct._id.toString())
    assert.equal(stored.messageId.toString(), otherMessage._id.toString())
    assert.equal(stored.messageEvidence.messageId.toString(), otherMessage._id.toString())
    assert.equal(stored.messageEvidence.senderUserId.toString(), target._id.toString())
    assert.equal(stored.messageEvidence.content, 'preserve exactly this')
    assert.equal(stored.messageEvidence.sentAt.toISOString(), otherMessage.createdAt.toISOString())
    assert.equal(JSON.stringify(stored).includes('neighbor must not be copied'), false)
    assert.equal((await DirectConversation.findById(direct._id).lean()).state, 'revoked')

    const ownMessage = await message(direct._id, reporter, 'own')
    await assertProblem(
      await request(baseUrl, `/api/messages/${ownMessage._id}/report`, {
        method: 'POST',
        token: reporterToken,
        body: { reason: 'other' },
      }),
      403,
      'REPORT_NOT_ALLOWED',
    )
  })

  it('creates independent Reports and reporter-only actorless confirmation DTOs', async () => {
    const beforeTarget = await Notification.countDocuments({ recipientId: target._id })
    const path = `/api/users/${target._id}/report`
    const submissions = await Promise.all(
      ['harassment_or_uncomfortable', 'spam_or_suspicious', 'other'].map(async (reason) => ({
        reason,
        response: await request(baseUrl, path, {
          method: 'POST',
          token: reporterToken,
          body: { reason },
        }),
      })),
    )
    const reports = []
    for (const { reason, response } of submissions) {
      assert.equal(response.status, 201)
      reports.push({ reason, id: (await response.json()).report.id })
    }
    assert.equal(new Set(reports.map(({ id }) => id)).size, reports.length)
    assert.equal(await Report.countDocuments({ _id: { $in: reports.map(({ id }) => id) } }), 3)
    assert.equal(await Notification.countDocuments({ recipientId: target._id }), beforeTarget)

    const list = await request(baseUrl, '/api/notifications?limit=50', { token: reporterToken })
    assert.equal(list.status, 200)
    const listed = (await list.json()).notifications.filter(
      (item) => item.type === 'report_submitted',
    )
    for (const { reason, id } of reports) {
      const item = listed.find((candidate) => candidate.report?.reportId === id)
      assert.ok(item)
      const [storedReport, storedNotification] = await Promise.all([
        Report.findById(id).lean(),
        Notification.findOne({ reportId: id }).lean(),
      ])
      assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'id', 'readAt', 'report', 'type'])
      assert.equal(item.id, storedNotification._id.toString())
      assert.equal(item.type, 'report_submitted')
      assert.equal(item.readAt, null)
      assert.equal(item.createdAt, storedNotification.createdAt.toISOString())
      assert.equal('actor' in item, false)
      assert.equal('message' in item, false)
      assert.equal('updatedAt' in item, false)
      assert.deepEqual(Object.keys(item.report).sort(), [
        'reason',
        'reportId',
        'reportedUser',
        'sourceType',
        'submittedAt',
      ])
      assert.equal(item.report.reportId, id)
      assert.equal(item.report.sourceType, 'public_profile')
      assert.equal(item.report.reason, reason)
      assert.equal(item.report.submittedAt, storedReport.createdAt.toISOString())
      assert.deepEqual(item.report.reportedUser, {
        id: target._id.toString(),
        displayName: target.displayName,
      })
      assert.deepEqual(Object.keys(item.report.reportedUser).sort(), ['displayName', 'id'])
      assert.equal('message' in item.report, false)
      for (const privateField of [
        'account',
        'email',
        'password',
        'role',
        'bio',
        'avatar',
        'privacy',
        'favorites',
        'collections',
        'blockState',
        'createdAt',
        'updatedAt',
        'moderation',
      ]) {
        assert.equal(privateField in item.report.reportedUser, false)
      }
      assert.equal(JSON.stringify(item).includes('description'), false)
      assert.equal(JSON.stringify(item).includes('reportedUserId'), false)
    }

    const targetList = await request(baseUrl, '/api/notifications?limit=50', {
      token: targetToken,
    })
    assert.equal(targetList.status, 200)
    assert.equal(
      (await targetList.json()).notifications.some((item) => item.type === 'report_submitted'),
      false,
    )
  })

  it('serializes message confirmations from the immutable snapshot and participates in unread/read flows', async () => {
    await DirectConversation.deleteMany({ participantIds: { $all: [reporter._id, target._id] } })
    const direct = await conversation('unlocked')
    const sent = await message(direct._id, target, 'notification snapshot')
    const submitted = await request(baseUrl, `/api/messages/${sent._id}/report`, {
      method: 'POST',
      token: reporterToken,
      body: { reason: 'spam_or_suspicious' },
    })
    assert.equal(submitted.status, 201)
    const reportId = (await submitted.json()).report.id
    const notification = await Notification.findOne({ reportId }).lean()
    assert.equal(notification.recipientId.toString(), reporter._id.toString())
    assert.equal(notification.actorId, undefined)
    assert.equal(notification.messageId.toString(), sent._id.toString())
    assert.equal(notification.readAt, null)

    const list = await request(baseUrl, '/api/notifications?limit=50', { token: reporterToken })
    const dto = (await list.json()).notifications.find((item) => item.report?.reportId === reportId)
    assert.deepEqual(Object.keys(dto).sort(), ['createdAt', 'id', 'readAt', 'report', 'type'])
    assert.equal(dto.report.reason, 'spam_or_suspicious')
    assert.deepEqual(dto.report.reportedUser, {
      id: target._id.toString(),
      displayName: target.displayName,
    })
    assert.deepEqual(dto.report.message, {
      id: sent._id.toString(),
      content: 'notification snapshot',
      sentAt: sent.createdAt.toISOString(),
    })
    assert.equal('message' in dto, false)
    assert.equal('updatedAt' in dto, false)
    assert.equal('actor' in dto, false)

    const summary = await request(baseUrl, '/api/inbox/summary', { token: reporterToken })
    const summaryBody = await summary.json()
    assert.equal(summaryBody.notificationsHasUnread, true)
    assert.equal(summaryBody.inboxHasUnread, true)
    assert.equal(summaryBody.inboxNeedsAttention, true)
    const pendingBefore = summaryBody.pendingIncomingRequestCount

    const read = await request(baseUrl, `/api/notifications/${notification._id}/read`, {
      method: 'PATCH',
      token: reporterToken,
    })
    assert.equal(read.status, 200)
    const after = await request(baseUrl, '/api/inbox/summary', { token: reporterToken })
    assert.equal((await after.json()).pendingIncomingRequestCount, pendingBefore)

    const markAll = await request(baseUrl, '/api/notifications/read-all', {
      method: 'PATCH',
      token: reporterToken,
    })
    assert.equal(markAll.status, 200)
    assert.ok((await markAll.json()).updatedCount >= 1)
    assert.equal(await Notification.countDocuments({ recipientId: reporter._id, readAt: null }), 0)
    const afterAll = await request(baseUrl, '/api/inbox/summary', { token: reporterToken })
    assert.equal((await afterAll.json()).notificationsHasUnread, false)
  })

  it('keeps historical reported-user identity renderable when the User lookup is unavailable', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const unavailable = await User.create({
      account: `p8s8-unavailable-${suffix}`,
      displayName: 'Unavailable target',
      email: `p8s8-unavailable-${suffix}@test.invalid`,
      password: 'not-used',
      role: 'user',
    })
    userIds.push(unavailable._id)
    const submitted = await request(baseUrl, `/api/users/${unavailable._id}/report`, {
      method: 'POST',
      token: reporterToken,
      body: { reason: 'other' },
    })
    assert.equal(submitted.status, 201)
    const reportId = (await submitted.json()).report.id
    await User.deleteOne({ _id: unavailable._id })

    const list = await request(baseUrl, '/api/notifications?limit=50', { token: reporterToken })
    assert.equal(list.status, 200)
    const dto = (await list.json()).notifications.find((item) => item.report?.reportId === reportId)
    assert.deepEqual(dto.report.reportedUser, {
      id: unavailable._id.toString(),
      displayName: '已停用的使用者',
    })
  })

  it('refuses a Notification reference to a Report owned by another caller', async () => {
    const foreignReport = await Report.create({
      reporterUserId: reporter._id,
      reportedUserId: target._id,
      reason: 'other',
      sourceType: 'public_profile',
    })
    const forgedNotification = await Notification.create({
      recipientId: outsider._id,
      type: 'report_submitted',
      reportId: foreignReport._id,
    })
    try {
      const response = await request(baseUrl, '/api/notifications?limit=50', {
        token: tokenFor(outsider),
      })
      assert.equal(response.status, 500)
      assert.equal(
        JSON.stringify(await response.json()).includes(foreignReport._id.toString()),
        false,
      )
    } finally {
      await Notification.deleteOne({ _id: forgedNotification._id })
      await Report.deleteOne({ _id: foreignReport._id })
    }
  })

  it('preserves the Report when confirmation Notification persistence fails', async () => {
    const failure = new Error('notification unavailable')
    let logged
    const before = await Report.countDocuments({ reporterUserId: reporter._id })
    const report = await submitProfileReport(
      reporter._id.toString(),
      target._id.toString(),
      { reason: 'other' },
      {
        createNotification: async () => {
          throw failure
        },
        reportSecondaryFailure: (error) => {
          logged = error
        },
      },
    )
    assert.ok(report._id)
    assert.equal(await Report.countDocuments({ reporterUserId: reporter._id }), before + 1)
    assert.equal(await Notification.countDocuments({ reportId: report._id }), 0)
    assert.equal(logged, failure)
  })

  it('preserves the exact existing Follow notification response', async () => {
    const follow = await Notification.create({
      recipientId: reporter._id,
      actorId: target._id,
      type: 'follow',
    })
    const list = await request(baseUrl, '/api/notifications?limit=50', { token: reporterToken })
    const dto = (await list.json()).notifications.find((item) => item._id === follow._id.toString())
    assert.deepEqual(Object.keys(dto).sort(), [
      '_id',
      'actor',
      'createdAt',
      'readAt',
      'type',
      'updatedAt',
    ])
    assert.deepEqual(dto.actor, {
      _id: target._id.toString(),
      account: target.account,
      displayName: target.displayName,
    })
  })
})

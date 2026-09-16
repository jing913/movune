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

process.env.JWT_SECRET ??= 'direct-transport-contract-test-secret'
await import('../dist/configs/passport.js')
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

const assertConversationDto = (conversation, interactionState) => {
  assert.equal(conversation.interactionState, interactionState)
  assert.equal(typeof conversation.id, 'string')
  assert.equal(typeof conversation.counterpart.id, 'string')
  assert.equal(typeof conversation.counterpart.displayName, 'string')
  assert.equal(typeof conversation.counterpart.username, 'string')
  assert.equal(typeof conversation.updatedAt, 'string')
  assert.deepEqual(Object.keys(conversation.capabilities).sort(), [
    'canAccept',
    'canBlockUser',
    'canCreateMessageRequest',
    'canDecline',
    'canFollowUser',
    'canSendMessage',
    'canUnblockUser',
  ])
  assert.deepEqual(Object.keys(conversation.lastMessage).sort(), [
    'content',
    'id',
    'senderId',
    'sentAt',
  ])
  assert.deepEqual(conversation.sharedContext, { shouldRender: false })
  for (const forbidden of [
    'participantIds',
    'participantKey',
    'initiatedByUserId',
    'unlockReason',
    'revocationReason',
    'messageRequestPreference',
    '__v',
  ]) {
    assert.equal(JSON.stringify(conversation).includes(forbidden), false)
  }
}

const assertProblem = async (response, status, code) => {
  assert.equal(response.status, status)
  const body = await response.json()
  assert.equal(body.error.code, code)
  return body
}

describe('Direct transport contract', { timeout: 120_000 }, () => {
  let server
  let baseUrl
  const userIds = []
  let sequence = 0

  const createUsers = async () => {
    sequence += 1
    const suffix = `${Date.now()}-${sequence}-${Math.random().toString(16).slice(2)}`
    const users = await User.create(
      ['initiator', 'recipient', 'outsider'].map((name) => ({
        account: `p8-transport-${name}-${suffix}`,
        displayName: `Transport ${name}`,
        email: `p8-transport-${name}-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      })),
    )
    userIds.push(...users.map((user) => user._id))
    return users
  }

  const sendFirst = async (sender, recipient, label, token = tokenFor(sender)) => {
    const response = await request(baseUrl, '/api/direct-conversations/messages', {
      method: 'POST',
      token,
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
    if (!url) throw new Error('DB_URL is required for Direct transport contract tests')
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

    const app = express()
    app.use(express.json())
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
    const guardIds = guards
      .filter((guard) => userIds.some((id) => guard.participantKey.includes(id.toString())))
      .map((guard) => guard._id)
    await ContactPairGuard.deleteMany({ _id: { $in: guardIds } })
    await User.deleteMany({ _id: { $in: userIds } })
    await mongoose.disconnect()
  })

  it('requires authentication and validates malformed conversation identifiers', async () => {
    const malformed = 'malformed-conversation-id-never-echo'
    for (const action of ['accept', 'decline']) {
      assert.equal(
        (
          await request(
            baseUrl,
            `/api/direct-conversations/${new mongoose.Types.ObjectId()}/${action}`,
            {
              method: 'POST',
            },
          )
        ).status,
        401,
      )

      const [actor] = await createUsers()
      const body = await assertProblem(
        await request(baseUrl, `/api/direct-conversations/${malformed}/${action}`, {
          method: 'POST',
          token: tokenFor(actor),
        }),
        400,
        'INVALID_INPUT',
      )
      assert.deepEqual(body.error.details, { field: 'conversationId' })
      assert.equal(JSON.stringify(body).includes(malformed), false)
    }
  })

  it('returns neutral resources and preserves recipient-only resolution authorization', async () => {
    const [initiator, recipient, outsider] = await createUsers()
    const first = await sendFirst(initiator, recipient, 'resolution-authorization')
    for (const action of ['accept', 'decline']) {
      const path = `/api/direct-conversations/${first.conversation.id}/${action}`
      await assertProblem(
        await request(baseUrl, path, { method: 'POST', token: tokenFor(outsider) }),
        404,
        'RESOURCE_NOT_FOUND',
      )
      await assertProblem(
        await request(baseUrl, path, { method: 'POST', token: tokenFor(initiator) }),
        403,
        'DIRECT_NOT_REQUEST_RECIPIENT',
      )
    }
  })

  it('Accept returns the authoritative actor-relative DTO without creating a Message', async () => {
    const [initiator, recipient] = await createUsers()
    const first = await sendFirst(initiator, recipient, 'accept-success')
    const before = await Message.countDocuments({ contextId: first.conversation.id })
    const response = await request(
      baseUrl,
      `/api/direct-conversations/${first.conversation.id}/accept`,
      { method: 'POST', token: tokenFor(recipient) },
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(Object.keys(body), ['conversation'])
    assertConversationDto(body.conversation, 'unlocked')
    assert.equal(body.conversation.capabilities.canSendMessage, true)
    assert.equal(await Message.countDocuments({ contextId: first.conversation.id }), before)

    await assertProblem(
      await request(baseUrl, `/api/direct-conversations/${first.conversation.id}/accept`, {
        method: 'POST',
        token: tokenFor(recipient),
      }),
      409,
      'DIRECT_STATE_CONFLICT',
    )
  })

  it('Decline returns the authoritative actor-relative DTO without creating a Message', async () => {
    const [initiator, recipient] = await createUsers()
    const first = await sendFirst(initiator, recipient, 'decline-success')
    const before = await Message.countDocuments({ contextId: first.conversation.id })
    const response = await request(
      baseUrl,
      `/api/direct-conversations/${first.conversation.id}/decline`,
      { method: 'POST', token: tokenFor(recipient) },
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(Object.keys(body), ['conversation'])
    assertConversationDto(body.conversation, 'declined')
    assert.equal(body.conversation.capabilities.canSendMessage, false)
    assert.equal(await Message.countDocuments({ contextId: first.conversation.id }), before)

    await assertProblem(
      await request(baseUrl, `/api/direct-conversations/${first.conversation.id}/decline`, {
        method: 'POST',
        token: tokenFor(recipient),
      }),
      409,
      'DIRECT_STATE_CONFLICT',
    )
  })

  it('first send returns Message plus authoritative Pending or Unlocked conversation', async () => {
    const [requestSender, requestRecipient] = await createUsers()
    const pending = await sendFirst(requestSender, requestRecipient, 'first-pending')
    assert.deepEqual(Object.keys(pending).sort(), ['conversation', 'message'])
    assert.equal(pending.message.contextId, pending.conversation.id)
    assertConversationDto(pending.conversation, 'pending_outgoing')

    const [directSender, directRecipient] = await createUsers()
    await Follow.create({ followerId: directRecipient._id, followingId: directSender._id })
    const unlocked = await sendFirst(directSender, directRecipient, 'first-unlocked')
    assert.deepEqual(Object.keys(unlocked).sort(), ['conversation', 'message'])
    assert.equal(unlocked.message.contextId, unlocked.conversation.id)
    assertConversationDto(unlocked.conversation, 'unlocked')
  })

  it('Reply and ordinary send return the authoritative post-mutation conversation', async () => {
    const [initiator, recipient] = await createUsers()
    const first = await sendFirst(initiator, recipient, 'reply-pending')
    const replyResponse = await request(
      baseUrl,
      `/api/direct-conversations/${first.conversation.id}/messages`,
      {
        method: 'POST',
        token: tokenFor(recipient),
        body: {
          clientMessageId: `reply-${new mongoose.Types.ObjectId()}`,
          content: 'authoritative reply',
        },
      },
    )
    assert.equal(replyResponse.status, 201)
    const reply = await replyResponse.json()
    assert.deepEqual(Object.keys(reply).sort(), ['conversation', 'message'])
    assertConversationDto(reply.conversation, 'unlocked')

    const commandId = `ordinary-${new mongoose.Types.ObjectId()}`
    const ordinaryPath = `/api/direct-conversations/${first.conversation.id}/messages`
    const ordinaryInput = {
      method: 'POST',
      token: tokenFor(initiator),
      body: { clientMessageId: commandId, content: 'ordinary unlocked send' },
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await request(baseUrl, ordinaryPath, ordinaryInput)
      assert.equal(response.status, 201)
      const body = await response.json()
      assert.deepEqual(Object.keys(body).sort(), ['conversation', 'message'])
      assertConversationDto(body.conversation, 'unlocked')
    }
    assert.equal(await Message.countDocuments({ clientMessageId: commandId }), 1)
  })
})

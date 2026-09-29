import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import mongoose, { Types } from 'mongoose'
import { ContactPairGuard } from '../dist/models/contactPairGuardModel.js'
import { DirectConversation } from '../dist/models/directConversationModel.js'
import { DirectConversationState } from '../dist/models/directConversationStateModel.js'
import { DiscussionMembership } from '../dist/models/discussionMembershipModel.js'
import { DiscussionRoom } from '../dist/models/discussionRoomModel.js'
import { Follow } from '../dist/models/followModel.js'
import { Message } from '../dist/models/messageModel.js'
import { User } from '../dist/models/userModel.js'
import {
  leaveDiscussion,
  getMessages,
  hasUnread,
  markRead,
  sendDirect,
  sendDiscussion,
  sendFirstDirect,
} from '../dist/services/messagingService.js'
import { participantKey } from '../dist/utils/messagingPolicy.js'

async function databaseUrl() {
  if (process.env.DB_URL) return process.env.DB_URL
  const env = await readFile(new URL('../.env', import.meta.url), 'utf8')
  const line = env.split(/\r?\n/).find((entry) => entry.startsWith('DB_URL='))
  return line?.slice('DB_URL='.length)
}

test(
  'Phase 6 transaction, lifecycle, idempotency, and read invariants',
  { timeout: 60_000 },
  async (t) => {
    const url = await databaseUrl()
    if (!url) return t.skip('DB_URL is not configured')
    await mongoose.connect(url)
    await Promise.all([
      ContactPairGuard.syncIndexes(),
      DirectConversation.syncIndexes(),
      DirectConversationState.syncIndexes(),
      DiscussionMembership.syncIndexes(),
      DiscussionRoom.syncIndexes(),
      Message.syncIndexes(),
    ])
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const users = await User.insertMany([
      {
        account: `p6a-${suffix}`,
        email: `p6a-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      },
      {
        account: `p6b-${suffix}`,
        email: `p6b-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      },
      {
        account: `p6c-${suffix}`,
        email: `p6c-${suffix}@test.invalid`,
        password: 'not-used',
        role: 'user',
      },
    ])
    const [a, b, c] = users
    const userIds = users.map((user) => user._id)
    let roomId
    try {
      await assert.rejects(
        () =>
          sendFirstDirect(
            a._id.toString(),
            b._id.toString(),
            `rollback-${suffix}`,
            'rollback',
            'after-message',
          ),
        /Injected/,
      )
      assert.equal(
        await DirectConversation.countDocuments({ participantIds: { $all: [a._id, b._id] } }),
        0,
      )
      assert.equal(await Message.countDocuments({ clientMessageId: `rollback-${suffix}` }), 0)

      const first = await sendFirstDirect(
        a._id.toString(),
        b._id.toString(),
        `first-${suffix}`,
        'hello',
      )
      const conversationId = first.message.contextId
      assert.equal(await DirectConversation.countDocuments({ _id: conversationId }), 1)
      assert.equal(await DirectConversationState.countDocuments({ conversationId }), 2)
      assert.equal(await Message.countDocuments({ contextId: conversationId }), 1)
      const conversation = await DirectConversation.findById(conversationId).lean()
      assert.equal(conversation.state, 'pending')
      assert.equal(conversation.lastMessage.messageId.toString(), first.message.id)
      assert.equal(await hasUnread('direct', conversation._id, a._id), false)
      assert.equal(await hasUnread('direct', conversation._id, b._id), true)

      const retry = await sendDirect(a._id.toString(), conversationId, `first-${suffix}`, 'hello')
      assert.equal(retry.message.id, first.message.id)
      await assert.rejects(
        () => sendDirect(a._id.toString(), conversationId, `first-${suffix}`, 'changed'),
        { code: 'IDEMPOTENCY_CONFLICT' },
      )
      await assert.rejects(
        () => sendDirect(a._id.toString(), conversationId, `second-${suffix}`, 'blocked'),
        { code: 'DIRECT_PENDING' },
      )

      const reply = await sendDirect(b._id.toString(), conversationId, `reply-${suffix}`, 'welcome')
      assert.ok(reply.message.id)
      assert.equal((await DirectConversation.findById(conversationId).lean()).state, 'unlocked')

      const concurrent = await Promise.allSettled([
        sendFirstDirect(a._id.toString(), c._id.toString(), `race-a-${suffix}`, 'first race'),
        sendFirstDirect(a._id.toString(), c._id.toString(), `race-b-${suffix}`, 'second race'),
      ])
      assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1)
      const raceConversation = await DirectConversation.findOne({
        participantIds: { $all: [a._id, c._id] },
      }).lean()
      assert.equal(await Message.countDocuments({ contextId: raceConversation._id }), 1)
      assert.equal(
        await DirectConversationState.countDocuments({ conversationId: raceConversation._id }),
        2,
      )
      await Follow.create({ followerId: c._id, followingId: a._id })
      const followUnlocked = await sendDirect(
        a._id.toString(),
        raceConversation._id.toString(),
        `follow-unlock-${suffix}`,
        'follow unlock',
      )
      assert.equal(followUnlocked.conversation.state, 'unlocked')
      await Follow.deleteOne({ followerId: c._id, followingId: a._id })
      await sendDirect(
        a._id.toString(),
        raceConversation._id.toString(),
        `after-unfollow-${suffix}`,
        'still unlocked',
      )
      assert.equal(
        (await DirectConversation.findById(raceConversation._id).lean()).state,
        'unlocked',
      )

      const initialWindow = await getMessages(
        c._id.toString(),
        'direct',
        raceConversation._id.toString(),
        {},
      )
      const gapMessage = await sendDirect(
        a._id.toString(),
        raceConversation._id.toString(),
        `gap-${suffix}`,
        'reconnect gap',
      )
      const gapWindow = await getMessages(
        c._id.toString(),
        'direct',
        raceConversation._id.toString(),
        { after: initialWindow.latestCursor },
      )
      assert.deepEqual(
        gapWindow.messages.map((message) => message.id),
        [gapMessage.message.id],
      )

      const room = await DiscussionRoom.create({
        tmdbId: Number(String(Date.now()).slice(-8)),
        movieSnapshot: { title: 'Phase 6 Test Movie', posterPath: null },
      })
      roomId = room._id
      await assert.rejects(
        () =>
          sendDiscussion(
            c._id.toString(),
            room._id.toString(),
            `room-rollback-${suffix}`,
            'rollback',
            'after-message',
          ),
        /Injected/,
      )
      assert.equal(
        await DiscussionMembership.countDocuments({ roomId: room._id, userId: c._id }),
        0,
      )
      assert.equal(await Message.countDocuments({ clientMessageId: `room-rollback-${suffix}` }), 0)

      const posted = await sendDiscussion(
        c._id.toString(),
        room._id.toString(),
        `room-first-${suffix}`,
        'first post',
      )
      assert.equal(posted.discussionMembership.status, 'joined')
      await leaveDiscussion(c._id.toString(), room._id.toString())
      assert.equal(
        (await DiscussionMembership.findOne({ roomId: room._id, userId: c._id }).lean()).status,
        'left',
      )
      assert.equal(await Message.countDocuments({ contextId: room._id }), 1)
      const rejoined = await sendDiscussion(
        c._id.toString(),
        room._id.toString(),
        `room-rejoin-${suffix}`,
        'back again',
      )
      assert.equal(rejoined.discussionMembership.status, 'joined')

      const newest = await Message.findOne({ contextId: room._id })
        .sort({ createdAt: -1, _id: -1 })
        .lean()
      const older = await Message.findOne({ contextId: room._id })
        .sort({ createdAt: 1, _id: 1 })
        .lean()
      await Promise.all([
        markRead(c._id.toString(), 'discussion', room._id.toString(), newest._id.toString()),
        markRead(c._id.toString(), 'discussion', room._id.toString(), older._id.toString()),
      ])
      const boundary = await DiscussionMembership.findOne({
        roomId: room._id,
        userId: c._id,
      }).lean()
      assert.equal(
        boundary.lastReadMessageId.toString(),
        newest._id.toString(),
        'older mark-read cannot regress the boundary',
      )
    } finally {
      await Message.deleteMany({ senderId: { $in: userIds } })
      await DirectConversationState.deleteMany({ userId: { $in: userIds } })
      await DirectConversation.deleteMany({ participantIds: { $in: userIds } })
      await DiscussionMembership.deleteMany({ userId: { $in: userIds } })
      await Follow.deleteMany({
        $or: [{ followerId: { $in: userIds } }, { followingId: { $in: userIds } }],
      })
      await ContactPairGuard.deleteMany({
        participantKey: {
          $in: [
            participantKey(a._id.toString(), b._id.toString()),
            participantKey(a._id.toString(), c._id.toString()),
          ],
        },
      })
      if (roomId) await DiscussionRoom.deleteOne({ _id: roomId })
      await User.deleteMany({ _id: { $in: userIds } })
      await mongoose.disconnect()
    }
  },
)

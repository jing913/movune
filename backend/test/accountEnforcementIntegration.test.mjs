import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import mongoose from 'mongoose'
import { AccountEnforcementAction } from '../dist/models/accountEnforcementActionModel.js'
import { Collection } from '../dist/models/collectionModel.js'
import { DirectConversation } from '../dist/models/directConversationModel.js'
import { DirectConversationState } from '../dist/models/directConversationStateModel.js'
import { DiscussionMembership } from '../dist/models/discussionMembershipModel.js'
import { DiscussionRoom } from '../dist/models/discussionRoomModel.js'
import { Favorite } from '../dist/models/favoriteModel.js'
import { Follow } from '../dist/models/followModel.js'
import { Message } from '../dist/models/messageModel.js'
import { Report } from '../dist/models/reportModel.js'
import { UserBlock } from '../dist/models/userBlockModel.js'
import { User } from '../dist/models/userModel.js'
import {
  AccountEnforcementServiceError,
  appendAccountEnforcementDecision,
  appendAccountEnforcementReversal,
  evaluateAccountEnforcementState,
  loadAccountEnforcementHistory,
} from '../dist/services/accountEnforcementService.js'

async function databaseUrl() {
  if (process.env.DB_URL) return process.env.DB_URL
  try {
    const env = await readFile(new URL('../.env', import.meta.url), 'utf8')
    return env
      .split(/\r?\n/)
      .find((line) => line.startsWith('DB_URL='))
      ?.slice('DB_URL='.length)
  } catch {
    return undefined
  }
}

const snapshot = async (ids) => ({
  follows: await Follow.find({ _id: { $in: ids.follow } }).lean(),
  blocks: await UserBlock.find({ _id: { $in: ids.block } }).lean(),
  conversations: await DirectConversation.find({ _id: { $in: ids.conversation } }).lean(),
  states: await DirectConversationState.find({ _id: { $in: ids.state } }).lean(),
  rooms: await DiscussionRoom.find({ _id: { $in: ids.room } }).lean(),
  memberships: await DiscussionMembership.find({ _id: { $in: ids.membership } }).lean(),
  messages: await Message.find({ _id: { $in: ids.message } })
    .sort({ _id: 1 })
    .lean(),
  favorites: await Favorite.find({ _id: { $in: ids.favorite } }).lean(),
  collections: await Collection.find({ _id: { $in: ids.collection } }).lean(),
  reports: await Report.find({ _id: { $in: ids.report } })
    .sort({ _id: 1 })
    .lean(),
})

test(
  'Phase 9 Stage 1 enforcement persistence and non-interference',
  { timeout: 120_000 },
  async (t) => {
    const url = await databaseUrl()
    if (!url) return t.skip('DB_URL is not configured')
    await mongoose.connect(url)
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const userIds = []
    const owned = {
      follow: [],
      block: [],
      conversation: [],
      state: [],
      room: [],
      membership: [],
      message: [],
      favorite: [],
      collection: [],
      report: [],
    }

    try {
      await AccountEnforcementAction.syncIndexes()
      const [target, actor, other] = await User.insertMany([
        {
          account: `p9s1-target-${suffix}`,
          email: `p9s1-target-${suffix}@test.invalid`,
          password: 'not-used',
          role: 'user',
        },
        {
          account: `p9s1-actor-${suffix}`,
          email: `p9s1-actor-${suffix}@test.invalid`,
          password: 'not-used',
          role: 'admin',
        },
        {
          account: `p9s1-other-${suffix}`,
          email: `p9s1-other-${suffix}@test.invalid`,
          password: 'not-used',
          role: 'user',
        },
      ])
      userIds.push(target._id, actor._id, other._id)

      const follow = await Follow.create({ followerId: target._id, followingId: other._id })
      owned.follow.push(follow._id)
      const block = await UserBlock.create({ blockerUserId: actor._id, blockedUserId: other._id })
      owned.block.push(block._id)
      const conversation = await DirectConversation.create({
        participantIds: [target._id, other._id],
        participantKey: [target._id.toString(), other._id.toString()].sort().join(':'),
        initiatedByUserId: target._id,
        state: 'unlocked',
        unlockedAt: new Date(),
        unlockReason: 'reply',
      })
      owned.conversation.push(conversation._id)
      const states = await DirectConversationState.insertMany([
        { conversationId: conversation._id, userId: target._id },
        { conversationId: conversation._id, userId: other._id },
      ])
      owned.state.push(...states.map((value) => value._id))
      const directMessage = await Message.create({
        senderId: other._id,
        clientMessageId: `p9s1-direct-${suffix}`,
        contextType: 'direct',
        contextId: conversation._id,
        content: 'Test-only existing direct content.',
      })
      owned.message.push(directMessage._id)
      const room = await DiscussionRoom.create({
        tmdbId: Number(String(Date.now()).slice(-8)),
        movieSnapshot: { title: 'Test-only Stage 1 Room', posterPath: null },
      })
      owned.room.push(room._id)
      const membership = await DiscussionMembership.create({
        roomId: room._id,
        userId: target._id,
        status: 'joined',
        joinedAt: new Date(),
      })
      owned.membership.push(membership._id)
      const discussionMessage = await Message.create({
        senderId: target._id,
        clientMessageId: `p9s1-discussion-${suffix}`,
        contextType: 'discussion',
        contextId: room._id,
        content: 'Test-only existing discussion content.',
      })
      owned.message.push(discussionMessage._id)
      const favorite = await Favorite.create({
        userId: target._id,
        tmdbId: 900000 + (Date.now() % 9999),
      })
      owned.favorite.push(favorite._id)
      const collection = await Collection.create({
        ownerId: target._id,
        name: `Test-only collection ${suffix}`,
      })
      owned.collection.push(collection._id)
      const reports = await Report.insertMany([
        {
          reporterUserId: actor._id,
          reportedUserId: target._id,
          reason: 'other',
          sourceType: 'public_profile',
        },
        {
          reporterUserId: other._id,
          reportedUserId: target._id,
          reason: 'spam_or_suspicious',
          sourceType: 'public_profile',
        },
      ])
      owned.report.push(...reports.map((value) => value._id))

      assert.equal(await AccountEnforcementAction.countDocuments({ targetUserId: target._id }), 0)
      assert.equal(
        (await evaluateAccountEnforcementState(target._id.toString(), new Date())).status,
        'active',
      )
      assert.equal(await AccountEnforcementAction.countDocuments({ targetUserId: target._id }), 0)

      const socialBefore = await snapshot(owned)
      const start = new Date('2035-01-01T00:00:00.000Z')
      const end = new Date('2035-01-02T00:00:00.000Z')
      const original = await appendAccountEnforcementDecision({
        targetUserId: target._id.toString(),
        performedByUserId: actor._id.toString(),
        decisionType: 'temporary_suspension',
        effectiveAt: start,
        endsAt: end,
        reasonCode: 'test-only.suspension',
        reasonSummary: 'Minimum necessary test-only suspension explanation.',
        guidelineRuleId: 'test-only.rule',
        guidelineVersion: 'test-only.v1',
      })
      assert.equal(
        (await evaluateAccountEnforcementState(target._id.toString(), start)).status,
        'suspended',
      )
      assert.equal(
        (await evaluateAccountEnforcementState(target._id.toString(), end)).status,
        'active',
      )
      assert.ok(await AccountEnforcementAction.exists({ _id: original.id }))

      const storedBeforeReversal = await AccountEnforcementAction.findById(original.id).lean()
      const reverseAt = new Date('2035-01-01T12:00:00.000Z')
      await appendAccountEnforcementReversal({
        targetUserId: target._id.toString(),
        performedByUserId: actor._id.toString(),
        reversesDecisionId: original.id,
        effectiveAt: reverseAt,
        reasonCode: 'test-only.reversal',
        reasonSummary: 'Minimum necessary test-only reversal explanation.',
      })
      assert.deepEqual(
        await AccountEnforcementAction.findById(original.id).lean(),
        storedBeforeReversal,
      )
      assert.equal(
        (await evaluateAccountEnforcementState(target._id.toString(), reverseAt)).status,
        'active',
      )
      const history = await loadAccountEnforcementHistory(target._id.toString())
      assert.equal(history.length, 2)
      assert.equal(history[1].reversesDecisionId, original.id)

      await assert.rejects(
        () =>
          appendAccountEnforcementReversal({
            targetUserId: target._id.toString(),
            performedByUserId: actor._id.toString(),
            reversesDecisionId: original.id,
            effectiveAt: reverseAt,
            reasonCode: 'test-only.duplicate',
            reasonSummary: 'Minimum necessary duplicate test explanation.',
          }),
        (error) =>
          error instanceof AccountEnforcementServiceError &&
          error.code === 'ACCOUNT_ENFORCEMENT_ALREADY_REVERSED',
      )
      await assert.rejects(
        () =>
          appendAccountEnforcementReversal({
            targetUserId: other._id.toString(),
            performedByUserId: actor._id.toString(),
            reversesDecisionId: original.id,
            effectiveAt: reverseAt,
            reasonCode: 'test-only.cross-user',
            reasonSummary: 'Minimum necessary cross-user test explanation.',
          }),
        (error) =>
          error instanceof AccountEnforcementServiceError &&
          error.code === 'ACCOUNT_ENFORCEMENT_REVERSAL_TARGET_MISMATCH',
      )

      assert.deepEqual(await snapshot(owned), socialBefore)
    } finally {
      await AccountEnforcementAction.deleteMany({ targetUserId: { $in: userIds } })
      await Report.deleteMany({ _id: { $in: owned.report } })
      await Collection.deleteMany({ _id: { $in: owned.collection } })
      await Favorite.deleteMany({ _id: { $in: owned.favorite } })
      await Message.deleteMany({ _id: { $in: owned.message } })
      await DiscussionMembership.deleteMany({ _id: { $in: owned.membership } })
      await DiscussionRoom.deleteMany({ _id: { $in: owned.room } })
      await DirectConversationState.deleteMany({ _id: { $in: owned.state } })
      await DirectConversation.deleteMany({ _id: { $in: owned.conversation } })
      await UserBlock.deleteMany({ _id: { $in: owned.block } })
      await Follow.deleteMany({ _id: { $in: owned.follow } })
      await User.deleteMany({ _id: { $in: userIds } })
      await mongoose.disconnect()
    }
  },
)

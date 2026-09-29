import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import mongoose from 'mongoose'
import { ContactPairGuard } from '../dist/models/contactPairGuardModel.js'
import { DirectConversation } from '../dist/models/directConversationModel.js'
import { DirectConversationState } from '../dist/models/directConversationStateModel.js'
import { DiscussionMembership } from '../dist/models/discussionMembershipModel.js'
import { DiscussionRoom } from '../dist/models/discussionRoomModel.js'
import { Follow } from '../dist/models/followModel.js'
import { Message } from '../dist/models/messageModel.js'
import { UserBlock } from '../dist/models/userBlockModel.js'
import { User } from '../dist/models/userModel.js'
import {
  acceptMessageRequest,
  blockContact,
  declineMessageRequest,
  followContact,
  unblockContact,
  unfollowContact,
} from '../dist/services/contactMutationService.js'
import {
  getDiscussion,
  getMessages,
  sendDirect,
  sendFirstDirect,
} from '../dist/services/messagingService.js'
import { participantKey } from '../dist/utils/messagingPolicy.js'

async function databaseUrl() {
  if (process.env.DB_URL) return process.env.DB_URL
  const env = await readFile(new URL('../.env', import.meta.url), 'utf8')
  return env
    .split(/\r?\n/)
    .find((line) => line.startsWith('DB_URL='))
    ?.slice('DB_URL='.length)
}

const fulfilledCount = (results) => results.filter((result) => result.status === 'fulfilled').length

test(
  'Phase 8 Stage 3 transaction, lifecycle, and concurrency invariants',
  { timeout: 180_000 },
  async (t) => {
    const url = await databaseUrl()
    if (!url) return t.skip('DB_URL is not configured')
    await mongoose.connect(url)
    const userIds = []
    const roomIds = []
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    let pairNumber = 0

    const users = async (preference = 'all_members') => {
      pairNumber += 1
      const created = await User.insertMany([
        {
          account: `p8s3-${pairNumber}-a-${suffix}`,
          email: `p8s3-${pairNumber}-a-${suffix}@test.invalid`,
          password: 'not-used',
          role: 'user',
        },
        {
          account: `p8s3-${pairNumber}-b-${suffix}`,
          email: `p8s3-${pairNumber}-b-${suffix}@test.invalid`,
          password: 'not-used',
          role: 'user',
          messageRequestPreference: preference,
        },
      ])
      userIds.push(...created.map((user) => user._id))
      return created
    }

    const pending = async (label) => {
      const [a, b] = await users()
      const sent = await sendFirstDirect(
        a._id.toString(),
        b._id.toString(),
        `${label}-${suffix}`,
        label,
      )
      return { a, b, conversationId: sent.message.contextId }
    }

    const seedLifecycle = async (state, preference = 'all_members') => {
      const [a, b] = await users(preference)
      const conversation = await DirectConversation.create({
        participantIds: [a._id, b._id],
        participantKey: participantKey(a._id.toString(), b._id.toString()),
        initiatedByUserId: a._id,
        state,
        ...(state === 'declined' ? { declinedAt: new Date() } : {}),
        ...(state === 'revoked' ? { revokedAt: new Date(), revocationReason: 'block' } : {}),
      })
      await DirectConversationState.insertMany([
        { conversationId: conversation._id, userId: a._id },
        { conversationId: conversation._id, userId: b._id },
      ])
      return { a, b, conversationId: conversation._id.toString() }
    }

    try {
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

      await t.test('expected-state Accept and Decline allow exactly one winner', async () => {
        const { a, b, conversationId } = await pending('accept-decline')
        const results = await Promise.allSettled([
          acceptMessageRequest(b._id.toString(), conversationId),
          declineMessageRequest(b._id.toString(), conversationId),
        ])
        assert.equal(fulfilledCount(results), 1)
        assert.equal(
          results.find((result) => result.status === 'rejected').reason.code,
          'DIRECT_STATE_CONFLICT',
        )
        const conversation = await DirectConversation.findById(conversationId).lean()
        assert.ok(['unlocked', 'declined'].includes(conversation.state))
        if (conversation.state === 'unlocked') {
          assert.equal(conversation.unlockReason, 'accept')
          assert.equal(conversation.declinedAt, undefined)
        } else {
          assert.ok(conversation.declinedAt)
          assert.equal(conversation.unlockedAt, undefined)
          assert.equal(conversation.unlockReason, undefined)
        }
        assert.equal(await Message.countDocuments({ contextId: conversation._id }), 1)
      })

      await t.test('Reply and Decline commit one complete outcome', async () => {
        const { b, conversationId } = await pending('reply-decline')
        const replyId = `reply-decline-reply-${suffix}`
        const results = await Promise.allSettled([
          sendDirect(b._id.toString(), conversationId, replyId, 'reply'),
          declineMessageRequest(b._id.toString(), conversationId),
        ])
        assert.equal(fulfilledCount(results), 1)
        const conversation = await DirectConversation.findById(conversationId).lean()
        const replyCount = await Message.countDocuments({ clientMessageId: replyId })
        assert.equal(replyCount, conversation.state === 'unlocked' ? 1 : 0)
        assert.ok(conversation.state === 'declined' || conversation.unlockReason === 'reply')
        if (conversation.state === 'unlocked') assert.equal(conversation.declinedAt, undefined)
      })

      await t.test('Block and Send serialize to revoked without half-state', async () => {
        const [a, b] = await users()
        await Follow.create({ followerId: b._id, followingId: a._id })
        const first = await sendFirstDirect(
          a._id.toString(),
          b._id.toString(),
          `block-send-first-${suffix}`,
          'first',
        )
        const raceMessageId = `block-send-race-${suffix}`
        const results = await Promise.allSettled([
          blockContact(a._id.toString(), b._id.toString()),
          sendDirect(a._id.toString(), first.message.contextId, raceMessageId, 'racing send'),
        ])
        assert.equal(results[0].status, 'fulfilled')
        const conversation = await DirectConversation.findById(first.message.contextId).lean()
        assert.equal(conversation.state, 'revoked')
        assert.equal(conversation.revocationReason, 'block')
        assert.equal(conversation.unlockedAt, undefined)
        assert.equal(conversation.unlockReason, undefined)
        assert.equal(
          await UserBlock.countDocuments({ blockerUserId: a._id, blockedUserId: b._id }),
          1,
        )
        assert.equal(
          await Follow.countDocuments({
            $or: [
              { followerId: a._id, followingId: b._id },
              { followerId: b._id, followingId: a._id },
            ],
          }),
          0,
        )
        assert.equal(
          await Message.countDocuments({ clientMessageId: raceMessageId }),
          results[1].status === 'fulfilled' ? 1 : 0,
        )
      })

      await t.test('Block and Follow share one guard and leave no Follow edge', async () => {
        const [a, b] = await users()
        const key = participantKey(a._id.toString(), b._id.toString())
        await ContactPairGuard.create({ participantKey: key, revision: 0 })
        const results = await Promise.allSettled([
          blockContact(a._id.toString(), b._id.toString()),
          followContact(b._id.toString(), a._id.toString()),
        ])
        assert.equal(results[0].status, 'fulfilled')
        assert.equal(await ContactPairGuard.countDocuments({ participantKey: key }), 1)
        assert.ok((await ContactPairGuard.findOne({ participantKey: key }).lean()).revision >= 1)
        assert.equal(
          await Follow.countDocuments({
            $or: [
              { followerId: a._id, followingId: b._id },
              { followerId: b._id, followingId: a._id },
            ],
          }),
          0,
        )
        assert.equal(
          await UserBlock.countDocuments({ blockerUserId: a._id, blockedUserId: b._id }),
          1,
        )
      })

      await t.test('Block races with Accept and Reply leave revoked authority', async () => {
        for (const operation of ['accept', 'reply']) {
          const { a, b, conversationId } = await pending(`block-${operation}`)
          const replyId = `block-reply-message-${pairNumber}-${suffix}`
          const other =
            operation === 'accept'
              ? acceptMessageRequest(b._id.toString(), conversationId)
              : sendDirect(b._id.toString(), conversationId, replyId, 'reply')
          const results = await Promise.allSettled([
            blockContact(a._id.toString(), b._id.toString()),
            other,
          ])
          assert.equal(results[0].status, 'fulfilled')
          const conversation = await DirectConversation.findById(conversationId).lean()
          assert.equal(conversation.state, 'revoked')
          assert.equal(conversation.revocationReason, 'block')
          if (operation === 'reply') {
            assert.equal(
              await Message.countDocuments({ clientMessageId: replyId }),
              results[1].status === 'fulfilled' ? 1 : 0,
            )
          }
        }
      })

      await t.test('Block and new Request leave no actionable Pending', async () => {
        const [a, b] = await users()
        const results = await Promise.allSettled([
          blockContact(a._id.toString(), b._id.toString()),
          sendFirstDirect(a._id.toString(), b._id.toString(), `block-request-${suffix}`, 'request'),
        ])
        assert.equal(results[0].status, 'fulfilled')
        const conversation = await DirectConversation.findOne({
          participantKey: participantKey(a._id.toString(), b._id.toString()),
        }).lean()
        assert.notEqual(conversation?.state, 'pending')
        if (conversation) assert.equal(conversation.state, 'revoked')
        assert.equal(
          await Message.countDocuments({ clientMessageId: `block-request-${suffix}` }),
          results[1].status === 'fulfilled' ? 1 : 0,
        )
      })

      await t.test(
        'Block and a Declined reopening leave no active direct authorization',
        async () => {
          const { a, b, conversationId } = await seedLifecycle('declined')
          await Follow.create({ followerId: b._id, followingId: a._id })
          const clientMessageId = `block-declined-cycle-${suffix}`
          const results = await Promise.allSettled([
            blockContact(a._id.toString(), b._id.toString()),
            sendDirect(a._id.toString(), conversationId, clientMessageId, 'reopen declined'),
          ])
          assert.equal(results[0].status, 'fulfilled')
          assert.equal(
            await UserBlock.countDocuments({ blockerUserId: a._id, blockedUserId: b._id }),
            1,
          )
          const conversation = await DirectConversation.findById(conversationId).lean()
          assert.ok(['declined', 'revoked'].includes(conversation.state))
          assert.notEqual(conversation.state, 'unlocked')
          assert.notEqual(conversation.state, 'pending')
          assert.equal(await Follow.countDocuments({ followerId: b._id, followingId: a._id }), 0)
          assert.equal(
            await Message.countDocuments({ clientMessageId }),
            results[1].status === 'fulfilled' ? 1 : 0,
          )
        },
      )

      await t.test('Block and a Revoked reopening leave revoked authority', async () => {
        const { a, b, conversationId } = await seedLifecycle('revoked')
        await Follow.create({ followerId: b._id, followingId: a._id })
        const clientMessageId = `block-revoked-cycle-${suffix}`
        const results = await Promise.allSettled([
          blockContact(a._id.toString(), b._id.toString()),
          sendDirect(a._id.toString(), conversationId, clientMessageId, 'reopen revoked'),
        ])
        assert.equal(results[0].status, 'fulfilled')
        assert.equal(
          await UserBlock.countDocuments({ blockerUserId: a._id, blockedUserId: b._id }),
          1,
        )
        const conversation = await DirectConversation.findById(conversationId).lean()
        assert.equal(conversation.state, 'revoked')
        assert.equal(conversation.revocationReason, 'block')
        assert.equal(conversation.unlockedAt, undefined)
        assert.equal(conversation.unlockReason, undefined)
        assert.equal(await Follow.countDocuments({ followerId: b._id, followingId: a._id }), 0)
        assert.equal(
          await Message.countDocuments({ clientMessageId }),
          results[1].status === 'fulfilled' ? 1 : 0,
        )
      })

      await t.test('reciprocal Block preserves directional ownership', async () => {
        const [a, b] = await users()
        const key = participantKey(a._id.toString(), b._id.toString())
        await ContactPairGuard.create({ participantKey: key, revision: 0 })
        const results = await Promise.allSettled([
          blockContact(a._id.toString(), b._id.toString()),
          blockContact(b._id.toString(), a._id.toString()),
        ])
        assert.equal(fulfilledCount(results), 2)
        assert.equal(
          await UserBlock.countDocuments({
            $or: [
              { blockerUserId: a._id, blockedUserId: b._id },
              { blockerUserId: b._id, blockedUserId: a._id },
            ],
          }),
          2,
        )
        assert.equal(await ContactPairGuard.countDocuments({ participantKey: key }), 1)
        assert.ok((await ContactPairGuard.findOne({ participantKey: key }).lean()).revision >= 2)
      })

      await t.test(
        'duplicate first send creates one conversation, message, and state pair',
        async () => {
          const [a, b] = await users()
          const results = await Promise.allSettled([
            sendFirstDirect(a._id.toString(), b._id.toString(), `duplicate-a-${suffix}`, 'first'),
            sendFirstDirect(a._id.toString(), b._id.toString(), `duplicate-b-${suffix}`, 'second'),
          ])
          assert.equal(fulfilledCount(results), 1)
          const conversation = await DirectConversation.findOne({
            participantKey: participantKey(a._id.toString(), b._id.toString()),
          }).lean()
          assert.ok(conversation)
          assert.equal(await Message.countDocuments({ contextId: conversation._id }), 1)
          assert.equal(
            await DirectConversationState.countDocuments({ conversationId: conversation._id }),
            2,
          )
        },
      )

      await t.test(
        'Follow and pending resolution never produce contradictory lifecycle',
        async () => {
          const { a, b, conversationId } = await pending('follow-resolution')
          const results = await Promise.allSettled([
            followContact(b._id.toString(), a._id.toString()),
            declineMessageRequest(b._id.toString(), conversationId),
          ])
          assert.equal(results[0].status, 'fulfilled')
          assert.equal(await Follow.countDocuments({ followerId: b._id, followingId: a._id }), 1)
          const conversation = await DirectConversation.findById(conversationId).lean()
          assert.ok(['unlocked', 'declined'].includes(conversation.state))
          if (conversation.state === 'unlocked') assert.equal(conversation.unlockReason, 'follow')
        },
      )

      await t.test('transaction failure injection rolls back every primary invariant', async () => {
        const { a, b, conversationId } = await pending('block-rollback')
        await Follow.insertMany([
          { followerId: a._id, followingId: b._id },
          { followerId: b._id, followingId: a._id },
        ])
        await assert.rejects(
          () => blockContact(a._id.toString(), b._id.toString(), 'after-follow-removals'),
          /Injected/,
        )
        assert.equal(
          await UserBlock.countDocuments({ blockerUserId: a._id, blockedUserId: b._id }),
          0,
        )
        assert.equal(
          await Follow.countDocuments({
            $or: [
              { followerId: a._id, followingId: b._id },
              { followerId: b._id, followingId: a._id },
            ],
          }),
          2,
        )
        assert.equal((await DirectConversation.findById(conversationId).lean()).state, 'pending')

        const replyId = `reply-rollback-${suffix}`
        await assert.rejects(
          () => sendDirect(b._id.toString(), conversationId, replyId, 'reply', 'after-message'),
          /Injected/,
        )
        assert.equal((await DirectConversation.findById(conversationId).lean()).state, 'pending')
        assert.equal(await Message.countDocuments({ clientMessageId: replyId }), 0)

        const [c, d] = await users()
        await assert.rejects(
          () =>
            sendFirstDirect(
              c._id.toString(),
              d._id.toString(),
              `request-rollback-${suffix}`,
              'request',
              'after-message',
            ),
          /Injected/,
        )
        assert.equal(
          await DirectConversation.countDocuments({
            participantKey: participantKey(c._id.toString(), d._id.toString()),
          }),
          0,
        )
        assert.equal(
          await Message.countDocuments({ clientMessageId: `request-rollback-${suffix}` }),
          0,
        )

        const pendingFollow = await pending('follow-rollback')
        await assert.rejects(
          () =>
            followContact(
              pendingFollow.b._id.toString(),
              pendingFollow.a._id.toString(),
              'after-follow',
            ),
          /Injected/,
        )
        assert.equal(
          await Follow.countDocuments({
            followerId: pendingFollow.b._id,
            followingId: pendingFollow.a._id,
          }),
          0,
        )
        assert.equal(
          (await DirectConversation.findById(pendingFollow.conversationId).lean()).state,
          'pending',
        )
      })

      await t.test(
        'failure after conversation revocation rolls back the entire Block',
        async () => {
          const { a, b, conversationId } = await pending('block-post-revocation-rollback')
          await Follow.insertMany([
            { followerId: a._id, followingId: b._id },
            { followerId: b._id, followingId: a._id },
          ])
          const messageCount = await Message.countDocuments({ contextId: conversationId })
          const stateCount = await DirectConversationState.countDocuments({ conversationId })

          await assert.rejects(
            () => blockContact(a._id.toString(), b._id.toString(), 'after-conversation'),
            /Injected failure after conversation/,
          )

          assert.equal(
            await UserBlock.countDocuments({ blockerUserId: a._id, blockedUserId: b._id }),
            0,
          )
          assert.equal(
            await Follow.countDocuments({
              $or: [
                { followerId: a._id, followingId: b._id },
                { followerId: b._id, followingId: a._id },
              ],
            }),
            2,
          )
          const conversation = await DirectConversation.findById(conversationId).lean()
          assert.equal(conversation.state, 'pending')
          assert.equal(conversation.revokedAt, undefined)
          assert.equal(conversation.revocationReason, undefined)
          assert.equal(await Message.countDocuments({ contextId: conversationId }), messageCount)
          assert.equal(await DirectConversationState.countDocuments({ conversationId }), stateCount)
        },
      )

      await t.test(
        'Block preserves an already-Revoked conversation without rewriting it',
        async () => {
          const { a, b, conversationId } = await seedLifecycle('revoked')
          const before = await DirectConversation.findById(conversationId).lean()
          await blockContact(a._id.toString(), b._id.toString())
          const after = await DirectConversation.findById(conversationId).lean()
          assert.equal(after.state, 'revoked')
          assert.equal(after.revocationReason, 'block')
          assert.equal(after.revokedAt.valueOf(), before.revokedAt.valueOf())
          assert.equal(after.updatedAt.valueOf(), before.updatedAt.valueOf())
          assert.equal(after.unlockedAt, undefined)
          assert.equal(after.unlockReason, undefined)
        },
      )

      await t.test(
        'Block preserves history/states/discussion and Unblock restores nothing',
        async () => {
          const [a, b] = await users()
          await Follow.insertMany([
            { followerId: a._id, followingId: b._id },
            { followerId: b._id, followingId: a._id },
          ])
          const first = await sendFirstDirect(
            a._id.toString(),
            b._id.toString(),
            `preserve-first-${suffix}`,
            'history',
          )
          const room = await DiscussionRoom.create({
            tmdbId: Number(String(Date.now()).slice(-8)),
            movieSnapshot: { title: 'Stage 3', posterPath: null },
          })
          roomIds.push(room._id)
          const membership = await DiscussionMembership.create({
            roomId: room._id,
            userId: a._id,
            status: 'joined',
            joinedAt: new Date(),
          })
          const discussionMessage = await Message.create({
            senderId: b._id,
            clientMessageId: `discussion-preserve-${suffix}`,
            contextType: 'discussion',
            contextId: room._id,
            content: 'preserve',
          })

          await blockContact(a._id.toString(), b._id.toString())
          await blockContact(b._id.toString(), a._id.toString())
          await unblockContact(a._id.toString(), b._id.toString())
          assert.equal(
            await UserBlock.countDocuments({ blockerUserId: a._id, blockedUserId: b._id }),
            0,
          )
          assert.equal(
            await UserBlock.countDocuments({ blockerUserId: b._id, blockedUserId: a._id }),
            1,
          )
          assert.equal(
            await Follow.countDocuments({
              $or: [
                { followerId: a._id, followingId: b._id },
                { followerId: b._id, followingId: a._id },
              ],
            }),
            0,
          )
          assert.equal(
            (await DirectConversation.findById(first.message.contextId).lean()).state,
            'revoked',
          )
          assert.equal(await Message.countDocuments({ contextId: first.message.contextId }), 1)
          assert.ok(
            await DirectConversationState.exists({
              conversationId: first.message.contextId,
              userId: a._id,
            }),
          )
          assert.ok(await DiscussionMembership.exists({ _id: membership._id }))
          assert.ok(await Message.exists({ _id: discussionMessage._id }))

          const retainedRoom = await getDiscussion(a._id.toString(), room._id.toString())
          const retainedWindow = await getMessages(
            a._id.toString(),
            'discussion',
            room._id.toString(),
            { initial: true },
          )
          const retainedMessage = retainedWindow.messages.find(
            (message) => message.id === discussionMessage._id.toString(),
          )
          assert.equal(retainedRoom.membership.status, 'joined')
          assert.ok(retainedMessage)
          assert.equal(retainedMessage.content, 'preserve')
          assert.deepEqual(retainedMessage.sender, {
            id: b._id.toString(),
            account: b.account,
            displayName: null,
            avatar: null,
          })
          assert.deepEqual(Object.keys(retainedRoom).sort(), [
            'hasUnread',
            'id',
            'lastMessage',
            'membership',
            'movieSnapshot',
            'tmdbId',
          ])
          assert.deepEqual(Object.keys(retainedMessage).sort(), [
            'clientMessageId',
            'content',
            'contextId',
            'contextType',
            'createdAt',
            'id',
            'sender',
            'senderId',
            'updatedAt',
          ])

          const declined = await seedLifecycle('declined')
          await blockContact(declined.a._id.toString(), declined.b._id.toString())
          assert.equal(
            (await DirectConversation.findById(declined.conversationId).lean()).state,
            'declined',
          )
        },
      )

      await t.test(
        'new cycles and directional pending Follow follow the official matrix',
        async () => {
          const direct = await seedLifecycle('revoked')
          await Follow.create({ followerId: direct.b._id, followingId: direct.a._id })
          await sendDirect(
            direct.a._id.toString(),
            direct.conversationId,
            `revoked-direct-${suffix}`,
            'direct',
          )
          let conversation = await DirectConversation.findById(direct.conversationId).lean()
          assert.equal(conversation.state, 'unlocked')
          assert.equal(conversation.unlockReason, 'follow')

          const request = await seedLifecycle('revoked')
          await sendDirect(
            request.a._id.toString(),
            request.conversationId,
            `revoked-request-${suffix}`,
            'request',
          )
          conversation = await DirectConversation.findById(request.conversationId).lean()
          assert.equal(conversation.state, 'pending')
          assert.equal(conversation.initiatedByUserId.toString(), request.a._id.toString())
          assert.equal(conversation.revokedAt, undefined)
          assert.equal(conversation.revocationReason, undefined)

          const denied = await seedLifecycle('revoked', 'followed_members')
          await assert.rejects(
            () =>
              sendDirect(
                denied.a._id.toString(),
                denied.conversationId,
                `revoked-denied-${suffix}`,
                'denied',
              ),
            { code: 'DIRECT_UNAVAILABLE' },
          )
          assert.equal(
            (await DirectConversation.findById(denied.conversationId).lean()).state,
            'revoked',
          )

          const declined = await seedLifecycle('declined')
          await assert.rejects(
            () =>
              sendDirect(
                declined.a._id.toString(),
                declined.conversationId,
                `declined-denied-${suffix}`,
                'denied',
              ),
            { code: 'DIRECT_DECLINED' },
          )
          await followContact(declined.b._id.toString(), declined.a._id.toString())
          assert.equal(
            (await DirectConversation.findById(declined.conversationId).lean()).state,
            'declined',
          )
          await sendDirect(
            declined.a._id.toString(),
            declined.conversationId,
            `declined-open-${suffix}`,
            'open',
          )
          conversation = await DirectConversation.findById(declined.conversationId).lean()
          assert.equal(conversation.state, 'unlocked')
          assert.equal(conversation.unlockReason, 'follow')
          assert.equal(conversation.declinedAt, undefined)

          const reverseDeclined = await seedLifecycle('declined')
          await followContact(reverseDeclined.a._id.toString(), reverseDeclined.b._id.toString())
          await assert.rejects(
            () =>
              sendDirect(
                reverseDeclined.b._id.toString(),
                reverseDeclined.conversationId,
                `declined-receiver-denied-${suffix}`,
                'receiver denied',
              ),
            { code: 'DIRECT_DECLINED' },
          )
          await followContact(reverseDeclined.b._id.toString(), reverseDeclined.a._id.toString())
          await assert.rejects(
            () =>
              sendDirect(
                reverseDeclined.b._id.toString(),
                reverseDeclined.conversationId,
                `declined-receiver-mutual-denied-${suffix}`,
                'receiver still denied',
              ),
            { code: 'DIRECT_DECLINED' },
          )
          await sendDirect(
            reverseDeclined.a._id.toString(),
            reverseDeclined.conversationId,
            `declined-initiator-mutual-open-${suffix}`,
            'initiator open',
          )
          conversation = await DirectConversation.findById(reverseDeclined.conversationId).lean()
          assert.equal(conversation.state, 'unlocked')
          assert.equal(conversation.unlockReason, 'follow')

          const directional = await pending('directional-follow')
          await followContact(directional.a._id.toString(), directional.b._id.toString())
          assert.equal(
            (await DirectConversation.findById(directional.conversationId).lean()).state,
            'pending',
          )
          await unfollowContact(directional.a._id.toString(), directional.b._id.toString())
          await followContact(directional.b._id.toString(), directional.a._id.toString())
          const followUnlocked = await DirectConversation.findById(
            directional.conversationId,
          ).lean()
          assert.equal(followUnlocked.state, 'unlocked')
          assert.equal(followUnlocked.unlockReason, 'follow')
          assert.ok(followUnlocked.unlockedAt)
          await unfollowContact(directional.b._id.toString(), directional.a._id.toString())
          assert.equal(
            (await DirectConversation.findById(directional.conversationId).lean()).state,
            'unlocked',
          )
        },
      )
    } finally {
      await Message.deleteMany({ senderId: { $in: userIds } })
      await DirectConversationState.deleteMany({ userId: { $in: userIds } })
      await DirectConversation.deleteMany({ participantIds: { $in: userIds } })
      await DiscussionMembership.deleteMany({ userId: { $in: userIds } })
      await DiscussionRoom.deleteMany({ _id: { $in: roomIds } })
      await Follow.deleteMany({
        $or: [{ followerId: { $in: userIds } }, { followingId: { $in: userIds } }],
      })
      await UserBlock.deleteMany({
        $or: [{ blockerUserId: { $in: userIds } }, { blockedUserId: { $in: userIds } }],
      })
      const keys = await ContactPairGuard.find({}).select('participantKey').lean()
      const ownedKeys = keys
        .filter((guard) => userIds.some((id) => guard.participantKey.includes(id.toString())))
        .map((guard) => guard._id)
      await ContactPairGuard.deleteMany({ _id: { $in: ownedKeys } })
      await User.deleteMany({ _id: { $in: userIds } })
      await mongoose.disconnect()
    }
  },
)

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import { ContactPairGuard } from '../dist/models/contactPairGuardModel.js'
import { DirectConversation } from '../dist/models/directConversationModel.js'
import { Notification } from '../dist/models/notificationModel.js'
import { Report } from '../dist/models/reportModel.js'
import { UserBlock } from '../dist/models/userBlockModel.js'
import { User } from '../dist/models/userModel.js'

const userId = () => new Types.ObjectId()

const directConversation = (overrides = {}) => {
  const firstUserId = userId()
  const secondUserId = userId()

  return new DirectConversation({
    participantIds: [firstUserId, secondUserId],
    participantKey: [firstUserId, secondUserId]
      .map((id) => id.toString())
      .sort()
      .join(':'),
    initiatedByUserId: firstUserId,
    state: 'pending',
    ...overrides,
  })
}

describe('Phase 8 DirectConversation persistence', () => {
  it('represents declined and revoked lifecycle metadata', async () => {
    await assert.doesNotReject(() =>
      directConversation({ state: 'declined', declinedAt: new Date() }).validate(),
    )
    await assert.doesNotReject(() =>
      directConversation({
        state: 'revoked',
        revokedAt: new Date(),
        revocationReason: 'block',
      }).validate(),
    )
  })

  it('accepts every official unlock reason', async () => {
    for (const unlockReason of ['reply', 'follow', 'accept']) {
      await assert.doesNotReject(() =>
        directConversation({ state: 'unlocked', unlockedAt: new Date(), unlockReason }).validate(),
      )
    }
  })

  it('rejects invalid lifecycle enum values', async () => {
    await assert.rejects(
      () => directConversation({ state: 'expired' }).validate(),
      (error) => error?.errors.state?.kind === 'enum',
    )
    await assert.rejects(
      () => directConversation({ unlockReason: 'request' }).validate(),
      (error) => error?.errors.unlockReason?.kind === 'enum',
    )
    await assert.rejects(
      () => directConversation({ revocationReason: 'moderation' }).validate(),
      (error) => error?.errors.revocationReason?.kind === 'enum',
    )
  })
})

describe('Phase 8 User messaging preference persistence', () => {
  const user = (overrides = {}) =>
    new User({
      account: `phase8-${new Types.ObjectId()}`,
      email: `${new Types.ObjectId()}@test.invalid`,
      password: 'not-used',
      role: 'user',
      ...overrides,
    })

  it('defaults new users to all_members', async () => {
    const newUser = user()
    await newUser.validate()
    assert.equal(newUser.messageRequestPreference, 'all_members')
  })

  it('accepts official values and rejects invalid values', async () => {
    for (const messageRequestPreference of ['all_members', 'followed_members']) {
      await assert.doesNotReject(() => user({ messageRequestPreference }).validate())
    }
    await assert.rejects(
      () => user({ messageRequestPreference: 'nobody' }).validate(),
      (error) => error?.errors.messageRequestPreference?.kind === 'enum',
    )
  })
})

describe('Phase 8 UserBlock persistence', () => {
  it('permits reciprocal directional records', async () => {
    const firstUserId = userId()
    const secondUserId = userId()

    await assert.doesNotReject(() =>
      new UserBlock({ blockerUserId: firstUserId, blockedUserId: secondUserId }).validate(),
    )
    await assert.doesNotReject(() =>
      new UserBlock({ blockerUserId: secondUserId, blockedUserId: firstUserId }).validate(),
    )
  })

  it('declares pair uniqueness and blocked-member cursor indexes', () => {
    const indexes = UserBlock.schema.indexes()
    assert.ok(
      indexes.some(
        ([fields, options]) =>
          fields.blockerUserId === 1 && fields.blockedUserId === 1 && options.unique === true,
      ),
    )
    assert.ok(
      indexes.some(
        ([fields]) => fields.blockerUserId === 1 && fields.createdAt === -1 && fields._id === -1,
      ),
    )
  })
})

describe('Phase 8 ContactPairGuard persistence', () => {
  it('defaults revision for future atomic increments', async () => {
    const guard = new ContactPairGuard({ participantKey: 'first:second' })
    await guard.validate()
    assert.equal(guard.revision, 0)
  })

  it('declares participantKey uniqueness', () => {
    assert.ok(
      ContactPairGuard.schema
        .indexes()
        .some(([fields, options]) => fields.participantKey === 1 && options.unique === true),
    )
  })
})

describe('Phase 8 Report persistence', () => {
  const reporterUserId = userId()
  const reportedUserId = userId()
  const conversationId = userId()
  const messageId = userId()

  const report = (overrides = {}) =>
    new Report({
      reporterUserId,
      reportedUserId,
      reason: 'other',
      sourceType: 'public_profile',
      ...overrides,
    })

  it('accepts every official reason and source shape', async () => {
    for (const reason of ['harassment_or_uncomfortable', 'spam_or_suspicious', 'other']) {
      await assert.doesNotReject(() => report({ reason }).validate())
    }
    await assert.doesNotReject(() =>
      report({ sourceType: 'direct_conversation', conversationId }).validate(),
    )
    await assert.doesNotReject(() =>
      report({
        sourceType: 'direct_message',
        conversationId,
        messageId,
        messageEvidence: {
          messageId,
          senderUserId: reportedUserId,
          content: 'Preserved message content',
          sentAt: new Date(),
        },
      }).validate(),
    )
  })

  it('rejects invalid enums and incomplete source-specific shapes', async () => {
    await assert.rejects(
      () => report({ reason: 'moderation' }).validate(),
      (error) => error?.errors.reason?.kind === 'enum',
    )
    await assert.rejects(
      () => report({ sourceType: 'discussion_message' }).validate(),
      (error) => error?.errors.sourceType?.kind === 'enum',
    )
    await assert.rejects(
      () => report({ sourceType: 'direct_conversation' }).validate(),
      (error) => error?.errors.conversationId?.kind === 'required',
    )
    await assert.rejects(
      () => report({ sourceType: 'direct_message', conversationId }).validate(),
      (error) =>
        error?.errors.messageId?.kind === 'required' &&
        error?.errors.messageEvidence?.kind === 'required',
    )
    await assert.rejects(
      () => report({ sourceType: 'public_profile', conversationId }).validate(),
      (error) => error?.errors.conversationId?.kind === 'user defined',
    )
    await assert.rejects(
      () => report({ sourceType: 'direct_conversation', conversationId, messageId }).validate(),
      (error) => error?.errors.messageId?.kind === 'user defined',
    )
  })
})

describe('Phase 8 Notification persistence', () => {
  const recipientId = userId()

  it('keeps follow notifications representable', async () => {
    await assert.doesNotReject(() =>
      new Notification({ recipientId, actorId: userId(), type: 'follow' }).validate(),
    )
  })

  it('represents report confirmations without a fake actor', async () => {
    const notification = new Notification({
      recipientId,
      type: 'report_submitted',
      reportId: userId(),
      messageId: userId(),
    })
    await notification.validate()
    assert.equal(notification.actorId, undefined)
  })

  it('enforces type-specific references', async () => {
    await assert.rejects(
      () => new Notification({ recipientId, type: 'follow' }).validate(),
      (error) => error?.errors.actorId?.kind === 'required',
    )
    await assert.rejects(
      () => new Notification({ recipientId, type: 'report_submitted' }).validate(),
      (error) => error?.errors.reportId?.kind === 'required',
    )
    await assert.rejects(
      () =>
        new Notification({
          recipientId,
          actorId: userId(),
          type: 'report_submitted',
          reportId: userId(),
        }).validate(),
      (error) => error?.errors.actorId?.kind === 'user defined',
    )
    await assert.rejects(
      () =>
        new Notification({
          recipientId,
          actorId: userId(),
          type: 'follow',
          reportId: userId(),
          messageId: userId(),
        }).validate(),
      (error) =>
        error?.errors.reportId?.kind === 'user defined' &&
        error?.errors.messageId?.kind === 'user defined',
    )
  })
})

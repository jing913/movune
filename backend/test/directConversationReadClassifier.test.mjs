import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyDirectConversationRead } from '../dist/utils/directConversationReadClassifier.js'

const actor = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const target = 'bbbbbbbbbbbbbbbbbbbbbbbb'

const context = (state, overrides = {}) => ({
  actorUserId: actor,
  targetUserId: target,
  targetExists: true,
  actorBlocksTarget: false,
  targetBlocksActor: false,
  actorFollowsTarget: false,
  targetFollowsActor: false,
  targetMessageRequestPreference: 'all_members',
  conversation: { state, initiatedByUserId: actor },
  ...overrides,
})

describe('Stage 6 central Direct Conversation read classifier', () => {
  it('keeps the four persisted lifecycles in their frozen buckets', () => {
    assert.equal(classifyDirectConversationRead(context('unlocked'), true).bucket, 'conversations')
    assert.equal(classifyDirectConversationRead(context('pending'), true).bucket, 'requests')
    assert.equal(classifyDirectConversationRead(context('declined'), true).bucket, 'ended')
    assert.equal(classifyDirectConversationRead(context('revoked'), true).bucket, 'ended')
  })

  it('derives pending direction actor-relatively', () => {
    assert.equal(
      classifyDirectConversationRead(context('pending'), true).interactionState,
      'pending_outgoing',
    )
    const incoming = classifyDirectConversationRead(
      context('pending', { conversation: { state: 'pending', initiatedByUserId: target } }),
      true,
    )
    assert.equal(incoming.interactionState, 'pending_incoming')
    assert.equal(incoming.isActionableIncomingRequest, true)
  })

  it('overlays effective Block as blocked Ended with suppressed shared context', () => {
    const result = classifyDirectConversationRead(
      context('unlocked', { actorBlocksTarget: true }),
      true,
    )
    assert.equal(result.interactionState, 'blocked')
    assert.equal(result.bucket, 'ended')
    assert.equal(result.shouldRenderSharedContext, false)
    assert.equal(result.capabilities.canUnblockUser, true)
  })

  it('keeps Declined and Revoked history Ended when current grants change semantics', () => {
    const declined = classifyDirectConversationRead(
      context('declined', { targetFollowsActor: true }),
      true,
    )
    assert.equal(declined.interactionState, 'direct_allowed')
    assert.equal(declined.bucket, 'ended')
    assert.equal(declined.shouldRenderSharedContext, false)

    const revokedDirect = classifyDirectConversationRead(
      context('revoked', { targetFollowsActor: true }),
      true,
    )
    assert.equal(revokedDirect.interactionState, 'direct_allowed')
    assert.equal(revokedDirect.bucket, 'ended')

    const revokedRequest = classifyDirectConversationRead(context('revoked'), true)
    assert.equal(revokedRequest.interactionState, 'request_allowed')
    assert.equal(revokedRequest.bucket, 'ended')
  })

  it('keeps the original Declined receiver read-only despite reverse Follow and preference', () => {
    for (const targetMessageRequestPreference of ['all_members', 'followed_members']) {
      const result = classifyDirectConversationRead(
        context('declined', {
          targetFollowsActor: true,
          targetMessageRequestPreference,
          conversation: { state: 'declined', initiatedByUserId: target },
        }),
        true,
      )
      assert.equal(result.interactionState, 'declined')
      assert.equal(result.capabilities.canSendMessage, false)
      assert.equal(result.capabilities.canCreateMessageRequest, false)
      assert.equal(result.bucket, 'ended')
      assert.equal(result.shouldRenderSharedContext, false)
    }
  })
})

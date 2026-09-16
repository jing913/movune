import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  evaluateContactAuthorization,
  mayReportDirectMessage,
} from '../dist/utils/contactAuthorizationPolicy.js'

const actorUserId = '64b64c0a4f4c6a2e9c6d1001'
const targetUserId = '64b64c0a4f4c6a2e9c6d1002'

const context = (overrides = {}) => ({
  actorUserId,
  targetUserId,
  targetExists: true,
  actorBlocksTarget: false,
  targetBlocksActor: false,
  actorFollowsTarget: false,
  targetFollowsActor: false,
  targetMessageRequestPreference: 'all_members',
  conversation: null,
  ...overrides,
})

const conversation = (state, initiatedByUserId = actorUserId) => ({
  state,
  initiatedByUserId,
})

describe('Contact Authorization new-contact policy', () => {
  const cases = [
    {
      name: 'target Follow grants actor direct contact',
      input: { targetFollowsActor: true, targetMessageRequestPreference: 'followed_members' },
      state: 'direct_allowed',
      reason: 'receiver_follows_actor',
      canSendMessage: true,
      canCreateMessageRequest: false,
    },
    {
      name: 'all_members allows one new request',
      input: { targetMessageRequestPreference: 'all_members' },
      state: 'request_allowed',
      reason: 'receiver_allows_requests',
      canSendMessage: false,
      canCreateMessageRequest: true,
    },
    {
      name: 'followed_members denies a request without target Follow',
      input: { targetMessageRequestPreference: 'followed_members' },
      state: 'none',
      reason: 'receiver_restricts_requests',
      canSendMessage: false,
      canCreateMessageRequest: false,
    },
    {
      name: 'invalid preference fails closed for request creation',
      input: { targetMessageRequestPreference: 'invalid' },
      state: 'none',
      reason: 'invalid_preference_fail_closed',
      canSendMessage: false,
      canCreateMessageRequest: false,
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      const decision = evaluateContactAuthorization(context(testCase.input))
      assert.equal(decision.interactionState, testCase.state)
      assert.equal(decision.reason, testCase.reason)
      assert.equal(decision.capabilities.canSendMessage, testCase.canSendMessage)
      assert.equal(decision.capabilities.canCreateMessageRequest, testCase.canCreateMessageRequest)
    })
  }

  it('does not reverse the critical Follow direction', () => {
    const actorOnlyFollows = evaluateContactAuthorization(
      context({
        actorFollowsTarget: true,
        targetFollowsActor: false,
        targetMessageRequestPreference: 'followed_members',
      }),
    )
    const targetFollows = evaluateContactAuthorization(
      context({
        actorFollowsTarget: false,
        targetFollowsActor: true,
        targetMessageRequestPreference: 'followed_members',
      }),
    )

    assert.equal(actorOnlyFollows.interactionState, 'none')
    assert.equal(actorOnlyFollows.capabilities.canSendMessage, false)
    assert.equal(actorOnlyFollows.capabilities.canFollow, false)
    assert.equal(targetFollows.interactionState, 'direct_allowed')
    assert.equal(targetFollows.capabilities.canSendMessage, true)
  })

  it('lets a valid target Follow outrank an invalid preference', () => {
    const decision = evaluateContactAuthorization(
      context({ targetFollowsActor: true, targetMessageRequestPreference: 'invalid' }),
    )
    assert.equal(decision.interactionState, 'direct_allowed')
    assert.equal(decision.reason, 'receiver_follows_actor')
  })
})

describe('Contact Authorization existing-conversation policy', () => {
  it('preserves an unlocked conversation after ordinary Unfollow', () => {
    const decision = evaluateContactAuthorization(
      context({
        conversation: conversation('unlocked'),
        targetFollowsActor: false,
        targetMessageRequestPreference: 'followed_members',
      }),
    )
    assert.equal(decision.interactionState, 'unlocked')
    assert.equal(decision.reason, 'existing_unlocked')
    assert.equal(decision.capabilities.canSendMessage, true)
  })

  it('keeps a pending initiator waiting without a new direct-contact grant', () => {
    const decision = evaluateContactAuthorization(
      context({ conversation: conversation('pending'), targetFollowsActor: false }),
    )
    assert.equal(decision.interactionState, 'pending_outgoing')
    assert.equal(decision.reason, 'pending_initiator_waiting')
    assert.equal(decision.capabilities.canSendMessage, false)
    assert.equal(decision.capabilities.canCreateMessageRequest, false)
    assert.equal(decision.capabilities.canAccept, false)
    assert.equal(decision.capabilities.canDecline, false)
  })

  it('recognizes target Follow for a pending initiator without mutating lifecycle', () => {
    const input = context({
      conversation: conversation('pending'),
      targetFollowsActor: true,
    })
    const decision = evaluateContactAuthorization(input)
    assert.equal(decision.interactionState, 'pending_outgoing')
    assert.equal(decision.reason, 'receiver_follows_actor')
    assert.equal(decision.capabilities.canSendMessage, true)
    assert.equal(input.conversation.state, 'pending')
  })

  it('allows the pending receiver to Accept, Decline, or Reply', () => {
    const decision = evaluateContactAuthorization(
      context({ conversation: conversation('pending', targetUserId) }),
    )
    assert.equal(decision.interactionState, 'pending_incoming')
    assert.equal(decision.reason, 'pending_receiver_can_resolve')
    assert.equal(decision.capabilities.canAccept, true)
    assert.equal(decision.capabilities.canDecline, true)
    assert.equal(decision.capabilities.canSendMessage, true)
    assert.equal(decision.capabilities.canCreateMessageRequest, false)
  })

  it('keeps Declined suppressed despite a permissive preference', () => {
    const decision = evaluateContactAuthorization(
      context({
        conversation: conversation('declined'),
        targetMessageRequestPreference: 'all_members',
      }),
    )
    assert.equal(decision.interactionState, 'declined')
    assert.equal(decision.reason, 'declined_request_suppressed')
    assert.equal(decision.capabilities.canCreateMessageRequest, false)
    assert.equal(decision.capabilities.canSendMessage, false)
  })

  it('derives direct contact after the original receiver follows the initiator', () => {
    const decision = evaluateContactAuthorization(
      context({
        conversation: conversation('declined'),
        targetFollowsActor: true,
      }),
    )
    assert.equal(decision.interactionState, 'direct_allowed')
    assert.equal(decision.capabilities.canSendMessage, true)
    assert.equal(decision.capabilities.canCreateMessageRequest, false)
  })

  for (const targetMessageRequestPreference of ['all_members', 'followed_members']) {
    it(`does not let the original receiver reopen Declined when the initiator follows them under ${targetMessageRequestPreference}`, () => {
      const decision = evaluateContactAuthorization(
        context({
          conversation: conversation('declined', targetUserId),
          actorFollowsTarget: true,
          targetFollowsActor: true,
          targetMessageRequestPreference,
        }),
      )
      assert.equal(decision.interactionState, 'declined')
      assert.equal(decision.reason, 'declined_request_suppressed')
      assert.equal(decision.capabilities.canSendMessage, false)
      assert.equal(decision.capabilities.canCreateMessageRequest, false)
    })
  }

  it('keeps Block authoritative over an otherwise eligible Declined initiator', () => {
    const decision = evaluateContactAuthorization(
      context({
        conversation: conversation('declined'),
        targetFollowsActor: true,
        actorBlocksTarget: true,
      }),
    )
    assert.equal(decision.interactionState, 'blocked')
    assert.equal(decision.capabilities.canSendMessage, false)
    assert.equal(decision.capabilities.canFollow, false)
  })

  const revokedCases = [
    {
      name: 'current target Follow grants direct contact',
      input: { targetFollowsActor: true, targetMessageRequestPreference: 'followed_members' },
      state: 'direct_allowed',
      canSendMessage: true,
      canCreateMessageRequest: false,
    },
    {
      name: 'current all_members preference allows a new request',
      input: { targetMessageRequestPreference: 'all_members' },
      state: 'request_allowed',
      canSendMessage: false,
      canCreateMessageRequest: true,
    },
    {
      name: 'current followed_members preference leaves history unavailable',
      input: { targetMessageRequestPreference: 'followed_members' },
      state: 'revoked_unavailable',
      canSendMessage: false,
      canCreateMessageRequest: false,
    },
    {
      name: 'invalid current preference fails closed',
      input: { targetMessageRequestPreference: 'invalid' },
      state: 'revoked_unavailable',
      canSendMessage: false,
      canCreateMessageRequest: false,
    },
  ]

  for (const testCase of revokedCases) {
    it(`re-evaluates Revoked from ${testCase.name}`, () => {
      const decision = evaluateContactAuthorization(
        context({ conversation: conversation('revoked'), ...testCase.input }),
      )
      assert.equal(decision.interactionState, testCase.state)
      assert.equal(decision.capabilities.canSendMessage, testCase.canSendMessage)
      assert.equal(decision.capabilities.canCreateMessageRequest, testCase.canCreateMessageRequest)
      assert.notEqual(decision.interactionState, 'unlocked')
    })
  }
})

describe('Contact Authorization Block, ownership, and reporting policy', () => {
  for (const blockState of [
    { actorBlocksTarget: true },
    { targetBlocksActor: true },
    { actorBlocksTarget: true, targetBlocksActor: true },
  ]) {
    it(`applies bilateral Block effect for ${JSON.stringify(blockState)}`, () => {
      const decision = evaluateContactAuthorization(
        context({ conversation: conversation('unlocked'), ...blockState }),
      )
      assert.equal(decision.interactionState, 'blocked')
      assert.equal(decision.reason, 'blocked')
      assert.equal(decision.capabilities.canSendMessage, false)
      assert.equal(decision.capabilities.canCreateMessageRequest, false)
      assert.equal(decision.capabilities.canFollow, false)
      assert.equal(decision.capabilities.mayAccessDirectSocialSurface, false)
      assert.equal(decision.capabilities.mayDistributeUser, false)
      assert.equal(decision.capabilities.canReportUser, true)
      assert.equal(decision.capabilities.canUnblock, blockState.actorBlocksTarget === true)
    })
  }

  it('does not confuse target-owned Block with actor ownership', () => {
    const decision = evaluateContactAuthorization(context({ targetBlocksActor: true }))
    assert.equal(decision.actorBlocksTarget, false)
    assert.equal(decision.targetBlocksActor, true)
    assert.equal(decision.capabilities.canUnblock, false)
    assert.equal(decision.capabilities.canBlock, true)
  })

  it('preserves actor-owned Unblock capability when the target record is unavailable', () => {
    const decision = evaluateContactAuthorization(
      context({ targetExists: false, actorBlocksTarget: true }),
    )
    assert.equal(decision.capabilities.canUnblock, true)
    assert.equal(decision.capabilityReasons.unblock, 'actor_owned_block')
  })

  it('reports only eligible other-user direct messages', () => {
    assert.deepEqual(
      mayReportDirectMessage({
        actorUserId,
        messageSenderUserId: targetUserId,
        hasEligibleDirectHistory: true,
      }),
      { allowed: true, reason: 'report_allowed' },
    )
    assert.equal(
      mayReportDirectMessage({
        actorUserId,
        messageSenderUserId: actorUserId,
        hasEligibleDirectHistory: true,
      }).allowed,
      false,
    )
    assert.equal(
      mayReportDirectMessage({
        actorUserId,
        messageSenderUserId: targetUserId,
        hasEligibleDirectHistory: false,
      }).allowed,
      false,
    )
  })
})

describe('Contact Authorization safety properties', () => {
  it('denies every person-to-person action for self-target', () => {
    const decision = evaluateContactAuthorization(
      context({ targetUserId: actorUserId, targetFollowsActor: true }),
    )
    assert.equal(decision.reason, 'self_target_invalid')
    assert.deepEqual(decision.capabilities, {
      canSendMessage: false,
      canCreateMessageRequest: false,
      canAccept: false,
      canDecline: false,
      canFollow: false,
      canBlock: false,
      canUnblock: false,
      canReportUser: false,
      mayAccessDirectSocialSurface: false,
      mayDistributeUser: false,
    })
  })

  it('fails closed when the target is unavailable', () => {
    const decision = evaluateContactAuthorization(context({ targetExists: false }))
    assert.equal(decision.reason, 'target_unavailable')
    assert.equal(decision.capabilities.canSendMessage, false)
    assert.equal(decision.capabilities.canCreateMessageRequest, false)
    assert.equal(decision.capabilities.canReportUser, false)
  })

  it('is deterministic and does not mutate a deeply frozen input', () => {
    const input = Object.freeze({
      ...context({ conversation: Object.freeze(conversation('pending')) }),
    })
    const first = evaluateContactAuthorization(input)
    const second = evaluateContactAuthorization(input)
    assert.deepEqual(first, second)
    assert.equal(input.conversation.state, 'pending')
  })

  it('does not reproduce or expose unrelated Favorite disclosure state', () => {
    const baseline = context({ targetMessageRequestPreference: 'followed_members' })
    const withPrivateFavoriteOverlap = {
      ...baseline,
      privateFavoriteOverlap: [{ tmdbId: 550 }],
    }
    assert.deepEqual(
      evaluateContactAuthorization(withPrivateFavoriteOverlap),
      evaluateContactAuthorization(baseline),
    )
    assert.equal(JSON.stringify(evaluateContactAuthorization(baseline)).includes('Favorite'), false)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getContactAuthorizationContext,
  normalizeMessageRequestPreference,
} from '../dist/services/contactAuthorizationContextService.js'
import { evaluateContactAuthorization } from '../dist/utils/contactAuthorizationPolicy.js'

const actorUserId = '64b64c0a4f4c6a2e9c6d1001'
const targetUserId = '64b64c0a4f4c6a2e9c6d1002'
const expectedParticipantKey = [actorUserId, targetUserId].sort().join(':')

const createReaders = (overrides = {}) => ({
  findBlocks: async () => [],
  findConversation: async () => null,
  hasFollow: async () => false,
  findTarget: async () => ({ messageRequestPreference: 'all_members' }),
  ...overrides,
})

describe('Contact Authorization context loader', () => {
  it('loads both directional relationships and preserves conversation identity', async () => {
    const calls = []
    const conversation = Object.freeze({ state: 'pending', initiatedByUserId: actorUserId })
    const blocks = Object.freeze([
      Object.freeze({ blockerUserId: actorUserId, blockedUserId: targetUserId }),
      Object.freeze({ blockerUserId: targetUserId, blockedUserId: actorUserId }),
    ])
    const readers = createReaders({
      findBlocks: async (actor, target) => {
        calls.push(['blocks', actor, target])
        return blocks
      },
      findConversation: async (key) => {
        calls.push(['conversation', key])
        return conversation
      },
      hasFollow: async (follower, following) => {
        calls.push(['follow', follower, following])
        return follower === targetUserId && following === actorUserId
      },
      findTarget: async (target) => {
        calls.push(['target', target])
        return Object.freeze({ messageRequestPreference: 'followed_members' })
      },
    })

    const result = await getContactAuthorizationContext(actorUserId, targetUserId, readers)

    assert.equal(result.actorBlocksTarget, true)
    assert.equal(result.targetBlocksActor, true)
    assert.equal(result.actorFollowsTarget, false)
    assert.equal(result.targetFollowsActor, true)
    assert.equal(result.conversation.state, 'pending')
    assert.equal(result.conversation.initiatedByUserId, actorUserId)
    assert.equal(result.targetMessageRequestPreference, 'followed_members')
    assert.ok(
      calls.some((call) => call[0] === 'conversation' && call[1] === expectedParticipantKey),
    )
    assert.ok(calls.some((call) => call[0] === 'target' && call[1] === targetUserId))
    assert.deepEqual(conversation, { state: 'pending', initiatedByUserId: actorUserId })
    assert.equal(blocks.length, 2)
  })

  it('keeps actor and target Follow directions distinct', async () => {
    const readers = createReaders({
      hasFollow: async (follower, following) =>
        follower === actorUserId && following === targetUserId,
    })
    const result = await getContactAuthorizationContext(actorUserId, targetUserId, readers)
    assert.equal(result.actorFollowsTarget, true)
    assert.equal(result.targetFollowsActor, false)
  })

  for (const [storedValue, expected] of [
    [undefined, 'all_members'],
    ['all_members', 'all_members'],
    ['followed_members', 'followed_members'],
    ['unexpected', 'invalid'],
    [null, 'invalid'],
  ]) {
    it(`normalizes stored preference ${String(storedValue)} to ${expected}`, async () => {
      const readers = createReaders({
        findTarget: async (id) => {
          assert.equal(id, targetUserId)
          return { messageRequestPreference: storedValue }
        },
      })
      const result = await getContactAuthorizationContext(actorUserId, targetUserId, readers)
      assert.equal(result.targetMessageRequestPreference, expected)
      assert.equal(normalizeMessageRequestPreference(storedValue), expected)
      if (storedValue === undefined) {
        assert.equal(evaluateContactAuthorization(result).interactionState, 'request_allowed')
      }
      if (storedValue === 'unexpected') {
        assert.equal(
          evaluateContactAuthorization(result).capabilities.canCreateMessageRequest,
          false,
        )
      }
    })
  }

  it('fails closed for an unavailable target without treating it as legacy preference', async () => {
    const result = await getContactAuthorizationContext(
      actorUserId,
      targetUserId,
      createReaders({ findTarget: async () => null }),
    )
    assert.equal(result.targetExists, false)
    assert.equal(result.targetMessageRequestPreference, 'invalid')
  })

  it('does not perform any read for self-target', async () => {
    let reads = 0
    const unexpectedRead = async () => {
      reads += 1
      throw new Error('self-target must not query')
    }
    const readers = {
      findBlocks: unexpectedRead,
      findConversation: unexpectedRead,
      hasFollow: unexpectedRead,
      findTarget: unexpectedRead,
    }
    const result = await getContactAuthorizationContext(actorUserId, actorUserId, readers)
    assert.equal(reads, 0)
    assert.equal(result.actorUserId, result.targetUserId)
  })
})

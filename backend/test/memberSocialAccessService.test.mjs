import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertMemberSocialPairAccess,
  loadEffectiveBlockedUserIds,
  memberSocialResourceNotFound,
} from '../dist/services/memberSocialAccessService.js'
import { ApiProblem } from '../dist/utils/messagingPolicy.js'

const viewerId = '64b64c0a4f4c6a2e9c6d1001'
const targetId = '64b64c0a4f4c6a2e9c6d1002'

const context = (overrides = {}) => ({
  actorUserId: viewerId,
  targetUserId: targetId,
  targetExists: true,
  actorBlocksTarget: false,
  targetBlocksActor: false,
  actorFollowsTarget: false,
  targetFollowsActor: false,
  targetMessageRequestPreference: 'all_members',
  conversation: null,
  ...overrides,
})

const assertNeutral = async (operation) => {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof ApiProblem)
    assert.equal(error.status, 404)
    assert.equal(error.code, 'RESOURCE_NOT_FOUND')
    assert.equal(error.message, 'Resource not found')
    assert.equal(error.details, undefined)
    return true
  })
}

describe('Stage 11 member-social pair access', () => {
  it('short-circuits self access without loading pair context', async () => {
    let reads = 0
    await assertMemberSocialPairAccess(viewerId, viewerId, async () => {
      reads += 1
      throw new Error('self must not load pair context')
    })
    assert.equal(reads, 0)
  })

  it('allows an existing unrelated pair through the canonical decision', async () => {
    await assert.doesNotReject(() =>
      assertMemberSocialPairAccess(viewerId, targetId, async () => context()),
    )
  })

  it('neutralizes missing targets and both Block directions identically', async () => {
    const deniedContexts = [
      context({ targetExists: false, targetMessageRequestPreference: 'invalid' }),
      context({ actorBlocksTarget: true }),
      context({ targetBlocksActor: true }),
    ]
    for (const deniedContext of deniedContexts) {
      await assertNeutral(() =>
        assertMemberSocialPairAccess(viewerId, targetId, async () => deniedContext),
      )
    }
  })

  it('constructs the exact reusable neutral resource problem', () => {
    const problem = memberSocialResourceNotFound()
    assert.ok(problem instanceof ApiProblem)
    assert.deepEqual(
      { status: problem.status, code: problem.code, message: problem.message },
      { status: 404, code: 'RESOURCE_NOT_FOUND', message: 'Resource not found' },
    )
  })
})

describe('Stage 11 distribution effective Block batch loader', () => {
  it('loads both directions once and returns only unique non-self counterpart IDs', async () => {
    const outgoingId = '64b64c0a4f4c6a2e9c6d1003'
    const incomingId = '64b64c0a4f4c6a2e9c6d1004'
    const reciprocalId = '64b64c0a4f4c6a2e9c6d1005'
    let calls = 0
    let loadedViewerId

    const blockedIds = await loadEffectiveBlockedUserIds(viewerId, async (requestedViewerId) => {
      calls += 1
      loadedViewerId = requestedViewerId
      return [
        { blockerUserId: viewerId, blockedUserId: outgoingId },
        { blockerUserId: incomingId, blockedUserId: viewerId },
        { blockerUserId: viewerId, blockedUserId: reciprocalId },
        { blockerUserId: reciprocalId, blockedUserId: viewerId },
        { blockerUserId: viewerId, blockedUserId: viewerId },
      ]
    })

    assert.equal(calls, 1)
    assert.equal(loadedViewerId, viewerId)
    assert.ok(blockedIds instanceof Set)
    assert.deepEqual([...blockedIds].sort(), [incomingId, outgoingId, reciprocalId].sort())
    assert.equal(blockedIds.has(viewerId), false)
    assert.equal(
      [...blockedIds].some((value) =>
        ['blockerUserId', 'blockedUserId', 'direction', 'blockedByViewer'].includes(value),
      ),
      false,
    )
  })
})

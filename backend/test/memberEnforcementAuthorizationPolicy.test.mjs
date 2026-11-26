import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { User } from '../dist/models/userModel.js'
import {
  MEMBER_ENFORCEMENT_PERMISSION,
  assertMemberEnforcementAuthorized,
  deriveMemberEnforcementCapabilities,
} from '../dist/policies/memberEnforcementAuthorizationPolicy.js'

const evaluatedAt = new Date('2035-09-01T00:00:00.000Z')
const activeState = () => ({
  status: 'active',
  evaluatedAt,
  governingDecisionId: null,
  activeRestrictionDecisionIds: [],
  restrictionEndsAt: null,
})
const identity = (memberEnforcementEnabled = true, role = 'admin') => ({
  _id: '507f1f77bcf86cd799439011',
  role,
  memberEnforcementEnabled,
})

describe('Member Enforcement authorization', () => {
  it('uses the independent members:enforce permission name', () => {
    assert.equal(MEMBER_ENFORCEMENT_PERMISSION, 'members:enforce')
  })

  it('fails closed for missing, false, invalid, legacy-hydrated, and non-Admin values', async () => {
    for (const raw of [
      { role: 'admin' },
      { role: 'admin', memberEnforcementEnabled: false },
      { role: 'admin', memberEnforcementEnabled: null },
      { role: 'admin', memberEnforcementEnabled: 'true' },
      { role: 'admin', memberEnforcementEnabled: 1 },
      { role: 'user', memberEnforcementEnabled: true },
    ]) {
      const actor = User.hydrate({ _id: identity()._id, ...raw })
      if (raw.role === 'admin') assert.notEqual(actor.memberEnforcementEnabled, true)
      assert.deepEqual(
        await deriveMemberEnforcementCapabilities(actor, evaluatedAt, async () => activeState()),
        { enforceMembers: false },
      )
      await assert.rejects(
        assertMemberEnforcementAuthorized(actor, evaluatedAt, async () => activeState()),
        (error) => error?.status === 403 && error?.code === 'MEMBER_ENFORCEMENT_FORBIDDEN',
      )
    }
  })

  it('accepts only explicit true with an active, consistent account state', async () => {
    assert.deepEqual(
      await deriveMemberEnforcementCapabilities(identity(), evaluatedAt, async () => activeState()),
      { enforceMembers: true },
    )
    await assert.doesNotReject(
      assertMemberEnforcementAuthorized(identity(), evaluatedAt, async () => activeState()),
    )

    const stale = { ...activeState(), evaluatedAt: new Date(evaluatedAt.valueOf() - 1) }
    assert.deepEqual(
      await deriveMemberEnforcementCapabilities(identity(), evaluatedAt, async () => stale),
      { enforceMembers: false },
    )
    assert.deepEqual(
      await deriveMemberEnforcementCapabilities(identity(), evaluatedAt, async () => {
        throw new Error('unavailable')
      }),
      { enforceMembers: false },
    )
  })
})

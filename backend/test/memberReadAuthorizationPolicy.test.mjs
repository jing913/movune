import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertMemberReadAuthorized,
  deriveMemberReadCapabilities,
  isMemberReadAuthorized,
} from '../dist/policies/memberReadAuthorizationPolicy.js'

const evaluatedAt = new Date('2035-08-01T00:00:00.000Z')
const identity = (role = 'admin', extra = {}) => ({
  _id: '507f1f77bcf86cd799439011',
  role,
  ...extra,
})
const state = (status) => ({
  status,
  evaluatedAt,
  governingDecisionId: null,
  activeRestrictionDecisionIds: [],
  restrictionEndsAt: null,
})

describe('D-ADM-01 Members Read authorization policy', () => {
  it('requires both admin role and active effective account status', () => {
    assert.equal(isMemberReadAuthorized(identity('admin'), state('active')), true)
    assert.equal(isMemberReadAuthorized(identity('user'), state('active')), false)
    assert.equal(isMemberReadAuthorized(identity('admin'), state('suspended')), false)
    assert.equal(isMemberReadAuthorized(identity('admin'), state('deactivated')), false)
    assert.equal(isMemberReadAuthorized(identity('admin'), null), false)
    assert.equal(isMemberReadAuthorized(undefined, state('active')), false)
  })

  it('does not consult status evidence for a non-admin or trust forged capabilities', async () => {
    let calls = 0
    const capabilities = await deriveMemberReadCapabilities(
      identity('user', { capabilities: { viewMembers: true } }),
      evaluatedAt,
      async () => {
        calls += 1
        return state('active')
      },
    )
    assert.deepEqual(capabilities, { viewMembers: false })
    assert.equal(calls, 0)
  })

  it('derives viewMembers only from authoritative loaded state', async () => {
    assert.deepEqual(
      await deriveMemberReadCapabilities(identity(), evaluatedAt, async () => state('active')),
      { viewMembers: true },
    )
    assert.deepEqual(
      await deriveMemberReadCapabilities(identity(), evaluatedAt, async () => state('suspended')),
      { viewMembers: false },
    )
  })

  it('fails closed when enforcement evidence is missing, corrupt, or indeterminate', async () => {
    const unavailable = async () => {
      throw new Error('ACCOUNT_ENFORCEMENT_HISTORY_INVALID')
    }
    assert.deepEqual(await deriveMemberReadCapabilities(identity(), evaluatedAt, unavailable), {
      viewMembers: false,
    })
    await assert.rejects(
      assertMemberReadAuthorized(identity(), evaluatedAt, unavailable),
      (error) => error?.status === 403 && error?.code === 'MEMBERS_READ_FORBIDDEN',
    )
  })

  it('permits an active admin and rejects every other effective state', async () => {
    await assert.doesNotReject(
      assertMemberReadAuthorized(identity(), evaluatedAt, async () => state('active')),
    )
    for (const status of ['suspended', 'deactivated']) {
      await assert.rejects(
        assertMemberReadAuthorized(identity(), evaluatedAt, async () => state(status)),
        (error) => error?.status === 403,
      )
    }
  })
})

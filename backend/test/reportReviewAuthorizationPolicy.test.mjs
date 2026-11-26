import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  REPORT_REVIEW_PERMISSION,
  assertReportReviewAuthorized,
  deriveReportReviewCapabilities,
  isReportReviewAuthorized,
} from '../dist/policies/reportReviewAuthorizationPolicy.js'

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

describe('Admin Report Review authorization foundation', () => {
  it('uses an independent resource/job permission identifier', () => {
    assert.equal(REPORT_REVIEW_PERMISSION, 'reports:review')
    assert.notEqual(REPORT_REVIEW_PERMISSION, 'members:read')
  })

  it('requires both Admin identity and active effective account status', () => {
    assert.equal(isReportReviewAuthorized(identity('admin'), state('active')), true)
    assert.equal(isReportReviewAuthorized(identity('user'), state('active')), false)
    assert.equal(isReportReviewAuthorized(identity('admin'), state('suspended')), false)
    assert.equal(isReportReviewAuthorized(identity('admin'), state('deactivated')), false)
    assert.equal(isReportReviewAuthorized(identity('admin'), null), false)
    assert.equal(isReportReviewAuthorized(identity('admin'), undefined), false)
    assert.equal(isReportReviewAuthorized(undefined, state('active')), false)
  })

  it('does not consult status evidence for a non-Admin or trust forged capabilities', async () => {
    let calls = 0
    const capabilities = await deriveReportReviewCapabilities(
      identity('user', {
        capabilities: {
          viewReports: true,
          viewMembers: true,
          manageAnnouncements: true,
          enforceMembers: true,
        },
      }),
      evaluatedAt,
      async () => {
        calls += 1
        return state('active')
      },
    )

    assert.deepEqual(capabilities, { viewReports: false })
    assert.equal(calls, 0)
  })

  it('derives only viewReports from authoritative effective account state', async () => {
    assert.deepEqual(
      await deriveReportReviewCapabilities(identity(), evaluatedAt, async () => state('active')),
      { viewReports: true },
    )
    for (const status of ['suspended', 'deactivated']) {
      assert.deepEqual(
        await deriveReportReviewCapabilities(identity(), evaluatedAt, async () => state(status)),
        { viewReports: false },
      )
    }

    const capabilities = await deriveReportReviewCapabilities(identity(), evaluatedAt, async () =>
      state('active'),
    )
    assert.deepEqual(Object.keys(capabilities), ['viewReports'])
    assert.equal('viewMembers' in capabilities, false)
    assert.equal('manageAnnouncements' in capabilities, false)
    assert.equal('enforceMembers' in capabilities, false)
  })

  it('fails closed for missing, malformed, corrupt, or unavailable evidence', async () => {
    const unavailable = async () => {
      throw new Error('ACCOUNT_ENFORCEMENT_HISTORY_INVALID')
    }
    const malformed = async () => ({ status: 'active' })
    const contradictory = async () => ({
      ...state('active'),
      governingDecisionId: 'unexpected-decision',
      activeRestrictionDecisionIds: ['unexpected-decision'],
    })
    const stale = async () => ({
      ...state('active'),
      evaluatedAt: new Date(evaluatedAt.valueOf() - 1),
    })

    assert.deepEqual(await deriveReportReviewCapabilities(undefined, evaluatedAt, unavailable), {
      viewReports: false,
    })
    assert.deepEqual(await deriveReportReviewCapabilities(identity(), evaluatedAt, unavailable), {
      viewReports: false,
    })
    assert.deepEqual(await deriveReportReviewCapabilities(identity(), evaluatedAt, malformed), {
      viewReports: false,
    })
    assert.deepEqual(await deriveReportReviewCapabilities(identity(), evaluatedAt, contradictory), {
      viewReports: false,
    })
    assert.deepEqual(await deriveReportReviewCapabilities(identity(), evaluatedAt, stale), {
      viewReports: false,
    })

    for (const user of [undefined, null, identity('user'), identity('admin')]) {
      await assert.rejects(
        assertReportReviewAuthorized(user, evaluatedAt, unavailable),
        (error) => error?.status === 403 && error?.code === 'REPORT_REVIEW_FORBIDDEN',
      )
    }
  })

  it('permits an active Admin and rejects all other supported effective states', async () => {
    await assert.doesNotReject(
      assertReportReviewAuthorized(identity(), evaluatedAt, async () => state('active')),
    )
    for (const status of ['suspended', 'deactivated']) {
      await assert.rejects(
        assertReportReviewAuthorized(identity(), evaluatedAt, async () => state(status)),
        (error) => error?.status === 403 && error?.code === 'REPORT_REVIEW_FORBIDDEN',
      )
    }
  })
})

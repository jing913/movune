import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import {
  REPORT_DETAIL_REPORTED_MEMBER_PROJECTION,
  REPORT_DETAIL_REPORTER_PROJECTION,
  REPORT_DETAIL_SOURCE_PROJECTION,
  getAdminReportDetail,
} from '../dist/services/adminReportDetailReadService.js'

const objectId = (suffix) => new Types.ObjectId(`0000000000000000000000${suffix}`)
const evaluatedAt = new Date('2035-08-15T12:00:00.000Z')

const report = (overrides = {}) => ({
  _id: objectId('21'),
  reason: 'harassment_or_uncomfortable',
  description: 'Submitted description',
  sourceType: 'direct_message',
  reporterUserId: objectId('31'),
  reportedUserId: objectId('11'),
  createdAt: new Date('2035-08-01T09:00:00.000Z'),
  messageId: objectId('41'),
  messageEvidence: { content: 'private-message-must-not-leak' },
  conversationId: objectId('51'),
  ...overrides,
})

const reportedMember = (overrides = {}) => ({
  _id: objectId('11'),
  account: 'reported-account',
  displayName: 'Reported Member',
  avatar: '/avatar.png',
  email: 'must-not-leak@example.com',
  bio: 'must-not-leak',
  ...overrides,
})

const reporter = (overrides = {}) => ({
  _id: objectId('31'),
  account: 'reporter-account',
  displayName: 'Reporter',
  avatar: '/reporter-avatar-must-not-load.png',
  email: 'must-not-leak@example.com',
  ...overrides,
})

const activeState = (at = evaluatedAt) => ({
  status: 'active',
  evaluatedAt: at,
  governingDecisionId: null,
  activeRestrictionDecisionIds: [],
  restrictionEndsAt: null,
})

const repository = (values = {}, calls = []) => ({
  async findReport(id, projection) {
    calls.push({ operation: 'findReport', id, projection })
    return values.report ?? null
  },
  async findReportedMember(id, projection) {
    calls.push({ operation: 'findReportedMember', id, projection })
    return values.reportedMember ?? null
  },
  async findReporter(id, projection) {
    calls.push({ operation: 'findReporter', id, projection })
    return values.reporter ?? null
  },
})

describe('Admin Report Detail read service', () => {
  it('returns the exact metadata contract and never loads or serializes evidence fields', async () => {
    const calls = []
    const result = await getAdminReportDetail(objectId('21').toString(), evaluatedAt, {
      repository: repository(
        { report: report(), reportedMember: reportedMember(), reporter: reporter() },
        calls,
      ),
      loadAccountState: async () => activeState(),
    })

    assert.deepEqual(Object.keys(result).sort(), ['report', 'reportedMember', 'reporter'])
    assert.deepEqual(result, {
      report: {
        id: objectId('21').toString(),
        reason: 'harassment_or_uncomfortable',
        description: 'Submitted description',
        sourceType: 'direct_message',
        submittedAt: '2035-08-01T09:00:00.000Z',
      },
      reportedMember: {
        avatar: '/avatar.png',
        displayName: { status: 'available', value: 'Reported Member' },
        account: { status: 'available', value: 'reported-account' },
        effectiveAccountStatus: { status: 'available', value: 'active' },
      },
      reporter: {
        displayName: { status: 'available', value: 'Reporter' },
        account: { status: 'available', value: 'reporter-account' },
      },
    })
    assert.equal(calls[0].projection, REPORT_DETAIL_SOURCE_PROJECTION)
    assert.equal(calls[1].projection, REPORT_DETAIL_REPORTED_MEMBER_PROJECTION)
    assert.equal(calls[2].projection, REPORT_DETAIL_REPORTER_PROJECTION)
    assert.equal(REPORT_DETAIL_SOURCE_PROJECTION.includes('message'), false)
    assert.equal(REPORT_DETAIL_SOURCE_PROJECTION.includes('conversation'), false)
    const serialized = JSON.stringify(result)
    for (const forbidden of [
      'messageEvidence',
      'messageId',
      'conversationId',
      'reporterUserId',
      'reportedUserId',
      'private-message-must-not-leak',
      'email',
      'bio',
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden)
    }
  })

  it('omits Description when it was not submitted', async () => {
    const result = await getAdminReportDetail(objectId('21').toString(), evaluatedAt, {
      repository: repository({
        report: report({ description: undefined }),
        reportedMember: reportedMember(),
        reporter: reporter(),
      }),
      loadAccountState: async () => activeState(),
    })
    assert.equal('description' in result.report, false)
  })

  it('preserves the Report with explicit missing Reporter and Reported Member states', async () => {
    let statusLoads = 0
    const result = await getAdminReportDetail(objectId('21').toString(), evaluatedAt, {
      repository: repository({ report: report() }),
      loadAccountState: async () => {
        statusLoads += 1
        return activeState()
      },
    })
    assert.deepEqual(result.reportedMember, {
      avatar: null,
      displayName: { status: 'missing', value: null },
      account: { status: 'missing', value: null },
      effectiveAccountStatus: { status: 'unavailable', value: null },
    })
    assert.deepEqual(result.reporter, {
      displayName: { status: 'missing', value: null },
      account: { status: 'missing', value: null },
    })
    assert.equal(statusLoads, 0)
    assert.equal(JSON.stringify(result).includes(objectId('11').toString()), false)
    assert.equal(JSON.stringify(result).includes(objectId('31').toString()), false)
  })

  it('derives current effective status and reports corrupt or unavailable evidence as unavailable', async () => {
    const base = {
      repository: repository({
        report: report(),
        reportedMember: reportedMember(),
        reporter: reporter(),
      }),
    }
    const suspended = await getAdminReportDetail(objectId('21').toString(), evaluatedAt, {
      ...base,
      loadAccountState: async () => ({
        status: 'suspended',
        evaluatedAt,
        governingDecisionId: 'decision-1',
        activeRestrictionDecisionIds: ['decision-1'],
        restrictionEndsAt: new Date('2035-09-01T00:00:00.000Z'),
      }),
    })
    assert.deepEqual(suspended.reportedMember.effectiveAccountStatus, {
      status: 'available',
      value: 'suspended',
    })

    for (const loadAccountState of [
      async () => ({
        status: 'active',
        evaluatedAt,
        governingDecisionId: 'contradictory',
        activeRestrictionDecisionIds: [],
        restrictionEndsAt: null,
      }),
      async () => {
        throw new Error('history unavailable')
      },
    ]) {
      const result = await getAdminReportDetail(objectId('21').toString(), evaluatedAt, {
        ...base,
        loadAccountState,
      })
      assert.deepEqual(result.reportedMember.effectiveAccountStatus, {
        status: 'unavailable',
        value: null,
      })
    }
  })

  it('validates the Report id before repository access and handles absent or malformed records', async () => {
    const calls = []
    await assert.rejects(
      () =>
        getAdminReportDetail('not-an-id', evaluatedAt, {
          repository: repository({}, calls),
        }),
      (error) => error?.status === 400 && error?.code === 'ADMIN_REPORT_ID_INVALID',
    )
    assert.equal(calls.length, 0)

    await assert.rejects(
      () =>
        getAdminReportDetail(objectId('21').toString(), evaluatedAt, {
          repository: repository({}),
        }),
      (error) => error?.status === 404 && error?.code === 'ADMIN_REPORT_NOT_FOUND',
    )
    await assert.rejects(
      () =>
        getAdminReportDetail(objectId('21').toString(), evaluatedAt, {
          repository: repository({ report: report({ reason: 'invented' }) }),
        }),
      (error) =>
        error?.status === 500 &&
        error?.code === 'ADMIN_REPORT_DETAIL_DATA_INVALID' &&
        !JSON.stringify(error).includes('Submitted description'),
    )
  })
})

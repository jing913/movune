import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import {
  ADMIN_CASE_DECISION_PROJECTION,
  ADMIN_CASE_DETAIL_PROJECTION,
  ADMIN_CASE_MEMBER_PROJECTION,
  decodeAdminCaseQueueCursor,
  encodeAdminCaseQueueCursor,
  getAdminCaseDetail,
  listAdminCases,
  parseAdminCaseQueueQuery,
} from '../dist/services/adminCaseReadService.js'
import { ApiProblem } from '../dist/utils/messagingPolicy.js'

const objectId = (suffix) => new Types.ObjectId(`c07f1f77bcf86cd7994390${suffix}`)
const evaluatedAt = new Date('2035-08-15T12:00:00.000Z')

const report = (suffix, reviewCases = [], overrides = {}) => ({
  _id: objectId(suffix),
  reason: 'other',
  sourceType: 'direct_message',
  reportedUserId: objectId('11'),
  createdAt: new Date(`2035-08-${suffix}T12:00:00.000Z`),
  reviewCases,
  reviewDecisions: [],
  reporterUserId: objectId('12'),
  description: 'must-not-leak',
  messageEvidence: { content: 'private-message-must-not-leak' },
  conversationId: objectId('13'),
  ...overrides,
})

const reviewCase = (reportId, state = 'under_review', overrides = {}) => ({
  _id: objectId(state === 'under_review' ? '31' : '32'),
  reportId,
  state,
  reviewStartedByUserId: objectId('91'),
  reviewStartedAt: new Date('2035-08-10T09:00:00.000Z'),
  ...(state === 'review_completed'
    ? {
        decisionId: objectId('41'),
        completedAt: new Date('2035-08-11T10:00:00.000Z'),
        revision: 2,
      }
    : { revision: 1 }),
  ...overrides,
})

const decision = (caseValue, overrides = {}) => ({
  _id: caseValue.decisionId,
  caseId: caseValue._id,
  reportId: caseValue.reportId,
  conclusion: 'insufficient_evidence',
  rationale: 'The submitted evidence is insufficient.',
  reviewStartedByUserId: caseValue.reviewStartedByUserId,
  decidedByUserId: objectId('92'),
  decidedAt: caseValue.completedAt,
  caseRevision: 2,
  evidence: 'must-not-leak',
  ...overrides,
})

const reportDetail = (reportId) => ({
  report: {
    id: reportId.toString(),
    reason: 'other',
    description: 'Submitted description',
    sourceType: 'direct_message',
    submittedAt: '2035-08-01T09:00:00.000Z',
  },
  reportedMember: {
    avatar: null,
    displayName: { status: 'available', value: 'Reported Member' },
    account: { status: 'available', value: 'reported-account' },
    effectiveAccountStatus: { status: 'available', value: 'active' },
  },
  reporter: {
    displayName: { status: 'available', value: 'Reporter' },
    account: { status: 'available', value: 'reporter-account' },
  },
})

const repository = (
  { queue = [], members = [], persistedCase = null, persistedDecisions = [] } = {},
  calls = [],
) => ({
  async findCaseQueue(cursor, state, limit) {
    calls.push({ operation: 'queue', cursor, state, limit })
    return queue
  },
  async findReportedMembers(ids, projection) {
    calls.push({ operation: 'members', ids, projection })
    return members
  },
  async findCaseByReportId(reportId, projection) {
    calls.push({ operation: 'case', reportId, projection })
    return persistedCase
  },
  async findDecisionsByReportId(reportId, projection) {
    calls.push({ operation: 'decisions', reportId, projection })
    return persistedDecisions
  },
})

describe('Admin Case read service', () => {
  it('parses exact queue controls and round-trips the bounded cursor', () => {
    const cursor = encodeAdminCaseQueueCursor({
      submittedAt: new Date('2035-08-20T12:00:00.000Z'),
      id: objectId('21'),
    })
    assert.deepEqual(parseAdminCaseQueueQuery({ cursor, limit: '50', state: 'under_review' }), {
      cursor: decodeAdminCaseQueueCursor(cursor),
      limit: 50,
      state: 'under_review',
    })
    assert.deepEqual(parseAdminCaseQueueQuery({}), { cursor: null, limit: 20, state: null })
  })

  it('rejects malformed, repeated, structured, unknown, and out-of-range controls', () => {
    for (const query of [
      { limit: ['10', '20'] },
      { limit: { $gt: 0 } },
      { limit: '0' },
      { limit: '51' },
      { limit: '1.5' },
      { state: ['needs_review'] },
      { state: 'resolved' },
      { cursor: 'not-a-canonical-cursor' },
      { sort: 'state' },
    ]) {
      assert.throws(
        () => parseAdminCaseQueueQuery(query),
        (error) => error?.status === 400 && error?.code === 'ADMIN_CASE_QUEUE_QUERY_INVALID',
      )
    }
  })

  it('maps absent, under-review, and completed persistence to strict queue DTOs', async () => {
    const needs = report('21')
    const under = report('22')
    under.reviewCases = [reviewCase(under._id)]
    const completed = report('23')
    completed.reviewCases = [reviewCase(completed._id, 'review_completed')]
    completed.reviewDecisions = [decision(completed.reviewCases[0])]
    const calls = []
    const result = await listAdminCases(
      { cursor: null, limit: 3, state: null },
      {
        repository: repository(
          {
            queue: [needs, under, completed],
            members: [
              {
                _id: objectId('11'),
                account: 'reported-account',
                displayName: 'Reported Member',
                email: 'must-not-leak@example.com',
              },
            ],
          },
          calls,
        ),
      },
    )

    assert.deepEqual(
      result.cases.map((value) => [value.case.state, value.case.revision]),
      [
        ['needs_review', 0],
        ['under_review', 1],
        ['review_completed', 2],
      ],
    )
    assert.deepEqual(Object.keys(result.cases[0]).sort(), ['case', 'report'])
    assert.deepEqual(Object.keys(result.cases[0].report).sort(), [
      'id',
      'reason',
      'reportedMemberAccount',
      'reportedMemberDisplayName',
      'sourceType',
      'submittedAt',
    ])
    assert.deepEqual(Object.keys(result.cases[0].case).sort(), [
      'completedAt',
      'id',
      'reportId',
      'reviewStartedAt',
      'revision',
      'state',
    ])
    assert.equal(calls[0].limit, 4)
    assert.equal(calls[1].projection, ADMIN_CASE_MEMBER_PROJECTION)
    const serialized = JSON.stringify(result)
    for (const forbidden of [
      'reporterUserId',
      'reportedUserId',
      'description',
      'messageEvidence',
      'private-message-must-not-leak',
      'conversationId',
      'rationale',
      'reviewStartedByUserId',
      'decisionId',
      'email',
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden)
    }
  })

  it('passes state and cursor boundaries to the repository and emits a stable next cursor', async () => {
    const first = report('21')
    const second = report('22')
    const calls = []
    const cursor = {
      submittedAt: new Date('2035-08-25T00:00:00.000Z'),
      id: objectId('29'),
    }
    const result = await listAdminCases(
      { cursor, limit: 1, state: 'needs_review' },
      { repository: repository({ queue: [first, second] }, calls) },
    )
    assert.equal(calls[0].state, 'needs_review')
    assert.deepEqual(calls[0].cursor, cursor)
    assert.equal(result.cases.length, 1)
    assert.equal(result.pagination.hasMore, true)
    assert.deepEqual(decodeAdminCaseQueueCursor(result.pagination.nextCursor), {
      submittedAt: first.createdAt,
      id: first._id,
    })
  })

  it('fails closed for orphaned, missing, duplicate, and contradictory queue Decisions', async () => {
    const noCase = report('21')
    const orphanCase = reviewCase(noCase._id, 'review_completed')
    noCase.reviewDecisions = [decision(orphanCase)]

    const under = report('22')
    const underCase = reviewCase(under._id)
    under.reviewCases = [underCase]
    under.reviewDecisions = [decision(reviewCase(under._id, 'review_completed'))]

    const missing = report('23')
    missing.reviewCases = [reviewCase(missing._id, 'review_completed')]

    const mismatch = report('24')
    const mismatchCase = reviewCase(mismatch._id, 'review_completed')
    mismatch.reviewCases = [mismatchCase]
    mismatch.reviewDecisions = [decision(mismatchCase, { reportId: objectId('25') })]

    const duplicate = report('25')
    const duplicateCase = reviewCase(duplicate._id, 'review_completed')
    duplicate.reviewCases = [duplicateCase]
    duplicate.reviewDecisions = [decision(duplicateCase), decision(duplicateCase)]

    const malformed = report('26', [], { _id: objectId('26').toString() })

    for (const source of [noCase, under, missing, mismatch, duplicate, malformed]) {
      await assert.rejects(
        () =>
          listAdminCases(
            { cursor: null, limit: 20, state: null },
            { repository: repository({ queue: [source] }) },
          ),
        (error) => error?.status === 500 && error?.code === 'ADMIN_CASE_DATA_INVALID',
      )
    }
  })

  it('returns exact needs-review and under-review detail after verifying Decision absence', async () => {
    for (const persistedCase of [null, reviewCase(objectId('21'))]) {
      const calls = []
      const result = await getAdminCaseDetail(objectId('21').toString(), evaluatedAt, {
        repository: repository({ persistedCase }, calls),
        loadReportDetail: async (id, at) => {
          assert.equal(id, objectId('21').toString())
          assert.equal(at, evaluatedAt)
          return reportDetail(objectId('21'))
        },
      })
      assert.equal(result.case.state, persistedCase ? 'under_review' : 'needs_review')
      assert.equal(result.decision, null)
      assert.equal(calls.some((call) => call.operation === 'decisions'), true)
      assert.equal(calls[0].projection, ADMIN_CASE_DETAIL_PROJECTION)
      assert.equal(JSON.stringify(result).includes('messageEvidence'), false)
      assert.equal(JSON.stringify(result).includes('conversationId'), false)
    }
  })

  it('returns only the permitted immutable decision fields for a valid completed Case', async () => {
    const persistedCase = reviewCase(objectId('21'), 'review_completed')
    const calls = []
    const result = await getAdminCaseDetail(objectId('21').toString(), evaluatedAt, {
      repository: repository(
        { persistedCase, persistedDecisions: [decision(persistedCase)] },
        calls,
      ),
      loadReportDetail: async () => reportDetail(objectId('21')),
    })
    assert.deepEqual(Object.keys(result.decision).sort(), [
      'caseRevision',
      'conclusion',
      'decidedAt',
      'decidedByUserId',
      'id',
      'rationale',
    ])
    assert.equal(result.decision.conclusion, 'insufficient_evidence')
    assert.equal(calls.at(-1).projection, ADMIN_CASE_DECISION_PROJECTION)
    assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
  })

  it('fails closed for invalid IDs and corrupt Case or Decision relationships', async () => {
    let detailLoads = 0
    await assert.rejects(
      () =>
        getAdminCaseDetail('not-an-id', evaluatedAt, {
          repository: repository(),
          loadReportDetail: async () => {
            detailLoads += 1
          },
        }),
      (error) => error?.status === 400 && error?.code === 'ADMIN_CASE_REPORT_ID_INVALID',
    )
    assert.equal(detailLoads, 0)

    const completed = reviewCase(objectId('21'), 'review_completed')
    const corruptCases = [
      { persistedCase: reviewCase(objectId('21'), 'under_review', { revision: 2 }) },
      { persistedCase: reviewCase(objectId('22')) },
      { persistedCase: completed, persistedDecisions: [] },
      {
        persistedCase: completed,
        persistedDecisions: [decision(completed, { reportId: objectId('22') })],
      },
      {
        persistedCase: completed,
        persistedDecisions: [decision(completed, { caseRevision: 1 })],
      },
      { persistedCase: null, persistedDecisions: [decision(completed)] },
      {
        persistedCase: reviewCase(objectId('21')),
        persistedDecisions: [decision(completed)],
      },
      {
        persistedCase: completed,
        persistedDecisions: [decision(completed), decision(completed)],
      },
      {
        persistedCase: reviewCase(objectId('21'), 'under_review', {
          reportId: objectId('21').toString(),
        }),
      },
    ]
    for (const values of corruptCases) {
      await assert.rejects(
        () =>
          getAdminCaseDetail(objectId('21').toString(), evaluatedAt, {
            repository: repository(values),
            loadReportDetail: async () => reportDetail(objectId('21')),
          }),
        (error) => error?.status === 500 && error?.code === 'ADMIN_CASE_DATA_INVALID',
      )
    }
  })

  it('preserves missing Report handling from the existing Report Detail service', async () => {
    await assert.rejects(
      () =>
        getAdminCaseDetail(objectId('21').toString(), evaluatedAt, {
          repository: repository(),
          loadReportDetail: async () => {
            throw new ApiProblem(404, 'ADMIN_REPORT_NOT_FOUND', 'Report not found')
          },
        }),
      (error) => error?.status === 404 && error?.code === 'ADMIN_REPORT_NOT_FOUND',
    )
  })
})

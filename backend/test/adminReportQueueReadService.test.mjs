import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import {
  REPORT_QUEUE_MEMBER_PROJECTION,
  REPORT_QUEUE_SORT,
  REPORT_QUEUE_SOURCE_PROJECTION,
  buildAdminReportQueueFilter,
  decodeAdminReportQueueCursor,
  encodeAdminReportQueueCursor,
  listAdminReportQueue,
  parseAdminReportQueueQuery,
} from '../dist/services/adminReportQueueReadService.js'

const objectId = (suffix) => new Types.ObjectId(`0000000000000000000000${suffix}`)
const submittedAt = new Date('2035-08-15T12:00:00.000Z')

const report = (suffix, memberSuffix, overrides = {}) => ({
  _id: objectId(suffix),
  reason: 'harassment_or_uncomfortable',
  sourceType: 'direct_message',
  reportedUserId: objectId(memberSuffix),
  createdAt: submittedAt,
  reporterUserId: objectId('91'),
  description: 'must-not-leak',
  messageId: objectId('81'),
  conversationId: objectId('82'),
  messageEvidence: { content: 'private-message-must-not-leak' },
  ...overrides,
})

const member = (suffix, overrides = {}) => ({
  _id: objectId(suffix),
  account: `member-${suffix}`,
  displayName: `Member ${suffix}`,
  email: 'must-not-leak@example.com',
  password: 'must-not-leak',
  ...overrides,
})

const repository = (reports, members, calls = []) => ({
  async findReports(filter, projection, sort, limit) {
    calls.push({ operation: 'findReports', filter, projection, sort, limit })
    return reports
  },
  async findReportedMembers(ids, projection) {
    calls.push({ operation: 'findReportedMembers', ids, projection })
    return members
  },
})

describe('Admin Report Queue read service', () => {
  it('returns exactly the six approved business fields and strips every private source field', async () => {
    const calls = []
    const result = await listAdminReportQueue(parseAdminReportQueueQuery({ limit: '20' }), {
      repository: repository([report('31', '11')], [member('11')], calls),
    })

    assert.deepEqual(Object.keys(result.reports[0]).sort(), [
      'id',
      'reason',
      'reportedMemberAccount',
      'reportedMemberDisplayName',
      'sourceType',
      'submittedAt',
    ])
    assert.deepEqual(result.reports[0], {
      id: objectId('31').toString(),
      reason: 'harassment_or_uncomfortable',
      sourceType: 'direct_message',
      reportedMemberDisplayName: { status: 'available', value: 'Member 11' },
      reportedMemberAccount: { status: 'available', value: 'member-11' },
      submittedAt: submittedAt.toISOString(),
    })
    const serialized = JSON.stringify(result)
    for (const forbidden of [
      'reporterUserId',
      'reportedUserId',
      'description',
      'messageEvidence',
      'messageId',
      'conversationId',
      'private-message-must-not-leak',
      'email',
      'password',
      'severity',
      'risk',
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden)
    }
    assert.equal('status' in result.reports[0], false)
    assert.equal(calls[0].projection, REPORT_QUEUE_SOURCE_PROJECTION)
    assert.equal(calls[1].projection, REPORT_QUEUE_MEMBER_PROJECTION)
    assert.equal(REPORT_QUEUE_SOURCE_PROJECTION.includes('reporterUserId'), false)
    assert.equal(REPORT_QUEUE_SOURCE_PROJECTION.includes('message'), false)
    assert.equal(REPORT_QUEUE_MEMBER_PROJECTION.includes('email'), false)
  })

  it('uses newest-first deterministic ordering and an opaque exclusive cursor', async () => {
    const calls = []
    const result = await listAdminReportQueue(parseAdminReportQueueQuery({ limit: '2' }), {
      repository: repository(
        [report('33', '11'), report('22', '12'), report('11', '13')],
        [member('11'), member('12')],
        calls,
      ),
    })
    assert.deepEqual(calls[0].sort, REPORT_QUEUE_SORT)
    assert.deepEqual(calls[0].sort, { createdAt: -1, _id: -1 })
    assert.equal(calls[0].limit, 3)
    assert.deepEqual(
      result.reports.map(({ id }) => id),
      [objectId('33').toString(), objectId('22').toString()],
    )
    assert.deepEqual(result.pagination, {
      limit: 2,
      hasMore: true,
      nextCursor: encodeAdminReportQueueCursor({ submittedAt, id: objectId('22') }),
    })

    const decoded = decodeAdminReportQueueCursor(result.pagination.nextCursor)
    assert.deepEqual(buildAdminReportQueueFilter(decoded), {
      $or: [
        { createdAt: { $lt: submittedAt } },
        { createdAt: submittedAt, _id: { $lt: objectId('22') } },
      ],
    })
  })

  it('preserves rows whose reported member is missing with explicit non-fabricated states', async () => {
    const result = await listAdminReportQueue(parseAdminReportQueueQuery({}), {
      repository: repository([report('31', '11')], []),
    })
    assert.deepEqual(result.reports[0].reportedMemberDisplayName, {
      status: 'missing',
      value: null,
    })
    assert.deepEqual(result.reports[0].reportedMemberAccount, {
      status: 'missing',
      value: null,
    })
    assert.equal(JSON.stringify(result).includes(objectId('11').toString()), false)
  })

  it('falls back to the existing account identity only for an existing member without a display name', async () => {
    const result = await listAdminReportQueue(parseAdminReportQueueQuery({}), {
      repository: repository([report('31', '11')], [member('11', { displayName: '  ' })]),
    })
    assert.deepEqual(result.reports[0].reportedMemberDisplayName, {
      status: 'available',
      value: 'member-11',
    })
  })

  it('validates bounded query input and rejects filters, sorting, arrays, and injection-like values', () => {
    assert.deepEqual(parseAdminReportQueueQuery({}), { cursor: null, limit: 20 })
    assert.equal(parseAdminReportQueueQuery({ limit: '50' }).limit, 50)

    const validCursor = encodeAdminReportQueueCursor({ submittedAt, id: objectId('31') })
    assert.equal(
      parseAdminReportQueueQuery({ cursor: validCursor }).cursor.id.toString(),
      objectId('31').toString(),
    )

    for (const invalid of [
      { limit: '0' },
      { limit: '51' },
      { limit: '-1' },
      { limit: '1.5' },
      { limit: { $gt: 0 } },
      { limit: ['20'] },
      { cursor: 'not-a-cursor' },
      { cursor: { $ne: null } },
      { sort: 'createdAt' },
      { status: 'pending' },
      { severity: 'high' },
      { search: 'member' },
      { page: '1' },
    ]) {
      assert.throws(
        () => parseAdminReportQueueQuery(invalid),
        (error) => error?.status === 400 && error?.code === 'ADMIN_REPORT_QUEUE_QUERY_INVALID',
      )
    }
  })

  it('returns a bounded empty page without querying member data unnecessarily', async () => {
    const calls = []
    const result = await listAdminReportQueue(parseAdminReportQueueQuery({ limit: '5' }), {
      repository: repository([], [], calls),
    })
    assert.deepEqual(result, {
      reports: [],
      pagination: { limit: 5, hasMore: false, nextCursor: null },
    })
    assert.deepEqual(calls[1].ids, [])
  })

  it('fails safely rather than shaping malformed persisted Report data', async () => {
    await assert.rejects(
      () =>
        listAdminReportQueue(parseAdminReportQueueQuery({}), {
          repository: repository(
            [report('31', '11', { reason: 'invented', description: 'private-detail' })],
            [],
          ),
        }),
      (error) =>
        error?.status === 500 &&
        error?.code === 'ADMIN_REPORT_QUEUE_DATA_INVALID' &&
        !JSON.stringify(error).includes('private-detail'),
    )
  })
})

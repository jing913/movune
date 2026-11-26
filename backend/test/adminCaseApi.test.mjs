import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { afterEach, before, describe, it } from 'node:test'
import express from 'express'
import passport from 'passport'
import { Types } from 'mongoose'
import { AccountEnforcementAction } from '../dist/models/accountEnforcementActionModel.js'
import { FinalReviewDecision } from '../dist/models/finalReviewDecisionModel.js'
import { Report } from '../dist/models/reportModel.js'
import { ReviewCase } from '../dist/models/reviewCaseModel.js'
import { User } from '../dist/models/userModel.js'
import adminCaseRouter from '../dist/routes/adminCase.js'
import { errorHandler } from '../dist/middlewares/errorHandler.js'

const originalAggregate = Report.aggregate
const originalReportFindById = Report.findById
const originalReviewCaseFindOne = ReviewCase.findOne
const originalDecisionFind = FinalReviewDecision.find
const originalUserFind = User.find
const originalUserFindById = User.findById
const originalEnforcementFind = AccountEnforcementAction.find
const originalEnforcementFindOne = AccountEnforcementAction.findOne
const servers = new Set()
const objectId = (suffix) => new Types.ObjectId(`d07f1f77bcf86cd7994390${suffix}`)
const activeAdminId = objectId('91')
const inactiveAdminId = objectId('92')
const normalUserId = objectId('93')
const reportId = objectId('21')
const reportedMemberId = objectId('11')
const reporterId = objectId('12')

class TestJwtStrategy extends passport.Strategy {
  name = 'jwt'

  authenticate(req) {
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    if (!token) return this.fail()
    if (token === 'active-admin') return this.success({ _id: activeAdminId, role: 'admin' })
    if (token === 'inactive-admin') return this.success({ _id: inactiveAdminId, role: 'admin' })
    if (token === 'forged') {
      return this.success({ _id: normalUserId, role: 'user', capabilities: { viewReports: true } })
    }
    return this.success({ _id: normalUserId, role: 'user' })
  }
}

before(() => passport.use(new TestJwtStrategy()))

const restriction = (targetUserId) => ({
  _id: objectId('61'),
  targetUserId,
  recordType: 'decision',
  decisionType: 'temporary_suspension',
  effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
  endsAt: new Date('2099-01-01T00:00:00.000Z'),
  performedByUserId: activeAdminId,
  reasonCode: 'test',
  reasonSummary: 'Test restriction',
  guidelineRuleId: 'test.rule',
  guidelineVersion: 'v1',
  createdAt: new Date('2020-01-01T00:00:00.000Z'),
})

const installAuthorization = ({ reject = false } = {}) => {
  AccountEnforcementAction.find = (filter) => ({
    sort() {
      return this
    },
    async lean() {
      if (reject) throw new Error('account-state unavailable')
      return filter.targetUserId.toString() === inactiveAdminId.toString()
        ? [restriction(inactiveAdminId)]
        : []
    },
  })
}

const chain = (value, captures, operation) => ({
  select(projection) {
    captures.push({ operation, projection })
    return this
  },
  async lean() {
    return value
  },
})

const installRecords = ({ queue = [], persistedCase = null, persistedDecisions = [] } = {}) => {
  const captures = []
  Report.aggregate = async (pipeline) => {
    captures.push({ operation: 'aggregate', pipeline })
    return queue
  }
  User.find = (filter) => ({
    select(projection) {
      captures.push({ operation: 'members', filter, projection })
      return this
    },
    async lean() {
      return [
        {
          _id: reportedMemberId,
          account: 'reported-account',
          displayName: 'Reported Member',
          email: 'must-not-leak@example.com',
        },
      ]
    },
  })
  Report.findById = (id) =>
    chain(
      {
        _id: reportId,
        reason: 'other',
        description: 'Detail description',
        sourceType: 'direct_message',
        reporterUserId: reporterId,
        reportedUserId: reportedMemberId,
        createdAt: new Date('2035-08-01T09:00:00.000Z'),
        messageEvidence: { content: 'private-message-must-not-leak' },
        conversationId: objectId('13'),
      },
      captures,
      `report:${id}`,
    )
  User.findById = (id) =>
    chain(
      id.toString() === reportedMemberId.toString()
        ? {
            _id: reportedMemberId,
            account: 'reported-account',
            displayName: 'Reported Member',
            avatar: null,
          }
        : { _id: reporterId, account: 'reporter-account', displayName: 'Reporter' },
      captures,
      `user:${id}`,
    )
  ReviewCase.findOne = (filter) => chain(persistedCase, captures, `case:${filter.reportId}`)
  FinalReviewDecision.find = (filter) => ({
    limit(value) {
      captures.push({ operation: 'decision-limit', filter, value })
      return this
    },
    select(projection) {
      captures.push({ operation: 'decisions', filter, projection })
      return this
    },
    async lean() {
      return persistedDecisions
    },
  })
  AccountEnforcementAction.findOne = (filter) =>
    chain(null, captures, `enforcement:${filter.reviewDecisionId}`)
  return captures
}

const queueRecord = () => ({
  _id: reportId,
  reason: 'other',
  sourceType: 'direct_message',
  reportedUserId: reportedMemberId,
  createdAt: new Date('2035-08-20T12:00:00.000Z'),
  reviewCases: [],
  reviewDecisions: [],
  reporterUserId: reporterId,
  description: 'must-not-leak',
  messageEvidence: { content: 'private-message-must-not-leak' },
  conversationId: objectId('13'),
})

const completedCase = () => ({
  _id: objectId('31'),
  reportId,
  state: 'review_completed',
  reviewStartedByUserId: activeAdminId,
  reviewStartedAt: new Date('2035-08-10T09:00:00.000Z'),
  decisionId: objectId('41'),
  completedAt: new Date('2035-08-11T10:00:00.000Z'),
  revision: 2,
})

const completedDecision = (caseValue) => ({
  _id: caseValue.decisionId,
  caseId: caseValue._id,
  reportId,
  conclusion: 'violation_confirmed',
  rationale: 'The submitted evidence establishes a violation.',
  reviewStartedByUserId: activeAdminId,
  decidedByUserId: activeAdminId,
  decidedAt: caseValue.completedAt,
  caseRevision: 2,
})

const startServer = async () => {
  const app = express()
  app.use(passport.initialize())
  app.use('/api/admin/cases', adminCaseRouter)
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  servers.add(server)
  await once(server, 'listening')
  return server
}

const request = (server, path, token, method = 'GET') =>
  new Promise((resolve, reject) => {
    const address = server.address()
    assert(address && typeof address === 'object')
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        method,
        path,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let body = null
          if (raw) {
            try {
              body = JSON.parse(raw)
            } catch {
              body = raw
            }
          }
          resolve({ status: response.statusCode, body })
        })
      },
    )
    outgoing.on('error', reject)
    outgoing.end()
  })

afterEach(async () => {
  Report.aggregate = originalAggregate
  Report.findById = originalReportFindById
  ReviewCase.findOne = originalReviewCaseFindOne
  FinalReviewDecision.find = originalDecisionFind
  User.find = originalUserFind
  User.findById = originalUserFindById
  AccountEnforcementAction.find = originalEnforcementFind
  AccountEnforcementAction.findOne = originalEnforcementFindOne
  await Promise.all(
    [...servers].map(async (server) => {
      server.close()
      await once(server, 'close')
      servers.delete(server)
    }),
  )
})

describe('Admin Case read API', () => {
  it('authenticates and authorizes before protected queue reads', async () => {
    const captures = installRecords({ queue: [queueRecord()] })
    installAuthorization()
    const server = await startServer()

    assert.equal((await request(server, '/api/admin/cases')).status, 401)
    for (const token of ['user', 'forged', 'inactive-admin']) {
      const response = await request(server, '/api/admin/cases', token)
      assert.equal(response.status, 403, token)
      assert.equal(response.body.error.code, 'REPORT_REVIEW_FORBIDDEN', token)
    }
    assert.equal(captures.length, 0)

    installAuthorization({ reject: true })
    const unavailable = await request(server, '/api/admin/cases', 'active-admin')
    assert.equal(unavailable.status, 403)
    assert.equal(captures.length, 0)
  })

  it('returns an exact needs-review queue DTO and applies filter, ordering, and cursor stages', async () => {
    installAuthorization()
    const captures = installRecords({ queue: [queueRecord()] })
    const server = await startServer()
    const response = await request(
      server,
      '/api/admin/cases?state=needs_review&limit=10',
      'active-admin',
    )

    assert.equal(response.status, 200)
    assert.equal(response.body.cases[0].case.state, 'needs_review')
    assert.deepEqual(Object.keys(response.body.cases[0]).sort(), ['case', 'report'])
    const serialized = JSON.stringify(response.body)
    for (const forbidden of [
      'reporterUserId',
      'reportedUserId',
      'description',
      'messageEvidence',
      'private-message-must-not-leak',
      'conversationId',
      'rationale',
      'reviewStartedByUserId',
      'email',
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden)
    }
    const pipeline = captures.find((capture) => capture.operation === 'aggregate').pipeline
    assert.deepEqual(pipeline[1], { $sort: { createdAt: -1, _id: -1 } })
    assert.equal(pipeline[3].$lookup.from, 'finalreviewdecisions')
    assert.deepEqual(pipeline[3].$lookup.pipeline, [{ $limit: 2 }])
    assert.deepEqual(pipeline[5], { $match: { derivedCaseState: 'needs_review' } })
    assert.deepEqual(pipeline[6], { $limit: 11 })
    assert.deepEqual(Object.keys(pipeline.at(-1).$project).sort(), [
      '_id',
      'createdAt',
      'reason',
      'reportedUserId',
      'reviewCases',
      'reviewDecisions',
      'sourceType',
    ])
  })

  it('builds the concrete descending cursor boundary with an ObjectId tie-breaker', async () => {
    installAuthorization()
    const captures = installRecords({ queue: [] })
    const server = await startServer()
    const submittedAt = new Date('2035-08-20T12:00:00.000Z')
    const cursorId = objectId('29')
    const cursor = Buffer.from(
      JSON.stringify([submittedAt.toISOString(), cursorId.toString()]),
      'utf8',
    ).toString('base64url')
    const response = await request(
      server,
      `/api/admin/cases?cursor=${cursor}&limit=10`,
      'active-admin',
    )

    assert.equal(response.status, 200)
    const pipeline = captures.find((capture) => capture.operation === 'aggregate').pipeline
    assert.deepEqual(pipeline[0], {
      $match: {
        $or: [
          { createdAt: { $lt: submittedAt } },
          { createdAt: submittedAt, _id: { $lt: cursorId } },
        ],
      },
    })
    assert.deepEqual(pipeline[1], { $sort: { createdAt: -1, _id: -1 } })
  })

  it('rejects invalid queue controls and exposes no Case write route', async () => {
    installAuthorization()
    installRecords()
    const server = await startServer()
    for (const query of [
      'state=resolved',
      'state=needs_review&state=under_review',
      'limit=51',
      'limit[$gt]=0',
      'sort=state',
    ]) {
      const response = await request(server, `/api/admin/cases?${query}`, 'active-admin')
      assert.equal(response.status, 400, query)
      assert.equal(response.body.error.code, 'ADMIN_CASE_QUEUE_QUERY_INVALID', query)
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal((await request(server, '/api/admin/cases', 'active-admin', method)).status, 404)
    }
  })

  it('returns Report context, completed Case, and only permitted immutable Decision fields', async () => {
    installAuthorization()
    const caseValue = completedCase()
    const captures = installRecords({
      persistedCase: caseValue,
      persistedDecisions: [completedDecision(caseValue)],
    })
    const server = await startServer()
    const response = await request(server, `/api/admin/cases/${reportId}`, 'active-admin')

    assert.equal(response.status, 200)
    assert.equal(response.body.case.state, 'review_completed')
    assert.equal(response.body.decision.conclusion, 'violation_confirmed')
    assert.deepEqual(Object.keys(response.body.decision).sort(), [
      'caseRevision',
      'conclusion',
      'decidedAt',
      'decidedByUserId',
      'id',
      'rationale',
    ])
    const reportProjection = captures.find((capture) => capture.operation.startsWith('report:'))
    assert.equal(reportProjection.projection.includes('message'), false)
    assert.equal(reportProjection.projection.includes('conversation'), false)
    const serialized = JSON.stringify(response.body)
    assert.equal(serialized.includes('private-message-must-not-leak'), false)
    assert.equal(serialized.includes('conversationId'), false)
  })

  it('fails closed for invalid IDs and corrupt completed relationships', async () => {
    installAuthorization()
    installRecords()
    let server = await startServer()
    const invalid = await request(server, '/api/admin/cases/not-an-id', 'active-admin')
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.error.code, 'ADMIN_CASE_REPORT_ID_INVALID')
    server.close()
    await once(server, 'close')
    servers.delete(server)

    const caseValue = completedCase()
    installRecords({ persistedCase: caseValue, persistedDecisions: [] })
    server = await startServer()
    const corrupt = await request(server, `/api/admin/cases/${reportId}`, 'active-admin')
    assert.equal(corrupt.status, 500)
    assert.equal(corrupt.body.error.code, 'ADMIN_CASE_DATA_INVALID')
    assert.equal(JSON.stringify(corrupt.body).includes('private-message-must-not-leak'), false)
  })

  it('fails closed when an orphan Decision contradicts a missing Case in queue or detail', async () => {
    installAuthorization()
    const orphanCase = completedCase()
    const orphanDecision = completedDecision(orphanCase)
    const orphanQueueRecord = queueRecord()
    orphanQueueRecord.reviewDecisions = [orphanDecision]
    installRecords({ queue: [orphanQueueRecord], persistedDecisions: [orphanDecision] })
    const server = await startServer()

    const queueResponse = await request(server, '/api/admin/cases', 'active-admin')
    assert.equal(queueResponse.status, 500)
    assert.equal(queueResponse.body.error.code, 'ADMIN_CASE_DATA_INVALID')

    const detailResponse = await request(server, `/api/admin/cases/${reportId}`, 'active-admin')
    assert.equal(detailResponse.status, 500)
    assert.equal(detailResponse.body.error.code, 'ADMIN_CASE_DATA_INVALID')
    assert.equal(
      JSON.stringify(detailResponse.body).includes('private-message-must-not-leak'),
      false,
    )
  })

  it('keeps evidence outside the Case routes', async () => {
    installAuthorization()
    installRecords()
    const server = await startServer()
    const response = await request(server, `/api/admin/cases/${reportId}/evidence`, 'active-admin')
    assert.equal(response.status, 404)
  })
})

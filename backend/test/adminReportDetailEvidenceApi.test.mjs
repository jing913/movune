import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { afterEach, before, describe, it } from 'node:test'
import express from 'express'
import passport from 'passport'
import { Types } from 'mongoose'
import { Report } from '../dist/models/reportModel.js'
import { User } from '../dist/models/userModel.js'
import { AccountEnforcementAction } from '../dist/models/accountEnforcementActionModel.js'
import { ReportEvidenceAccessAuditEventModel } from '../dist/models/reportEvidenceAccessAuditEventModel.js'
import adminReportRouter from '../dist/routes/adminReport.js'
import { errorHandler } from '../dist/middlewares/errorHandler.js'

const originalReportFindById = Report.findById
const originalUserFindById = User.findById
const originalEnforcementFind = AccountEnforcementAction.find
const originalAuditInsertOne = ReportEvidenceAccessAuditEventModel.collection.insertOne
const servers = new Set()
const objectId = (suffix) => new Types.ObjectId(`a07f1f77bcf86cd7994390${suffix}`)
const activeAdminId = objectId('91')
const inactiveAdminId = objectId('92')
const normalUserId = objectId('93')
const reportedMemberId = objectId('11')
const reporterId = objectId('12')
const reportId = objectId('21')
const messageId = objectId('31')
const evidenceContent = 'Synthetic bounded evidence'

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
  _id: objectId('41'),
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

const installEnforcementHistory = ({ rejectActor = false } = {}) => {
  AccountEnforcementAction.find = (filter) => ({
    sort() {
      return this
    },
    async lean() {
      const id = filter.targetUserId.toString()
      if (rejectActor && id === activeAdminId.toString()) {
        throw new Error('account-state unavailable')
      }
      if (id === inactiveAdminId.toString()) return [restriction(inactiveAdminId)]
      return []
    },
  })
}

const detailRecord = () => ({
  _id: reportId,
  reason: 'other',
  description: 'Detail description',
  sourceType: 'direct_message',
  reporterUserId: reporterId,
  reportedUserId: reportedMemberId,
  createdAt: new Date('2035-08-01T09:00:00.000Z'),
  messageId,
  messageEvidence: { content: 'must-not-load-through-detail' },
  conversationId: objectId('51'),
})

const evidenceRecord = () => ({
  _id: reportId,
  sourceType: 'direct_message',
  reportedUserId: reportedMemberId,
  messageId,
  messageEvidence: {
    messageId,
    senderUserId: reportedMemberId,
    content: evidenceContent,
    sentAt: new Date('2035-08-01T08:30:00.000Z'),
  },
})

const installRecords = ({ detail = detailRecord(), evidence = evidenceRecord() } = {}) => {
  const reportCalls = []
  const userCalls = []
  Report.findById = (id) => ({
    select(projection) {
      reportCalls.push({ id, projection })
      return this
    },
    async lean() {
      return reportCalls.at(-1).projection.includes('messageEvidence') ? evidence : detail
    },
  })
  User.findById = (id) => ({
    select(projection) {
      userCalls.push({ id, projection })
      return this
    },
    async lean() {
      if (id.toString() === reportedMemberId.toString()) {
        return {
          _id: reportedMemberId,
          account: 'reported-account',
          displayName: 'Reported Member',
          avatar: '/avatar.png',
          email: 'must-not-leak@example.com',
        }
      }
      if (id.toString() === reporterId.toString()) {
        return {
          _id: reporterId,
          account: 'reporter-account',
          displayName: 'Reporter',
          email: 'must-not-leak@example.com',
        }
      }
      return null
    },
  })
  return { reportCalls, userCalls }
}

const installAuditSuccess = (auditCalls = []) => {
  ReportEvidenceAccessAuditEventModel.collection.insertOne = async (document, options) => {
    auditCalls.push({ document, options })
    return { acknowledged: true, insertedId: document._id }
  }
}

const startServer = async () => {
  const app = express()
  app.use(passport.initialize())
  app.use('/api/admin/reports', adminReportRouter)
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  servers.add(server)
  await once(server, 'listening')
  return server
}

const request = (server, path, token) =>
  new Promise((resolve, reject) => {
    const address = server.address()
    assert(address && typeof address === 'object')
    const outgoing = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        method: 'GET',
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
  Report.findById = originalReportFindById
  User.findById = originalUserFindById
  AccountEnforcementAction.find = originalEnforcementFind
  ReportEvidenceAccessAuditEventModel.collection.insertOne = originalAuditInsertOne
  await Promise.all(
    [...servers].map(async (server) => {
      server.close()
      await once(server, 'close')
      servers.delete(server)
    }),
  )
})

describe('Admin Report Detail and bounded evidence API', () => {
  it('returns exact metadata without loading or disclosing evidence', async () => {
    installEnforcementHistory()
    const { reportCalls } = installRecords()
    installAuditSuccess()
    const server = await startServer()
    const response = await request(server, `/api/admin/reports/${reportId}`, 'active-admin')

    assert.equal(response.status, 200)
    assert.deepEqual(Object.keys(response.body).sort(), ['report', 'reportedMember', 'reporter'])
    assert.deepEqual(Object.keys(response.body.report).sort(), [
      'description',
      'id',
      'reason',
      'sourceType',
      'submittedAt',
    ])
    assert.equal(reportCalls.length, 1)
    assert.equal(reportCalls[0].projection.includes('message'), false)
    assert.equal(reportCalls[0].projection.includes('conversation'), false)
    const serialized = JSON.stringify(response.body)
    assert.equal(serialized.includes('messageEvidence'), false)
    assert.equal(serialized.includes('must-not-load-through-detail'), false)
    assert.equal(serialized.includes('reporterUserId'), false)
    assert.equal(serialized.includes('reportedUserId'), false)
    assert.equal(serialized.includes('email'), false)
  })

  it('returns bounded evidence only after the durable same-request audit succeeds', async () => {
    installEnforcementHistory()
    const { reportCalls, userCalls } = installRecords()
    const auditCalls = []
    installAuditSuccess(auditCalls)
    const server = await startServer()
    const response = await request(
      server,
      `/api/admin/reports/${reportId}/evidence`,
      'active-admin',
    )

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, {
      evidence: {
        messageId: messageId.toString(),
        content: evidenceContent,
        sentAt: '2035-08-01T08:30:00.000Z',
      },
    })
    assert.equal(reportCalls.length, 1)
    assert.equal(userCalls.length, 0)
    assert.equal(auditCalls.length, 1)
    assert.equal(auditCalls[0].document.reportId.toString(), reportId.toString())
    assert.equal(auditCalls[0].document.evidenceMessageId.toString(), messageId.toString())
    assert.equal(JSON.stringify(auditCalls[0].document).includes(evidenceContent), false)
    assert.deepEqual(auditCalls[0].options.writeConcern, {
      w: 'majority',
      journal: true,
      wtimeoutMS: 5000,
    })
  })

  it('performs no Report query before authorization succeeds', async () => {
    installEnforcementHistory()
    const { reportCalls } = installRecords()
    installAuditSuccess()
    const server = await startServer()

    for (const path of [
      `/api/admin/reports/${reportId}`,
      `/api/admin/reports/${reportId}/evidence`,
    ]) {
      assert.equal((await request(server, path)).status, 401)
      for (const token of ['user', 'forged', 'inactive-admin']) {
        const response = await request(server, path, token)
        assert.equal(response.status, 403, `${path} ${token}`)
        assert.equal(response.body.error.code, 'REPORT_REVIEW_FORBIDDEN')
      }
    }
    assert.equal(reportCalls.length, 0)

    installEnforcementHistory({ rejectActor: true })
    const failed = await request(server, `/api/admin/reports/${reportId}/evidence`, 'active-admin')
    assert.equal(failed.status, 403)
    assert.equal(failed.body.error.code, 'REPORT_REVIEW_FORBIDDEN')
    assert.equal(reportCalls.length, 0)
  })

  it('validates IDs before Report access and returns controlled missing-record responses', async () => {
    installEnforcementHistory()
    const { reportCalls } = installRecords({ detail: null, evidence: null })
    installAuditSuccess()
    const server = await startServer()

    for (const suffix of ['', '/evidence']) {
      const invalid = await request(server, `/api/admin/reports/not-an-id${suffix}`, 'active-admin')
      assert.equal(invalid.status, 400)
      assert.equal(invalid.body.error.code, 'ADMIN_REPORT_ID_INVALID')
    }
    assert.equal(reportCalls.length, 0)

    const missing = await request(server, `/api/admin/reports/${reportId}`, 'active-admin')
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'ADMIN_REPORT_NOT_FOUND')
  })

  it('returns no evidence when the durable audit append fails', async () => {
    installEnforcementHistory()
    installRecords()
    ReportEvidenceAccessAuditEventModel.collection.insertOne = async () => {
      throw new Error(`topology failed while handling ${evidenceContent}`)
    }
    const server = await startServer()
    const response = await request(
      server,
      `/api/admin/reports/${reportId}/evidence`,
      'active-admin',
    )

    assert.equal(response.status, 503)
    assert.equal(response.body.error.code, 'REPORT_EVIDENCE_AUDIT_UNCONFIRMED')
    assert.equal(JSON.stringify(response.body).includes(evidenceContent), false)
    assert.equal(JSON.stringify(response.body).includes('topology'), false)
  })
})

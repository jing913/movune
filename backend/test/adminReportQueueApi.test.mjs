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
import adminReportRouter from '../dist/routes/adminReport.js'
import { errorHandler } from '../dist/middlewares/errorHandler.js'

const originalReportFind = Report.find
const originalUserFind = User.find
const originalEnforcementFind = AccountEnforcementAction.find
const servers = new Set()
const objectId = (suffix) => new Types.ObjectId(`907f1f77bcf86cd7994390${suffix}`)
const activeAdminId = objectId('91')
const inactiveAdminId = objectId('92')
const normalUserId = objectId('93')
const reportedMemberId = objectId('11')
const reportId = objectId('21')

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

const action = (targetUserId) => ({
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

const installEnforcementHistory = ({ reject = false } = {}) => {
  AccountEnforcementAction.find = (filter) => ({
    sort() {
      return this
    },
    async lean() {
      if (reject) throw new Error('account-state unavailable')
      return filter.targetUserId.toString() === inactiveAdminId.toString()
        ? [action(inactiveAdminId)]
        : []
    },
  })
}

const installQueue = (reports = [], members = [], captures = []) => {
  Report.find = (filter) => {
    captures.push({ operation: 'reports', filter })
    return {
      select(projection) {
        captures.at(-1).projection = projection
        return this
      },
      sort(sort) {
        captures.at(-1).sort = sort
        return this
      },
      limit(limit) {
        captures.at(-1).limit = limit
        return this
      },
      async lean() {
        return reports
      },
    }
  }
  User.find = (filter) => {
    captures.push({ operation: 'members', filter })
    return {
      select(projection) {
        captures.at(-1).projection = projection
        return this
      },
      async lean() {
        return members
      },
    }
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
  Report.find = originalReportFind
  User.find = originalUserFind
  AccountEnforcementAction.find = originalEnforcementFind
  await Promise.all(
    [...servers].map(async (server) => {
      server.close()
      await once(server, 'close')
      servers.delete(server)
    }),
  )
})

describe('Admin Report Queue API', () => {
  it('requires authentication and independently denies non-admin, inactive, forged, or unverifiable users', async () => {
    const captures = []
    installEnforcementHistory()
    installQueue([], [], captures)
    const server = await startServer()

    assert.equal((await request(server, '/api/admin/reports')).status, 401)
    for (const token of ['user', 'forged', 'inactive-admin']) {
      const response = await request(server, '/api/admin/reports', token)
      assert.equal(response.status, 403, token)
      assert.equal(response.body.error.code, 'REPORT_REVIEW_FORBIDDEN', token)
      assert.equal(JSON.stringify(response.body).includes('reporterUserId'), false)
    }
    assert.equal(captures.length, 0)

    installEnforcementHistory({ reject: true })
    const failedState = await request(server, '/api/admin/reports', 'active-admin')
    assert.equal(failedState.status, 403)
    assert.equal(failedState.body.error.code, 'REPORT_REVIEW_FORBIDDEN')
    assert.equal(captures.length, 0)
  })

  it('returns only the approved Queue DTO through strict Report and User projections', async () => {
    const captures = []
    installEnforcementHistory()
    installQueue(
      [
        {
          _id: reportId,
          reason: 'spam_or_suspicious',
          sourceType: 'direct_message',
          reportedUserId: reportedMemberId,
          createdAt: new Date('2035-08-15T12:00:00.000Z'),
          reporterUserId: objectId('31'),
          description: 'must-not-leak',
          messageEvidence: { content: 'private-message-must-not-leak' },
          conversationId: objectId('32'),
        },
      ],
      [
        {
          _id: reportedMemberId,
          account: 'reported-account',
          displayName: 'Reported Member',
          email: 'must-not-leak@example.com',
        },
      ],
      captures,
    )
    const server = await startServer()
    const response = await request(server, '/api/admin/reports?limit=10', 'active-admin')

    assert.equal(response.status, 200)
    assert.deepEqual(Object.keys(response.body.reports[0]).sort(), [
      'id',
      'reason',
      'reportedMemberAccount',
      'reportedMemberDisplayName',
      'sourceType',
      'submittedAt',
    ])
    const serialized = JSON.stringify(response.body)
    for (const forbidden of [
      'reporterUserId',
      'reportedUserId',
      'description',
      'messageEvidence',
      'conversationId',
      'private-message-must-not-leak',
      'email',
    ]) {
      assert.equal(serialized.includes(forbidden), false, forbidden)
    }
    assert.equal(captures[0].projection, '_id reason sourceType reportedUserId createdAt')
    assert.deepEqual(captures[0].sort, { createdAt: -1, _id: -1 })
    assert.equal(captures[0].limit, 11)
    assert.equal(captures[1].projection, '_id account displayName')
  })

  it('rejects unapproved query controls and exposes no write route', async () => {
    installEnforcementHistory()
    installQueue([], [])
    const server = await startServer()

    for (const query of ['sort=reason', 'status=pending', 'limit=51', 'limit[$gt]=0']) {
      const response = await request(server, `/api/admin/reports?${query}`, 'active-admin')
      assert.equal(response.status, 400, query)
      assert.equal(response.body.error.code, 'ADMIN_REPORT_QUEUE_QUERY_INVALID')
      assert.equal(JSON.stringify(response.body).includes('messageEvidence'), false)
    }
    assert.equal((await request(server, '/api/admin/reports', 'active-admin', 'POST')).status, 404)
  })
})

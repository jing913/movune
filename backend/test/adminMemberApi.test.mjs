import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { afterEach, before, describe, it } from 'node:test'
import express from 'express'
import passport from 'passport'
import { Types } from 'mongoose'
import { User } from '../dist/models/userModel.js'
import { AccountEnforcementAction } from '../dist/models/accountEnforcementActionModel.js'
import adminMemberRouter from '../dist/routes/adminMember.js'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import {
  buildAdminMemberListPipeline,
  listAdminMembers,
  parseAdminMemberListQuery,
} from '../dist/services/adminMemberReadService.js'
import { serializeCurrentUser } from '../dist/controllers/userController.js'
import { evaluateAccountEnforcement } from '../dist/utils/accountEnforcementPolicy.js'

const originalAggregate = User.aggregate
const originalFindById = User.findById
const originalEnforcementFind = AccountEnforcementAction.find
const servers = new Set()
const evaluatedAt = new Date('2035-08-15T12:00:00.000Z')
const objectId = (suffix) => new Types.ObjectId(`807f1f77bcf86cd7994390${suffix}`)
const activeAdminId = objectId('91')
const inactiveAdminId = objectId('92')
const corruptAdminId = objectId('93')
const normalUserId = objectId('94')
const memberId = objectId('11')

const action = (suffix, targetUserId, overrides = {}) => ({
  _id: objectId(suffix),
  targetUserId,
  recordType: 'decision',
  effectiveAt: new Date('2020-01-01T00:00:00.000Z'),
  performedByUserId: activeAdminId,
  reasonCode: 'policy.test',
  reasonSummary: 'Test policy decision',
  decisionType: 'temporary_suspension',
  guidelineRuleId: 'guideline.test',
  guidelineVersion: 'v1',
  endsAt: new Date('2099-01-01T00:00:00.000Z'),
  createdAt: new Date('2020-01-01T00:00:00.000Z'),
  ...overrides,
})

const policyAction = (suffix, targetUserId, overrides = {}) => {
  const record = action(suffix, targetUserId, overrides)
  return {
    ...record,
    id: record._id.toString(),
    targetUserId: record.targetUserId.toString(),
    performedByUserId: record.performedByUserId.toString(),
    ...(record.reversesDecisionId
      ? { reversesDecisionId: record.reversesDecisionId.toString() }
      : {}),
  }
}

const historyByUser = new Map([
  [activeAdminId.toString(), []],
  [normalUserId.toString(), []],
  [inactiveAdminId.toString(), [action('21', inactiveAdminId)]],
  [
    corruptAdminId.toString(),
    [
      action('22', corruptAdminId, {
        recordType: 'reversal',
        decisionType: undefined,
        guidelineRuleId: undefined,
        guidelineVersion: undefined,
        endsAt: undefined,
        reversesDecisionId: objectId('29'),
      }),
    ],
  ],
  [memberId.toString(), []],
])

class TestJwtStrategy extends passport.Strategy {
  name = 'jwt'

  authenticate(req) {
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    if (!token) return this.fail()
    if (token === 'active-admin') return this.success({ _id: activeAdminId, role: 'admin' })
    if (token === 'inactive-admin') return this.success({ _id: inactiveAdminId, role: 'admin' })
    if (token === 'corrupt-admin') return this.success({ _id: corruptAdminId, role: 'admin' })
    if (token === 'forged') {
      return this.success({
        _id: normalUserId,
        role: 'user',
        capabilities: { viewMembers: true },
      })
    }
    return this.success({ _id: normalUserId, role: 'user' })
  }
}

before(() => passport.use(new TestJwtStrategy()))

const installEnforcementHistory = () => {
  AccountEnforcementAction.find = (filter) => {
    const records = historyByUser.get(filter.targetUserId.toString()) ?? []
    return {
      sort() {
        return this
      },
      async lean() {
        return records
      },
    }
  }
}

const installList = (members = []) => {
  User.aggregate = async () => [
    {
      members,
      total: [{ count: members.length }],
    },
  ]
}

const installDetail = (value) => {
  User.findById = () => ({
    select() {
      return this
    },
    async lean() {
      return value
    },
  })
}

const startServer = async () => {
  const app = express()
  app.use(passport.initialize())
  app.use('/api/admin/members', adminMemberRouter)
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
  User.aggregate = originalAggregate
  User.findById = originalFindById
  AccountEnforcementAction.find = originalEnforcementFind
  await Promise.all(
    [...servers].map(async (server) => {
      server.close()
      await once(server, 'close')
      servers.delete(server)
    }),
  )
})

describe('Admin Members Read API', () => {
  it('requires authentication and rejects non-admin, inactive admin, corrupt evidence, and forged capability', async () => {
    installEnforcementHistory()
    installList([])
    const server = await startServer()

    assert.equal((await request(server, '/api/admin/members')).status, 401)
    for (const token of ['user', 'forged', 'inactive-admin', 'corrupt-admin']) {
      const denied = await request(server, '/api/admin/members', token)
      assert.equal(denied.status, 403, token)
      assert.equal(denied.body.error.code, 'MEMBERS_READ_FORBIDDEN', token)
    }
    assert.equal((await request(server, '/api/admin/members', 'active-admin')).status, 200)
  })

  it('returns an exact list DTO with explicitly unavailable Recent Login', async () => {
    installEnforcementHistory()
    installList([
      {
        id: memberId.toString(),
        avatar: null,
        displayName: 'Member',
        account: 'member-account',
        accountStatus: 'active',
        registrationDate: new Date('2035-07-01T00:00:00.000Z'),
        recentLogin: { status: 'available', at: 'fabricated' },
        email: 'must-not-leak@example.com',
        password: 'must-not-leak',
      },
    ])
    const server = await startServer()
    const response = await request(server, '/api/admin/members', 'active-admin')

    assert.equal(response.status, 200)
    assert.deepEqual(Object.keys(response.body.members[0]).sort(), [
      'account',
      'accountStatus',
      'avatar',
      'displayName',
      'id',
      'recentLogin',
      'registrationDate',
    ])
    assert.deepEqual(response.body.members[0].recentLogin, { status: 'unavailable', at: null })
    assert.equal(JSON.stringify(response.body).includes('must-not-leak'), false)
  })

  it('returns exact detail fields, 400 for malformed ids, and 404 for missing members', async () => {
    installEnforcementHistory()
    installDetail({
      _id: memberId,
      account: 'member-account',
      displayName: 'Member',
      avatar: undefined,
      bio: 'Bounded bio',
      role: 'user',
      createdAt: new Date('2035-07-01T00:00:00.000Z'),
      email: 'must-not-leak@example.com',
      password: 'must-not-leak',
    })
    const server = await startServer()

    assert.equal(
      (await request(server, '/api/admin/members/not-an-object-id', 'active-admin')).status,
      400,
    )
    const detail = await request(
      server,
      `/api/admin/members/${memberId.toString()}`,
      'active-admin',
    )
    assert.equal(detail.status, 200)
    assert.deepEqual(Object.keys(detail.body.member).sort(), [
      'account',
      'accountStatus',
      'avatar',
      'bio',
      'displayName',
      'id',
      'recentLogin',
      'registrationDate',
      'role',
    ])
    assert.equal(JSON.stringify(detail.body).includes('must-not-leak'), false)
    assert.deepEqual(detail.body.member.recentLogin, { status: 'unavailable', at: null })

    installDetail(null)
    assert.equal(
      (await request(server, `/api/admin/members/${objectId('12').toString()}`, 'active-admin'))
        .status,
      404,
    )
  })

  it('validates and bounds combined search, role, date, status, page, and limit inputs', () => {
    const parsed = parseAdminMemberListQuery({
      search: 'member.*',
      role: 'user',
      status: 'suspended',
      registeredFrom: '2035-01-01',
      registeredTo: '2035-01-31',
      page: '2',
      limit: '30',
    })
    assert.equal(parsed.search, 'member.*')
    assert.equal(parsed.status, 'suspended')
    assert.equal(parsed.role, 'user')
    assert.equal(parsed.page, 2)
    assert.equal(parsed.limit, 30)
    assert.equal(parsed.registeredFrom.toISOString(), '2035-01-01T00:00:00.000Z')
    assert.equal(parsed.registeredToExclusive.toISOString(), '2035-02-01T00:00:00.000Z')

    for (const invalid of [
      { limit: '31' },
      { page: '0' },
      { page: '10001' },
      { role: 'owner' },
      { status: 'unknown' },
      { registeredFrom: '2035-02-30' },
      { registeredFrom: '2035-02-01', registeredTo: '2035-01-01' },
      { fields: 'email' },
      { search: ['member'] },
    ]) {
      assert.throws(
        () => parseAdminMemberListQuery(invalid),
        (error) => error?.status === 400 && error?.code === 'ADMIN_MEMBER_QUERY_INVALID',
      )
    }
  })

  it('searches only escaped Account/Display Name and status-filters before totals and paging', () => {
    const query = parseAdminMemberListQuery({
      search: 'member.*',
      role: 'user',
      status: 'active',
      registeredFrom: '2035-01-01',
      registeredTo: '2035-12-31',
      page: '2',
      limit: '10',
    })
    const pipeline = buildAdminMemberListPipeline(query, evaluatedAt)
    const serialized = JSON.stringify(pipeline)
    const firstMatch = pipeline[0].$match
    assert.deepEqual(firstMatch.$or, [
      { account: { $regex: 'member\\.\\*', $options: 'i' } },
      { displayName: { $regex: 'member\\.\\*', $options: 'i' } },
    ])
    assert.equal(serialized.includes('email'), false)

    const statusMatchIndex = pipeline.findIndex((stage) => stage.$match?.accountStatus === 'active')
    const facetIndex = pipeline.findIndex((stage) => stage.$facet)
    assert(statusMatchIndex > 0)
    assert(statusMatchIndex < facetIndex)
    const membersFacet = pipeline[facetIndex].$facet.members
    assert.equal(membersFacet.find((stage) => stage.$skip)?.$skip, 10)
    assert.equal(membersFacet.find((stage) => stage.$limit)?.$limit, 10)
  })

  it('preserves deterministic registration ordering and pagination totals without DTO leakage', async () => {
    let capturedPipeline
    User.aggregate = async (pipeline) => {
      capturedPipeline = pipeline
      return [
        {
          members: [
            {
              id: memberId.toString(),
              avatar: null,
              displayName: 'Member',
              account: 'member-account',
              accountStatus: 'active',
              registrationDate: new Date('2035-07-01T00:00:00.000Z'),
              recentLogin: { status: 'unavailable', at: null },
              email: 'must-not-leak@example.com',
            },
          ],
          total: [{ count: 41 }],
        },
      ]
    }
    const result = await listAdminMembers(
      parseAdminMemberListQuery({ page: '2', limit: '20' }),
      evaluatedAt,
    )
    assert.deepEqual(result.pagination, { page: 2, limit: 20, total: 41, totalPages: 3 })
    assert.equal('email' in result.members[0], false)
    assert.deepEqual(result.members[0].recentLogin, { status: 'unavailable', at: null })
    const membersFacet = capturedPipeline[1].$facet.members
    assert.deepEqual(membersFacet[0], { $sort: { createdAt: -1, _id: -1 } })
  })

  it('keeps list status derivation aligned with the existing pure evaluator for active restrictions', () => {
    const active = evaluateAccountEnforcement([], evaluatedAt)
    const suspended = evaluateAccountEnforcement([policyAction('23', memberId)], evaluatedAt)
    const deactivated = evaluateAccountEnforcement(
      [policyAction('24', memberId, { decisionType: 'permanent_deactivation', endsAt: undefined })],
      evaluatedAt,
    )
    assert.deepEqual(
      [active.status, suspended.status, deactivated.status],
      ['active', 'suspended', 'deactivated'],
    )

    for (const expected of ['active', 'suspended', 'deactivated']) {
      const pipeline = buildAdminMemberListPipeline(
        parseAdminMemberListQuery({ status: expected }),
        evaluatedAt,
      )
      assert(pipeline.some((stage) => stage.$match?.accountStatus === expected))
    }
  })

  it('derives viewMembers in the current-user response without exposing enforcement history', async () => {
    installEnforcementHistory()
    const serialized = await serializeCurrentUser(
      {
        _id: activeAdminId,
        role: 'admin',
        account: 'administrator',
        displayName: 'Administrator',
        favoritesPublic: false,
      },
      evaluatedAt,
    )
    assert.equal(serialized.capabilities.viewMembers, true)
    assert.equal('viewReports' in serialized.capabilities, false)
    assert.equal(serialized.capabilities.manageAnnouncements, true)
    assert.equal('role' in serialized, false)
    assert.equal('enforcementHistory' in serialized, false)
  })
})

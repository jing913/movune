import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { afterEach, before, describe, it } from 'node:test'
import express from 'express'
import passport from 'passport'
import { Types } from 'mongoose'
import { User } from '../dist/models/userModel.js'
import { AccountEnforcementAction } from '../dist/models/accountEnforcementActionModel.js'
import { ApiProblem } from '../dist/utils/messagingPolicy.js'
import adminEnforcementRouter from '../dist/routes/adminEnforcement.js'
import { errorHandler } from '../dist/middlewares/errorHandler.js'
import { accountEnforcementReversalApplicationService } from '../dist/services/accountEnforcementReversalApplicationService.js'

const ACTOR = '111111111111111111111111'
const TARGET = '222222222222222222222222'
const DECISION = '333333333333333333333333'
const originalFind = AccountEnforcementAction.find
const originalFindById = User.findById
const originalReverse = accountEnforcementReversalApplicationService.reverseDecision
const servers = new Set()

class Strategy extends passport.Strategy {
  name = 'jwt'
  authenticate(req) {
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    if (!token) return this.fail()
    const base = { _id: new Types.ObjectId(ACTOR), role: 'admin' }
    if (token === 'enforcer') return this.success({ ...base, memberEnforcementEnabled: true })
    if (token === 'viewer') return this.success({ ...base, memberEnforcementEnabled: false })
    if (token === 'both') return this.success({ ...base, memberEnforcementEnabled: true })
    return this.success({ ...base, role: 'user', memberEnforcementEnabled: true })
  }
}

before(() => passport.use(new Strategy()))

const installReads = () => {
  AccountEnforcementAction.find = (filter) => {
    const isAuthorization = filter.targetUserId?.toString() === ACTOR
    const records = isAuthorization
      ? []
      : [
          {
            _id: new Types.ObjectId(DECISION),
            targetUserId: new Types.ObjectId(TARGET),
            recordType: 'decision',
            decisionType: 'formal_warning',
            effectiveAt: new Date('2035-09-01T00:00:00.000Z'),
            reasonSummary: 'Internal reason',
          },
        ]
    return {
      select() {
        return this
      },
      sort() {
        return this
      },
      async lean() {
        return records
      },
    }
  }
  User.findById = () => ({
    select() {
      return this
    },
    async lean() {
      return { _id: new Types.ObjectId(TARGET), account: 'member', displayName: 'Member' }
    },
  })
}

const start = async () => {
  const app = express()
  app.use(express.json())
  app.use(passport.initialize())
  app.use('/api/admin/enforcement-decisions', adminEnforcementRouter)
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  servers.add(server)
  await once(server, 'listening')
  return server
}

const request = (server, method, path, token, body) =>
  new Promise((resolve, reject) => {
    const address = server.address()
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        method,
        path,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString()
          let parsed = null
          if (raw) {
            try {
              parsed = JSON.parse(raw)
            } catch {
              parsed = raw
            }
          }
          resolve({ status: res.statusCode, body: parsed })
        })
      },
    )
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })

afterEach(async () => {
  AccountEnforcementAction.find = originalFind
  User.findById = originalFindById
  accountEnforcementReversalApplicationService.reverseDecision = originalReverse
  await Promise.all(
    [...servers].map(async (server) => {
      server.close()
      await once(server, 'close')
      servers.delete(server)
    }),
  )
})

describe('Admin enforcement HTTP API', () => {
  it('enforces JWT and base Member Enforcement capability independently of Member Read', async () => {
    installReads()
    const server = await start()
    const path = `/api/admin/enforcement-decisions?targetUserId=${TARGET}`
    assert.equal((await request(server, 'GET', path)).status, 401)
    for (const token of ['viewer', 'user']) {
      const denied = await request(server, 'GET', path, token)
      assert.equal(denied.status, 403, token)
      assert.equal(denied.body.error.code, 'MEMBER_ENFORCEMENT_FORBIDDEN')
    }
    const allowed = await request(server, 'GET', path, 'enforcer')
    assert.equal(allowed.status, 200)
    assert.deepEqual(Object.keys(allowed.body.member).sort(), ['account', 'displayName', 'id'])
    assert.equal(JSON.stringify(allowed.body).includes('email'), false)
  })

  it('rejects forged command fields and returns a bounded success DTO', async () => {
    accountEnforcementReversalApplicationService.reverseDecision = async (actor, input) => {
      if (actor.memberEnforcementEnabled !== true) {
        throw new ApiProblem(403, 'MEMBER_ENFORCEMENT_FORBIDDEN', 'forbidden')
      }
      return {
        kind: 'committed',
        operationId: input.operationId,
        reversal: {
          id: '444444444444444444444444',
          targetUserId: TARGET,
          performedByUserId: ACTOR,
          reversesDecisionId: input.decisionId,
          effectiveAt: new Date('2035-09-02T00:00:00.000Z'),
          reasonCode: 'admin.reversal',
          reasonSummary: input.reasonSummary,
          memberFacingReasonSummary: '經重新審查後，此正式警告已撤銷。',
        },
      }
    }
    const server = await start()
    const path = `/api/admin/enforcement-decisions/${DECISION}/reversal`
    const base = {
      operationId: 'reversal.api.1',
      reasonSummary: 'Internal reason',
      memberFacingReasonCode: 'warning_reversed_after_review_v1',
    }
    for (const forged of [
      { actorUserId: ACTOR },
      { targetUserId: TARGET },
      { effectiveAt: '2035-01-01' },
      { reasonCode: 'forged' },
      { commandDigest: 'a'.repeat(64) },
    ]) {
      const result = await request(server, 'POST', path, 'enforcer', { ...base, ...forged })
      assert.equal(result.status, 400)
    }
    assert.equal((await request(server, 'POST', path, 'viewer', base)).status, 403)
    const result = await request(server, 'POST', path, 'enforcer', base)
    assert.equal(result.status, 200)
    assert.equal(result.body.reversal.effectiveAt, '2035-09-02T00:00:00.000Z')
    assert.equal(JSON.stringify(result.body).includes('reporter'), false)
  })

  it('rejects unknown query fields and malformed JSON with the exact problem envelope', async () => {
    installReads()
    const server = await start()
    const invalid = await request(
      server,
      'GET',
      `/api/admin/enforcement-decisions?targetUserId=${TARGET}&include=email`,
      'enforcer',
    )
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.error.code, 'ADMIN_ENFORCEMENT_TARGET_INVALID')
  })
})

import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { after, afterEach, before, describe, it } from 'node:test'
import express from 'express'
import passport from 'passport'
import adminCaseRouter from '../src/routes/adminCase.ts'
import { errorHandler } from '../src/middlewares/errorHandler.ts'
import { assertMemberEnforcementAuthorized } from '../src/policies/memberEnforcementAuthorizationPolicy.ts'
import {
  CaseEnforcementServiceError,
  caseEnforcementService,
} from '../src/services/caseEnforcementService.ts'
import { AccountEnforcementAction } from '../src/models/accountEnforcementActionModel.ts'

const REPORT = '111111111111111111111111'
const DECISION = '222222222222222222222222'
const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const originalRecord = caseEnforcementService.recordInitialDecision
const originalEnforcementFind = AccountEnforcementAction.find
const servers = new Set()

class TestJwtStrategy extends passport.Strategy {
  name = 'jwt'
  authenticate(req) {
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    if (!token) return this.fail()
    return this.success({
      _id: ACTOR,
      role: token === 'user' ? 'user' : 'admin',
      memberEnforcementEnabled: token === 'enforcer',
    })
  }
}

before(() => {
  passport.use(new TestJwtStrategy())
  AccountEnforcementAction.find = () => ({
    sort() {
      return this
    },
    async lean() {
      return []
    },
  })
})
after(() => {
  AccountEnforcementAction.find = originalEnforcementFind
})
afterEach(async () => {
  caseEnforcementService.recordInitialDecision = originalRecord
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))))
  servers.clear()
})

const activeState = (evaluatedAt) => ({
  status: 'active',
  evaluatedAt,
  governingDecisionId: null,
  activeRestrictionDecisionIds: [],
  restrictionEndsAt: null,
})

const install = (handler) => {
  caseEnforcementService.recordInitialDecision = async (actor, reportId, input) => {
    const evaluatedAt = new Date('2035-09-01T00:00:00.000Z')
    await assertMemberEnforcementAuthorized(actor, evaluatedAt, async () =>
      activeState(evaluatedAt),
    )
    return handler(actor, reportId, input)
  }
}

const start = async () => {
  const app = express()
  app.use(express.json())
  app.use(passport.initialize())
  app.use('/api/admin/cases', adminCaseRouter)
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  servers.add(server)
  await once(server, 'listening')
  return server
}

const request = (server, token, body) =>
  new Promise((resolve, reject) => {
    const address = server.address()
    const raw = JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path: `/api/admin/cases/${REPORT}/enforcement-decisions`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(raw),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }),
        )
      },
    )
    req.on('error', reject)
    req.end(raw)
  })

const requestRaw = (server, token, raw) =>
  new Promise((resolve, reject) => {
    const address = server.address()
    const req = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path: `/api/admin/cases/${REPORT}/enforcement-decisions`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(raw),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString()
          resolve({ status: res.statusCode, body: JSON.parse(text), text })
        })
      },
    )
    req.on('error', reject)
    req.end(raw)
  })

const command = {
  operationId: 'case.enforcement.api-1',
  reviewDecisionId: DECISION,
  decisionType: 'formal_warning',
  reasonSummary: '會員可見的正式警告理由。',
  reasonCode: 'targeted_harassment',
  guidelineRuleId: 'CG-001',
  guidelineVersion: '1.0.0',
}

describe('Admin Case Enforcement API', () => {
  it('maps malformed JSON to the bounded enforcement input contract without parser leakage', async () => {
    install(() => assert.fail('malformed JSON must not reach the enforcement service'))
    const raw = '{"reasonSummary":"private-sentinel",'
    const result = await requestRaw(await start(), 'enforcer', raw)
    assert.equal(result.status, 400)
    assert.deepEqual(result.body, {
      error: {
        code: 'CASE_ENFORCEMENT_INPUT_INVALID',
        message: 'Enforcement command input is invalid',
        details: {},
      },
    })
    assert.equal(result.text.includes('private-sentinel'), false)
    assert.equal(result.text.includes('JSON'), false)
    assert.equal(result.text.includes('Unexpected'), false)
  })

  it('returns the backend-authoritative catalog only to an authorized enforcer', async () => {
    const server = await start()
    const get = (token) =>
      new Promise((resolve, reject) => {
        const address = server.address()
        const req = http.get(
          {
            host: '127.0.0.1',
            port: address.port,
            path: '/api/admin/cases/enforcement-guidelines',
            headers: { Authorization: `Bearer ${token}` },
          },
          (res) => {
            const chunks = []
            res.on('data', (chunk) => chunks.push(chunk))
            res.on('end', () =>
              resolve({
                status: res.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              }),
            )
          },
        )
        req.on('error', reject)
      })
    const allowed = await get('enforcer')
    assert.equal(allowed.status, 200)
    assert.deepEqual(
      allowed.body.guidelines.map(({ guidelineRuleId, reasonCode, guidelineVersion }) => ({
        guidelineRuleId,
        reasonCode,
        guidelineVersion,
      })),
      [
        { guidelineRuleId: 'CG-001', reasonCode: 'targeted_harassment', guidelineVersion: '1.0.0' },
        { guidelineRuleId: 'CG-002', reasonCode: 'unwanted_contact', guidelineVersion: '1.0.0' },
        { guidelineRuleId: 'CG-003', reasonCode: 'spam_or_abuse', guidelineVersion: '1.0.0' },
        { guidelineRuleId: 'CG-004', reasonCode: 'privacy_violation', guidelineVersion: '1.0.0' },
      ],
    )
    assert.equal((await get('reports-only')).status, 403)
  })
  it('denies Reports-only, Case-only, missing, invalid, and non-Admin actors', async () => {
    install(() => assert.fail('unauthorized handler must not execute'))
    const server = await start()
    for (const token of ['reports-only', 'case-only', 'legacy-admin', 'user']) {
      const result = await request(server, token, command)
      assert.equal(result.status, 403, token)
      assert.equal(result.body.error.code, 'MEMBER_ENFORCEMENT_FORBIDDEN')
    }
  })

  it('rejects forged authority and target fields before the service', async () => {
    install(() => assert.fail('invalid body must not reach service'))
    const server = await start()
    for (const extra of [
      { targetUserId: 'bbbbbbbbbbbbbbbbbbbbbbbb' },
      { performedByUserId: 'bbbbbbbbbbbbbbbbbbbbbbbb' },
      { memberEnforcementEnabled: true },
    ]) {
      const result = await request(server, 'enforcer', { ...command, ...extra })
      assert.equal(result.status, 400)
      assert.equal(result.body.error.code, 'CASE_ENFORCEMENT_INPUT_INVALID')
    }
  })

  it('preserves No Action bodies with optional reasonCode and optional complete guideline fields', async () => {
    const observed = []
    install((_actor, _reportId, input) => {
      observed.push(input)
      return {
        kind: 'committed',
        operationId: input.operationId,
        action: {
          id: '333333333333333333333333',
          reviewDecisionId: input.reviewDecisionId,
          targetUserId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
          decisionType: input.decisionType,
          effectiveAt: new Date('2035-09-01T00:00:00.000Z'),
          performedByUserId: ACTOR,
          ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
          reasonSummary: input.reasonSummary,
          ...(input.guidelineRuleId
            ? {
                guidelineRuleId: input.guidelineRuleId,
                guidelineVersion: input.guidelineVersion,
              }
            : {}),
        },
      }
    })
    const server = await start()
    const base = {
      operationId: 'case.enforcement.no-action-api',
      reviewDecisionId: DECISION,
      decisionType: 'no_action',
      reasonSummary: 'No Action remains reasoned and non-punitive.',
    }
    for (const body of [
      base,
      { ...base, operationId: `${base.operationId}-reason`, reasonCode: 'targeted_harassment' },
      {
        ...base,
        operationId: `${base.operationId}-guideline`,
        reasonCode: 'targeted_harassment',
        guidelineRuleId: 'CG-001',
        guidelineVersion: '1.0.0',
      },
    ]) {
      assert.equal((await request(server, 'enforcer', body)).status, 200)
    }
    assert.equal(observed.length, 3)
    assert.equal(observed[0].reasonCode, undefined)
    assert.equal(observed[1].reasonCode, 'targeted_harassment')
    assert.equal(observed[1].guidelineRuleId, undefined)
    assert.equal(observed[2].guidelineRuleId, 'CG-001')
  })

  it('returns a bounded DTO for an explicitly authorized actor', async () => {
    install((actor, reportId, input) => ({
      kind: 'committed',
      operationId: input.operationId,
      action: {
        id: '333333333333333333333333',
        reviewDecisionId: input.reviewDecisionId,
        targetUserId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        decisionType: input.decisionType,
        effectiveAt: new Date('2035-09-01T00:00:00.000Z'),
        performedByUserId: actor._id,
        reasonCode: 'test-only.reason',
        reasonSummary: input.reasonSummary,
        guidelineRuleId: 'test-only.rule',
        guidelineVersion: 'test-only.v1',
      },
    }))
    const result = await request(await start(), 'enforcer', command)
    assert.equal(result.status, 200)
    assert.equal(result.body.action.reviewDecisionId, DECISION)
    assert.equal(result.body.action.effectiveAt, '2035-09-01T00:00:00.000Z')
    assert.equal(JSON.stringify(result.body).includes('reporter'), false)
  })

  it('surfaces the missing approved catalog as a fail-closed 503', async () => {
    install(() => {
      throw new CaseEnforcementServiceError(
        'CASE_ENFORCEMENT_POLICY_UNAVAILABLE',
        'Approved enforcement guideline and reason catalog is unavailable',
      )
    })
    const result = await request(await start(), 'enforcer', command)
    assert.equal(result.status, 503)
    assert.equal(result.body.error.code, 'CASE_ENFORCEMENT_POLICY_UNAVAILABLE')
  })
})

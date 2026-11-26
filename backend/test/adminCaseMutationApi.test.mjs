import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import { once } from 'node:events'
import { afterEach, before, describe, it } from 'node:test'
import express from 'express'
import passport from 'passport'
import { ApiProblem } from '../src/utils/messagingPolicy.ts'
import adminCaseRouter from '../src/routes/adminCase.ts'
import { errorHandler } from '../src/middlewares/errorHandler.ts'
import {
  CaseTransactionServiceError,
  caseTransactionService,
  createCaseTransactionService,
} from '../src/services/caseTransactionService.ts'

const REPORT = '111111111111111111111111'
const OTHER_REPORT = '444444444444444444444444'
const CASE = '222222222222222222222222'
const DECISION = '333333333333333333333333'
const ADMIN_A = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const ADMIN_B = 'bbbbbbbbbbbbbbbbbbbbbbbb'
const USER = 'cccccccccccccccccccccccc'
const WHEN = new Date('2035-08-20T12:00:00.000Z')
const PRIVATE = 'private-message-must-not-leak'

const originalBeginReview = caseTransactionService.beginReview
const originalFinalizeReview = caseTransactionService.finalizeReview
const servers = new Set()
const observedAuthorizationHeaders = []
const passportActors = []
const mutationActors = []

class TestJwtStrategy extends passport.Strategy {
  name = 'jwt'

  authenticate(req) {
    observedAuthorizationHeaders.push(req.headers.authorization ?? null)
    const token = req.headers.authorization?.replace(/^Bearer /, '')
    if (!token || token === 'invalid') return this.fail()
    const succeed = (actor) => {
      passportActors.push(actor)
      return this.success(actor)
    }
    if (token === 'admin-a')
      return succeed({
        _id: ADMIN_A,
        role: 'admin',
        active: true,
        caseReviewMutationEnabled: true,
      })
    if (token === 'admin-b')
      return succeed({
        _id: ADMIN_B,
        role: 'admin',
        active: true,
        caseReviewMutationEnabled: true,
      })
    if (token === 'reports-only')
      return succeed({
        _id: ADMIN_B,
        role: 'admin',
        active: true,
        caseReviewMutationEnabled: false,
      })
    if (token === 'legacy-admin')
      return succeed({
        _id: ADMIN_B,
        role: 'admin',
        active: true,
      })
    if (token === 'invalid-capability')
      return succeed({
        _id: ADMIN_B,
        role: 'admin',
        active: true,
        caseReviewMutationEnabled: 'true',
      })
    if (token === 'inactive-admin') {
      return succeed({ _id: ADMIN_A, role: 'admin', active: false })
    }
    return succeed({
      _id: USER,
      role: 'user',
      active: true,
      capabilities: { viewReports: true },
    })
  }
}

before(() => passport.use(new TestJwtStrategy()))

const cloneMap = (value) => new Map([...value].map(([key, item]) => [key, structuredClone(item)]))

const makeStore = () => ({
  reports: new Set([REPORT, OTHER_REPORT]),
  cases: new Map(),
  decisions: new Map(),
  events: new Map(),
  trace: [],
  casMiss: false,
  duplicateCase: false,
  transactionUnavailable: false,
  unknownAfterCommit: false,
  sequence: 0,
})

const makeRepository = (store) => {
  const touch = (name) => store.trace.push(name)
  return {
    async reportExists(reportId) {
      touch('reportExists')
      return store.reports.has(reportId)
    },
    async findCaseByReportId(reportId) {
      touch('findCaseByReportId')
      return [...store.cases.values()].find((value) => value.reportId === reportId) ?? null
    },
    async findCaseById(caseId) {
      touch('findCaseById')
      return store.cases.get(caseId) ?? null
    },
    async createCase(value) {
      touch('createCase')
      if (store.duplicateCase)
        throw Object.assign(new Error('duplicate private detail'), { code: 11000 })
      store.cases.set(value.id, structuredClone(value))
      return value
    },
    async finalizeCase(caseId, expectedRevision, decisionId, completedAt) {
      touch('finalizeCase')
      const current = store.cases.get(caseId)
      if (
        store.casMiss ||
        !current ||
        current.state !== 'under_review' ||
        current.revision !== expectedRevision ||
        current.decisionId !== undefined
      ) {
        return null
      }
      const updated = {
        ...current,
        state: 'review_completed',
        revision: current.revision + 1,
        decisionId,
        completedAt,
      }
      store.cases.set(caseId, updated)
      return updated
    },
    async findDecisionById(decisionId) {
      touch('findDecisionById')
      return store.decisions.get(decisionId) ?? null
    },
    async createDecision(value) {
      touch('createDecision')
      store.decisions.set(value.id, structuredClone(value))
      return value
    },
    async findEventByOperationId(operationId) {
      touch('findEventByOperationId')
      return store.events.get(operationId) ?? null
    },
    async findEventByCaseAndAction(caseId, action) {
      touch('findEventByCaseAndAction')
      return (
        [...store.events.values()].find(
          (value) => value.caseId === caseId && value.action === action,
        ) ?? null
      )
    },
    async createEvent(value) {
      touch('createEvent')
      const event = {
        id: `eeeeeeeeeeeeeeeeeeeeee${String(++store.sequence).padStart(2, '0')}`,
        ...structuredClone(value),
      }
      store.events.set(value.operationId, event)
      return event
    },
  }
}

const transactionRunner = (store) => async (operation) => {
  store.trace.push('transaction')
  if (store.transactionUnavailable) throw new Error('database endpoint must not leak')
  const snapshot = {
    cases: cloneMap(store.cases),
    decisions: cloneMap(store.decisions),
    events: cloneMap(store.events),
  }
  let result
  try {
    result = await operation({ synthetic: true })
  } catch (error) {
    store.cases = snapshot.cases
    store.decisions = snapshot.decisions
    store.events = snapshot.events
    throw error
  }
  if (store.unknownAfterCommit) {
    store.unknownAfterCommit = false
    throw Object.assign(new Error('unknown private transaction state'), {
      hasErrorLabel: (label) => label === 'UnknownTransactionCommitResult',
    })
  }
  return result
}

const installService = (store) => {
  const service = createCaseTransactionService({
    repository: makeRepository(store),
    transactionRunner: transactionRunner(store),
    authorize: async (actor) => {
      store.trace.push('authorize')
      if (actor.role !== 'admin' || actor.active !== true) {
        throw new ApiProblem(403, 'REPORT_REVIEW_FORBIDDEN', 'Report Review permission is required')
      }
      if (actor.caseReviewMutationEnabled !== true) {
        throw new ApiProblem(403, 'CASE_REVIEW_FORBIDDEN', 'Case Review permission is required')
      }
    },
    now: () => new Date(WHEN),
    newId: () => (store.cases.size === 0 ? CASE : DECISION),
  })
  caseTransactionService.beginReview = (actor, input) => {
    mutationActors.push({ action: 'begin_review', actor })
    return service.beginReview(actor, input)
  }
  caseTransactionService.finalizeReview = (actor, input) => {
    mutationActors.push({ action: 'finalize_review', actor })
    return service.finalizeReview(actor, input)
  }
}

const startServer = async () => {
  const app = express()
  app.use(express.json({ limit: '100kb' }))
  app.use(passport.initialize())
  app.use('/api/admin/cases', adminCaseRouter)
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  servers.add(server)
  await once(server, 'listening')
  return server
}

const request = (server, path, { token, method = 'POST', body, rawBody } = {}) =>
  new Promise((resolve, reject) => {
    const address = server.address()
    assert(address && typeof address === 'object')
    const payload =
      rawBody === undefined ? (body === undefined ? null : JSON.stringify(body)) : rawBody
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`
    if (payload !== null) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const outgoing = http.request(
      { host: '127.0.0.1', port: address.port, method, path, headers },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let responseBody = null
          if (raw) {
            try {
              responseBody = JSON.parse(raw)
            } catch {
              responseBody = raw
            }
          }
          resolve({ status: response.statusCode, body: responseBody })
        })
      },
    )
    outgoing.on('error', reject)
    if (payload !== null) outgoing.write(payload)
    outgoing.end()
  })

const begin = (server, operationId = 'begin-1', token = 'admin-a', reportId = REPORT) =>
  request(server, `/api/admin/cases/${reportId}/begin-review`, {
    token,
    body: { operationId },
  })

const finalize = (
  server,
  {
    operationId = 'finalize-1',
    token = 'admin-a',
    reportId = REPORT,
    caseId = CASE,
    expectedRevision = 1,
    conclusion = 'violation_confirmed',
    rationale = 'Bounded synthetic rationale',
  } = {},
) =>
  request(server, `/api/admin/cases/${reportId}/finalize-review`, {
    token,
    body: { operationId, caseId, expectedRevision, conclusion, rationale },
  })

const assertPrivateDataAbsent = (body) => {
  const serialized = JSON.stringify(body)
  for (const forbidden of [
    PRIVATE,
    'messageEvidence',
    'conversationId',
    'commandDigest',
    'mongodb',
    'database endpoint',
  ]) {
    assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden)
  }
}

afterEach(async () => {
  caseTransactionService.beginReview = originalBeginReview
  caseTransactionService.finalizeReview = originalFinalizeReview
  passportActors.length = 0
  mutationActors.length = 0
  await Promise.all(
    [...servers].map(async (server) => {
      server.close()
      await once(server, 'close')
      servers.delete(server)
    }),
  )
})

describe('Admin Case mutation API', { concurrency: false }, () => {
  it('passes the exact Passport actor through the post-authentication mutation boundary', async () => {
    const store = makeStore()
    installService(store)
    const server = await startServer()

    assert.equal((await begin(server)).status, 200)
    assert.equal((await finalize(server, { token: 'admin-b' })).status, 200)
    assert.deepEqual(
      mutationActors.map(({ action }) => action),
      ['begin_review', 'finalize_review'],
    )
    assert.strictEqual(mutationActors[0].actor, passportActors[0])
    assert.strictEqual(mutationActors[1].actor, passportActors[1])
    assert.equal(mutationActors[0].actor._id, ADMIN_A)
    assert.equal(mutationActors[1].actor._id, ADMIN_B)
  })

  it('protects both routes with JWT and fails closed for unauthorized identities before reads', async () => {
    const store = makeStore()
    installService(store)
    const server = await startServer()

    observedAuthorizationHeaders.length = 0
    assert.equal((await begin(server, 'begin-auth', null)).status, 401)
    assert.equal(observedAuthorizationHeaders.at(-1), null)
    assert.equal((await begin(server, 'begin-auth', 'invalid')).status, 401)
    assert.equal(mutationActors.length, 0)
    for (const token of ['user', 'inactive-admin']) {
      store.trace.length = 0
      const response = await begin(server, 'begin-auth', token)
      assert.equal(response.status, 403, token)
      assert.equal(response.body.error.code, 'REPORT_REVIEW_FORBIDDEN', token)
      assert.deepEqual(store.trace, ['transaction', 'authorize'], token)
    }

    assert.equal(
      (await finalize(server, { operationId: 'finalize-auth', token: null })).status,
      401,
    )
    assert.equal(observedAuthorizationHeaders.at(-1), null)
    assert.equal(
      (await finalize(server, { operationId: 'finalize-auth', token: 'invalid' })).status,
      401,
    )
    assert.equal(mutationActors.filter(({ action }) => action === 'finalize_review').length, 0)
    for (const token of ['user', 'inactive-admin']) {
      store.trace.length = 0
      const response = await finalize(server, { operationId: 'finalize-auth', token })
      assert.equal(response.status, 403, token)
      assert.equal(response.body.error.code, 'REPORT_REVIEW_FORBIDDEN', token)
      assert.deepEqual(store.trace, ['transaction', 'authorize'], token)
    }
  })

  it('denies missing, false, and invalid capabilities without changing operation state', async () => {
    const store = makeStore()
    installService(store)
    const server = await startServer()

    for (const token of ['legacy-admin', 'reports-only', 'invalid-capability']) {
      const deniedBegin = await begin(server, `${token}-begin`, token)
      assert.equal(deniedBegin.status, 403, token)
      assert.equal(deniedBegin.body.error.code, 'CASE_REVIEW_FORBIDDEN', token)
      assert.equal(store.cases.size, 0, token)
      assert.equal(store.decisions.size, 0, token)
      assert.equal(store.events.size, 0, token)
    }

    await begin(server, 'full-admin-begin')
    const beforeCase = structuredClone(store.cases.get(CASE))
    for (const token of ['legacy-admin', 'reports-only', 'invalid-capability']) {
      const deniedFinalize = await finalize(server, {
        operationId: `${token}-finalize`,
        token,
      })
      assert.equal(deniedFinalize.status, 403, token)
      assert.equal(deniedFinalize.body.error.code, 'CASE_REVIEW_FORBIDDEN', token)
      assert.deepEqual(store.cases.get(CASE), beforeCase, token)
      assert.equal(store.decisions.size, 0, token)
      assert.equal(store.events.size, 1, token)
      assert.equal([...store.events.values()][0].action, 'review_started', token)
    }
  })

  it('sanitizes primitive and malformed JSON on both mutation routes', async () => {
    const store = makeStore()
    installService(store)
    const server = await startServer()
    const paths = [
      `/api/admin/cases/${REPORT}/begin-review`,
      `/api/admin/cases/${REPORT}/finalize-review`,
    ]
    const rawBodies = ['null', `"${PRIVATE}"`, '42', 'true', `{"operationId":"${PRIVATE}"`]

    for (const path of paths) {
      for (const rawBody of rawBodies) {
        store.trace.length = 0
        const response = await request(server, path, { token: 'admin-a', rawBody })
        assert.equal(response.status, 400, `${path}: ${rawBody}`)
        assert.deepEqual(response.body, {
          error: {
            code: 'CASE_INPUT_INVALID',
            message: 'Case command input is invalid',
            details: {},
          },
        })
        assert.deepEqual(store.trace, [])
        assertPrivateDataAbsent(response.body)
        assert.equal(JSON.stringify(response.body).includes('entity.parse.failed'), false)
        assert.equal(JSON.stringify(response.body).includes('SyntaxError'), false)
      }
    }
  })

  it('begins review with transaction-first authorization and an exact privacy-bounded DTO', async () => {
    const store = makeStore()
    installService(store)
    const server = await startServer()
    const response = await begin(server)

    assert.equal(response.status, 200)
    assert.deepEqual(response.body, {
      kind: 'committed',
      operationId: 'begin-1',
      case: {
        id: CASE,
        reportId: REPORT,
        state: 'under_review',
        revision: 1,
        reviewStartedByUserId: ADMIN_A,
        reviewStartedAt: WHEN.toISOString(),
        completedAt: null,
      },
    })
    assert.deepEqual(store.trace.slice(0, 3), [
      'transaction',
      'authorize',
      'findEventByOperationId',
    ])
    assertPrivateDataAbsent(response.body)
  })

  it('preserves the original Begin result when replayed after finalization', async () => {
    const store = makeStore()
    installService(store)
    const server = await startServer()

    assert.equal((await begin(server, 'begin-replay')).body.kind, 'committed')
    assert.equal(
      (await finalize(server, { operationId: 'finalize-later', token: 'admin-b' })).body.kind,
      'committed',
    )
    const replay = await begin(server, 'begin-replay')
    assert.equal(replay.status, 200)
    assert.equal(replay.body.kind, 'replayed')
    assert.equal(replay.body.case.state, 'under_review')
    assert.equal(replay.body.case.revision, 1)
    assert.equal(store.cases.get(CASE).state, 'review_completed')
  })

  it('allows another active Admin to finalize and returns only the accepted Decision DTO', async () => {
    const store = makeStore()
    installService(store)
    const server = await startServer()
    await begin(server)
    const response = await finalize(server, { token: 'admin-b' })

    assert.equal(response.status, 200)
    assert.equal(response.body.kind, 'committed')
    assert.deepEqual(Object.keys(response.body).sort(), ['case', 'decision', 'kind', 'operationId'])
    assert.deepEqual(Object.keys(response.body.case).sort(), [
      'completedAt',
      'id',
      'reportId',
      'reviewStartedAt',
      'reviewStartedByUserId',
      'revision',
      'state',
    ])
    assert.deepEqual(Object.keys(response.body.decision).sort(), [
      'caseRevision',
      'conclusion',
      'decidedAt',
      'decidedByUserId',
      'id',
      'rationale',
    ])
    assert.equal(response.body.case.state, 'review_completed')
    assert.equal(response.body.case.revision, 2)
    assert.equal(response.body.case.reviewStartedByUserId, ADMIN_A)
    assert.equal(response.body.decision.decidedByUserId, ADMIN_B)
    assertPrivateDataAbsent(response.body)
  })

  it('safely replays Finalize and rejects operationId reuse with changed payload or actor', async () => {
    const store = makeStore()
    installService(store)
    const server = await startServer()
    await begin(server)
    const committed = await finalize(server, { operationId: 'finalize-replay' })
    const replay = await finalize(server, { operationId: 'finalize-replay' })
    const changed = await finalize(server, {
      operationId: 'finalize-replay',
      rationale: 'Changed rationale',
    })

    assert.equal(committed.body.kind, 'committed')
    assert.equal(replay.status, 200)
    assert.equal(replay.body.kind, 'replayed')
    assert.deepEqual(replay.body.decision, committed.body.decision)
    assert.equal(changed.status, 409)
    assert.equal(changed.body.error.code, 'CASE_OPERATION_ID_REUSED')

    const otherStore = makeStore()
    installService(otherStore)
    const otherServer = await startServer()
    await begin(otherServer, 'actor-bound')
    const changedActor = await begin(otherServer, 'actor-bound', 'admin-b')
    assert.equal(changedActor.status, 409)
    assert.equal(changedActor.body.error.code, 'CASE_OPERATION_ID_REUSED')
  })

  it('rejects missing Reports, stale revisions, Case/Report mismatch, and finalized transitions', async () => {
    const missingStore = makeStore()
    missingStore.reports.delete(OTHER_REPORT)
    installService(missingStore)
    let server = await startServer()
    const missing = await begin(server, 'missing', 'admin-a', OTHER_REPORT)
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'CASE_REPORT_NOT_FOUND')

    const store = makeStore()
    installService(store)
    server = await startServer()
    await begin(server)
    const started = await begin(server, 'second-begin')
    assert.equal(started.status, 409)
    assert.equal(started.body.error.code, 'CASE_ALREADY_STARTED')
    const stale = await finalize(server, { operationId: 'stale', expectedRevision: 0 })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'CASE_STALE_REVISION')
    const mismatch = await finalize(server, { operationId: 'mismatch', reportId: OTHER_REPORT })
    assert.equal(mismatch.status, 409)
    assert.equal(mismatch.body.error.code, 'CASE_INVALID_TRANSITION')
    await finalize(server)
    const finalized = await finalize(server, { operationId: 'again' })
    assert.equal(finalized.status, 409)
    assert.equal(finalized.body.error.code, 'CASE_ALREADY_FINALIZED')
  })

  it('maps CAS and duplicate-key conflicts without leaking persistence detail', async () => {
    const duplicateStore = makeStore()
    duplicateStore.duplicateCase = true
    installService(duplicateStore)
    let server = await startServer()
    const duplicate = await begin(server, 'duplicate')
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.body.error.code, 'CASE_DUPLICATE_KEY_CONFLICT')
    assertPrivateDataAbsent(duplicate.body)

    const casStore = makeStore()
    installService(casStore)
    server = await startServer()
    await begin(server)
    casStore.casMiss = true
    const cas = await finalize(server, { operationId: 'cas-conflict' })
    assert.equal(cas.status, 409)
    assert.equal(cas.body.error.code, 'CASE_CAS_CONFLICT')
  })

  it('returns unconfirmed with same-operation retry guidance and then reconciles replay', async () => {
    const store = makeStore()
    installService(store)
    const server = await startServer()
    store.unknownAfterCommit = true
    const unknown = await begin(server, 'unknown-commit')

    assert.equal(unknown.status, 503)
    assert.equal(unknown.body.error.code, 'CASE_OPERATION_UNCONFIRMED')
    assert.deepEqual(unknown.body.error.details, {
      operationId: 'unknown-commit',
      retryWithSameOperationId: true,
    })
    const retry = await begin(server, 'unknown-commit')
    assert.equal(retry.status, 200)
    assert.equal(retry.body.kind, 'replayed')
  })

  it('maps transaction unavailability and persistence integrity failures to sanitized responses', async () => {
    const unavailableStore = makeStore()
    unavailableStore.transactionUnavailable = true
    installService(unavailableStore)
    let server = await startServer()
    const unavailable = await begin(server, 'unavailable')
    assert.equal(unavailable.status, 503)
    assert.equal(unavailable.body.error.code, 'CASE_TRANSACTION_UNAVAILABLE')
    assertPrivateDataAbsent(unavailable.body)

    const corruptStore = makeStore()
    corruptStore.cases.set(CASE, {
      id: CASE,
      reportId: REPORT,
      state: 'under_review',
      reviewStartedByUserId: ADMIN_A,
      reviewStartedAt: WHEN,
      revision: 2,
    })
    installService(corruptStore)
    server = await startServer()
    const corrupt = await finalize(server, { operationId: 'corrupt' })
    assert.equal(corrupt.status, 500)
    assert.equal(corrupt.body.error.code, 'CASE_PERSISTENCE_INTEGRITY')
    assertPrivateDataAbsent(corrupt.body)
  })

  it('rejects invalid and extra Begin bodies using CASE_INPUT_INVALID', async () => {
    const store = makeStore()
    installService(store)
    const server = await startServer()
    for (const body of [
      {},
      [],
      { operationId: 1 },
      { operationId: '' },
      { operationId: 'UPPERCASE' },
      { operationId: 'valid', reportId: REPORT },
      { operationId: 'valid', extra: true },
    ]) {
      const response = await request(server, `/api/admin/cases/${REPORT}/begin-review`, {
        token: 'admin-a',
        body,
      })
      assert.equal(response.status, 400, JSON.stringify(body))
      assert.equal(response.body.error.code, 'CASE_INPUT_INVALID', JSON.stringify(body))
    }
  })

  it('rejects caller-supplied authority and evidence fields on both mutation routes', async () => {
    const store = makeStore()
    installService(store)
    const server = await startServer()
    const injected = {
      actorUserId: ADMIN_A,
      authenticatedActor: { _id: ADMIN_A, role: 'admin' },
      commandDigest: '0'.repeat(64),
      dependencies: {},
      identity: { kind: 'MATCH' },
      persistence: { kind: 'COMMITTED', graph: 'COMPLETE' },
      provenance: { source: 'caller' },
      normalReplay: { kind: 'ELIGIBLE' },
      review: { kind: 'INDEPENDENTLY_AUTHORIZED' },
    }
    const finalizeBody = {
      operationId: 'authority-finalize',
      caseId: CASE,
      expectedRevision: 1,
      conclusion: 'violation_confirmed',
      rationale: 'Valid rationale',
    }

    for (const [field, value] of Object.entries(injected)) {
      const beginResponse = await request(server, `/api/admin/cases/${REPORT}/begin-review`, {
        token: 'admin-a',
        body: { operationId: `authority-begin-${field}`, [field]: value },
      })
      assert.equal(beginResponse.status, 400, `begin:${field}`)
      assert.equal(beginResponse.body.error.code, 'CASE_INPUT_INVALID', `begin:${field}`)

      const finalizeResponse = await request(server, `/api/admin/cases/${REPORT}/finalize-review`, {
        token: 'admin-a',
        body: { ...finalizeBody, operationId: `authority-finalize-${field}`, [field]: value },
      })
      assert.equal(finalizeResponse.status, 400, `finalize:${field}`)
      assert.equal(finalizeResponse.body.error.code, 'CASE_INPUT_INVALID', `finalize:${field}`)
    }
    assert.equal(mutationActors.length, 0)
    assert.deepEqual(store.trace, [])
  })

  it('rejects invalid Finalize bodies, conclusions, revisions, and rationales', async () => {
    const store = makeStore()
    installService(store)
    const server = await startServer()
    await begin(server)
    const valid = {
      operationId: 'invalid-finalize',
      caseId: CASE,
      expectedRevision: 1,
      conclusion: 'violation_confirmed',
      rationale: 'Valid rationale',
    }
    const invalidBodies = [
      { ...valid, extra: true },
      { ...valid, caseId: 'not-an-id' },
      { ...valid, expectedRevision: -1 },
      { ...valid, expectedRevision: 1.5 },
      { ...valid, conclusion: 'appealed' },
      { ...valid, rationale: '   ' },
      { ...valid, rationale: '😀'.repeat(1001) },
    ]
    for (const [index, body] of invalidBodies.entries()) {
      body.operationId = `invalid-finalize-${index}`
      const response = await request(server, `/api/admin/cases/${REPORT}/finalize-review`, {
        token: 'admin-a',
        body,
      })
      assert.equal(response.status, 400, String(index))
      assert.equal(response.body.error.code, 'CASE_INPUT_INVALID', String(index))
      assertPrivateDataAbsent(response.body)
    }
  })

  it('maps every typed service error to the authorized HTTP status and exact envelope', async () => {
    const mappings = {
      CASE_INPUT_INVALID: 400,
      CASE_REPORT_NOT_FOUND: 404,
      CASE_INVALID_TRANSITION: 409,
      CASE_STALE_REVISION: 409,
      CASE_ALREADY_STARTED: 409,
      CASE_ALREADY_FINALIZED: 409,
      CASE_OPERATION_ID_REUSED: 409,
      CASE_CAS_CONFLICT: 409,
      CASE_DUPLICATE_KEY_CONFLICT: 409,
      CASE_TRANSACTION_UNAVAILABLE: 503,
      CASE_OPERATION_UNCONFIRMED: 503,
      CASE_PERSISTENCE_INTEGRITY: 500,
    }
    const server = await startServer()
    for (const [code, status] of Object.entries(mappings)) {
      caseTransactionService.beginReview = async () => {
        throw new CaseTransactionServiceError(code, 'Safe bounded error', 'mapping-operation')
      }
      const response = await begin(server, 'mapping-operation')
      assert.equal(response.status, status, code)
      assert.equal(response.body.error.code, code)
      assert.equal(response.body.error.message, 'Safe bounded error')
      assert.equal(response.body.error.details.operationId, 'mapping-operation')
      assert.deepEqual(Object.keys(response.body.error).sort(), ['code', 'details', 'message'])
      assertPrivateDataAbsent(response.body)
    }
  })

  it('adds no unrelated mutation routes and no Case evidence endpoint', async () => {
    const store = makeStore()
    installService(store)
    const server = await startServer()
    for (const path of [
      '/api/admin/cases',
      `/api/admin/cases/${REPORT}`,
      `/api/admin/cases/${REPORT}/evidence`,
      `/api/admin/cases/${REPORT}/reopen`,
      `/api/admin/cases/${REPORT}/appeal`,
      `/api/admin/cases/${REPORT}/reassign`,
    ]) {
      const response = await request(server, path, { token: 'admin-a', body: {} })
      assert.equal(response.status, 404, path)
    }
  })

  it('does not wire Reader, Provider, IS-1, recovery, or evidence execution into HTTP', async () => {
    const sources = await Promise.all(
      [
        '../src/server.ts',
        '../src/routes/adminCase.ts',
        '../src/controllers/adminCaseController.ts',
      ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
    )
    for (const source of sources) {
      for (const forbidden of [
        'casePersistenceEvidenceReader',
        'casePersistenceEvidenceProvider',
        'caseEvidenceClassificationPolicy',
        'REPLAY_CANDIDATE',
        'NON_COMMITTED',
        'Recovery Review',
      ]) {
        assert.equal(source.includes(forbidden), false, forbidden)
      }
    }
  })
})

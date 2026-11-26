import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CASE_TRANSACTION_OPTIONS,
  CaseTransactionServiceError,
  createCaseTransactionService,
  deriveBeginReviewCommandDigest,
  deriveFinalizeReviewCommandDigest,
} from '../dist/services/caseTransactionService.js'
import { ApiProblem } from '../dist/utils/messagingPolicy.js'
import { AccountEnforcementAction } from '../dist/models/accountEnforcementActionModel.js'
import { evaluateAccountEnforcementState } from '../dist/services/accountEnforcementService.js'

const REPORT = '111111111111111111111111'
const CASE = '222222222222222222222222'
const DECISION = '333333333333333333333333'
const OTHER_REPORT = '444444444444444444444444'
const OTHER_CASE = '555555555555555555555555'
const OTHER_DECISION = '666666666666666666666666'
const ACTOR_A = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const ACTOR_B = 'bbbbbbbbbbbbbbbbbbbbbbbb'
const EVENT = 'eeeeeeeeeeeeeeeeeeeeeeee'
const WHEN = new Date('2026-10-18T01:02:03.000Z')

const actor = (id = ACTOR_A) => ({
  _id: id,
  role: 'admin',
  caseReviewMutationEnabled: true,
})

const expectCode = async (promise, code) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof CaseTransactionServiceError || error instanceof ApiProblem, true)
    assert.equal(error.code, code)
    return true
  })
}

const makeStore = () => ({
  reports: new Set([REPORT]),
  cases: new Map(),
  decisions: new Map(),
  events: new Map(),
  sessions: [],
  failAt: null,
  casMiss: false,
})

const cloneMap = (map) => new Map([...map].map(([key, value]) => [key, structuredClone(value)]))

const makeRepository = (store) => {
  const use = (name, session) => {
    store.sessions.push({ name, session })
    if (store.failAt === name) throw new Error(`synthetic ${name} failure`)
  }
  return {
    async reportExists(reportId, session) {
      use('reportExists', session)
      return store.reports.has(reportId)
    },
    async findCaseByReportId(reportId, session) {
      use('findCaseByReportId', session)
      return [...store.cases.values()].find((value) => value.reportId === reportId) ?? null
    },
    async findCaseById(caseId, session) {
      use('findCaseById', session)
      return store.cases.get(caseId) ?? null
    },
    async createCase(value, session) {
      use('createCase', session)
      if ([...store.cases.values()].some((item) => item.reportId === value.reportId)) {
        throw Object.assign(new Error('duplicate'), { code: 11000 })
      }
      store.cases.set(value.id, structuredClone(value))
      return value
    },
    async finalizeCase(caseId, expectedRevision, decisionId, completedAt, session) {
      use('finalizeCase', session)
      const current = store.cases.get(caseId)
      if (
        store.casMiss ||
        !current ||
        current.state !== 'under_review' ||
        current.revision !== expectedRevision ||
        current.decisionId !== undefined
      )
        return null
      const updated = {
        ...current,
        state: 'review_completed',
        decisionId,
        completedAt,
        revision: current.revision + 1,
      }
      store.cases.set(caseId, updated)
      return updated
    },
    async findDecisionById(decisionId, session) {
      use('findDecisionById', session)
      return store.decisions.get(decisionId) ?? null
    },
    async createDecision(value, session) {
      use('createDecision', session)
      if (
        [...store.decisions.values()].some(
          (item) => item.reportId === value.reportId || item.caseId === value.caseId,
        )
      ) {
        throw Object.assign(new Error('duplicate'), { code: 11000 })
      }
      store.decisions.set(value.id, structuredClone(value))
      return value
    },
    async findEventByOperationId(operationId, session) {
      use('findEventByOperationId', session)
      return store.events.get(operationId) ?? null
    },
    async findEventByCaseAndAction(caseId, action, session) {
      use('findEventByCaseAndAction', session)
      return (
        [...store.events.values()].find(
          (value) => value.caseId === caseId && value.action === action,
        ) ?? null
      )
    },
    async createEvent(value, session) {
      use('createEvent', session)
      if (store.events.has(value.operationId))
        throw Object.assign(new Error('duplicate'), { code: 11000 })
      const result = { id: EVENT, ...structuredClone(value) }
      store.events.set(value.operationId, result)
      return result
    },
  }
}

const rollbackRunner = (store) => async (operation, options) => {
  assert.deepEqual(options, CASE_TRANSACTION_OPTIONS)
  const snapshot = {
    cases: cloneMap(store.cases),
    decisions: cloneMap(store.decisions),
    events: cloneMap(store.events),
  }
  try {
    return await operation({ token: Symbol('session') })
  } catch (error) {
    store.cases = snapshot.cases
    store.decisions = snapshot.decisions
    store.events = snapshot.events
    throw error
  }
}

const seedUnderReview = (store, starter = ACTOR_A) => {
  store.cases.set(CASE, {
    id: CASE,
    reportId: REPORT,
    state: 'under_review',
    reviewStartedByUserId: starter,
    reviewStartedAt: WHEN,
    revision: 1,
  })
}

const seedCompleted = (
  store,
  {
    operationId = 'finish-replay',
    starter = ACTOR_A,
    decider = ACTOR_A,
    conclusion = 'insufficient_evidence',
    rationale = 'Independent rationale',
  } = {},
) => {
  seedUnderReview(store, starter)
  store.cases.set(CASE, {
    ...store.cases.get(CASE),
    state: 'review_completed',
    decisionId: DECISION,
    completedAt: WHEN,
    revision: 2,
  })
  store.decisions.set(DECISION, {
    id: DECISION,
    caseId: CASE,
    reportId: REPORT,
    conclusion,
    rationale,
    reviewStartedByUserId: starter,
    decidedByUserId: decider,
    decidedAt: WHEN,
    caseRevision: 2,
  })
  store.events.set(operationId, {
    id: EVENT,
    caseId: CASE,
    reportId: REPORT,
    actorUserId: decider,
    action: 'review_completed',
    occurredAt: WHEN,
    outcome: 'succeeded',
    fromState: 'under_review',
    toState: 'review_completed',
    fromRevision: 1,
    toRevision: 2,
    operationId,
    commandDigest: deriveFinalizeReviewCommandDigest(
      REPORT,
      CASE,
      decider,
      1,
      conclusion,
      rationale,
    ),
    decisionId: DECISION,
  })
}

const makeService = (store, overrides = {}) => {
  return createCaseTransactionService({
    repository: makeRepository(store),
    transactionRunner: rollbackRunner(store),
    authorize: async () => {},
    now: () => new Date(WHEN),
    newId: () => (store.cases.has(CASE) ? DECISION : CASE),
    ...overrides,
  })
}

const makeCompletedBeginReplay = async () => {
  const store = makeStore()
  const service = makeService(store)
  await service.beginReview(actor(), { operationId: 'begin-then-finalize', reportId: REPORT })
  await service.finalizeReview(actor(ACTOR_B), {
    operationId: 'later-finalize',
    reportId: REPORT,
    caseId: CASE,
    expectedRevision: 1,
    conclusion: 'no_violation_found',
    rationale: 'Independent rationale',
  })
  return { store, service }
}

test('command digests are deterministic, versioned, actor-bound and payload-bound', () => {
  assert.equal(
    deriveBeginReviewCommandDigest(REPORT, ACTOR_A),
    deriveBeginReviewCommandDigest(REPORT, ACTOR_A),
  )
  assert.notEqual(
    deriveBeginReviewCommandDigest(REPORT, ACTOR_A),
    deriveBeginReviewCommandDigest(REPORT, ACTOR_B),
  )
  assert.notEqual(
    deriveFinalizeReviewCommandDigest(REPORT, CASE, ACTOR_A, 1, 'violation_confirmed', 'reason'),
    deriveFinalizeReviewCommandDigest(REPORT, CASE, ACTOR_A, 1, 'violation_confirmed', 'changed'),
  )
})

test('Begin Review creates Case and minimized event atomically using one session', async () => {
  const store = makeStore()
  const result = await makeService(store).beginReview(actor(), {
    operationId: 'begin-1',
    reportId: REPORT,
  })
  assert.equal(result.kind, 'committed')
  assert.deepEqual(result.case, {
    id: CASE,
    reportId: REPORT,
    state: 'under_review',
    reviewStartedByUserId: ACTOR_A,
    reviewStartedAt: WHEN,
    revision: 1,
  })
  const event = store.events.get('begin-1')
  assert.equal(event.action, 'review_started')
  assert.equal('rationale' in event, false)
  assert.equal('evidence' in event, false)
  assert.equal(new Set(store.sessions.map(({ session }) => session)).size, 1)
})

test('Begin Review rejects missing Report and existing started/completed Case', async () => {
  const missing = makeStore()
  missing.reports.clear()
  await expectCode(
    makeService(missing).beginReview(actor(), { operationId: 'missing', reportId: REPORT }),
    'CASE_REPORT_NOT_FOUND',
  )
  const started = makeStore()
  seedUnderReview(started)
  await expectCode(
    makeService(started).beginReview(actor(), { operationId: 'started', reportId: REPORT }),
    'CASE_ALREADY_STARTED',
  )
  started.cases.set(CASE, {
    ...started.cases.get(CASE),
    state: 'review_completed',
    decisionId: DECISION,
    completedAt: WHEN,
    revision: 2,
  })
  await expectCode(
    makeService(started).beginReview(actor(), { operationId: 'done', reportId: REPORT }),
    'CASE_ALREADY_FINALIZED',
  )
})

test('Begin Review same operation replays and changed actor is rejected', async () => {
  const store = makeStore()
  const service = makeService(store)
  await service.beginReview(actor(), { operationId: 'begin-replay', reportId: REPORT })
  const replay = await service.beginReview(actor(), {
    operationId: 'begin-replay',
    reportId: REPORT,
  })
  assert.equal(replay.kind, 'replayed')
  await expectCode(
    service.beginReview(actor(ACTOR_B), { operationId: 'begin-replay', reportId: REPORT }),
    'CASE_OPERATION_ID_REUSED',
  )
})

test('Begin replay accepts a legitimately finalized aggregate using one transaction session', async () => {
  const { store, service } = await makeCompletedBeginReplay()
  const beforeReplay = store.sessions.length
  assert.equal(
    (await service.beginReview(actor(), { operationId: 'begin-then-finalize', reportId: REPORT }))
      .kind,
    'replayed',
  )
  const replayReads = store.sessions.slice(beforeReplay)
  assert.ok(replayReads.some(({ name }) => name === 'findDecisionById'))
  assert.ok(replayReads.some(({ name }) => name === 'findEventByCaseAndAction'))
  assert.equal(new Set(replayReads.map(({ session }) => session)).size, 1)
})

test('Begin replay rejects start-time inconsistency after completion', async () => {
  const { store, service } = await makeCompletedBeginReplay()
  store.cases.get(CASE).reviewStartedAt = new Date(WHEN.valueOf() + 1)
  await expectCode(
    service.beginReview(actor(), { operationId: 'begin-then-finalize', reportId: REPORT }),
    'CASE_PERSISTENCE_INTEGRITY',
  )
})

test('Begin replay rejects missing or mismatched completed Decision relationships', async () => {
  const corruptions = [
    (store) => store.decisions.delete(DECISION),
    (store) => {
      store.decisions.get(DECISION).id = OTHER_DECISION
    },
    (store) => {
      store.decisions.get(DECISION).caseId = OTHER_CASE
    },
    (store) => {
      store.decisions.get(DECISION).reportId = OTHER_REPORT
    },
    (store) => {
      store.decisions.get(DECISION).reviewStartedByUserId = ACTOR_B
    },
    (store) => {
      store.decisions.get(DECISION).caseRevision = 1
    },
    (store) => {
      store.decisions.get(DECISION).decidedAt = new Date(WHEN.valueOf() + 1)
    },
    (store) => {
      store.decisions.get(DECISION).conclusion = 'unsupported_conclusion'
    },
    (store) => {
      store.decisions.get(DECISION).rationale = '   '
    },
    (store) => {
      store.decisions.get(DECISION).decidedByUserId = 'invalid-actor'
    },
  ]
  for (const corrupt of corruptions) {
    const { store, service } = await makeCompletedBeginReplay()
    corrupt(store)
    await expectCode(
      service.beginReview(actor(), { operationId: 'begin-then-finalize', reportId: REPORT }),
      'CASE_PERSISTENCE_INTEGRITY',
    )
  }
})

test('Begin replay rejects missing or inconsistent completion governance events', async () => {
  const corruptions = [
    (store) => store.events.delete('later-finalize'),
    (store) => {
      store.events.get('later-finalize').caseId = OTHER_CASE
    },
    (store) => {
      store.events.get('later-finalize').reportId = OTHER_REPORT
    },
    (store) => {
      store.events.get('later-finalize').decisionId = OTHER_DECISION
    },
    (store) => {
      store.events.get('later-finalize').actorUserId = ACTOR_A
    },
    (store) => {
      store.events.get('later-finalize').action = 'review_started'
    },
    (store) => {
      store.events.get('later-finalize').fromRevision = 0
    },
    (store) => {
      store.events.get('later-finalize').toRevision = 1
    },
    (store) => {
      store.events.get('later-finalize').occurredAt = new Date(WHEN.valueOf() + 1)
    },
    (store) => {
      store.events.get('later-finalize').commandDigest = '0'.repeat(64)
    },
  ]
  for (const corrupt of corruptions) {
    const { store, service } = await makeCompletedBeginReplay()
    corrupt(store)
    await expectCode(
      service.beginReview(actor(), { operationId: 'begin-then-finalize', reportId: REPORT }),
      'CASE_PERSISTENCE_INTEGRITY',
    )
  }
})

test('Begin replay reauthorizes the current reviewer before reconciliation reads', async () => {
  const { store } = await makeCompletedBeginReplay()
  const beforeReplay = store.sessions.length
  const denied = makeService(store, {
    authorize: async () => {
      throw new ApiProblem(403, 'REPORT_REVIEW_FORBIDDEN', 'forbidden')
    },
  })
  await expectCode(
    denied.beginReview(actor(), { operationId: 'begin-then-finalize', reportId: REPORT }),
    'REPORT_REVIEW_FORBIDDEN',
  )
  assert.equal(store.sessions.length, beforeReplay)
})

test('Begin replay integrity failures do not expose persisted private content', async () => {
  const { store, service } = await makeCompletedBeginReplay()
  const secret = 'PRIVATE-EVIDENCE-CONTENT'
  store.decisions.get(DECISION).rationale = secret.repeat(100)
  await assert.rejects(
    service.beginReview(actor(), { operationId: 'begin-then-finalize', reportId: REPORT }),
    (error) => {
      assert.equal(error.code, 'CASE_PERSISTENCE_INTEGRITY')
      assert.equal(error.message.includes(secret), false)
      assert.equal(JSON.stringify(error).includes(secret), false)
      return true
    },
  )
})

test('Begin Review rolls back Case if event append fails', async () => {
  const store = makeStore()
  store.failAt = 'createEvent'
  await expectCode(
    makeService(store).beginReview(actor(), { operationId: 'rollback', reportId: REPORT }),
    'CASE_TRANSACTION_UNAVAILABLE',
  )
  assert.equal(store.cases.size, 0)
  assert.equal(store.events.size, 0)
})

test('authorization denial fails closed before writes', async () => {
  const store = makeStore()
  const service = makeService(store, {
    authorize: async () => {
      throw new ApiProblem(403, 'REPORT_REVIEW_FORBIDDEN', 'forbidden')
    },
  })
  await expectCode(
    service.beginReview(actor(), { operationId: 'denied', reportId: REPORT }),
    'REPORT_REVIEW_FORBIDDEN',
  )
  assert.equal(store.cases.size, 0)
})

test('each retried transaction callback reauthorizes and uses its retry session', async () => {
  const store = makeStore()
  const repository = makeRepository(store)
  let authorizations = 0
  let attempts = 0
  const service = createCaseTransactionService({
    repository,
    authorize: async (_actor, _at, session) => {
      authorizations += 1
      assert.equal(session.attempt, attempts)
    },
    transactionRunner: async (operation) => {
      attempts = 1
      store.failAt = 'findEventByOperationId'
      await assert.rejects(operation({ attempt: 1 }))
      store.failAt = null
      attempts = 2
      return operation({ attempt: 2 })
    },
    now: () => WHEN,
    newId: () => CASE,
  })
  await service.beginReview(actor(), { operationId: 'retried', reportId: REPORT })
  assert.equal(authorizations, 2)
})

test('session-aware enforcement evaluation preserves the supplied transaction session', async () => {
  const originalFind = AccountEnforcementAction.find
  const session = { transaction: 'case-authorization' }
  let receivedSession
  const query = {
    sort() {
      return this
    },
    session(value) {
      receivedSession = value
      return this
    },
    async lean() {
      return []
    },
  }
  AccountEnforcementAction.find = () => query
  try {
    const result = await evaluateAccountEnforcementState(ACTOR_A, WHEN, { session })
    assert.equal(receivedSession, session)
    assert.equal(result.status, 'active')
  } finally {
    AccountEnforcementAction.find = originalFind
  }
})

for (const conclusion of ['violation_confirmed', 'no_violation_found', 'insufficient_evidence']) {
  test(`Finalize Review commits ${conclusion} with separate provenance`, async () => {
    const store = makeStore()
    seedUnderReview(store, ACTOR_A)
    const result = await makeService(store).finalizeReview(actor(ACTOR_B), {
      operationId: `finish-${conclusion}`,
      reportId: REPORT,
      caseId: CASE,
      expectedRevision: 1,
      conclusion,
      rationale: '  independently authored 😀  ',
    })
    assert.equal(result.kind, 'committed')
    assert.equal(result.case.state, 'review_completed')
    assert.equal(result.decision.reviewStartedByUserId, ACTOR_A)
    assert.equal(result.decision.decidedByUserId, ACTOR_B)
    assert.equal(result.decision.rationale, 'independently authored 😀')
    assert.equal(store.events.values().next().value.rationale, undefined)
  })
}

test('Finalize Review allows same reviewer without imposing ownership', async () => {
  const store = makeStore()
  seedUnderReview(store)
  const result = await makeService(store).finalizeReview(actor(), {
    operationId: 'same-reviewer',
    reportId: REPORT,
    caseId: CASE,
    expectedRevision: 1,
    conclusion: 'no_violation_found',
    rationale: 'Independent rationale',
  })
  assert.equal(result.decision.reviewStartedByUserId, result.decision.decidedByUserId)
})

test('Finalize Review enforces rationale type, blank and Unicode code-point limit', async () => {
  for (const [suffix, rationale] of [
    ['blank', '   '],
    ['type', 42],
    ['long', '😀'.repeat(1001)],
  ]) {
    const store = makeStore()
    seedUnderReview(store)
    await expectCode(
      makeService(store).finalizeReview(actor(), {
        operationId: `bad-${suffix}`,
        reportId: REPORT,
        caseId: CASE,
        expectedRevision: 1,
        conclusion: 'violation_confirmed',
        rationale,
      }),
      'CASE_INPUT_INVALID',
    )
  }
  const store = makeStore()
  seedUnderReview(store)
  const result = await makeService(store).finalizeReview(actor(), {
    operationId: 'max-unicode',
    reportId: REPORT,
    caseId: CASE,
    expectedRevision: 1,
    conclusion: 'violation_confirmed',
    rationale: '😀'.repeat(1000),
  })
  assert.equal([...result.decision.rationale].length, 1000)
})

test('Finalize Review distinguishes stale revision, finalized state, and CAS conflict', async () => {
  const stale = makeStore()
  seedUnderReview(stale)
  await expectCode(
    makeService(stale).finalizeReview(actor(), {
      operationId: 'stale',
      reportId: REPORT,
      caseId: CASE,
      expectedRevision: 0,
      conclusion: 'violation_confirmed',
      rationale: 'reason',
    }),
    'CASE_STALE_REVISION',
  )

  const done = makeStore()
  seedUnderReview(done)
  done.cases.set(CASE, {
    ...done.cases.get(CASE),
    state: 'review_completed',
    decisionId: DECISION,
    completedAt: WHEN,
    revision: 2,
  })
  await expectCode(
    makeService(done).finalizeReview(actor(), {
      operationId: 'done-finalize',
      reportId: REPORT,
      caseId: CASE,
      expectedRevision: 2,
      conclusion: 'violation_confirmed',
      rationale: 'reason',
    }),
    'CASE_ALREADY_FINALIZED',
  )

  const cas = makeStore()
  seedUnderReview(cas)
  cas.casMiss = true
  await expectCode(
    makeService(cas).finalizeReview(actor(), {
      operationId: 'cas',
      reportId: REPORT,
      caseId: CASE,
      expectedRevision: 1,
      conclusion: 'violation_confirmed',
      rationale: 'reason',
    }),
    'CASE_CAS_CONFLICT',
  )
})

test('Finalize Review rejects corrupted persisted under-review revisions', async () => {
  for (const revision of [0, 2, Number.MAX_SAFE_INTEGER]) {
    const store = makeStore()
    seedUnderReview(store)
    store.cases.get(CASE).revision = revision
    await expectCode(
      makeService(store).finalizeReview(actor(), {
        operationId: `corrupt-revision-${revision}`,
        reportId: REPORT,
        caseId: CASE,
        expectedRevision: revision,
        conclusion: 'violation_confirmed',
        rationale: 'Independent rationale',
      }),
      'CASE_PERSISTENCE_INTEGRITY',
    )
  }
})

test('Finalize Review same operation replays complete state and rejects changed command', async () => {
  const store = makeStore()
  seedUnderReview(store)
  const service = makeService(store)
  const command = {
    operationId: 'finish-replay',
    reportId: REPORT,
    caseId: CASE,
    expectedRevision: 1,
    conclusion: 'insufficient_evidence',
    rationale: 'Independent rationale',
  }
  await service.finalizeReview(actor(), command)
  assert.equal((await service.finalizeReview(actor(), command)).kind, 'replayed')
  await expectCode(
    service.finalizeReview(actor(), { ...command, rationale: 'Changed rationale' }),
    'CASE_OPERATION_ID_REUSED',
  )
})

test('Finalize replay rejects altered persisted Decision semantics and provenance', async () => {
  const corruptions = [
    (store) => {
      store.decisions.get(DECISION).conclusion = 'violation_confirmed'
    },
    (store) => {
      store.decisions.get(DECISION).rationale = 'Altered rationale'
    },
    (store) => {
      store.decisions.get(DECISION).reviewStartedByUserId = ACTOR_B
    },
    (store) => {
      store.decisions.get(DECISION).decidedAt = new Date(WHEN.valueOf() + 1)
    },
    (store) => {
      store.cases.get(CASE).completedAt = new Date(WHEN.valueOf() + 1)
    },
    (store) => {
      store.events.get('finish-replay').occurredAt = new Date(WHEN.valueOf() + 1)
    },
  ]
  for (const corrupt of corruptions) {
    const store = makeStore()
    seedCompleted(store)
    corrupt(store)
    await expectCode(
      makeService(store).finalizeReview(actor(), {
        operationId: 'finish-replay',
        reportId: REPORT,
        caseId: CASE,
        expectedRevision: 1,
        conclusion: 'insufficient_evidence',
        rationale: 'Independent rationale',
      }),
      'CASE_PERSISTENCE_INTEGRITY',
    )
  }

  const digestStore = makeStore()
  seedCompleted(digestStore)
  digestStore.events.get('finish-replay').commandDigest = '0'.repeat(64)
  await expectCode(
    makeService(digestStore).finalizeReview(actor(), {
      operationId: 'finish-replay',
      reportId: REPORT,
      caseId: CASE,
      expectedRevision: 1,
      conclusion: 'insufficient_evidence',
      rationale: 'Independent rationale',
    }),
    'CASE_OPERATION_ID_REUSED',
  )
})

test('global operationId namespace rejects cross-action reuse', async () => {
  const store = makeStore()
  const service = makeService(store)
  await service.beginReview(actor(), { operationId: 'cross-action', reportId: REPORT })
  await expectCode(
    service.finalizeReview(actor(), {
      operationId: 'cross-action',
      reportId: REPORT,
      caseId: CASE,
      expectedRevision: 1,
      conclusion: 'violation_confirmed',
      rationale: 'Independent rationale',
    }),
    'CASE_OPERATION_ID_REUSED',
  )
})

test('different finalization operations produce one winner', async () => {
  const store = makeStore()
  seedUnderReview(store)
  const service = makeService(store)
  await service.finalizeReview(actor(), {
    operationId: 'winner',
    reportId: REPORT,
    caseId: CASE,
    expectedRevision: 1,
    conclusion: 'violation_confirmed',
    rationale: 'winner rationale',
  })
  await expectCode(
    service.finalizeReview(actor(), {
      operationId: 'loser',
      reportId: REPORT,
      caseId: CASE,
      expectedRevision: 1,
      conclusion: 'no_violation_found',
      rationale: 'loser rationale',
    }),
    'CASE_ALREADY_FINALIZED',
  )
  assert.equal(store.decisions.size, 1)
})

test('decision or event failure rolls back completed Case', async () => {
  for (const failAt of ['createDecision', 'createEvent']) {
    const store = makeStore()
    seedUnderReview(store)
    store.failAt = failAt
    await expectCode(
      makeService(store).finalizeReview(actor(), {
        operationId: `fail-${failAt.toLowerCase()}`,
        reportId: REPORT,
        caseId: CASE,
        expectedRevision: 1,
        conclusion: 'violation_confirmed',
        rationale: 'reason',
      }),
      'CASE_TRANSACTION_UNAVAILABLE',
    )
    assert.equal(store.cases.get(CASE).state, 'under_review')
    assert.equal(store.decisions.size, 0)
    assert.equal(store.events.size, 0)
  }
})

test('duplicate key is separately classified without database detail leakage', async () => {
  const store = makeStore()
  const service = makeService(store, {
    transactionRunner: async () => {
      throw Object.assign(new Error('secret index detail'), { code: 11000 })
    },
  })
  await assert.rejects(
    service.beginReview(actor(), { operationId: 'duplicate', reportId: REPORT }),
    (error) => {
      assert.equal(error.code, 'CASE_DUPLICATE_KEY_CONFLICT')
      assert.equal(error.message.includes('secret'), false)
      return true
    },
  )
})

test('unknown commit result returns unconfirmed and later same-operation retry reconciles', async () => {
  const store = makeStore()
  const repository = makeRepository(store)
  const unknown = Object.assign(new Error('unknown'), {
    hasErrorLabel: (label) => label === 'UnknownTransactionCommitResult',
  })
  const uncertain = createCaseTransactionService({
    repository,
    transactionRunner: async (operation) => {
      await operation({ attempt: 1 })
      throw unknown
    },
    authorize: async () => {},
    now: () => WHEN,
    newId: () => CASE,
  })
  await expectCode(
    uncertain.beginReview(actor(), { operationId: 'unknown-commit', reportId: REPORT }),
    'CASE_OPERATION_UNCONFIRMED',
  )
  const retry = createCaseTransactionService({
    repository,
    transactionRunner: async (operation) => operation({ attempt: 2 }),
    authorize: async () => {},
    now: () => WHEN,
    newId: () => CASE,
  })
  assert.equal(
    (await retry.beginReview(actor(), { operationId: 'unknown-commit', reportId: REPORT })).kind,
    'replayed',
  )
})

test('Finalize unknown commit result is unconfirmed and a later caller retry reconciles', async () => {
  const store = makeStore()
  seedUnderReview(store)
  const repository = makeRepository(store)
  const unknown = Object.assign(new Error('unknown'), {
    hasErrorLabel: (label) => label === 'UnknownTransactionCommitResult',
  })
  const uncertain = createCaseTransactionService({
    repository,
    transactionRunner: async (operation) => {
      await operation({ attempt: 1 })
      throw unknown
    },
    authorize: async () => {},
    now: () => WHEN,
    newId: () => DECISION,
  })
  const command = {
    operationId: 'finalize-unknown',
    reportId: REPORT,
    caseId: CASE,
    expectedRevision: 1,
    conclusion: 'insufficient_evidence',
    rationale: 'Independent rationale',
  }
  await expectCode(uncertain.finalizeReview(actor(), command), 'CASE_OPERATION_UNCONFIRMED')

  const retry = createCaseTransactionService({
    repository,
    transactionRunner: async (operation) => operation({ attempt: 2 }),
    authorize: async () => {},
    now: () => WHEN,
    newId: () => DECISION,
  })
  assert.equal((await retry.finalizeReview(actor(), command)).kind, 'replayed')
})

test('inconsistent replay event and aggregate fails with integrity code', async () => {
  const store = makeStore()
  seedUnderReview(store)
  store.events.set('corrupt', {
    id: EVENT,
    caseId: CASE,
    reportId: REPORT,
    actorUserId: ACTOR_A,
    action: 'review_started',
    occurredAt: WHEN,
    outcome: 'succeeded',
    fromState: 'needs_review',
    toState: 'under_review',
    fromRevision: 0,
    toRevision: 99,
    operationId: 'corrupt',
    commandDigest: deriveBeginReviewCommandDigest(REPORT, ACTOR_A),
  })
  await expectCode(
    makeService(store).beginReview(actor(), { operationId: 'corrupt', reportId: REPORT }),
    'CASE_PERSISTENCE_INTEGRITY',
  )
})

test('operation validation and service errors do not include rationale or private evidence', async () => {
  const store = makeStore()
  seedUnderReview(store)
  const secret = 'PRIVATE-EVIDENCE-CONTENT'
  await assert.rejects(
    makeService(store).finalizeReview(actor(), {
      operationId: 'privacy',
      reportId: REPORT,
      caseId: CASE,
      expectedRevision: 1,
      conclusion: 'violation_confirmed',
      rationale: secret.repeat(100),
    }),
    (error) => {
      assert.equal(error.message.includes(secret), false)
      assert.equal(JSON.stringify(error).includes(secret), false)
      return true
    },
  )
})

test('unexpected command fields are rejected instead of becoming unbound semantics', async () => {
  const store = makeStore()
  await expectCode(
    Promise.resolve().then(() =>
      makeService(store).beginReview(actor(), {
        operationId: 'extra-field',
        reportId: REPORT,
        evidence: 'must not be accepted',
      }),
    ),
    'CASE_INPUT_INVALID',
  )
  assert.equal(store.cases.size, 0)
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import {
  CaseEnforcementServiceError,
  createCaseEnforcementService,
} from '../dist/services/caseEnforcementService.js'

const REPORT = '111111111111111111111111'
const OTHER_REPORT = '111111111111111111111112'
const CASE = '222222222222222222222222'
const DECISION = '333333333333333333333333'
const TARGET = '444444444444444444444444'
const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const WHEN = new Date('2035-09-01T00:00:00.000Z')
const objectId = (value) => new Types.ObjectId(value)

const actor = (enabled = true) => ({
  _id: ACTOR,
  role: 'admin',
  memberEnforcementEnabled: enabled,
})
const command = (overrides = {}) => ({
  operationId: 'case.enforcement.service-1',
  reviewDecisionId: DECISION,
  decisionType: 'formal_warning',
  reasonSummary: '會員可見的正式警告理由。',
  ...((overrides.decisionType ?? 'formal_warning') === 'formal_warning'
    ? {
        reasonCode: 'targeted_harassment',
        guidelineRuleId: 'CG-001',
        guidelineVersion: '1.0.0',
      }
    : {}),
  ...overrides,
})

const makeStore = (conclusion = 'violation_confirmed') => ({
  decisions: new Map([
    [
      DECISION,
      {
        _id: objectId(DECISION),
        caseId: objectId(CASE),
        reportId: objectId(REPORT),
        conclusion,
      },
    ],
  ]),
  cases: new Map([
    [
      CASE,
      {
        _id: objectId(CASE),
        reportId: objectId(REPORT),
        state: 'review_completed',
        decisionId: objectId(DECISION),
      },
    ],
  ]),
  reports: new Map([[REPORT, { _id: objectId(REPORT), reportedUserId: objectId(TARGET) }]]),
  actionsByOperation: new Map(),
  actionsByDecision: new Map(),
  writes: 0,
  failCreate: false,
})

const makeRepository = (store) => ({
  async findActionByOperationId(id) {
    return store.actionsByOperation.get(id) ?? null
  },
  async findActionByReviewDecisionId(id) {
    return store.actionsByDecision.get(id) ?? null
  },
  async findReviewDecision(id) {
    return store.decisions.get(id) ?? null
  },
  async findReviewCase(id) {
    return store.cases.get(id) ?? null
  },
  async findReport(id) {
    return store.reports.get(id) ?? null
  },
  async createAction(value) {
    await Promise.resolve()
    if (store.failCreate) throw new Error('synthetic write failure')
    if (
      store.actionsByOperation.has(value.operationId) ||
      store.actionsByDecision.has(value.reviewDecisionId)
    ) {
      throw Object.assign(new Error('duplicate'), { code: 11000 })
    }
    const action = { _id: objectId('555555555555555555555555'), ...value }
    store.actionsByOperation.set(value.operationId, action)
    store.actionsByDecision.set(value.reviewDecisionId, action)
    store.writes += 1
    return action
  },
})

const makeService = (store, options = {}) =>
  createCaseEnforcementService({
    repository: makeRepository(store),
    transactionRunner: async (operation) => operation({ synthetic: true }),
    authorize: async (value) => {
      if (value.memberEnforcementEnabled !== true) {
        throw Object.assign(new Error('forbidden'), {
          status: 403,
          code: 'MEMBER_ENFORCEMENT_FORBIDDEN',
        })
      }
    },
    resolveGuideline:
      options.resolveGuideline === undefined
        ? (_conclusion, _decisionType, requested) => requested
        : options.resolveGuideline,
    now: () => new Date(WHEN),
  })

describe('Case Enforcement service', () => {
  it('records No Action for all three conclusions and derives actor/target provenance', async () => {
    for (const conclusion of [
      'violation_confirmed',
      'no_violation_found',
      'insufficient_evidence',
    ]) {
      const store = makeStore(conclusion)
      const result = await makeService(store).recordInitialDecision(
        actor(),
        REPORT,
        command({ operationId: `case.enforcement.${conclusion}`, decisionType: 'no_action' }),
      )
      assert.equal(result.kind, 'committed')
      assert.equal(result.action.targetUserId, TARGET)
      assert.equal(result.action.performedByUserId, ACTOR)
      assert.equal(result.action.reviewDecisionId, DECISION)
      assert.equal(result.action.reasonCode, undefined)
      assert.equal(result.action.guidelineRuleId, undefined)
      assert.equal(result.action.guidelineVersion, undefined)
      assert.equal(store.writes, 1)
    }
  })

  it('records Formal Warning only for violation_confirmed', async () => {
    const committedStore = makeStore()
    assert.equal(
      (await makeService(committedStore).recordInitialDecision(actor(), REPORT, command())).action
        .decisionType,
      'formal_warning',
    )
    assert.equal(
      committedStore.actionsByDecision.get(DECISION).memberNoticeProvenance,
      'stage_b_formal_warning_v1',
    )
    const publicResult = await makeService(makeStore()).recordInitialDecision(
      actor(),
      REPORT,
      command({ operationId: 'case.enforcement.public-contract' }),
    )
    assert.equal(Object.hasOwn(publicResult.action, 'memberNoticeProvenance'), false)
    for (const conclusion of ['no_violation_found', 'insufficient_evidence']) {
      const store = makeStore(conclusion)
      await assert.rejects(
        makeService(store).recordInitialDecision(actor(), REPORT, command()),
        (error) =>
          error instanceof CaseEnforcementServiceError &&
          error.code === 'CASE_ENFORCEMENT_ACTION_NOT_ALLOWED',
      )
      assert.equal(store.writes, 0)
    }
  })

  it('preserves the approved optional-guideline No Action contract', async () => {
    const withoutGuideline = makeStore()
    const plain = await makeService(withoutGuideline).recordInitialDecision(
      actor(),
      REPORT,
      command({ decisionType: 'no_action' }),
    )
    assert.equal(plain.action.reasonCode, undefined)
    assert.equal(withoutGuideline.actionsByDecision.get(DECISION).memberNoticeProvenance, undefined)

    const reasonOnlyStore = makeStore()
    const reasonOnly = await makeService(reasonOnlyStore).recordInitialDecision(
      actor(),
      REPORT,
      command({
        operationId: 'case.enforcement.no-action-reason',
        decisionType: 'no_action',
        reasonCode: 'targeted_harassment',
      }),
    )
    assert.equal(reasonOnly.action.reasonCode, 'targeted_harassment')
    assert.equal(reasonOnly.action.guidelineRuleId, undefined)

    const guidelineStore = makeStore()
    const withGuideline = await makeService(guidelineStore).recordInitialDecision(
      actor(),
      REPORT,
      command({
        operationId: 'case.enforcement.no-action-guideline',
        decisionType: 'no_action',
        reasonCode: 'targeted_harassment',
        guidelineRuleId: 'CG-001',
        guidelineVersion: '1.0.0',
      }),
    )
    assert.equal(withGuideline.action.reasonCode, 'targeted_harassment')
    assert.equal(withGuideline.action.guidelineRuleId, 'CG-001')
    assert.equal(withGuideline.action.guidelineVersion, '1.0.0')
    assert.equal(guidelineStore.actionsByDecision.get(DECISION).memberNoticeProvenance, undefined)
  })

  it('rejects incomplete or non-canonical No Action guideline references without writes', async () => {
    const invalid = [
      { guidelineRuleId: 'CG-001' },
      { guidelineVersion: '1.0.0' },
      { guidelineRuleId: 'CG-001', guidelineVersion: '1.0.0' },
      {
        reasonCode: 'targeted_harassment',
        guidelineRuleId: 'CG-999',
        guidelineVersion: '1.0.0',
      },
      {
        reasonCode: 'targeted_harassment',
        guidelineRuleId: 'CG-001',
        guidelineVersion: '2.0.0',
      },
      {
        reasonCode: 'privacy_violation',
        guidelineRuleId: 'CG-001',
        guidelineVersion: '1.0.0',
      },
    ]
    for (const [index, override] of invalid.entries()) {
      const store = makeStore()
      const service = createCaseEnforcementService({
        repository: makeRepository(store),
        transactionRunner: async (operation) => operation({ synthetic: true }),
        authorize: async () => {},
        now: () => new Date(WHEN),
      })
      await assert.rejects(
        service.recordInitialDecision(
          actor(),
          REPORT,
          command({
            operationId: `case.enforcement.invalid-no-action-${index}`,
            decisionType: 'no_action',
            ...override,
          }),
        ),
        (error) => error.code === 'CASE_ENFORCEMENT_GUIDELINE_INVALID',
      )
      assert.equal(store.writes, 0)
    }
  })

  it('replays the same operation and rejects changed payload without a second write', async () => {
    const store = makeStore()
    const service = makeService(store)
    assert.equal(
      (await service.recordInitialDecision(actor(), REPORT, command())).kind,
      'committed',
    )
    assert.equal((await service.recordInitialDecision(actor(), REPORT, command())).kind, 'replayed')
    await assert.rejects(
      service.recordInitialDecision(actor(), REPORT, command({ reasonSummary: '不同內容。' })),
      (error) => error.code === 'CASE_ENFORCEMENT_OPERATION_ID_REUSED',
    )
    assert.equal(store.writes, 1)
  })

  it('permits at most one initial action per Review Decision', async () => {
    const store = makeStore()
    const service = makeService(store)
    await service.recordInitialDecision(actor(), REPORT, command())
    await assert.rejects(
      service.recordInitialDecision(
        actor(),
        REPORT,
        command({ operationId: 'case.enforcement.second', decisionType: 'no_action' }),
      ),
      (error) => error.code === 'CASE_ENFORCEMENT_ALREADY_RECORDED',
    )
    assert.equal(store.writes, 1)
  })

  it('rejects unrelated, cross-Report, missing, and incomplete sources without writes', async () => {
    const scenarios = [
      (store) => store.decisions.clear(),
      (store) => {
        store.decisions.get(DECISION).reportId = objectId(OTHER_REPORT)
      },
      (store) => {
        store.cases.get(CASE).state = 'under_review'
      },
      (store) => {
        store.cases.get(CASE).decisionId = objectId('333333333333333333333334')
      },
    ]
    for (const arrange of scenarios) {
      const store = makeStore()
      arrange(store)
      await assert.rejects(makeService(store).recordInitialDecision(actor(), REPORT, command()))
      assert.equal(store.writes, 0)
    }
  })

  it('runs shared-session source reads sequentially', async () => {
    const store = makeStore()
    const session = { synthetic: true }
    const events = []
    let resolveReviewCase
    let signalReviewCaseStarted
    const reviewCaseStarted = new Promise((resolve) => {
      signalReviewCaseStarted = resolve
    })
    const reviewCaseResult = new Promise((resolve) => {
      resolveReviewCase = resolve
    })
    const repository = {
      ...makeRepository(store),
      async findReviewCase(id, receivedSession) {
        events.push('reviewCase:start')
        assert.equal(receivedSession, session)
        signalReviewCaseStarted()
        const result = await reviewCaseResult
        events.push('reviewCase:resolve')
        return result
      },
      async findReport(id, receivedSession) {
        events.push('report:start')
        assert.equal(receivedSession, session)
        return store.reports.get(id) ?? null
      },
    }
    const service = createCaseEnforcementService({
      repository,
      transactionRunner: async (operation) => operation(session),
      authorize: async () => {},
      resolveGuideline: (_conclusion, _decisionType, requested) => requested,
      now: () => new Date(WHEN),
    })

    const pending = service.recordInitialDecision(actor(), REPORT, command())
    await reviewCaseStarted
    assert.deepEqual(events, ['reviewCase:start'])

    resolveReviewCase(store.cases.get(CASE))
    const result = await pending
    assert.equal(result.kind, 'committed')
    assert.deepEqual(events, ['reviewCase:start', 'reviewCase:resolve', 'report:start'])
  })

  it('does not read the Report when the Review Case read rejects', async () => {
    const store = makeStore()
    let reportReads = 0
    const repository = {
      ...makeRepository(store),
      async findReviewCase() {
        throw new Error('synthetic Review Case read failure')
      },
      async findReport() {
        reportReads += 1
        return store.reports.get(REPORT)
      },
    }
    const service = createCaseEnforcementService({
      repository,
      transactionRunner: async (operation) => operation({ synthetic: true }),
      authorize: async () => {},
      resolveGuideline: (_conclusion, _decisionType, requested) => requested,
      now: () => new Date(WHEN),
    })

    await assert.rejects(
      service.recordInitialDecision(actor(), REPORT, command()),
      /synthetic Review Case read failure/,
    )
    assert.equal(reportReads, 0)
    assert.equal(store.writes, 0)
  })

  it('retains source-invalid results for null Review Case and Report reads', async () => {
    for (const missingSource of ['reviewCase', 'report']) {
      const store = makeStore()
      const repository = {
        ...makeRepository(store),
        ...(missingSource === 'reviewCase' ? { findReviewCase: async () => null } : {}),
        ...(missingSource === 'report' ? { findReport: async () => null } : {}),
      }
      const service = createCaseEnforcementService({
        repository,
        transactionRunner: async (operation) => operation({ synthetic: true }),
        authorize: async () => {},
        resolveGuideline: (_conclusion, _decisionType, requested) => requested,
        now: () => new Date(WHEN),
      })

      await assert.rejects(
        service.recordInitialDecision(actor(), REPORT, command()),
        (error) =>
          error instanceof CaseEnforcementServiceError &&
          error.code === 'CASE_ENFORCEMENT_SOURCE_INVALID',
      )
      assert.equal(store.writes, 0)
    }
  })

  it('fails closed when the approved guideline/reason catalog is unavailable', async () => {
    const store = makeStore()
    await assert.rejects(
      makeService(store, { resolveGuideline: () => undefined }).recordInitialDecision(
        actor(),
        REPORT,
        command(),
      ),
      (error) => error.code === 'CASE_ENFORCEMENT_POLICY_UNAVAILABLE',
    )
    assert.equal(store.writes, 0)
  })

  it('uses the production catalog to accept each approved Formal Warning mapping', async () => {
    const rules = [
      ['CG-001', 'targeted_harassment'],
      ['CG-002', 'unwanted_contact'],
      ['CG-003', 'spam_or_abuse'],
      ['CG-004', 'privacy_violation'],
    ]
    for (const [guidelineRuleId, reasonCode] of rules) {
      const store = makeStore()
      const service = createCaseEnforcementService({
        repository: makeRepository(store),
        transactionRunner: async (operation) => operation({ synthetic: true }),
        authorize: async () => {},
        now: () => new Date(WHEN),
      })
      const result = await service.recordInitialDecision(
        actor(),
        REPORT,
        command({
          operationId: `case.enforcement.${guidelineRuleId.toLowerCase()}`,
          guidelineRuleId,
          reasonCode,
        }),
      )
      assert.equal(result.action.guidelineRuleId, guidelineRuleId)
      assert.equal(result.action.reasonCode, reasonCode)
      assert.equal(result.action.guidelineVersion, '1.0.0')
      assert.equal(store.writes, 1)
    }
  })

  it('rejects unknown, wrong-version, and mismatched Formal Warning catalog choices', async () => {
    const invalid = [
      { guidelineRuleId: 'CG-999' },
      { guidelineVersion: '2.0.0' },
      { reasonCode: 'privacy_violation' },
    ]
    for (const override of invalid) {
      const store = makeStore()
      const service = createCaseEnforcementService({
        repository: makeRepository(store),
        transactionRunner: async (operation) => operation({ synthetic: true }),
        authorize: async () => {},
        now: () => new Date(WHEN),
      })
      await assert.rejects(
        service.recordInitialDecision(actor(), REPORT, command(override)),
        (error) => error.code === 'CASE_ENFORCEMENT_GUIDELINE_INVALID',
      )
      assert.equal(store.writes, 0)
    }
  })

  it('fails closed when the trusted guideline resolver returns invalid identifiers', async () => {
    const store = makeStore()
    await assert.rejects(
      makeService(store, {
        resolveGuideline: () => ({
          reasonCode: 'INVALID VALUE',
          guidelineRuleId: 'test-only.rule',
          guidelineVersion: 'test-only.v1',
        }),
      }).recordInitialDecision(actor(), REPORT, command()),
      (error) => error.code === 'CASE_ENFORCEMENT_POLICY_UNAVAILABLE',
    )
    assert.equal(store.writes, 0)
  })

  it('rejects blank No Action and Formal Warning reasons before source writes', async () => {
    for (const decisionType of ['no_action', 'formal_warning']) {
      const store = makeStore(decisionType === 'no_action' ? 'no_violation_found' : undefined)
      await assert.rejects(
        makeService(store).recordInitialDecision(
          actor(),
          REPORT,
          command({ decisionType, reasonSummary: '   ' }),
        ),
        (error) => error.code === 'CASE_ENFORCEMENT_INPUT_INVALID',
      )
      assert.equal(store.writes, 0)
    }
  })

  it('allows at most one concurrent initial action', async () => {
    const store = makeStore()
    const service = makeService(store)
    const results = await Promise.allSettled([
      service.recordInitialDecision(actor(), REPORT, command()),
      service.recordInitialDecision(
        actor(),
        REPORT,
        command({ operationId: 'case.enforcement.concurrent-2' }),
      ),
    ])
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
    assert.equal(store.writes, 1)
  })

  it('does not retain an action when persistence fails', async () => {
    const store = makeStore()
    store.failCreate = true
    await assert.rejects(makeService(store).recordInitialDecision(actor(), REPORT, command()))
    assert.equal(store.writes, 0)
    assert.equal(store.actionsByOperation.size, 0)
    assert.equal(store.actionsByDecision.size, 0)
  })
})

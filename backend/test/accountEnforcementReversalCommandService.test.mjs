import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import { AccountEnforcementAction } from '../dist/models/accountEnforcementActionModel.js'
import { User } from '../dist/models/userModel.js'
import { ApiProblem } from '../dist/utils/messagingPolicy.js'
import { evaluateAccountEnforcement } from '../dist/utils/accountEnforcementPolicy.js'
import { loadAccountEnforcementHistory } from '../dist/services/accountEnforcementService.js'
import {
  ACCOUNT_ENFORCEMENT_REVERSAL_REASON_CODE,
  AccountEnforcementReversalCommandError,
  createAccountEnforcementReversalCommandService,
} from '../dist/services/accountEnforcementReversalCommandService.js'

const DECISION = '111111111111111111111111'
const SECOND_DECISION = '111111111111111111111112'
const TARGET = '222222222222222222222222'
const ACTOR = 'aaaaaaaaaaaaaaaaaaaaaaaa'
const WHEN = new Date('2036-01-02T00:00:00.000Z')
const DECIDED_AT = new Date('2036-01-01T00:00:00.000Z')
const objectId = (value) => new Types.ObjectId(value)

const actor = (enabled = true) => ({
  _id: ACTOR,
  role: 'admin',
  memberEnforcementEnabled: enabled,
})

const command = (overrides = {}) => {
  const value = {
    operationId: 'reversal.command-1',
    decisionId: DECISION,
    reasonSummary: 'Internal administrative correction.',
    memberFacingReasonSummary: '已核准的會員可見撤銷理由。',
    ...overrides,
  }
  if (value.memberFacingReasonSummary === undefined) delete value.memberFacingReasonSummary
  return value
}

const sourceDecision = (decisionType = 'formal_warning', id = DECISION) => ({
  _id: objectId(id),
  targetUserId: objectId(TARGET),
  recordType: 'decision',
  decisionType,
  effectiveAt: DECIDED_AT,
  performedByUserId: objectId(ACTOR),
  reasonCode: 'test-only.original',
  reasonSummary: 'Original decision remains immutable.',
  createdAt: DECIDED_AT,
})

const makeStore = (decisionType = 'formal_warning') => ({
  decisions: new Map([[DECISION, sourceDecision(decisionType)]]),
  byOperation: new Map(),
  byDecision: new Map(),
  writes: 0,
  sessions: [],
  failCreate: null,
})

const makeRepository = (store) => ({
  async findDecisionById(id, session) {
    store.sessions.push(['decision', session])
    return store.decisions.get(id) ?? null
  },
  async findActionByOperationId(id, session) {
    store.sessions.push(['operation', session])
    return store.byOperation.get(id) ?? null
  },
  async findReversalByDecisionId(id, session) {
    store.sessions.push(['reversal', session])
    return store.byDecision.get(id) ?? null
  },
  async createReversal(value, session) {
    store.sessions.push(['create', session])
    if (store.failCreate) throw store.failCreate
    if (
      store.byOperation.has(value.operationId) ||
      store.byDecision.has(value.reversesDecisionId)
    ) {
      throw Object.assign(new Error('duplicate'), { code: 11000 })
    }
    const created = {
      _id: objectId('333333333333333333333333'),
      ...value,
      createdAt: value.effectiveAt,
    }
    store.byOperation.set(value.operationId, created)
    store.byDecision.set(value.reversesDecisionId, created)
    store.writes += 1
    return created
  },
})

const makeService = (store, options = {}) => {
  const session = options.session ?? { synthetic: 'session' }
  let authorizationCalls = 0
  const service = createAccountEnforcementReversalCommandService({
    repository: options.repository ?? makeRepository(store),
    transactionRunner: options.transactionRunner ?? (async (operation) => operation(session)),
    authorize:
      options.authorize ??
      (async (value, evaluatedAt, receivedSession) => {
        authorizationCalls += 1
        assert.equal(receivedSession, session)
        assert.equal(evaluatedAt.valueOf(), WHEN.valueOf())
        if (value.memberEnforcementEnabled !== true) {
          throw new ApiProblem(
            403,
            'MEMBER_ENFORCEMENT_FORBIDDEN',
            'Member Enforcement permission is required',
          )
        }
      }),
    now: () => new Date(WHEN),
  })
  return { service, session, authorizationCalls: () => authorizationCalls }
}

const isCode = (code) => (error) =>
  error instanceof AccountEnforcementReversalCommandError && error.code === code

describe('REV-02B1 dormant reversal command service (pure fake transaction tests)', () => {
  it('derives trusted Warning actor, target and time while preserving the original decision', async () => {
    const store = makeStore()
    const original = JSON.stringify(store.decisions.get(DECISION))
    const { service, session } = makeService(store)

    const result = await service.reverseDecision(actor(), command())

    assert.equal(result.kind, 'committed')
    assert.equal(result.reversal.targetUserId, TARGET)
    assert.equal(result.reversal.performedByUserId, ACTOR)
    assert.equal(result.reversal.effectiveAt.valueOf(), WHEN.valueOf())
    assert.equal(result.reversal.reasonCode, ACCOUNT_ENFORCEMENT_REVERSAL_REASON_CODE)
    assert.equal(result.reversal.memberFacingReasonSummary, '已核准的會員可見撤銷理由。')
    assert.equal(JSON.stringify(store.decisions.get(DECISION)), original)
    assert.equal(store.writes, 1)
    assert.ok(store.sessions.every(([, received]) => received === session))
  })

  it('authorizes Temporary Suspension but fail-closes Permanent Deactivation and No Action', async () => {
    const suspensionStore = makeStore('temporary_suspension')
    const suspension = await makeService(suspensionStore).service.reverseDecision(
      actor(),
      command({ memberFacingReasonSummary: undefined }),
    )
    assert.equal(suspension.kind, 'committed')

    const disclosedStore = makeStore('temporary_suspension')
    await assert.rejects(
      makeService(disclosedStore).service.reverseDecision(actor(), command()),
      isCode('ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID'),
    )
    assert.equal(disclosedStore.writes, 0)

    for (const [decisionType, expectedCode] of [
      ['permanent_deactivation', 'ACCOUNT_ENFORCEMENT_PERMANENT_REVERSAL_BLOCKED'],
      ['no_action', 'ACCOUNT_ENFORCEMENT_REVERSAL_DECISION_NOT_REVERSIBLE'],
    ]) {
      const store = makeStore(decisionType)
      await assert.rejects(
        makeService(store).service.reverseDecision(
          actor(),
          command({ memberFacingReasonSummary: undefined }),
        ),
        isCode(expectedCode),
      )
      assert.equal(store.writes, 0)
    }
  })

  it('requires a separately approved member-facing reason for Formal Warning', async () => {
    const store = makeStore()
    await assert.rejects(
      makeService(store).service.reverseDecision(
        actor(),
        command({ memberFacingReasonSummary: undefined }),
      ),
      isCode('ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID'),
    )
    assert.equal(store.writes, 0)
  })

  it('rejects a missing original decision and invalid or missing authenticated actors', async () => {
    const missing = makeStore()
    missing.decisions.clear()
    await assert.rejects(
      makeService(missing).service.reverseDecision(actor(), command()),
      isCode('ACCOUNT_ENFORCEMENT_REVERSAL_DECISION_NOT_FOUND'),
    )
    for (const invalidActor of [null, undefined, {}, { _id: 'not-an-object-id' }]) {
      const store = makeStore()
      await assert.rejects(
        makeService(store).service.reverseDecision(invalidActor, command()),
        isCode('ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID'),
      )
      assert.equal(store.writes, 0)
    }
  })

  it('accepts a genuine Mongoose actor document without accepting inherited identity spoofing', async () => {
    const mongooseActor = new User({
      _id: objectId(ACTOR),
      account: 'mvp-command-actor',
      email: 'mvp-command-actor@example.invalid',
      password: 'not-used',
      role: 'admin',
      caseReviewMutationEnabled: false,
      memberEnforcementEnabled: true,
    })
    assert.equal(Object.hasOwn(mongooseActor, '_id'), false)
    assert.equal(
      (await makeService(makeStore()).service.reverseDecision(mongooseActor, command())).kind,
      'committed',
    )

    const inheritedActor = Object.assign(Object.create({ _id: objectId(ACTOR) }), {
      role: 'admin',
      memberEnforcementEnabled: true,
    })
    assert.equal(Object.hasOwn(inheritedActor, '_id'), false)
    const store = makeStore()
    await assert.rejects(
      makeService(store).service.reverseDecision(inheritedActor, command()),
      isCode('ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID'),
    )
    assert.equal(store.writes, 0)
  })

  it('validates the server-owned clock and rejects a reversal that predates its decision', async () => {
    for (const [clock, expectedCode] of [
      [new Date('invalid'), 'ACCOUNT_ENFORCEMENT_REVERSAL_TRANSACTION_UNAVAILABLE'],
      [new Date(DECIDED_AT.valueOf() - 1), 'ACCOUNT_ENFORCEMENT_REVERSAL_PREDATES_DECISION'],
    ]) {
      const store = makeStore()
      const session = { synthetic: 'clock-session' }
      const service = createAccountEnforcementReversalCommandService({
        repository: makeRepository(store),
        transactionRunner: async (operation) => operation(session),
        authorize: async () => {},
        now: () => clock,
      })
      await assert.rejects(service.reverseDecision(actor(), command()), isCode(expectedCode))
      assert.equal(store.writes, 0)
    }
  })

  it('replays the exact command and rejects changed payload without a second write', async () => {
    const store = makeStore()
    const { service, authorizationCalls } = makeService(store)
    assert.equal((await service.reverseDecision(actor(), command())).kind, 'committed')
    assert.equal((await service.reverseDecision(actor(), command())).kind, 'replayed')
    await assert.rejects(
      service.reverseDecision(actor(), command({ reasonSummary: 'Changed payload.' })),
      isCode('ACCOUNT_ENFORCEMENT_REVERSAL_OPERATION_ID_REUSED'),
    )
    assert.equal(store.writes, 1)
    assert.equal(authorizationCalls(), 3)
  })

  it('rejects an operationId already owned by an enforcement decision', async () => {
    const store = makeStore()
    store.byOperation.set(command().operationId, {
      ...sourceDecision('formal_warning', SECOND_DECISION),
      operationId: command().operationId,
      commandDigest: 'a'.repeat(64),
    })
    await assert.rejects(
      makeService(store).service.reverseDecision(actor(), command()),
      isCode('ACCOUNT_ENFORCEMENT_REVERSAL_OPERATION_ID_REUSED'),
    )
    assert.equal(store.writes, 0)
  })

  it('reauthorizes replay and denies it after authorization is lost', async () => {
    const store = makeStore()
    const { service } = makeService(store)
    await service.reverseDecision(actor(), command())
    await assert.rejects(
      service.reverseDecision(actor(false), command()),
      (error) => error instanceof ApiProblem && error.code === 'MEMBER_ENFORCEMENT_FORBIDDEN',
    )
    assert.equal(store.writes, 1)
  })

  it('classifies an existing legacy reversal and unique-index concurrency failures', async () => {
    const legacyStore = makeStore('temporary_suspension')
    legacyStore.byDecision.set(DECISION, {
      _id: objectId('333333333333333333333334'),
      recordType: 'reversal',
      targetUserId: objectId(TARGET),
      performedByUserId: objectId(ACTOR),
      reversesDecisionId: objectId(DECISION),
      effectiveAt: WHEN,
      reasonCode: 'legacy.reversal',
      reasonSummary: 'Legacy reversal has no operation metadata.',
    })
    await assert.rejects(
      makeService(legacyStore).service.reverseDecision(
        actor(),
        command({ memberFacingReasonSummary: undefined }),
      ),
      isCode('ACCOUNT_ENFORCEMENT_REVERSAL_ALREADY_RECORDED'),
    )

    const conflictStore = makeStore()
    conflictStore.failCreate = Object.assign(new Error('duplicate'), { code: 11000 })
    await assert.rejects(
      makeService(conflictStore).service.reverseDecision(actor(), command()),
      isCode('ACCOUNT_ENFORCEMENT_REVERSAL_CONFLICT'),
    )
  })

  it('fails closed when persistence returns null or an inconsistent reversal', async () => {
    for (const returned of [null, { _id: objectId('333333333333333333333335') }]) {
      const store = makeStore()
      const repository = {
        ...makeRepository(store),
        async createReversal() {
          return returned
        },
      }
      await assert.rejects(
        makeService(store, { repository }).service.reverseDecision(actor(), command()),
        isCode('ACCOUNT_ENFORCEMENT_REVERSAL_CONFLICT'),
      )
    }
  })

  it('reauthorizes every transaction callback retry and forwards each callback session', async () => {
    const store = makeStore()
    const sessions = [{ attempt: 1 }, { attempt: 2 }]
    const authorizationSessions = []
    const service = createAccountEnforcementReversalCommandService({
      repository: makeRepository(store),
      transactionRunner: async (operation) => {
        await operation(sessions[0])
        return operation(sessions[1])
      },
      authorize: async (_actor, _at, session) => authorizationSessions.push(session),
      now: () => new Date(WHEN),
    })
    const result = await service.reverseDecision(actor(), command())
    assert.equal(result.kind, 'replayed')
    assert.deepEqual(authorizationSessions, sessions)
    assert.ok(store.sessions.some(([, session]) => session === sessions[0]))
    assert.ok(store.sessions.some(([, session]) => session === sessions[1]))
    assert.equal(store.writes, 1)
  })

  it('rejects caller-controlled identity, target, time, digest and persisted identifiers', async () => {
    for (const extra of [
      { actorId: ACTOR },
      { targetUserId: TARGET },
      { effectiveAt: WHEN },
      { commandDigest: 'a'.repeat(64) },
      { reversalId: SECOND_DECISION },
    ]) {
      const store = makeStore()
      await assert.rejects(
        makeService(store).service.reverseDecision(actor(), command(extra)),
        isCode('ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID'),
      )
      assert.equal(store.writes, 0)
    }
  })

  it('reports unknown commit outcomes separately and fails other transaction errors closed', async () => {
    const unknown = Object.assign(new Error('unknown commit'), {
      hasErrorLabel: (label) => label === 'UnknownTransactionCommitResult',
    })
    await assert.rejects(
      makeService(makeStore(), {
        transactionRunner: async () => {
          throw unknown
        },
      }).service.reverseDecision(actor(), command()),
      isCode('ACCOUNT_ENFORCEMENT_REVERSAL_OPERATION_UNCONFIRMED'),
    )
    await assert.rejects(
      makeService(makeStore(), {
        transactionRunner: async () => {
          throw new Error('transaction unavailable')
        },
      }).service.reverseDecision(actor(), command()),
      isCode('ACCOUNT_ENFORCEMENT_REVERSAL_TRANSACTION_UNAVAILABLE'),
    )
  })

  it('keeps command-created reversal facts compatible with full history evaluation', async () => {
    const originalFind = AccountEnforcementAction.find
    const decisionId = objectId(DECISION)
    const reversalId = objectId('333333333333333333333336')
    AccountEnforcementAction.find = () => ({
      sort() {
        return this
      },
      async lean() {
        return [
          {
            _id: decisionId,
            targetUserId: objectId(TARGET),
            recordType: 'decision',
            effectiveAt: DECIDED_AT,
            performedByUserId: objectId(ACTOR),
            reasonCode: 'test-only.suspension',
            reasonSummary: 'Original suspension.',
            decisionType: 'temporary_suspension',
            guidelineRuleId: 'test-only.rule',
            guidelineVersion: 'test-only.v1',
            endsAt: new Date('2036-02-01T00:00:00.000Z'),
            createdAt: DECIDED_AT,
          },
          {
            _id: reversalId,
            targetUserId: objectId(TARGET),
            recordType: 'reversal',
            effectiveAt: WHEN,
            performedByUserId: objectId(ACTOR),
            operationId: 'reversal.history-compatible',
            commandDigest: 'b'.repeat(64),
            reasonCode: ACCOUNT_ENFORCEMENT_REVERSAL_REASON_CODE,
            reasonSummary: 'Internal administrative correction.',
            reversesDecisionId: decisionId,
            createdAt: WHEN,
          },
        ]
      },
    })
    try {
      const history = await loadAccountEnforcementHistory(TARGET)
      assert.equal(history[1].operationId, undefined)
      assert.equal(history[1].commandDigest, undefined)
      assert.equal(history[1].reversesDecisionId, DECISION)
      assert.equal(evaluateAccountEnforcement(history, WHEN).status, 'active')
    } finally {
      AccountEnforcementAction.find = originalFind
    }
  })
})

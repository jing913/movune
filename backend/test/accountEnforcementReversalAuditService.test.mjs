import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import { ApiProblem } from '../dist/utils/messagingPolicy.js'
import { createAccountEnforcementReversalAuditService } from '../dist/services/accountEnforcementReversalAuditService.js'
import { createAccountEnforcementReversalApplicationService } from '../dist/services/accountEnforcementReversalApplicationService.js'
import { AccountEnforcementReversalCommandError } from '../dist/services/accountEnforcementReversalCommandService.js'

const ACTOR = '111111111111111111111111'
const DECISION = '222222222222222222222222'
const ATTEMPT = new Types.ObjectId('333333333333333333333333')
const identity = { actorUserId: ACTOR, decisionId: DECISION, operationId: 'reversal.audit.test' }

describe('REV-02 reversal audit boundary', () => {
  it('writes minimized immutable started and terminal events with bounded options', async () => {
    const events = []
    const audit = createAccountEnforcementReversalAuditService({
      newAttemptId: () => ATTEMPT,
      now: () => new Date('2035-09-01T00:00:00.000Z'),
      repository: {
        append: async (event, options) => {
          events.push({ event, options })
          return { acknowledged: true, insertedId: new Types.ObjectId() }
        },
      },
    })
    const attempt = await audit.start(identity)
    await audit.terminal(identity, attempt, 'failed', 'BOUNDED_FAILURE')
    assert.equal(attempt.toString(), ATTEMPT.toString())
    assert.deepEqual(
      events.map(({ event }) => event.eventType),
      ['started', 'failed'],
    )
    assert.equal(events[0].event.failureCode, undefined)
    assert.equal(events[1].event.failureCode, 'BOUNDED_FAILURE')
    for (const { event, options } of events) {
      assert.deepEqual(
        Object.keys(event).sort(),
        event.eventType === 'started'
          ? ['actorUserId', 'attemptId', 'decisionId', 'eventType', 'occurredAt', 'operationId']
          : [
              'actorUserId',
              'attemptId',
              'decisionId',
              'eventType',
              'failureCode',
              'occurredAt',
              'operationId',
            ],
      )
      assert.equal(options.writeConcern.journal, true)
      assert.equal(options.timeoutMS, 6000)
    }
  })

  it('fails closed before command execution when starter audit is unacknowledged', async () => {
    let executed = false
    const service = createAccountEnforcementReversalApplicationService({
      audit: {
        start: async () => {
          throw new ApiProblem(503, 'ACCOUNT_ENFORCEMENT_REVERSAL_AUDIT_UNAVAILABLE', 'unavailable')
        },
        terminal: async () => assert.fail('terminal must not execute'),
      },
      authorize: async () => {},
      reverse: async () => {
        executed = true
      },
    })
    await assert.rejects(
      service.reverseDecision(
        { _id: ACTOR, role: 'admin', memberEnforcementEnabled: true },
        {
          ...identity,
          decisionId: DECISION,
          reasonSummary: 'Internal reason',
        },
      ),
      (error) => error.code === 'ACCOUNT_ENFORCEMENT_REVERSAL_AUDIT_UNAVAILABLE',
    )
    assert.equal(executed, false)
  })

  it('records denial and never reaches B1 when entry authorization is revoked', async () => {
    const terminals = []
    const service = createAccountEnforcementReversalApplicationService({
      audit: {
        start: async () => ATTEMPT,
        terminal: async (_identity, _attempt, type, code) => terminals.push([type, code]),
      },
      authorize: async () => {
        throw new ApiProblem(403, 'MEMBER_ENFORCEMENT_FORBIDDEN', 'forbidden')
      },
      reverse: async () => assert.fail('B1 must not execute'),
    })
    await assert.rejects(
      service.reverseDecision(
        { _id: ACTOR, role: 'admin', memberEnforcementEnabled: false },
        {
          operationId: identity.operationId,
          decisionId: DECISION,
          reasonSummary: 'Internal reason',
        },
      ),
      (error) => error.code === 'MEMBER_ENFORCEMENT_FORBIDDEN',
    )
    assert.deepEqual(terminals, [['denied', 'MEMBER_ENFORCEMENT_FORBIDDEN']])
  })

  it('does not replace an unknown commit outcome when terminal audit also fails', async () => {
    const service = createAccountEnforcementReversalApplicationService({
      audit: {
        start: async () => ATTEMPT,
        terminal: async () => {
          throw new Error('audit terminal unavailable')
        },
      },
      authorize: async () => {},
      reverse: async () => {
        throw new AccountEnforcementReversalCommandError(
          'ACCOUNT_ENFORCEMENT_REVERSAL_OPERATION_UNCONFIRMED',
          'unknown',
          identity.operationId,
        )
      },
    })
    await assert.rejects(
      service.reverseDecision(
        { _id: ACTOR, role: 'admin', memberEnforcementEnabled: true },
        {
          operationId: identity.operationId,
          decisionId: DECISION,
          reasonSummary: 'Internal reason',
        },
      ),
      (error) => error.code === 'ACCOUNT_ENFORCEMENT_REVERSAL_OPERATION_UNCONFIRMED',
    )
  })
})

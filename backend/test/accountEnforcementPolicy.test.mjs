import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  AccountEnforcementInvariantError,
  evaluateAccountEnforcement,
} from '../dist/utils/accountEnforcementPolicy.js'

const baseTime = new Date('2035-01-01T00:00:00.000Z')
const hour = 60 * 60 * 1000

const decision = (id, decisionType, overrides = {}) => ({
  id,
  targetUserId: 'test-only-target',
  recordType: 'decision',
  decisionType,
  effectiveAt: baseTime,
  performedByUserId: 'test-only-actor',
  reasonCode: 'test-only.reason',
  reasonSummary: 'Minimum necessary test-only explanation.',
  guidelineRuleId: 'test-only.rule',
  guidelineVersion: 'test-only.v1',
  createdAt: new Date(baseTime.valueOf() - hour),
  ...overrides,
})

const suspension = (id, overrides = {}) =>
  decision(id, 'temporary_suspension', {
    endsAt: new Date(baseTime.valueOf() + 2 * hour),
    ...overrides,
  })

const reversal = (id, reversesDecisionId, overrides = {}) => ({
  id,
  targetUserId: 'test-only-target',
  recordType: 'reversal',
  effectiveAt: new Date(baseTime.valueOf() + hour),
  performedByUserId: 'test-only-actor',
  reasonCode: 'test-only.reversal',
  reasonSummary: 'Minimum necessary test-only reversal explanation.',
  reversesDecisionId,
  createdAt: new Date(baseTime.valueOf() + hour),
  ...overrides,
})

describe('Phase 9 Stage 1 account enforcement policy', () => {
  it('keeps empty, no-action, and warning histories active', () => {
    for (const history of [
      [],
      [decision('no-action', 'no_action')],
      [decision('warning', 'formal_warning')],
      [decision('warning', 'formal_warning'), decision('no-action', 'no_action')],
    ]) {
      assert.deepEqual(evaluateAccountEnforcement(history, baseTime), {
        status: 'active',
        evaluatedAt: baseTime,
        governingDecisionId: null,
        activeRestrictionDecisionIds: [],
        restrictionEndsAt: null,
      })
    }
  })

  it('uses inclusive starts and exclusive suspension ends without ambient time', () => {
    const start = new Date(baseTime.valueOf() + hour)
    const end = new Date(baseTime.valueOf() + 3 * hour)
    const history = [suspension('suspension', { effectiveAt: start, endsAt: end })]

    assert.equal(
      evaluateAccountEnforcement(history, new Date(start.valueOf() - 1)).status,
      'active',
    )
    assert.equal(evaluateAccountEnforcement(history, start).status, 'suspended')
    assert.equal(
      evaluateAccountEnforcement(history, new Date(end.valueOf() - 1)).status,
      'suspended',
    )
    assert.equal(evaluateAccountEnforcement(history, end).status, 'active')
  })

  it('applies a reversal only from its effective time and only to its decision', () => {
    const first = suspension('first', { endsAt: new Date(baseTime.valueOf() + 4 * hour) })
    const second = suspension('second', { endsAt: new Date(baseTime.valueOf() + 5 * hour) })
    const history = [first, second, reversal('reverse-first', first.id)]

    assert.deepEqual(
      evaluateAccountEnforcement(history, new Date(baseTime.valueOf() + hour - 1))
        .activeRestrictionDecisionIds,
      ['first', 'second'],
    )
    const after = evaluateAccountEnforcement(history, new Date(baseTime.valueOf() + hour))
    assert.deepEqual(after.activeRestrictionDecisionIds, ['second'])
    assert.equal(after.restrictionEndsAt.toISOString(), second.endsAt.toISOString())
  })

  it('gives deactivation precedence and reveals an underlying suspension after reversal', () => {
    const suspended = suspension('suspended', { endsAt: new Date(baseTime.valueOf() + 8 * hour) })
    const deactivated = decision('deactivated', 'permanent_deactivation')
    const history = [
      suspended,
      deactivated,
      reversal('reverse-deactivation', deactivated.id, {
        effectiveAt: new Date(baseTime.valueOf() + 2 * hour),
      }),
    ]

    const before = evaluateAccountEnforcement(history, new Date(baseTime.valueOf() + hour))
    assert.equal(before.status, 'deactivated')
    assert.equal(before.governingDecisionId, 'deactivated')
    assert.equal(before.restrictionEndsAt, null)

    const after = evaluateAccountEnforcement(history, new Date(baseTime.valueOf() + 2 * hour))
    assert.equal(after.status, 'suspended')
    assert.equal(after.governingDecisionId, 'suspended')
  })

  it('selects governing decisions deterministically and reports the latest active end', () => {
    const history = [
      suspension('a', { endsAt: new Date(baseTime.valueOf() + 2 * hour) }),
      suspension('b', { endsAt: new Date(baseTime.valueOf() + 5 * hour) }),
      suspension('c', {
        effectiveAt: new Date(baseTime.valueOf() + hour),
        endsAt: new Date(baseTime.valueOf() + 4 * hour),
      }),
    ]
    const state = evaluateAccountEnforcement(history, new Date(baseTime.valueOf() + hour))
    assert.equal(state.governingDecisionId, 'c')
    assert.equal(state.restrictionEndsAt.toISOString(), history[1].endsAt.toISOString())

    const tied = evaluateAccountEnforcement([suspension('tie-a'), suspension('tie-b')], baseTime)
    assert.equal(tied.governingDecisionId, 'tie-b')
  })

  it('is input-order independent and does not mutate input', () => {
    const history = [
      suspension('suspension'),
      decision('deactivation', 'permanent_deactivation'),
      reversal('reversal', 'deactivation'),
    ]
    const before = JSON.stringify(history)
    const forward = evaluateAccountEnforcement(history, new Date(baseTime.valueOf() + 2 * hour))
    const reverse = evaluateAccountEnforcement(
      [...history].reverse(),
      new Date(baseTime.valueOf() + 2 * hour),
    )
    assert.deepEqual(reverse, forward)
    assert.equal(JSON.stringify(history), before)
  })

  it('rejects corrupt persisted history explicitly', () => {
    const corruptHistories = [
      [reversal('missing', 'absent')],
      [decision('warning', 'formal_warning'), reversal('reverse-warning', 'warning')],
      [suspension('target'), reversal('wrong-user', 'target', { targetUserId: 'test-only-other' })],
      [
        suspension('target'),
        reversal('first-reversal', 'target'),
        reversal('second-reversal', 'target', {
          effectiveAt: new Date(baseTime.valueOf() + 2 * hour),
        }),
      ],
      [suspension('invalid-window', { endsAt: baseTime })],
    ]

    for (const history of corruptHistories) {
      assert.throws(
        () => evaluateAccountEnforcement(history, baseTime),
        (error) =>
          error instanceof AccountEnforcementInvariantError &&
          error.code === 'ACCOUNT_ENFORCEMENT_HISTORY_INVALID',
      )
    }
  })
})

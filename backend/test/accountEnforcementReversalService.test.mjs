import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Types } from 'mongoose'
import { AccountEnforcementAction } from '../dist/models/accountEnforcementActionModel.js'
import { User } from '../dist/models/userModel.js'
import {
  AccountEnforcementServiceError,
  appendAccountEnforcementReversal,
} from '../dist/services/accountEnforcementService.js'

const targetUserId = new Types.ObjectId()
const actorUserId = new Types.ObjectId()
const decisionId = new Types.ObjectId()
const effectiveAt = new Date('2035-01-01T00:00:00.000Z')
const reversalAt = new Date('2035-01-02T00:00:00.000Z')

const originalExists = User.exists
const originalFindById = AccountEnforcementAction.findById
const originalCreate = AccountEnforcementAction.create

const decision = (decisionType) => ({
  _id: decisionId,
  targetUserId,
  recordType: 'decision',
  decisionType,
  effectiveAt,
  performedByUserId: actorUserId,
  reasonCode: 'test-only.original',
  reasonSummary: 'Original decision remains unchanged.',
  guidelineRuleId: 'test-only.rule',
  guidelineVersion: 'test-only.v1',
  ...(decisionType === 'temporary_suspension'
    ? { endsAt: new Date('2035-01-03T00:00:00.000Z') }
    : {}),
  createdAt: effectiveAt,
})

const input = (overrides = {}) => ({
  targetUserId: targetUserId.toString(),
  performedByUserId: actorUserId.toString(),
  reversesDecisionId: decisionId.toString(),
  effectiveAt: reversalAt,
  reasonCode: 'test-only.reversal',
  reasonSummary: 'Internal reversal rationale.',
  ...overrides,
})

const install = ({ source, create } = {}) => {
  User.exists = async () => ({ _id: new Types.ObjectId() })
  AccountEnforcementAction.findById = () => ({ lean: async () => source })
  AccountEnforcementAction.create = create
}

afterEach(() => {
  User.exists = originalExists
  AccountEnforcementAction.findById = originalFindById
  AccountEnforcementAction.create = originalCreate
})

describe('REV-02A trusted reversal append primitive', () => {
  it('appends a separately reasoned Formal Warning reversal without mutating its source', async () => {
    const source = decision('formal_warning')
    const before = JSON.stringify(source)
    let created
    install({
      source,
      create: async (value) => {
        created = value
        return {
          ...value,
          _id: new Types.ObjectId(),
          createdAt: reversalAt,
        }
      },
    })

    const result = await appendAccountEnforcementReversal(
      input({ memberFacingReasonSummary: '已核准的會員可見撤銷理由。' }),
    )

    assert.equal(JSON.stringify(source), before)
    assert.equal(created.recordType, 'reversal')
    assert.equal(created.memberFacingReasonSummary, '已核准的會員可見撤銷理由。')
    assert.equal(result.memberFacingReasonSummary, '已核准的會員可見撤銷理由。')
    assert.equal(result.reversesDecisionId, decisionId.toString())
    assert.equal(result.operationId, undefined)
    assert.equal(result.commandDigest, undefined)
  })

  it('rejects a new Formal Warning reversal without an approved member-facing reason', async () => {
    let createCalled = false
    install({
      source: decision('formal_warning'),
      create: async () => {
        createCalled = true
      },
    })

    await assert.rejects(
      () => appendAccountEnforcementReversal(input()),
      (error) =>
        error instanceof AccountEnforcementServiceError &&
        error.code === 'ACCOUNT_ENFORCEMENT_INPUT_INVALID',
    )
    assert.equal(createCalled, false)
  })

  it('continues to reject No Action reversal', async () => {
    install({ source: decision('no_action'), create: async () => assert.fail('must not create') })

    await assert.rejects(
      () => appendAccountEnforcementReversal(input()),
      (error) =>
        error instanceof AccountEnforcementServiceError &&
        error.code === 'ACCOUNT_ENFORCEMENT_DECISION_NOT_REVERSIBLE',
    )
  })

  it('preserves restriction reversal compatibility without requiring a member-facing reason', async () => {
    for (const decisionType of ['temporary_suspension', 'permanent_deactivation']) {
      install({
        source: decision(decisionType),
        create: async (value) => ({
          ...value,
          _id: new Types.ObjectId(),
          createdAt: reversalAt,
        }),
      })

      const result = await appendAccountEnforcementReversal(input())
      assert.equal(result.memberFacingReasonSummary, undefined)
      assert.equal(result.reversesDecisionId, decisionId.toString())
    }
  })

  it('preserves duplicate reversal classification', async () => {
    install({
      source: decision('temporary_suspension'),
      create: async () => {
        throw Object.assign(new Error('synthetic duplicate'), { code: 11000 })
      },
    })

    await assert.rejects(
      () => appendAccountEnforcementReversal(input()),
      (error) =>
        error instanceof AccountEnforcementServiceError &&
        error.code === 'ACCOUNT_ENFORCEMENT_ALREADY_REVERSED',
    )
  })
})

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Types } from 'mongoose'
import { User } from '../dist/models/userModel.js'
import { AccountEnforcementAction } from '../dist/models/accountEnforcementActionModel.js'
import { readAdminEnforcementDecisions } from '../dist/services/adminEnforcementReadService.js'

const TARGET = '111111111111111111111111'
const originalFindById = User.findById
const originalFind = AccountEnforcementAction.find

const install = (actions) => {
  User.findById = () => ({
    select() {
      return this
    },
    async lean() {
      return { _id: new Types.ObjectId(TARGET), account: 'member', displayName: 'Member' }
    },
  })
  AccountEnforcementAction.find = () => ({
    select() {
      return this
    },
    sort() {
      return this
    },
    async lean() {
      return actions
    },
  })
}

afterEach(() => {
  User.findById = originalFindById
  AccountEnforcementAction.find = originalFind
})

describe('Admin enforcement minimal read model', () => {
  it('returns only required identity and Warning/Suspension decision facts', async () => {
    const warningId = new Types.ObjectId('222222222222222222222222')
    install([
      {
        _id: warningId,
        targetUserId: new Types.ObjectId(TARGET),
        recordType: 'decision',
        decisionType: 'formal_warning',
        effectiveAt: new Date('2035-09-01T00:00:00.000Z'),
        reasonSummary: 'Internal decision reason',
        privateEvidence: 'must-not-leak',
      },
      {
        _id: new Types.ObjectId('333333333333333333333333'),
        targetUserId: new Types.ObjectId(TARGET),
        recordType: 'reversal',
        effectiveAt: new Date('2035-09-02T00:00:00.000Z'),
        operationId: 'reversal.web.read',
        reversesDecisionId: warningId,
      },
    ])
    const result = await readAdminEnforcementDecisions(TARGET, new Date('2035-10-01T00:00:00.000Z'))
    assert.deepEqual(result.member, { id: TARGET, displayName: 'Member', account: 'member' })
    assert.equal(result.decisions[0].state, 'reversed')
    assert.equal(result.decisions[0].reversal.operationId, 'reversal.web.read')
    assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
    assert.equal(result.memberFacingReasonOptions[0].code, 'warning_reversed_after_review_v1')
  })

  it('keeps expired suspensions reversible without changing original timestamps', async () => {
    install([
      {
        _id: new Types.ObjectId('222222222222222222222223'),
        targetUserId: new Types.ObjectId(TARGET),
        recordType: 'decision',
        decisionType: 'temporary_suspension',
        effectiveAt: new Date('2035-01-01T00:00:00.000Z'),
        endsAt: new Date('2035-02-01T00:00:00.000Z'),
        reasonSummary: 'Historical suspension',
      },
    ])
    const result = await readAdminEnforcementDecisions(TARGET, new Date('2035-10-01T00:00:00.000Z'))
    assert.equal(result.decisions[0].expired, true)
    assert.equal(result.decisions[0].state, 'reversible')
    assert.equal(result.decisions[0].endsAt.toISOString(), '2035-02-01T00:00:00.000Z')
  })

  it('fails closed on duplicate or contradictory reversals', async () => {
    const decisionId = new Types.ObjectId('222222222222222222222224')
    install([
      {
        _id: decisionId,
        targetUserId: new Types.ObjectId(TARGET),
        recordType: 'decision',
        decisionType: 'formal_warning',
        effectiveAt: new Date('2035-01-01T00:00:00.000Z'),
        reasonSummary: 'Warning',
      },
      ...['1', '2'].map((suffix) => ({
        _id: new Types.ObjectId(`44444444444444444444444${suffix}`),
        targetUserId: new Types.ObjectId(TARGET),
        recordType: 'reversal',
        effectiveAt: new Date('2035-02-01T00:00:00.000Z'),
        reversesDecisionId: decisionId,
      })),
    ])
    await assert.rejects(
      readAdminEnforcementDecisions(TARGET, new Date('2035-10-01T00:00:00.000Z')),
      (error) => error.code === 'ADMIN_ENFORCEMENT_DATA_INVALID',
    )
  })
})

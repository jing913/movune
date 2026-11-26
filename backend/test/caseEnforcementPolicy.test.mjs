import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isConclusionActionAllowed,
  validEnforcementReasonCode,
  validMemberFacingReason,
} from '../dist/policies/caseEnforcementPolicy.js'

describe('Case Enforcement Stage B policy', () => {
  it('allows No Action for every approved Review conclusion', () => {
    for (const conclusion of [
      'violation_confirmed',
      'no_violation_found',
      'insufficient_evidence',
    ]) {
      assert.equal(isConclusionActionAllowed(conclusion, 'no_action'), true)
    }
  })

  it('allows Formal Warning only for a confirmed violation', () => {
    assert.equal(isConclusionActionAllowed('violation_confirmed', 'formal_warning'), true)
    assert.equal(isConclusionActionAllowed('no_violation_found', 'formal_warning'), false)
    assert.equal(isConclusionActionAllowed('insufficient_evidence', 'formal_warning'), false)
  })

  it('requires a bounded, trimmed, meaningful member-facing reason', () => {
    assert.equal(validMemberFacingReason('已確認違反治理規範。'), true)
    assert.equal(validMemberFacingReason(''), false)
    assert.equal(validMemberFacingReason(' padded '), false)
    assert.equal(validMemberFacingReason('a'.repeat(1001)), false)
  })

  it('accepts only structurally bounded optional reason codes', () => {
    assert.equal(validEnforcementReasonCode('targeted_harassment'), true)
    assert.equal(validEnforcementReasonCode(''), false)
    assert.equal(validEnforcementReasonCode('not valid'), false)
    assert.equal(validEnforcementReasonCode('a'.repeat(129)), false)
  })
})

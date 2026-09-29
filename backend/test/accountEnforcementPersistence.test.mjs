import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Types } from 'mongoose'
import {
  ACCOUNT_ENFORCEMENT_IMMUTABLE_MESSAGE,
  AccountEnforcementAction,
} from '../dist/models/accountEnforcementActionModel.js'

const userId = () => new Types.ObjectId()
const effectiveAt = new Date('2035-01-01T00:00:00.000Z')

const decision = (overrides = {}) =>
  new AccountEnforcementAction({
    targetUserId: userId(),
    recordType: 'decision',
    effectiveAt,
    performedByUserId: userId(),
    reasonCode: 'test-only.reason',
    reasonSummary: 'Minimum necessary test-only explanation.',
    decisionType: 'formal_warning',
    guidelineRuleId: 'test-only.rule',
    guidelineVersion: 'test-only.v1',
    ...overrides,
  })

const reversal = (overrides = {}) =>
  new AccountEnforcementAction({
    targetUserId: userId(),
    recordType: 'reversal',
    effectiveAt,
    performedByUserId: userId(),
    reasonCode: 'test-only.reversal',
    reasonSummary: 'Minimum necessary test-only reversal explanation.',
    reversesDecisionId: userId(),
    ...overrides,
  })

describe('Phase 9 Stage 1 enforcement persistence', () => {
  it('represents every decision and requires a valid temporary interval', async () => {
    for (const decisionType of ['no_action', 'formal_warning', 'permanent_deactivation']) {
      await assert.doesNotReject(() => decision({ decisionType }).validate())
    }
    await assert.doesNotReject(() =>
      decision({
        decisionType: 'temporary_suspension',
        endsAt: new Date(effectiveAt.valueOf() + 1000),
      }).validate(),
    )
    await assert.rejects(
      () => decision({ decisionType: 'temporary_suspension' }).validate(),
      (error) => error?.errors.endsAt?.kind === 'required',
    )
    await assert.rejects(
      () => decision({ decisionType: 'temporary_suspension', endsAt: effectiveAt }).validate(),
      (error) => error?.errors.endsAt?.kind === 'user defined',
    )
    await assert.rejects(
      () => decision({ endsAt: new Date(effectiveAt.valueOf() + 1000) }).validate(),
      (error) => error?.errors.endsAt?.kind === 'user defined',
    )
  })

  it('enforces decision and reversal field separation', async () => {
    for (const overrides of [
      { decisionType: undefined },
      { guidelineRuleId: undefined },
      { guidelineVersion: undefined },
      { reversesDecisionId: userId() },
    ]) {
      await assert.rejects(() => decision(overrides).validate())
    }
    await assert.doesNotReject(() => reversal().validate())
    for (const overrides of [
      { reversesDecisionId: undefined },
      { decisionType: 'formal_warning' },
      { guidelineRuleId: 'test-only.rule' },
      { guidelineVersion: 'test-only.v1' },
      { endsAt: new Date(effectiveAt.valueOf() + 1000) },
    ]) {
      await assert.rejects(() => reversal(overrides).validate())
    }
  })

  it('validates structurally safe reason and guideline references', async () => {
    for (const overrides of [
      { reasonCode: '' },
      { reasonCode: 'Reporter selected Other' },
      { reasonSummary: '' },
      { reasonSummary: 'x'.repeat(1001) },
      { guidelineRuleId: 'P8 Rule Display Text' },
      { guidelineVersion: '' },
    ]) {
      await assert.rejects(() => decision(overrides).validate())
    }
    await assert.rejects(() => reversal({ reasonCode: undefined }).validate())
    await assert.rejects(() => reversal({ reasonSummary: undefined }).validate())
  })

  it('declares every retained field immutable and omits updatedAt', () => {
    const mutableException = new Set(['_id', '__v'])
    for (const [name, path] of Object.entries(AccountEnforcementAction.schema.paths)) {
      if (!mutableException.has(name) && name !== 'createdAt') {
        assert.equal(path.options.immutable, true, `${name} must be immutable`)
      }
    }
    assert.equal(AccountEnforcementAction.schema.path('createdAt').options.immutable, true)
    assert.equal(AccountEnforcementAction.schema.path('updatedAt'), undefined)
  })

  it('rejects model-level updates and replacements before database access', async () => {
    for (const operation of [
      AccountEnforcementAction.updateOne({}, { $set: { reasonSummary: 'changed' } }),
      AccountEnforcementAction.updateMany({}, { $set: { reasonSummary: 'changed' } }),
      AccountEnforcementAction.findOneAndUpdate({}, { $set: { reasonSummary: 'changed' } }),
      AccountEnforcementAction.replaceOne({}, decision().toObject()),
      AccountEnforcementAction.findOneAndReplace({}, decision().toObject()),
      AccountEnforcementAction.bulkWrite([
        { updateOne: { filter: {}, update: { $set: { reasonSummary: 'changed' } } } },
      ]),
    ]) {
      await assert.rejects(() => operation, new RegExp(ACCOUNT_ENFORCEMENT_IMMUTABLE_MESSAGE))
    }
  })

  it('declares deterministic and duplicate-reversal indexes without TTL', () => {
    const indexes = AccountEnforcementAction.schema.indexes()
    assert.ok(
      indexes.some(
        ([fields]) => fields.targetUserId === 1 && fields.effectiveAt === 1 && fields._id === 1,
      ),
    )
    assert.ok(
      indexes.some(
        ([fields, options]) =>
          fields.reversesDecisionId === 1 &&
          options.unique === true &&
          options.partialFilterExpression?.recordType === 'reversal',
      ),
    )
    assert.equal(
      indexes.some(([, options]) => 'expireAfterSeconds' in options),
      false,
    )
  })

  it('contains no evidence-shaped or speculative retention fields', () => {
    const paths = new Set(Object.keys(AccountEnforcementAction.schema.paths))
    for (const forbidden of [
      'reportId',
      'reporterUserId',
      'messageId',
      'conversationId',
      'messageEvidence',
      'attachments',
      'caseNotes',
      'deleteAt',
      'retentionExpiresAt',
      'caseClosedAt',
      'legalHold',
    ]) {
      assert.equal(paths.has(forbidden), false)
    }
  })
})

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
      { memberFacingReasonSummary: 'Only reversals may carry this field.' },
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
    await assert.doesNotReject(() =>
      reversal({
        operationId: 'reversal.persistence-1',
        commandDigest: 'a'.repeat(64),
      }).validate(),
    )
    await assert.rejects(() => reversal({ operationId: 'reversal.incomplete' }).validate())
    await assert.rejects(() => reversal({ commandDigest: 'a'.repeat(64) }).validate())
  })

  it('validates optional member-facing reversal reasons without breaking legacy reversals', async () => {
    await assert.doesNotReject(() => reversal().validate())
    await assert.doesNotReject(() =>
      reversal({ memberFacingReasonSummary: '已核准的會員可見撤銷理由。' }).validate(),
    )
    await assert.doesNotReject(() =>
      reversal({ memberFacingReasonSummary: '😀'.repeat(1000) }).validate(),
    )

    for (const memberFacingReasonSummary of [
      null,
      42,
      {},
      '',
      '   ',
      ' untrimmed',
      'untrimmed ',
      '😀'.repeat(1001),
    ]) {
      await assert.rejects(() => reversal({ memberFacingReasonSummary }).validate())
    }
  })

  it('validates structurally safe reason and guideline references', async () => {
    await assert.doesNotReject(() =>
      decision({
        reasonCode: 'targeted_harassment',
        guidelineRuleId: 'CG-001',
        guidelineVersion: '1.0.0',
      }).validate(),
    )
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

  it('allows reasoned No Action without a fabricated violation guideline', async () => {
    await assert.doesNotReject(() =>
      decision({
        decisionType: 'no_action',
        reasonCode: undefined,
        guidelineRuleId: undefined,
        guidelineVersion: undefined,
      }).validate(),
    )
    await assert.doesNotReject(() =>
      decision({ decisionType: 'no_action', reasonCode: undefined }).validate(),
    )
    await assert.rejects(() =>
      decision({
        decisionType: 'no_action',
        guidelineRuleId: 'test-only.rule',
        guidelineVersion: undefined,
      }).validate(),
    )
    await assert.rejects(() =>
      decision({
        decisionType: 'formal_warning',
        guidelineRuleId: undefined,
        guidelineVersion: undefined,
      }).validate(),
    )
    await assert.rejects(() =>
      decision({ decisionType: 'formal_warning', reasonCode: undefined }).validate(),
    )
  })

  it('preserves immutable Case Review provenance and one-initial-action indexes', async () => {
    const schema = AccountEnforcementAction.schema
    assert.equal(schema.path('reviewDecisionId').options.immutable, true)
    assert.equal(schema.path('operationId').options.immutable, true)
    assert.equal(schema.path('commandDigest').options.immutable, true)
    assert.equal(schema.path('memberNoticeProvenance').options.immutable, true)
    assert.equal(schema.path('memberFacingReasonSummary').options.immutable, true)

    const indexes = schema.indexes()
    assert.ok(
      indexes.some(([keys, options]) => keys.reviewDecisionId === 1 && options.unique === true),
    )
    assert.ok(indexes.some(([keys, options]) => keys.operationId === 1 && options.unique === true))
    const operationIndex = indexes.find(([keys]) => keys.operationId === 1)
    assert.deepEqual(operationIndex?.[1].partialFilterExpression, {
      operationId: { $exists: true },
    })
  })

  it('defaults legacy records out and permits only trusted Stage B Formal Warning notice provenance', async () => {
    await assert.doesNotReject(() => decision().validate())
    await assert.doesNotReject(() =>
      decision({
        reviewDecisionId: userId(),
        operationId: 'case.enforcement.persistence-1',
        commandDigest: 'a'.repeat(64),
        memberNoticeProvenance: 'stage_b_formal_warning_v1',
      }).validate(),
    )
    await assert.rejects(() =>
      decision({ memberNoticeProvenance: 'stage_b_formal_warning_v1' }).validate(),
    )
    await assert.rejects(() =>
      decision({
        reviewDecisionId: userId(),
        operationId: 'case.enforcement.persistence-2',
        commandDigest: 'b'.repeat(64),
        memberNoticeProvenance: 'unknown_legacy_source',
      }).validate(),
    )
    await assert.rejects(() =>
      decision({
        decisionType: 'no_action',
        reviewDecisionId: userId(),
        operationId: 'case.enforcement.persistence-3',
        commandDigest: 'c'.repeat(64),
        memberNoticeProvenance: 'stage_b_formal_warning_v1',
      }).validate(),
    )
  })

  it('hydrates historical records without inventing member-visible eligibility', () => {
    const legacy = AccountEnforcementAction.hydrate({
      _id: userId(),
      targetUserId: userId(),
      recordType: 'decision',
      effectiveAt,
      performedByUserId: userId(),
      reasonCode: 'targeted_harassment',
      reasonSummary: 'Historical internal summary remains internally readable.',
      decisionType: 'formal_warning',
      guidelineRuleId: 'CG-001',
      guidelineVersion: '0.9.0',
      createdAt: effectiveAt,
    })
    assert.equal(legacy.memberNoticeProvenance, undefined)
    assert.equal(legacy.reasonSummary, 'Historical internal summary remains internally readable.')
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

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Types } from 'mongoose'
import { AccountEnforcementAction } from '../dist/models/accountEnforcementActionModel.js'
import { listMemberEnforcementNotices } from '../dist/services/memberEnforcementNoticeService.js'

const USER = '111111111111111111111111'
const OTHER_USER = '111111111111111111111112'
const originalFind = AccountEnforcementAction.find
const trustedAction = (overrides = {}) => ({
  _id: new Types.ObjectId('222222222222222222222222'),
  targetUserId: new Types.ObjectId(USER),
  recordType: 'decision',
  decisionType: 'formal_warning',
  effectiveAt: new Date('2035-09-01T00:00:00.000Z'),
  reviewDecisionId: new Types.ObjectId('333333333333333333333333'),
  operationId: 'case.enforcement.notice-1',
  commandDigest: 'a'.repeat(64),
  memberNoticeProvenance: 'stage_b_formal_warning_v1',
  reasonSummary: '會員可見的正式警告理由。',
  reasonCode: 'targeted_harassment',
  guidelineRuleId: 'CG-001',
  guidelineVersion: '1.0.0',
  ...overrides,
})

const installActions = (actions, reversals = [], observe = {}) => {
  let call = 0
  AccountEnforcementAction.find = (filter) => {
    call += 1
    if (call === 1) observe.filter = filter
    const query = {
      select(value) {
        if (call === 1) observe.select = value
        return query
      },
      sort() {
        return query
      },
      limit(value) {
        assert.equal(value, 50)
        return query
      },
      async lean() {
        return call === 1 ? actions : reversals
      },
    }
    return query
  }
}

afterEach(() => {
  AccountEnforcementAction.find = originalFind
})

describe('member-visible Formal Warning projection', () => {
  it('returns only bounded member fields and filters to the authenticated target', async () => {
    let observedFilter
    let observedSelect
    const observe = {}
    installActions(
      [
        trustedAction({
          reporterUserId: 'must-not-leak',
          rationale: 'must-not-leak',
          performedByUserId: 'must-not-leak',
        }),
      ],
      [],
      observe,
    )

    const notices = await listMemberEnforcementNotices(USER)
    observedFilter = observe.filter
    observedSelect = observe.select
    assert.equal(observedFilter.targetUserId.toString(), USER)
    assert.equal(observedFilter.decisionType, 'formal_warning')
    assert.equal(observedFilter.memberNoticeProvenance, 'stage_b_formal_warning_v1')
    assert.equal(
      observedSelect,
      '_id targetUserId recordType decisionType effectiveAt reviewDecisionId operationId commandDigest memberNoticeProvenance reasonSummary reasonCode guidelineRuleId guidelineVersion',
    )
    assert.deepEqual(notices, [
      {
        id: '222222222222222222222222',
        actionType: 'formal_warning',
        status: 'recorded',
        recordedAt: new Date('2035-09-01T00:00:00.000Z'),
        reason: '會員可見的正式警告理由。',
        guideline: { ruleId: 'CG-001', version: '1.0.0', title: '尊重其他會員' },
      },
    ])
    assert.equal(JSON.stringify(notices).includes('must-not-leak'), false)
  })

  it('skips ambiguous legacy, unknown-version, No Action, and cross-member records independently', async () => {
    installActions([
      trustedAction(),
      trustedAction({
        _id: new Types.ObjectId('222222222222222222222223'),
        memberNoticeProvenance: undefined,
        reasonSummary: 'SENSITIVE INTERNAL LEGACY SUMMARY',
      }),
      trustedAction({
        _id: new Types.ObjectId('222222222222222222222224'),
        guidelineVersion: '2.0.0',
        reasonSummary: 'UNKNOWN VERSION MUST NOT BREAK THE LIST',
      }),
      trustedAction({
        _id: new Types.ObjectId('222222222222222222222225'),
        decisionType: 'no_action',
        reasonSummary: 'NO ACTION MUST NOT BE A NOTICE',
      }),
      trustedAction({
        _id: new Types.ObjectId('222222222222222222222226'),
        targetUserId: new Types.ObjectId(OTHER_USER),
        reasonSummary: 'OTHER MEMBER PRIVATE WARNING',
      }),
    ])

    const notices = await listMemberEnforcementNotices(USER)
    assert.equal(notices.length, 1)
    assert.equal(notices[0].reason, '會員可見的正式警告理由。')
    const serialized = JSON.stringify(notices)
    for (const sensitive of [
      'SENSITIVE INTERNAL LEGACY SUMMARY',
      'UNKNOWN VERSION MUST NOT BREAK THE LIST',
      'NO ACTION MUST NOT BE A NOTICE',
      'OTHER MEMBER PRIVATE WARNING',
    ]) {
      assert.equal(serialized.includes(sensitive), false)
    }
  })

  it('retains canonical CG-001 through CG-004 member notice metadata', async () => {
    const rules = [
      ['CG-001', 'targeted_harassment', '尊重其他會員'],
      ['CG-002', 'unwanted_contact', '尊重互動與聯絡界線'],
      ['CG-003', 'spam_or_abuse', '禁止垃圾訊息與濫用互動功能'],
      ['CG-004', 'privacy_violation', '保護他人隱私'],
    ]
    installActions(
      rules.map(([guidelineRuleId, reasonCode], index) =>
        trustedAction({
          _id: new Types.ObjectId(`22222222222222222222222${index + 2}`),
          operationId: `case.enforcement.notice-${index + 2}`,
          guidelineRuleId,
          reasonCode,
        }),
      ),
    )

    const notices = await listMemberEnforcementNotices(USER)
    assert.deepEqual(
      notices.map(({ guideline }) => guideline),
      rules.map(([ruleId, , title]) => ({ ruleId, version: '1.0.0', title })),
    )
  })

  it('projects current and legacy reversals without leaking internal reasons', async () => {
    const currentDecision = trustedAction()
    const legacyDecision = trustedAction({
      _id: new Types.ObjectId('222222222222222222222229'),
      operationId: 'case.enforcement.notice-legacy',
    })
    installActions(
      [currentDecision, legacyDecision],
      [
        {
          _id: new Types.ObjectId('444444444444444444444441'),
          targetUserId: new Types.ObjectId(USER),
          recordType: 'reversal',
          effectiveAt: new Date('2035-09-02T00:00:00.000Z'),
          operationId: 'reversal.web.current',
          commandDigest: 'b'.repeat(64),
          reasonCode: 'admin.reversal',
          reasonSummary: 'SENSITIVE INTERNAL REVERSAL REASON',
          memberFacingReasonSummary: '經重新審查後，此正式警告已撤銷。',
          reversesDecisionId: currentDecision._id,
        },
        {
          _id: new Types.ObjectId('444444444444444444444442'),
          targetUserId: new Types.ObjectId(USER),
          recordType: 'reversal',
          effectiveAt: new Date('2035-09-03T00:00:00.000Z'),
          operationId: 'reversal.command-foundation.legacy',
          commandDigest: 'c'.repeat(64),
          reasonCode: 'admin.reversal',
          reasonSummary: 'SENSITIVE LEGACY REVERSAL REASON',
          reversesDecisionId: legacyDecision._id,
        },
      ],
    )
    const notices = await listMemberEnforcementNotices(USER)
    assert.equal(notices[0].status, 'reversed')
    assert.equal(notices[0].reversalReason, '經重新審查後，此正式警告已撤銷。')
    assert.equal(notices[1].status, 'legacy_reversed')
    assert.equal(notices[1].reversalReason, undefined)
    assert.equal(JSON.stringify(notices).includes('SENSITIVE'), false)
  })

  it('fails closed on contradictory reversal history', async () => {
    const decision = trustedAction()
    installActions(
      [decision],
      [
        {
          _id: new Types.ObjectId('444444444444444444444443'),
          targetUserId: new Types.ObjectId(OTHER_USER),
          recordType: 'reversal',
          effectiveAt: new Date('2035-09-02T00:00:00.000Z'),
          reversesDecisionId: decision._id,
        },
      ],
    )
    await assert.rejects(
      listMemberEnforcementNotices(USER),
      (error) =>
        error.status === 503 && error.code === 'MEMBER_ENFORCEMENT_NOTICE_PROJECTION_UNAVAILABLE',
    )
  })

  it('fails closed when reversal command identity is partial', async () => {
    const decision = trustedAction()
    installActions(
      [decision],
      [
        {
          _id: new Types.ObjectId('444444444444444444444444'),
          targetUserId: new Types.ObjectId(USER),
          recordType: 'reversal',
          effectiveAt: new Date('2035-09-02T00:00:00.000Z'),
          operationId: 'reversal.command-foundation.malformed',
          reasonCode: 'admin.reversal',
          reasonSummary: 'SENSITIVE MALFORMED REVERSAL REASON',
          reversesDecisionId: decision._id,
        },
      ],
    )
    await assert.rejects(
      listMemberEnforcementNotices(USER),
      (error) =>
        error.status === 503 && error.code === 'MEMBER_ENFORCEMENT_NOTICE_PROJECTION_UNAVAILABLE',
    )
  })

  it('rejects an invalid authenticated identity before querying', async () => {
    AccountEnforcementAction.find = () => assert.fail('query must not execute')
    await assert.rejects(
      listMemberEnforcementNotices('invalid'),
      (error) => error.status === 400 && error.code === 'MEMBER_ENFORCEMENT_NOTICE_INPUT_INVALID',
    )
  })
})

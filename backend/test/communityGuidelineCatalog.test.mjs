import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ACTIVE_COMMUNITY_GUIDELINE_VERSION,
  COMMUNITY_GUIDELINE_CATALOG,
  resolveCommunityGuideline,
  resolveHistoricalCommunityGuideline,
} from '../dist/policies/communityGuidelineCatalog.js'

describe('Community Guidelines 1.0.0 catalog', () => {
  it('retains the exact approved immutable rules and mappings', () => {
    assert.equal(ACTIVE_COMMUNITY_GUIDELINE_VERSION, '1.0.0')
    assert.deepEqual(COMMUNITY_GUIDELINE_CATALOG, [
      {
        guidelineRuleId: 'CG-001',
        reasonCode: 'targeted_harassment',
        guidelineVersion: '1.0.0',
        title: '尊重其他會員',
        policy:
          '禁止針對其他會員持續辱罵、羞辱、騷擾或以惡意言語攻擊對方。電影喜好可以不同，但不得以此作為人身攻擊的理由。',
      },
      {
        guidelineRuleId: 'CG-002',
        reasonCode: 'unwanted_contact',
        guidelineVersion: '1.0.0',
        title: '尊重互動與聯絡界線',
        policy:
          '會員明確表示不願繼續交流後，不得持續發送騷擾訊息、施壓要求回覆，或利用其他功能規避對方的拒絕與封鎖。',
      },
      {
        guidelineRuleId: 'CG-003',
        reasonCode: 'spam_or_abuse',
        guidelineVersion: '1.0.0',
        title: '禁止垃圾訊息與濫用互動功能',
        policy:
          '不得大量發送重複訊息、未經邀請的商業推廣內容，或使用關注、私訊及其他互動功能進行垃圾訊息騷擾。',
      },
      {
        guidelineRuleId: 'CG-004',
        reasonCode: 'privacy_violation',
        guidelineVersion: '1.0.0',
        title: '保護他人隱私',
        policy:
          '不得未經允許揭露他人的非公開個人資料、私人聯絡資訊或私人對話內容，亦不得以揭露這些資訊威脅其他會員。',
      },
    ])
    assert.equal(Object.isFrozen(COMMUNITY_GUIDELINE_CATALOG), true)
    assert.equal(COMMUNITY_GUIDELINE_CATALOG.every(Object.isFrozen), true)
  })

  it('resolves only an exact canonical triple and preserves historical version lookup', () => {
    assert.equal(
      resolveCommunityGuideline({
        guidelineRuleId: 'CG-001',
        reasonCode: 'targeted_harassment',
        guidelineVersion: '1.0.0',
      })?.title,
      '尊重其他會員',
    )
    assert.equal(
      resolveHistoricalCommunityGuideline('CG-004', '1.0.0')?.reasonCode,
      'privacy_violation',
    )
    assert.equal(
      resolveCommunityGuideline({
        guidelineRuleId: 'CG-001',
        reasonCode: 'privacy_violation',
        guidelineVersion: '1.0.0',
      }),
      null,
    )
    assert.equal(resolveHistoricalCommunityGuideline('CG-001', '2.0.0'), null)
  })
})

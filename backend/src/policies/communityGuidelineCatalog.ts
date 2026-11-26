export const ACTIVE_COMMUNITY_GUIDELINE_VERSION = '1.0.0' as const

export type CommunityGuidelineRule = Readonly<{
  guidelineRuleId: string
  reasonCode: string
  guidelineVersion: typeof ACTIVE_COMMUNITY_GUIDELINE_VERSION
  title: string
  policy: string
}>

const approvedRules = [
  {
    guidelineRuleId: 'CG-001',
    reasonCode: 'targeted_harassment',
    guidelineVersion: ACTIVE_COMMUNITY_GUIDELINE_VERSION,
    title: '尊重其他會員',
    policy:
      '禁止針對其他會員持續辱罵、羞辱、騷擾或以惡意言語攻擊對方。電影喜好可以不同，但不得以此作為人身攻擊的理由。',
  },
  {
    guidelineRuleId: 'CG-002',
    reasonCode: 'unwanted_contact',
    guidelineVersion: ACTIVE_COMMUNITY_GUIDELINE_VERSION,
    title: '尊重互動與聯絡界線',
    policy:
      '會員明確表示不願繼續交流後，不得持續發送騷擾訊息、施壓要求回覆，或利用其他功能規避對方的拒絕與封鎖。',
  },
  {
    guidelineRuleId: 'CG-003',
    reasonCode: 'spam_or_abuse',
    guidelineVersion: ACTIVE_COMMUNITY_GUIDELINE_VERSION,
    title: '禁止垃圾訊息與濫用互動功能',
    policy:
      '不得大量發送重複訊息、未經邀請的商業推廣內容，或使用關注、私訊及其他互動功能進行垃圾訊息騷擾。',
  },
  {
    guidelineRuleId: 'CG-004',
    reasonCode: 'privacy_violation',
    guidelineVersion: ACTIVE_COMMUNITY_GUIDELINE_VERSION,
    title: '保護他人隱私',
    policy:
      '不得未經允許揭露他人的非公開個人資料、私人聯絡資訊或私人對話內容，亦不得以揭露這些資訊威脅其他會員。',
  },
] as const satisfies readonly CommunityGuidelineRule[]

export const COMMUNITY_GUIDELINE_CATALOG = Object.freeze(
  approvedRules.map((rule) => Object.freeze({ ...rule })),
) as readonly CommunityGuidelineRule[]

export type RequestedCommunityGuideline = Readonly<{
  guidelineRuleId: string
  reasonCode: string
  guidelineVersion: string
}>

export const resolveCommunityGuideline = (
  requested: RequestedCommunityGuideline,
): CommunityGuidelineRule | null =>
  COMMUNITY_GUIDELINE_CATALOG.find(
    (rule) =>
      rule.guidelineRuleId === requested.guidelineRuleId &&
      rule.reasonCode === requested.reasonCode &&
      rule.guidelineVersion === requested.guidelineVersion,
  ) ?? null

export const resolveHistoricalCommunityGuideline = (
  guidelineRuleId: string,
  guidelineVersion: string,
): CommunityGuidelineRule | null =>
  COMMUNITY_GUIDELINE_CATALOG.find(
    (rule) =>
      rule.guidelineRuleId === guidelineRuleId && rule.guidelineVersion === guidelineVersion,
  ) ?? null

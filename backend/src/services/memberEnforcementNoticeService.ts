import { Types, isObjectIdOrHexString } from 'mongoose'
import {
  AccountEnforcementAction,
  STAGE_B_MEMBER_NOTICE_PROVENANCE,
  type IAccountEnforcementAction,
} from '../models/accountEnforcementActionModel.js'
import { ApiProblem } from '../utils/messagingPolicy.js'
import { resolveHistoricalCommunityGuideline } from '../policies/communityGuidelineCatalog.js'
import { validMemberFacingReason } from '../policies/caseEnforcementPolicy.js'

export type MemberEnforcementNotice = Readonly<{
  id: string
  actionType: 'formal_warning'
  status: 'recorded' | 'reversed' | 'legacy_reversed'
  recordedAt: Date
  reason: string
  guideline: Readonly<{ ruleId: string; version: string; title: string }>
  reversedAt?: Date
  reversalReason?: string
}>

const isTrustedStageBNotice = (
  action: Partial<IAccountEnforcementAction>,
  authenticatedUserId: string,
) =>
  action.memberNoticeProvenance === STAGE_B_MEMBER_NOTICE_PROVENANCE &&
  action.recordType === 'decision' &&
  action.decisionType === 'formal_warning' &&
  action.targetUserId?.toString() === authenticatedUserId &&
  isObjectIdOrHexString(action.reviewDecisionId) &&
  typeof action.operationId === 'string' &&
  /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(action.operationId) &&
  typeof action.commandDigest === 'string' &&
  /^[a-f0-9]{64}$/.test(action.commandDigest) &&
  validMemberFacingReason(action.reasonSummary)

export const listMemberEnforcementNotices = async (
  authenticatedUserId: string,
): Promise<readonly MemberEnforcementNotice[]> => {
  if (!isObjectIdOrHexString(authenticatedUserId)) {
    throw new ApiProblem(
      400,
      'MEMBER_ENFORCEMENT_NOTICE_INPUT_INVALID',
      'Member identity is invalid',
    )
  }
  const decisions = await AccountEnforcementAction.find({
    targetUserId: new Types.ObjectId(authenticatedUserId),
    recordType: 'decision',
    decisionType: 'formal_warning',
    memberNoticeProvenance: STAGE_B_MEMBER_NOTICE_PROVENANCE,
  })
    .select(
      '_id targetUserId recordType decisionType effectiveAt reviewDecisionId operationId commandDigest memberNoticeProvenance reasonSummary reasonCode guidelineRuleId guidelineVersion',
    )
    .sort({ effectiveAt: -1, _id: -1 })
    .limit(50)
    .lean()

  const decisionIds = decisions.map((decision) => decision._id)
  const reversals = decisionIds.length
    ? await AccountEnforcementAction.find({
        recordType: 'reversal',
        reversesDecisionId: { $in: decisionIds },
      })
        .select(
          '_id targetUserId recordType effectiveAt operationId commandDigest reasonCode memberFacingReasonSummary reversesDecisionId',
        )
        .sort({ effectiveAt: 1, _id: 1 })
        .lean()
    : []

  const malformed = () =>
    new ApiProblem(
      503,
      'MEMBER_ENFORCEMENT_NOTICE_PROJECTION_UNAVAILABLE',
      'Member enforcement notices are unavailable',
    )

  return decisions.flatMap<MemberEnforcementNotice>((action) => {
    if (!isTrustedStageBNotice(action, authenticatedUserId)) return []
    const guideline = resolveHistoricalCommunityGuideline(
      action.guidelineRuleId!,
      action.guidelineVersion!,
    )
    if (!guideline || guideline.reasonCode !== action.reasonCode) {
      return []
    }
    const matching = reversals.filter(
      (reversal) => reversal.reversesDecisionId?.toString() === action._id.toString(),
    )
    if (matching.length > 1) throw malformed()
    const reversal = matching[0]
    const base = {
      id: action._id.toString(),
      actionType: 'formal_warning' as const,
      recordedAt: new Date(action.effectiveAt),
      reason: action.reasonSummary,
      guideline: {
        ruleId: guideline.guidelineRuleId,
        version: guideline.guidelineVersion,
        title: guideline.title,
      },
    }
    if (!reversal) return [{ ...base, status: 'recorded' as const }]
    if (
      reversal.recordType !== 'reversal' ||
      reversal.targetUserId?.toString() !== authenticatedUserId ||
      !(reversal.effectiveAt instanceof Date) ||
      reversal.effectiveAt < action.effectiveAt
    ) {
      throw malformed()
    }
    const hasOperationId = reversal.operationId !== undefined
    const hasDigest = reversal.commandDigest !== undefined
    if (!hasOperationId && !hasDigest) {
      return [
        {
          ...base,
          status: 'legacy_reversed' as const,
          reversedAt: new Date(reversal.effectiveAt),
        },
      ]
    }
    if (
      typeof reversal.operationId !== 'string' ||
      !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(reversal.operationId) ||
      typeof reversal.commandDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(reversal.commandDigest) ||
      reversal.reasonCode !== 'admin.reversal'
    ) {
      throw malformed()
    }
    if (reversal.memberFacingReasonSummary === undefined) {
      return [
        {
          ...base,
          status: 'legacy_reversed' as const,
          reversedAt: new Date(reversal.effectiveAt),
        },
      ]
    }
    if (!validMemberFacingReason(reversal.memberFacingReasonSummary)) throw malformed()
    return [
      {
        ...base,
        status: 'reversed' as const,
        reversedAt: new Date(reversal.effectiveAt),
        reversalReason: reversal.memberFacingReasonSummary,
      },
    ]
  })
}

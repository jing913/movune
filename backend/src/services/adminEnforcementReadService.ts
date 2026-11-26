import { isObjectIdOrHexString } from 'mongoose'
import { AccountEnforcementAction } from '../models/accountEnforcementActionModel.js'
import { User } from '../models/userModel.js'
import { ACCOUNT_ENFORCEMENT_REVERSAL_REASON_OPTIONS } from '../policies/accountEnforcementReversalReasonCatalog.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

const unavailable = () =>
  new ApiProblem(503, 'ADMIN_ENFORCEMENT_DATA_INVALID', 'Enforcement history is unavailable')

export const readAdminEnforcementDecisions = async (targetUserId: string, evaluatedAt: Date) => {
  if (!isObjectIdOrHexString(targetUserId)) {
    throw new ApiProblem(400, 'ADMIN_ENFORCEMENT_TARGET_INVALID', 'Target member id is invalid')
  }
  const member = await User.findById(targetUserId).select('_id account displayName').lean()
  if (!member)
    throw new ApiProblem(404, 'ADMIN_ENFORCEMENT_TARGET_NOT_FOUND', 'Target member not found')

  const actions = await AccountEnforcementAction.find({ targetUserId })
    .select(
      '_id targetUserId recordType decisionType effectiveAt endsAt reasonSummary operationId reversesDecisionId performedByUserId',
    )
    .sort({ effectiveAt: -1, _id: -1 })
    .lean()
  const decisions = actions.filter(
    (action) =>
      action.recordType === 'decision' &&
      (action.decisionType === 'formal_warning' || action.decisionType === 'temporary_suspension'),
  )
  const reversals = actions.filter((action) => action.recordType === 'reversal')

  return {
    member: {
      id: member._id.toString(),
      displayName: member.displayName?.trim() || member.account,
      account: member.account,
    },
    decisions: decisions.slice(0, 50).map((decision) => {
      if (
        !decision._id ||
        !decision.targetUserId ||
        !(decision.effectiveAt instanceof Date) ||
        typeof decision.reasonSummary !== 'string'
      ) {
        throw unavailable()
      }
      const matching = reversals.filter(
        (reversal) => reversal.reversesDecisionId?.toString() === decision._id.toString(),
      )
      if (matching.length > 1) throw unavailable()
      const reversal = matching[0]
      if (
        reversal &&
        (!(reversal.effectiveAt instanceof Date) ||
          reversal.targetUserId?.toString() !== targetUserId ||
          reversal.effectiveAt < decision.effectiveAt)
      ) {
        throw unavailable()
      }
      const endsAt = decision.endsAt instanceof Date ? decision.endsAt : null
      return {
        id: decision._id.toString(),
        targetUserId,
        decisionType: decision.decisionType as 'formal_warning' | 'temporary_suspension',
        effectiveAt: decision.effectiveAt,
        endsAt,
        reasonSummary: decision.reasonSummary,
        expired:
          decision.decisionType === 'temporary_suspension' &&
          endsAt !== null &&
          endsAt <= evaluatedAt,
        state: reversal ? ('reversed' as const) : ('reversible' as const),
        reversal: reversal
          ? {
              id: reversal._id.toString(),
              operationId: typeof reversal.operationId === 'string' ? reversal.operationId : null,
              effectiveAt: reversal.effectiveAt as Date,
            }
          : null,
      }
    }),
    memberFacingReasonOptions: ACCOUNT_ENFORCEMENT_REVERSAL_REASON_OPTIONS,
  }
}

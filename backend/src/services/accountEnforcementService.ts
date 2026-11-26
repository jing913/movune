import { Types, isObjectIdOrHexString, type ClientSession } from 'mongoose'
import {
  AccountEnforcementAction,
  type IAccountEnforcementAction,
} from '../models/accountEnforcementActionModel.js'
import { User } from '../models/userModel.js'
import {
  ENFORCEMENT_REASON_SUMMARY_MAX_LENGTH,
  evaluateAccountEnforcement,
  type AccountEnforcementDecisionType,
  type AccountEnforcementHistoryItem,
} from '../utils/accountEnforcementPolicy.js'

export type AppendAccountEnforcementDecisionInput = Readonly<{
  targetUserId: string
  performedByUserId: string
  decisionType: AccountEnforcementDecisionType
  effectiveAt: Date
  endsAt?: Date
  reasonCode?: string
  reasonSummary: string
  guidelineRuleId?: string
  guidelineVersion?: string
}>

export type AppendAccountEnforcementReversalInput = Readonly<{
  targetUserId: string
  performedByUserId: string
  reversesDecisionId: string
  effectiveAt: Date
  reasonCode: string
  reasonSummary: string
  memberFacingReasonSummary?: string
}>

export type AccountEnforcementServiceErrorCode =
  | 'ACCOUNT_ENFORCEMENT_INPUT_INVALID'
  | 'ACCOUNT_ENFORCEMENT_USER_NOT_FOUND'
  | 'ACCOUNT_ENFORCEMENT_DECISION_NOT_FOUND'
  | 'ACCOUNT_ENFORCEMENT_REVERSAL_TARGET_MISMATCH'
  | 'ACCOUNT_ENFORCEMENT_DECISION_NOT_REVERSIBLE'
  | 'ACCOUNT_ENFORCEMENT_REVERSAL_PREDATES_DECISION'
  | 'ACCOUNT_ENFORCEMENT_ALREADY_REVERSED'

export class AccountEnforcementServiceError extends Error {
  constructor(
    public readonly code: AccountEnforcementServiceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AccountEnforcementServiceError'
  }
}

const requireObjectId = (value: string, field: string) => {
  if (!isObjectIdOrHexString(value)) {
    throw new AccountEnforcementServiceError(
      'ACCOUNT_ENFORCEMENT_INPUT_INVALID',
      `${field} is invalid`,
    )
  }
  return new Types.ObjectId(value)
}

const requireUsers = async (targetUserId: Types.ObjectId, performedByUserId: Types.ObjectId) => {
  const [targetExists, actorExists] = await Promise.all([
    User.exists({ _id: targetUserId }),
    User.exists({ _id: performedByUserId }),
  ])
  if (!targetExists || !actorExists) {
    throw new AccountEnforcementServiceError(
      'ACCOUNT_ENFORCEMENT_USER_NOT_FOUND',
      'Target and performing users must exist',
    )
  }
}

const isDuplicateKeyError = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000

const isMemberFacingReasonSummary = (value: unknown): value is string =>
  typeof value === 'string' &&
  value === value.trim() &&
  value.length > 0 &&
  [...value].length <= ENFORCEMENT_REASON_SUMMARY_MAX_LENGTH

const toHistoryItem = (
  action: IAccountEnforcementAction & { _id: Types.ObjectId },
): AccountEnforcementHistoryItem => ({
  id: action._id.toString(),
  targetUserId: action.targetUserId.toString(),
  recordType: action.recordType,
  effectiveAt: new Date(action.effectiveAt),
  performedByUserId: action.performedByUserId.toString(),
  ...(action.reviewDecisionId ? { reviewDecisionId: action.reviewDecisionId.toString() } : {}),
  ...(action.recordType === 'decision' && action.operationId
    ? { operationId: action.operationId }
    : {}),
  ...(action.recordType === 'decision' && action.commandDigest
    ? { commandDigest: action.commandDigest }
    : {}),
  ...(action.reasonCode ? { reasonCode: action.reasonCode } : {}),
  reasonSummary: action.reasonSummary,
  ...(action.memberFacingReasonSummary !== undefined
    ? { memberFacingReasonSummary: action.memberFacingReasonSummary }
    : {}),
  ...(action.decisionType ? { decisionType: action.decisionType } : {}),
  ...(action.guidelineRuleId ? { guidelineRuleId: action.guidelineRuleId } : {}),
  ...(action.guidelineVersion ? { guidelineVersion: action.guidelineVersion } : {}),
  ...(action.endsAt ? { endsAt: new Date(action.endsAt) } : {}),
  ...(action.reversesDecisionId
    ? { reversesDecisionId: action.reversesDecisionId.toString() }
    : {}),
  createdAt: new Date(action.createdAt),
})

export const appendAccountEnforcementDecision = async (
  input: AppendAccountEnforcementDecisionInput,
) => {
  const targetUserId = requireObjectId(input.targetUserId, 'targetUserId')
  const performedByUserId = requireObjectId(input.performedByUserId, 'performedByUserId')
  await requireUsers(targetUserId, performedByUserId)
  const action = await AccountEnforcementAction.create({
    targetUserId,
    recordType: 'decision',
    effectiveAt: input.effectiveAt,
    performedByUserId,
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    reasonSummary: input.reasonSummary,
    decisionType: input.decisionType,
    ...(input.guidelineRuleId ? { guidelineRuleId: input.guidelineRuleId } : {}),
    ...(input.guidelineVersion ? { guidelineVersion: input.guidelineVersion } : {}),
    ...(input.endsAt ? { endsAt: input.endsAt } : {}),
  })
  return toHistoryItem(action)
}

export const appendAccountEnforcementReversal = async (
  input: AppendAccountEnforcementReversalInput,
) => {
  const targetUserId = requireObjectId(input.targetUserId, 'targetUserId')
  const performedByUserId = requireObjectId(input.performedByUserId, 'performedByUserId')
  const reversesDecisionId = requireObjectId(input.reversesDecisionId, 'reversesDecisionId')
  await requireUsers(targetUserId, performedByUserId)

  const decision = await AccountEnforcementAction.findById(reversesDecisionId).lean()
  if (!decision || decision.recordType !== 'decision') {
    throw new AccountEnforcementServiceError(
      'ACCOUNT_ENFORCEMENT_DECISION_NOT_FOUND',
      'The referenced enforcement decision does not exist',
    )
  }
  if (!decision.targetUserId.equals(targetUserId)) {
    throw new AccountEnforcementServiceError(
      'ACCOUNT_ENFORCEMENT_REVERSAL_TARGET_MISMATCH',
      'The reversal target does not match the decision target',
    )
  }
  if (
    decision.decisionType !== 'formal_warning' &&
    decision.decisionType !== 'temporary_suspension' &&
    decision.decisionType !== 'permanent_deactivation'
  ) {
    throw new AccountEnforcementServiceError(
      'ACCOUNT_ENFORCEMENT_DECISION_NOT_REVERSIBLE',
      'The referenced decision is not reversible',
    )
  }
  if (
    decision.decisionType === 'formal_warning' &&
    !isMemberFacingReasonSummary(input.memberFacingReasonSummary)
  ) {
    throw new AccountEnforcementServiceError(
      'ACCOUNT_ENFORCEMENT_INPUT_INVALID',
      'A Formal Warning reversal requires an approved member-facing reason',
    )
  }
  if (input.effectiveAt < decision.effectiveAt) {
    throw new AccountEnforcementServiceError(
      'ACCOUNT_ENFORCEMENT_REVERSAL_PREDATES_DECISION',
      'A reversal cannot predate its decision',
    )
  }

  try {
    const action = await AccountEnforcementAction.create({
      targetUserId,
      recordType: 'reversal',
      effectiveAt: input.effectiveAt,
      performedByUserId,
      reasonCode: input.reasonCode,
      reasonSummary: input.reasonSummary,
      ...(input.memberFacingReasonSummary !== undefined
        ? { memberFacingReasonSummary: input.memberFacingReasonSummary }
        : {}),
      reversesDecisionId,
    })
    return toHistoryItem(action)
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new AccountEnforcementServiceError(
        'ACCOUNT_ENFORCEMENT_ALREADY_REVERSED',
        'The referenced decision already has a reversal',
      )
    }
    throw error
  }
}

export type AccountEnforcementReadOptions = Readonly<{ session?: ClientSession }>

export const loadAccountEnforcementHistory = async (
  targetUserIdValue: string,
  options: AccountEnforcementReadOptions = {},
) => {
  const targetUserId = requireObjectId(targetUserIdValue, 'targetUserId')
  let query = AccountEnforcementAction.find({ targetUserId }).sort({ effectiveAt: 1, _id: 1 })
  if (options.session) query = query.session(options.session)
  const actions = await query.lean()
  return actions.map((action) =>
    toHistoryItem(action as IAccountEnforcementAction & { _id: Types.ObjectId }),
  )
}

export const evaluateAccountEnforcementState = async (
  targetUserId: string,
  evaluatedAt: Date,
  options: AccountEnforcementReadOptions = {},
) =>
  evaluateAccountEnforcement(
    await loadAccountEnforcementHistory(targetUserId, options),
    evaluatedAt,
  )

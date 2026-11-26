import {
  ENFORCEMENT_IDENTIFIER_MAX_LENGTH,
  ENFORCEMENT_IDENTIFIER_PATTERN,
  ENFORCEMENT_GUIDELINE_RULE_PATTERN,
  ENFORCEMENT_REASON_SUMMARY_MAX_LENGTH,
  type AccountEnforcementDecisionType,
} from '../utils/accountEnforcementPolicy.js'
import type { FinalReviewConclusion } from './caseLifecyclePolicy.js'

export const CASE_ENFORCEMENT_DECISION_TYPES = ['no_action', 'formal_warning'] as const
export type CaseEnforcementDecisionType = (typeof CASE_ENFORCEMENT_DECISION_TYPES)[number]

export type CaseEnforcementCommand = Readonly<{
  operationId: string
  reviewDecisionId: string
  decisionType: CaseEnforcementDecisionType
  reasonSummary: string
  reasonCode?: string
  guidelineRuleId?: string
  guidelineVersion?: string
}>

export const isCaseEnforcementDecisionType = (
  value: unknown,
): value is CaseEnforcementDecisionType =>
  typeof value === 'string' &&
  (CASE_ENFORCEMENT_DECISION_TYPES as readonly string[]).includes(value)

export const isConclusionActionAllowed = (
  conclusion: FinalReviewConclusion,
  decisionType: AccountEnforcementDecisionType,
) =>
  decisionType === 'no_action' ||
  (decisionType === 'formal_warning' && conclusion === 'violation_confirmed')

export const validMemberFacingReason = (value: unknown): value is string =>
  typeof value === 'string' &&
  value === value.trim() &&
  value.length > 0 &&
  [...value].length <= ENFORCEMENT_REASON_SUMMARY_MAX_LENGTH

export const validEnforcementReasonCode = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= ENFORCEMENT_IDENTIFIER_MAX_LENGTH &&
  ENFORCEMENT_IDENTIFIER_PATTERN.test(value)

export const validEnforcementGuidelineReference = (
  value: unknown,
): value is Readonly<{
  reasonCode: string
  guidelineRuleId: string
  guidelineVersion: string
}> => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    validEnforcementReasonCode(candidate.reasonCode) &&
    typeof candidate.guidelineRuleId === 'string' &&
    candidate.guidelineRuleId.length <= ENFORCEMENT_IDENTIFIER_MAX_LENGTH &&
    ENFORCEMENT_GUIDELINE_RULE_PATTERN.test(candidate.guidelineRuleId) &&
    typeof candidate.guidelineVersion === 'string' &&
    candidate.guidelineVersion.length <= ENFORCEMENT_IDENTIFIER_MAX_LENGTH &&
    ENFORCEMENT_IDENTIFIER_PATTERN.test(candidate.guidelineVersion)
  )
}

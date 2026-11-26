export const ACCOUNT_ENFORCEMENT_REVERSAL_REASON_OPTIONS = Object.freeze([
  Object.freeze({
    code: 'warning_reversed_after_review_v1',
    summary: '經重新審查後，此正式警告已撤銷。',
  }),
] as const)

export type AccountEnforcementReversalReasonCode =
  (typeof ACCOUNT_ENFORCEMENT_REVERSAL_REASON_OPTIONS)[number]['code']

export const resolveAccountEnforcementReversalReason = (value: unknown) =>
  ACCOUNT_ENFORCEMENT_REVERSAL_REASON_OPTIONS.find((option) => option.code === value) ?? null

export const ENFORCEMENT_IDENTIFIER_MAX_LENGTH = 128
export const ENFORCEMENT_REASON_SUMMARY_MAX_LENGTH = 1000
export const ENFORCEMENT_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/

export const ACCOUNT_ENFORCEMENT_DECISION_TYPES = [
  'no_action',
  'formal_warning',
  'temporary_suspension',
  'permanent_deactivation',
] as const

export type AccountEnforcementDecisionType = (typeof ACCOUNT_ENFORCEMENT_DECISION_TYPES)[number]
export type AccountEnforcementRecordType = 'decision' | 'reversal'
export type EffectiveAccountStatus = 'active' | 'suspended' | 'deactivated'

export type AccountEnforcementHistoryItem = Readonly<{
  id: string
  targetUserId: string
  recordType: AccountEnforcementRecordType
  effectiveAt: Date
  performedByUserId: string
  reasonCode: string
  reasonSummary: string
  decisionType?: AccountEnforcementDecisionType
  guidelineRuleId?: string
  guidelineVersion?: string
  endsAt?: Date
  reversesDecisionId?: string
  createdAt: Date
}>

export type EffectiveAccountState = Readonly<{
  status: EffectiveAccountStatus
  evaluatedAt: Date
  governingDecisionId: string | null
  activeRestrictionDecisionIds: readonly string[]
  restrictionEndsAt: Date | null
}>

export class AccountEnforcementInvariantError extends Error {
  readonly code = 'ACCOUNT_ENFORCEMENT_HISTORY_INVALID'

  constructor(message: string) {
    super(message)
    this.name = 'AccountEnforcementInvariantError'
  }
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new AccountEnforcementInvariantError(message)
}

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.valueOf())

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= ENFORCEMENT_IDENTIFIER_MAX_LENGTH &&
  ENFORCEMENT_IDENTIFIER_PATTERN.test(value)

const isReasonSummary = (value: unknown): value is string =>
  typeof value === 'string' &&
  value === value.trim() &&
  value.length > 0 &&
  [...value].length <= ENFORCEMENT_REASON_SUMMARY_MAX_LENGTH

const isDecisionType = (value: unknown): value is AccountEnforcementDecisionType =>
  typeof value === 'string' &&
  (ACCOUNT_ENFORCEMENT_DECISION_TYPES as readonly string[]).includes(value)

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

const compareActions = (
  left: AccountEnforcementHistoryItem,
  right: AccountEnforcementHistoryItem,
) => left.effectiveAt.valueOf() - right.effectiveAt.valueOf() || compareText(left.id, right.id)

const validateCommonFields = (item: AccountEnforcementHistoryItem) => {
  invariant(typeof item.id === 'string' && item.id.length > 0, 'Action id is required')
  invariant(
    typeof item.targetUserId === 'string' && item.targetUserId.length > 0,
    'Target user id is required',
  )
  invariant(
    item.recordType === 'decision' || item.recordType === 'reversal',
    'Record type is invalid',
  )
  invariant(isValidDate(item.effectiveAt), 'Effective time is invalid')
  invariant(
    typeof item.performedByUserId === 'string' && item.performedByUserId.length > 0,
    'Performing user id is required',
  )
  invariant(isIdentifier(item.reasonCode), 'Reason code is invalid')
  invariant(isReasonSummary(item.reasonSummary), 'Reason summary is invalid')
  invariant(isValidDate(item.createdAt), 'Creation time is invalid')
}

const validateDecision = (item: AccountEnforcementHistoryItem) => {
  invariant(isDecisionType(item.decisionType), 'Decision type is invalid')
  invariant(isIdentifier(item.guidelineRuleId), 'Guideline rule id is invalid')
  invariant(isIdentifier(item.guidelineVersion), 'Guideline version is invalid')
  invariant(item.reversesDecisionId === undefined, 'A decision cannot reverse another decision')
  if (item.decisionType === 'temporary_suspension') {
    invariant(isValidDate(item.endsAt), 'Temporary suspension end time is required')
    invariant(item.endsAt > item.effectiveAt, 'Temporary suspension end time must follow its start')
  } else {
    invariant(item.endsAt === undefined, 'Only temporary suspension may have an end time')
  }
}

const validateReversalShape = (item: AccountEnforcementHistoryItem) => {
  invariant(item.decisionType === undefined, 'A reversal cannot have a decision type')
  invariant(item.guidelineRuleId === undefined, 'A reversal cannot have a guideline rule id')
  invariant(item.guidelineVersion === undefined, 'A reversal cannot have a guideline version')
  invariant(item.endsAt === undefined, 'A reversal cannot have an end time')
  invariant(
    typeof item.reversesDecisionId === 'string' && item.reversesDecisionId.length > 0,
    'A reversal must reference a decision',
  )
}

const validateHistory = (history: readonly AccountEnforcementHistoryItem[]) => {
  const byId = new Map<string, AccountEnforcementHistoryItem>()
  for (const item of history) {
    validateCommonFields(item)
    invariant(!byId.has(item.id), 'Action ids must be unique')
    byId.set(item.id, item)
    if (item.recordType === 'decision') validateDecision(item)
    else validateReversalShape(item)
  }

  const reversedDecisionIds = new Set<string>()
  for (const reversal of history.filter((item) => item.recordType === 'reversal')) {
    const decision = byId.get(reversal.reversesDecisionId!)
    invariant(decision !== undefined, 'A reversal references a missing decision')
    invariant(decision.recordType === 'decision', 'A reversal must reference a decision')
    invariant(decision.targetUserId === reversal.targetUserId, 'A reversal target does not match')
    invariant(
      decision.decisionType === 'temporary_suspension' ||
        decision.decisionType === 'permanent_deactivation',
      'The referenced decision is not reversible',
    )
    invariant(
      reversal.effectiveAt >= decision.effectiveAt,
      'A reversal cannot predate its decision',
    )
    invariant(!reversedDecisionIds.has(decision.id), 'A decision cannot have multiple reversals')
    reversedDecisionIds.add(decision.id)
  }
}

const decisionRank = (decision: AccountEnforcementHistoryItem) =>
  decision.decisionType === 'permanent_deactivation' ? 2 : 1

const compareGoverningPriority = (
  left: AccountEnforcementHistoryItem,
  right: AccountEnforcementHistoryItem,
) =>
  decisionRank(left) - decisionRank(right) ||
  left.effectiveAt.valueOf() - right.effectiveAt.valueOf() ||
  compareText(left.id, right.id)

export const evaluateAccountEnforcement = (
  history: readonly AccountEnforcementHistoryItem[],
  evaluatedAt: Date,
): EffectiveAccountState => {
  invariant(isValidDate(evaluatedAt), 'Evaluation time is invalid')
  validateHistory(history)

  const sorted = [...history].sort(compareActions)
  const effectiveReversals = new Set(
    sorted
      .filter((item) => item.recordType === 'reversal' && item.effectiveAt <= evaluatedAt)
      .map((item) => item.reversesDecisionId!),
  )
  const activeRestrictions = sorted.filter((item) => {
    if (item.recordType !== 'decision' || item.effectiveAt > evaluatedAt) return false
    if (effectiveReversals.has(item.id)) return false
    if (item.decisionType === 'permanent_deactivation') return true
    return item.decisionType === 'temporary_suspension' && item.endsAt! > evaluatedAt
  })

  const governing = activeRestrictions.reduce<AccountEnforcementHistoryItem | null>(
    (current, candidate) =>
      current === null || compareGoverningPriority(candidate, current) > 0 ? candidate : current,
    null,
  )
  const status: EffectiveAccountStatus =
    governing?.decisionType === 'permanent_deactivation'
      ? 'deactivated'
      : governing?.decisionType === 'temporary_suspension'
        ? 'suspended'
        : 'active'
  const restrictionEndsAt =
    status === 'suspended'
      ? new Date(
          Math.max(
            ...activeRestrictions
              .filter((item) => item.decisionType === 'temporary_suspension')
              .map((item) => item.endsAt!.valueOf()),
          ),
        )
      : null

  return {
    status,
    evaluatedAt: new Date(evaluatedAt),
    governingDecisionId: governing?.id ?? null,
    activeRestrictionDecisionIds: activeRestrictions.map((item) => item.id),
    restrictionEndsAt,
  }
}

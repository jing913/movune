import type { EffectiveAccountState } from '../utils/accountEnforcementPolicy.js'
import { evaluateAccountEnforcementState } from '../services/accountEnforcementService.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

export const REPORT_REVIEW_PERMISSION = 'reports:review' as const

export type ReportReviewAuthorizationIdentity = Readonly<{
  _id: string | Readonly<{ toString(): string }>
  role: 'user' | 'admin'
}>

export type ReportReviewCapabilities = Readonly<{
  viewReports: boolean
}>

export type ReportReviewAccountStateLoader = (
  userId: string,
  evaluatedAt: Date,
) => Promise<EffectiveAccountState>

const hasIdentity = (user: ReportReviewAuthorizationIdentity) => {
  try {
    return user._id.toString().length > 0
  } catch {
    return false
  }
}

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.valueOf())

const isConsistentAccountState = (accountState: EffectiveAccountState) => {
  if (
    !isValidDate(accountState.evaluatedAt) ||
    !Array.isArray(accountState.activeRestrictionDecisionIds) ||
    !accountState.activeRestrictionDecisionIds.every(
      (decisionId) => typeof decisionId === 'string' && decisionId.length > 0,
    )
  ) {
    return false
  }

  if (accountState.status === 'active') {
    return (
      accountState.governingDecisionId === null &&
      accountState.activeRestrictionDecisionIds.length === 0 &&
      accountState.restrictionEndsAt === null
    )
  }

  if (
    typeof accountState.governingDecisionId !== 'string' ||
    !accountState.activeRestrictionDecisionIds.includes(accountState.governingDecisionId)
  ) {
    return false
  }

  if (accountState.status === 'suspended') return isValidDate(accountState.restrictionEndsAt)
  if (accountState.status === 'deactivated') return accountState.restrictionEndsAt === null
  return false
}

export const isReportReviewAuthorized = (
  user: ReportReviewAuthorizationIdentity | null | undefined,
  accountState: EffectiveAccountState | null | undefined,
) =>
  Boolean(
    user &&
    user.role === 'admin' &&
    hasIdentity(user) &&
    accountState &&
    isConsistentAccountState(accountState) &&
    accountState.status === 'active',
  )

export const deriveReportReviewCapabilities = async (
  user: ReportReviewAuthorizationIdentity | null | undefined,
  evaluatedAt: Date,
  loadAccountState: ReportReviewAccountStateLoader = evaluateAccountEnforcementState,
): Promise<ReportReviewCapabilities> => {
  if (!user || user.role !== 'admin') return { viewReports: false }

  try {
    const accountState = await loadAccountState(user._id.toString(), evaluatedAt)
    if (accountState.evaluatedAt.valueOf() !== evaluatedAt.valueOf()) {
      return { viewReports: false }
    }
    return { viewReports: isReportReviewAuthorized(user, accountState) }
  } catch {
    return { viewReports: false }
  }
}

export const assertReportReviewAuthorized = async (
  user: ReportReviewAuthorizationIdentity | null | undefined,
  evaluatedAt: Date,
  loadAccountState: ReportReviewAccountStateLoader = evaluateAccountEnforcementState,
) => {
  const capabilities = await deriveReportReviewCapabilities(user, evaluatedAt, loadAccountState)
  if (!capabilities.viewReports) {
    throw new ApiProblem(403, 'REPORT_REVIEW_FORBIDDEN', 'Report Review permission is required')
  }
}

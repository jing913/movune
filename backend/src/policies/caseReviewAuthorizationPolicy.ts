import {
  REPORT_REVIEW_PERMISSION,
  assertReportReviewAuthorized,
  deriveReportReviewCapabilities,
  type ReportReviewAccountStateLoader,
  type ReportReviewAuthorizationIdentity,
} from './reportReviewAuthorizationPolicy.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

/**
 * Case review deliberately reuses the existing Report Review authorization
 * boundary. This alias creates no new permission, role, or authorization rule.
 */
export const CASE_REVIEW_PERMISSION = REPORT_REVIEW_PERMISSION
export const assertCaseReviewAuthorized = assertReportReviewAuthorized

export const CASE_REVIEW_MUTATION_PERMISSION = 'cases:review' as const

export type CaseReviewMutationAuthorizationIdentity = ReportReviewAuthorizationIdentity &
  Readonly<{ caseReviewMutationEnabled?: unknown }>

export type CaseReviewMutationCapabilities = Readonly<{ reviewCases: boolean }>

export const deriveCaseReviewMutationCapabilities = async (
  user: CaseReviewMutationAuthorizationIdentity | null | undefined,
  evaluatedAt: Date,
  loadAccountState?: ReportReviewAccountStateLoader,
): Promise<CaseReviewMutationCapabilities> => {
  if (user?.caseReviewMutationEnabled !== true) return { reviewCases: false }
  const reportCapabilities = await deriveReportReviewCapabilities(
    user,
    evaluatedAt,
    loadAccountState,
  )
  return { reviewCases: reportCapabilities.viewReports }
}

export const assertCaseReviewMutationAuthorized = async (
  user: CaseReviewMutationAuthorizationIdentity | null | undefined,
  evaluatedAt: Date,
  loadAccountState?: ReportReviewAccountStateLoader,
) => {
  const capabilities = await deriveCaseReviewMutationCapabilities(
    user,
    evaluatedAt,
    loadAccountState,
  )
  if (!capabilities.reviewCases) {
    throw new ApiProblem(403, 'CASE_REVIEW_FORBIDDEN', 'Case Review permission is required')
  }
}

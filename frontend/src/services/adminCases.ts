import axios from 'axios'
import api from '@/services/api'
import type {
  AdminReportAccountStatus,
  AdminReportReason,
  AdminReportSourceType,
  ReportAccountStatusValue,
  ReportIdentityValue,
} from '@/services/adminReports'

export const ADMIN_CASE_STATES = ['needs_review', 'under_review', 'review_completed'] as const
export const ADMIN_CASE_CONCLUSIONS = [
  'violation_confirmed',
  'no_violation_found',
  'insufficient_evidence',
] as const
export const ADMIN_CASE_ENFORCEMENT_DECISION_TYPES = ['no_action', 'formal_warning'] as const

const REPORT_REASONS = ['harassment_or_uncomfortable', 'spam_or_suspicious', 'other'] as const
const REPORT_SOURCE_TYPES = ['public_profile', 'direct_conversation', 'direct_message'] as const
const ACCOUNT_STATUSES = ['active', 'suspended', 'deactivated'] as const
const CASE_ERROR_CODES = [
  'ADMIN_CASE_QUEUE_QUERY_INVALID',
  'ADMIN_CASE_REPORT_ID_INVALID',
  'ADMIN_CASE_DATA_INVALID',
  'CASE_INPUT_INVALID',
  'CASE_REPORT_NOT_FOUND',
  'CASE_INVALID_TRANSITION',
  'CASE_STALE_REVISION',
  'CASE_ALREADY_STARTED',
  'CASE_ALREADY_FINALIZED',
  'CASE_OPERATION_ID_REUSED',
  'CASE_CAS_CONFLICT',
  'CASE_DUPLICATE_KEY_CONFLICT',
  'CASE_TRANSACTION_UNAVAILABLE',
  'CASE_OPERATION_UNCONFIRMED',
  'CASE_PERSISTENCE_INTEGRITY',
  'MEMBER_ENFORCEMENT_FORBIDDEN',
  'CASE_ENFORCEMENT_INPUT_INVALID',
  'CASE_ENFORCEMENT_SOURCE_NOT_FOUND',
  'CASE_ENFORCEMENT_SOURCE_INVALID',
  'CASE_ENFORCEMENT_ACTION_NOT_ALLOWED',
  'CASE_ENFORCEMENT_GUIDELINE_INVALID',
  'CASE_ENFORCEMENT_ALREADY_RECORDED',
  'CASE_ENFORCEMENT_OPERATION_ID_REUSED',
  'CASE_ENFORCEMENT_POLICY_UNAVAILABLE',
  'CASE_ENFORCEMENT_TRANSACTION_UNAVAILABLE',
  'CASE_ENFORCEMENT_CONFLICT',
] as const

export type AdminCaseState = (typeof ADMIN_CASE_STATES)[number]
export type AdminCaseConclusion = (typeof ADMIN_CASE_CONCLUSIONS)[number]
export type AdminCaseEnforcementDecisionType =
  (typeof ADMIN_CASE_ENFORCEMENT_DECISION_TYPES)[number]
export type AdminCaseErrorCode = (typeof CASE_ERROR_CODES)[number]
export type AdminCaseMutationKind = 'committed' | 'replayed'

export interface AdminCaseSummary {
  id: string | null
  reportId: string
  state: AdminCaseState
  revision: number
  reviewStartedAt: string | null
  completedAt: string | null
}

export interface AdminCaseQueueItem {
  report: {
    id: string
    reason: AdminReportReason
    sourceType: AdminReportSourceType
    reportedMemberDisplayName: ReportIdentityValue
    reportedMemberAccount: ReportIdentityValue
    submittedAt: string
  }
  case: AdminCaseSummary
}

export interface AdminCaseQueueResponse {
  cases: AdminCaseQueueItem[]
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null }
}

export interface AdminCaseDetail {
  report: {
    id: string
    reason: AdminReportReason
    description?: string
    sourceType: AdminReportSourceType
    submittedAt: string
  }
  reportedMember: {
    avatar: string | null
    displayName: ReportIdentityValue
    account: ReportIdentityValue
    effectiveAccountStatus: ReportAccountStatusValue
  }
  reporter: {
    displayName: ReportIdentityValue
    account: ReportIdentityValue
  }
  case: AdminCaseSummary & { reviewStartedByUserId: string | null }
  decision: {
    id: string
    conclusion: AdminCaseConclusion
    rationale: string
    decidedByUserId: string
    decidedAt: string
    caseRevision: number
  } | null
  enforcement: AdminCaseEnforcementAction | null
}

export interface AdminCaseEnforcementAction {
  id: string
  reviewDecisionId: string
  targetUserId?: string
  decisionType: AdminCaseEnforcementDecisionType
  effectiveAt: string
  performedByUserId: string
  reasonCode?: string
  reasonSummary: string
  guidelineRuleId?: string
  guidelineVersion?: string
}

export interface CreateAdminCaseEnforcementInput {
  reportId: string
  operationId: string
  reviewDecisionId: string
  decisionType: AdminCaseEnforcementDecisionType
  reasonSummary: string
  reasonCode?: string
  guidelineRuleId?: string
  guidelineVersion?: string
}

export interface AdminEnforcementGuideline {
  guidelineRuleId: string
  reasonCode: string
  guidelineVersion: string
  title: string
  policy: string
}

export const canConfirmAdminCaseEnforcement = (
  decisionType: AdminCaseEnforcementDecisionType,
  guidelineState: 'idle' | 'loading' | 'ready' | 'error',
  hasSelectedGuideline: boolean,
) =>
  decisionType === 'no_action' ||
  (decisionType === 'formal_warning' && guidelineState === 'ready' && hasSelectedGuideline)

export interface AdminCaseEnforcementResponse {
  kind: AdminCaseMutationKind
  operationId: string
  action: AdminCaseEnforcementAction
}

export interface BeginAdminCaseReviewInput {
  reportId: string
  operationId: string
}

export interface FinalizeAdminCaseReviewInput extends BeginAdminCaseReviewInput {
  caseId: string
  expectedRevision: number
  conclusion: AdminCaseConclusion
  rationale: string
}

export interface AdminCaseMutationResponse {
  kind: AdminCaseMutationKind
  operationId: string
  case: AdminCaseSummary & { id: string; reviewStartedByUserId: string }
  decision?: NonNullable<AdminCaseDetail['decision']>
}

export interface ParsedAdminCaseApiError {
  status: number | null
  code: AdminCaseErrorCode | 'UNKNOWN'
  operationId: string | null
  retryWithSameOperationId: boolean
}

const objectIdPattern = /^[a-f\d]{24}$/i
const cursorPattern = /^[A-Za-z\d_-]+$/
const operationIdPattern = /^[a-z0-9][a-z0-9._:-]*$/
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T/

export const isAdminCaseReportId = (value: string) => objectIdPattern.test(value)
export const isAdminCaseState = (value: unknown): value is AdminCaseState =>
  ADMIN_CASE_STATES.includes(value as AdminCaseState)
export const isAdminCaseConclusion = (value: unknown): value is AdminCaseConclusion =>
  ADMIN_CASE_CONCLUSIONS.includes(value as AdminCaseConclusion)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isObjectId = (value: unknown): value is string =>
  typeof value === 'string' && objectIdPattern.test(value)
const isDateTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  dateTimePattern.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value
const isReason = (value: unknown): value is AdminReportReason =>
  REPORT_REASONS.includes(value as AdminReportReason)
const isSourceType = (value: unknown): value is AdminReportSourceType =>
  REPORT_SOURCE_TYPES.includes(value as AdminReportSourceType)
const isAccountStatus = (value: unknown): value is AdminReportAccountStatus =>
  ACCOUNT_STATUSES.includes(value as AdminReportAccountStatus)
const isIdentity = (value: unknown): value is ReportIdentityValue =>
  isRecord(value) &&
  ((value.status === 'available' && typeof value.value === 'string' && value.value.length > 0) ||
    (value.status === 'missing' && value.value === null))
const isAccountStatusValue = (value: unknown): value is ReportAccountStatusValue =>
  isRecord(value) &&
  ((value.status === 'available' && isAccountStatus(value.value)) ||
    (value.status === 'unavailable' && value.value === null))

const invalidResponse = (): never => {
  throw new Error('ADMIN_CASE_RESPONSE_INVALID')
}
const invalidInput = (code: string): never => {
  throw new Error(code)
}
const normalizeIdentity = (value: ReportIdentityValue): ReportIdentityValue =>
  value.status === 'available'
    ? { status: 'available', value: value.value }
    : { status: 'missing', value: null }

function requireCaseSummary(value: unknown): AdminCaseSummary {
  if (
    !isRecord(value) ||
    !(value.id === null || isObjectId(value.id)) ||
    !isObjectId(value.reportId) ||
    !isAdminCaseState(value.state) ||
    !Number.isSafeInteger(value.revision) ||
    !(value.reviewStartedAt === null || isDateTime(value.reviewStartedAt)) ||
    !(value.completedAt === null || isDateTime(value.completedAt))
  ) {
    return invalidResponse()
  }
  const validState =
    (value.state === 'needs_review' &&
      value.id === null &&
      value.revision === 0 &&
      value.reviewStartedAt === null &&
      value.completedAt === null) ||
    (value.state === 'under_review' &&
      value.id !== null &&
      value.revision === 1 &&
      value.reviewStartedAt !== null &&
      value.completedAt === null) ||
    (value.state === 'review_completed' &&
      value.id !== null &&
      value.revision === 2 &&
      value.reviewStartedAt !== null &&
      value.completedAt !== null)
  if (!validState) return invalidResponse()
  return {
    id: value.id,
    reportId: value.reportId,
    state: value.state,
    revision: value.revision as number,
    reviewStartedAt: value.reviewStartedAt,
    completedAt: value.completedAt,
  }
}

function requireQueueItem(value: unknown): AdminCaseQueueItem {
  if (!isRecord(value) || !isRecord(value.report)) return invalidResponse()
  const report = value.report
  const summary = requireCaseSummary(value.case)
  if (
    !isObjectId(report.id) ||
    !isReason(report.reason) ||
    !isSourceType(report.sourceType) ||
    !isIdentity(report.reportedMemberDisplayName) ||
    !isIdentity(report.reportedMemberAccount) ||
    !isDateTime(report.submittedAt) ||
    summary.reportId !== report.id
  ) {
    return invalidResponse()
  }
  return {
    report: {
      id: report.id,
      reason: report.reason,
      sourceType: report.sourceType,
      reportedMemberDisplayName: normalizeIdentity(report.reportedMemberDisplayName),
      reportedMemberAccount: normalizeIdentity(report.reportedMemberAccount),
      submittedAt: report.submittedAt,
    },
    case: summary,
  }
}

function requireQueueResponse(value: unknown): AdminCaseQueueResponse {
  if (!isRecord(value) || !Array.isArray(value.cases) || !isRecord(value.pagination)) {
    return invalidResponse()
  }
  const { limit, hasMore, nextCursor } = value.pagination
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > 50 ||
    typeof hasMore !== 'boolean' ||
    !(
      nextCursor === null ||
      (typeof nextCursor === 'string' && nextCursor.length <= 256 && cursorPattern.test(nextCursor))
    ) ||
    (hasMore === true && nextCursor === null) ||
    (hasMore === false && nextCursor !== null)
  ) {
    return invalidResponse()
  }
  return {
    cases: value.cases.map(requireQueueItem),
    pagination: { limit: limit as number, hasMore, nextCursor },
  }
}

function requireReportDetail(value: Record<string, unknown>) {
  if (!isRecord(value.report) || !isRecord(value.reportedMember) || !isRecord(value.reporter)) {
    return invalidResponse()
  }
  const report = value.report
  const member = value.reportedMember
  const reporter = value.reporter
  if (
    !isObjectId(report.id) ||
    !isReason(report.reason) ||
    !isSourceType(report.sourceType) ||
    !isDateTime(report.submittedAt) ||
    (report.description !== undefined && typeof report.description !== 'string') ||
    !(typeof member.avatar === 'string' || member.avatar === null) ||
    !isIdentity(member.displayName) ||
    !isIdentity(member.account) ||
    !isAccountStatusValue(member.effectiveAccountStatus) ||
    !isIdentity(reporter.displayName) ||
    !isIdentity(reporter.account)
  ) {
    return invalidResponse()
  }
  return {
    report: {
      id: report.id,
      reason: report.reason,
      ...(report.description !== undefined ? { description: report.description } : {}),
      sourceType: report.sourceType,
      submittedAt: report.submittedAt,
    },
    reportedMember: {
      avatar: member.avatar,
      displayName: normalizeIdentity(member.displayName),
      account: normalizeIdentity(member.account),
      effectiveAccountStatus:
        member.effectiveAccountStatus.status === 'available'
          ? { status: 'available' as const, value: member.effectiveAccountStatus.value }
          : { status: 'unavailable' as const, value: null },
    },
    reporter: {
      displayName: normalizeIdentity(reporter.displayName),
      account: normalizeIdentity(reporter.account),
    },
  }
}

function requireDecision(value: unknown, summary: AdminCaseSummary) {
  if (summary.state !== 'review_completed') {
    if (value !== null) return invalidResponse()
    return null
  }
  if (
    !isRecord(value) ||
    !isObjectId(value.id) ||
    !isAdminCaseConclusion(value.conclusion) ||
    typeof value.rationale !== 'string' ||
    value.rationale !== value.rationale.trim() ||
    [...value.rationale].length < 1 ||
    [...value.rationale].length > 1000 ||
    !isObjectId(value.decidedByUserId) ||
    !isDateTime(value.decidedAt) ||
    value.caseRevision !== summary.revision ||
    value.decidedAt !== summary.completedAt
  ) {
    return invalidResponse()
  }
  return {
    id: value.id,
    conclusion: value.conclusion,
    rationale: value.rationale,
    decidedByUserId: value.decidedByUserId,
    decidedAt: value.decidedAt,
    caseRevision: value.caseRevision,
  }
}

function requireEnforcementAction(value: unknown, reviewDecisionId: string) {
  if (
    !isRecord(value) ||
    !isObjectId(value.id) ||
    value.reviewDecisionId !== reviewDecisionId ||
    !isObjectId(value.performedByUserId) ||
    (value.targetUserId !== undefined && !isObjectId(value.targetUserId)) ||
    !ADMIN_CASE_ENFORCEMENT_DECISION_TYPES.includes(
      value.decisionType as AdminCaseEnforcementDecisionType,
    ) ||
    !isDateTime(value.effectiveAt) ||
    typeof value.reasonSummary !== 'string' ||
    value.reasonSummary !== value.reasonSummary.trim() ||
    [...value.reasonSummary].length < 1 ||
    [...value.reasonSummary].length > 1000
  ) {
    return invalidResponse()
  }
  const hasRule = typeof value.guidelineRuleId === 'string'
  const hasVersion = typeof value.guidelineVersion === 'string'
  if (
    hasRule !== hasVersion ||
    (value.decisionType === 'formal_warning' && !hasRule) ||
    (value.reasonCode !== undefined && typeof value.reasonCode !== 'string')
  ) {
    return invalidResponse()
  }
  return {
    id: value.id,
    reviewDecisionId: value.reviewDecisionId,
    ...(value.targetUserId !== undefined ? { targetUserId: value.targetUserId } : {}),
    decisionType: value.decisionType as AdminCaseEnforcementDecisionType,
    effectiveAt: value.effectiveAt,
    performedByUserId: value.performedByUserId,
    ...(typeof value.reasonCode === 'string' ? { reasonCode: value.reasonCode } : {}),
    reasonSummary: value.reasonSummary,
    ...(hasRule
      ? {
          guidelineRuleId: value.guidelineRuleId as string,
          guidelineVersion: value.guidelineVersion as string,
        }
      : {}),
  }
}

function requireDetailResponse(value: unknown): AdminCaseDetail {
  if (!isRecord(value) || !isRecord(value.case)) return invalidResponse()
  const reportDetail = requireReportDetail(value)
  const summary = requireCaseSummary(value.case)
  const reviewer = value.case.reviewStartedByUserId
  if (
    summary.reportId !== reportDetail.report.id ||
    !(
      (summary.state === 'needs_review' && reviewer === null) ||
      (summary.state !== 'needs_review' && isObjectId(reviewer))
    )
  ) {
    return invalidResponse()
  }
  const decision = requireDecision(value.decision, summary)
  const enforcement =
    value.enforcement == null
      ? null
      : decision
        ? requireEnforcementAction(value.enforcement, decision.id)
        : invalidResponse()
  return {
    ...reportDetail,
    case: { ...summary, reviewStartedByUserId: reviewer as string | null },
    decision,
    enforcement,
  }
}

function requireMutationCase(value: unknown) {
  if (!isRecord(value) || !isObjectId(value.reviewStartedByUserId)) return invalidResponse()
  const summary = requireCaseSummary(value)
  if (summary.id === null || summary.state === 'needs_review') return invalidResponse()
  return { ...summary, id: summary.id, reviewStartedByUserId: value.reviewStartedByUserId }
}

function requireMutationResponse(
  value: unknown,
  expectedOperationId: string,
  action: 'begin' | 'finalize',
): AdminCaseMutationResponse {
  if (
    !isRecord(value) ||
    !(value.kind === 'committed' || value.kind === 'replayed') ||
    value.operationId !== expectedOperationId
  ) {
    return invalidResponse()
  }
  const mutationCase = requireMutationCase(value.case)
  if (action === 'begin') {
    if (mutationCase.state !== 'under_review' || value.decision !== undefined) {
      return invalidResponse()
    }
    return { kind: value.kind, operationId: value.operationId, case: mutationCase }
  }
  const decision = requireDecision(value.decision, mutationCase)
  if (mutationCase.state !== 'review_completed' || !decision) return invalidResponse()
  return { kind: value.kind, operationId: value.operationId, case: mutationCase, decision }
}

function requireReportId(reportId: string) {
  if (!isAdminCaseReportId(reportId)) return invalidInput('ADMIN_CASE_REPORT_ID_INVALID')
  return reportId
}

function requireOperationId(operationId: string) {
  if (operationId.length < 1 || operationId.length > 128 || !operationIdPattern.test(operationId)) {
    return invalidInput('ADMIN_CASE_OPERATION_ID_INVALID')
  }
  return operationId
}

export function createAdminCaseOperationId(action: 'begin' | 'finalize' | 'enforcement') {
  return requireOperationId(`case.${action}.${crypto.randomUUID()}`)
}

export async function createAdminCaseEnforcement(
  input: CreateAdminCaseEnforcementInput,
  signal?: AbortSignal,
) {
  const reportId = requireReportId(input.reportId)
  const operationId = requireOperationId(input.operationId)
  if (
    !isObjectId(input.reviewDecisionId) ||
    !ADMIN_CASE_ENFORCEMENT_DECISION_TYPES.includes(input.decisionType) ||
    input.reasonSummary !== input.reasonSummary.trim() ||
    [...input.reasonSummary].length < 1 ||
    [...input.reasonSummary].length > 1000
  ) {
    return invalidInput('ADMIN_CASE_COMMAND_INVALID')
  }
  const guidelineValues = [input.reasonCode, input.guidelineRuleId, input.guidelineVersion]
  const suppliedGuidelineValues = guidelineValues.filter((value) => value !== undefined)
  if (
    (input.decisionType === 'formal_warning' && suppliedGuidelineValues.length !== 3) ||
    (suppliedGuidelineValues.length !== 0 &&
      (suppliedGuidelineValues.length !== 3 ||
        guidelineValues.some(
          (value) => typeof value !== 'string' || value.length < 1 || value.length > 128,
        )))
  ) {
    return invalidInput('ADMIN_CASE_COMMAND_INVALID')
  }
  const response = await api.post<unknown>(
    `/api/admin/cases/${encodeURIComponent(reportId)}/enforcement-decisions`,
    {
      operationId,
      reviewDecisionId: input.reviewDecisionId,
      decisionType: input.decisionType,
      reasonSummary: input.reasonSummary,
      ...(suppliedGuidelineValues.length === 3
        ? {
            reasonCode: input.reasonCode,
            guidelineRuleId: input.guidelineRuleId,
            guidelineVersion: input.guidelineVersion,
          }
        : {}),
    },
    { signal },
  )
  if (
    !isRecord(response.data) ||
    !(response.data.kind === 'committed' || response.data.kind === 'replayed') ||
    response.data.operationId !== operationId
  ) {
    return invalidResponse()
  }
  const action = requireEnforcementAction(response.data.action, input.reviewDecisionId)
  if (
    action.decisionType !== input.decisionType ||
    (input.decisionType === 'formal_warning' &&
      (action.reasonCode !== input.reasonCode ||
        action.guidelineRuleId !== input.guidelineRuleId ||
        action.guidelineVersion !== input.guidelineVersion))
  ) {
    return invalidResponse()
  }
  return {
    kind: response.data.kind,
    operationId,
    action,
  } satisfies AdminCaseEnforcementResponse
}

const requireAdminEnforcementGuideline = (value: unknown): AdminEnforcementGuideline => {
  if (
    !isRecord(value) ||
    typeof value.guidelineRuleId !== 'string' ||
    typeof value.reasonCode !== 'string' ||
    typeof value.guidelineVersion !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.policy !== 'string' ||
    !value.guidelineRuleId ||
    !value.reasonCode ||
    !value.guidelineVersion ||
    !value.title ||
    !value.policy
  ) {
    return invalidResponse()
  }
  return {
    guidelineRuleId: value.guidelineRuleId,
    reasonCode: value.reasonCode,
    guidelineVersion: value.guidelineVersion,
    title: value.title,
    policy: value.policy,
  }
}

export async function listAdminEnforcementGuidelines(signal?: AbortSignal) {
  const response = await api.get<unknown>('/api/admin/cases/enforcement-guidelines', { signal })
  if (!isRecord(response.data) || !Array.isArray(response.data.guidelines)) {
    return invalidResponse()
  }
  const guidelines = response.data.guidelines.map(requireAdminEnforcementGuideline)
  if (
    guidelines.length !== 4 ||
    new Set(guidelines.map((value) => value.guidelineRuleId)).size !== 4
  ) {
    return invalidResponse()
  }
  return guidelines
}

export async function listAdminCases(input: {
  cursor?: string
  limit?: number
  state?: AdminCaseState
}) {
  const keys = Object.keys(input)
  if (keys.some((key) => !['cursor', 'limit', 'state'].includes(key))) {
    return invalidInput('ADMIN_CASE_QUERY_INVALID')
  }
  if (
    (input.cursor !== undefined &&
      (input.cursor.length < 1 ||
        input.cursor.length > 256 ||
        !cursorPattern.test(input.cursor))) ||
    (input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50)) ||
    (input.state !== undefined && !isAdminCaseState(input.state))
  ) {
    return invalidInput('ADMIN_CASE_QUERY_INVALID')
  }
  const response = await api.get<unknown>('/api/admin/cases', { params: input })
  return requireQueueResponse(response.data)
}

export async function getAdminCase(reportId: string, signal?: AbortSignal) {
  requireReportId(reportId)
  const response = await api.get<unknown>(`/api/admin/cases/${encodeURIComponent(reportId)}`, {
    signal,
  })
  return requireDetailResponse(response.data)
}

export async function beginAdminCaseReview(input: BeginAdminCaseReviewInput, signal?: AbortSignal) {
  const reportId = requireReportId(input.reportId)
  const operationId = requireOperationId(input.operationId)
  const response = await api.post<unknown>(
    `/api/admin/cases/${encodeURIComponent(reportId)}/begin-review`,
    { operationId },
    { signal },
  )
  return requireMutationResponse(response.data, operationId, 'begin')
}

export async function finalizeAdminCaseReview(
  input: FinalizeAdminCaseReviewInput,
  signal?: AbortSignal,
) {
  const reportId = requireReportId(input.reportId)
  const operationId = requireOperationId(input.operationId)
  if (
    !isObjectId(input.caseId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !isAdminCaseConclusion(input.conclusion) ||
    input.rationale !== input.rationale.trim() ||
    [...input.rationale].length < 1 ||
    [...input.rationale].length > 1000
  ) {
    return invalidInput('ADMIN_CASE_COMMAND_INVALID')
  }
  const payload = {
    operationId,
    caseId: input.caseId,
    expectedRevision: input.expectedRevision,
    conclusion: input.conclusion,
    rationale: input.rationale,
  }
  const response = await api.post<unknown>(
    `/api/admin/cases/${encodeURIComponent(reportId)}/finalize-review`,
    payload,
    { signal },
  )
  return requireMutationResponse(response.data, operationId, 'finalize')
}

export function parseAdminCaseApiError(error: unknown): ParsedAdminCaseApiError {
  const status =
    axios.isAxiosError(error) && Number.isInteger(error.response?.status)
      ? (error.response?.status ?? null)
      : null
  const envelope =
    axios.isAxiosError(error) &&
    isRecord(error.response?.data) &&
    isRecord(error.response.data.error)
      ? error.response.data.error
      : null
  const code =
    envelope && CASE_ERROR_CODES.includes(envelope.code as AdminCaseErrorCode)
      ? (envelope.code as AdminCaseErrorCode)
      : 'UNKNOWN'
  const details = envelope && isRecord(envelope.details) ? envelope.details : null
  const operationId =
    details && typeof details.operationId === 'string' ? details.operationId : null
  return {
    status,
    code,
    operationId,
    retryWithSameOperationId:
      code === 'CASE_OPERATION_UNCONFIRMED' &&
      details?.retryWithSameOperationId === true &&
      operationId !== null,
  }
}

export const ADMIN_CASE_COMMAND_FENCE_KEY = 'movune.admin-case-command-fence.v1'

export type AdminCaseCommand =
  | Readonly<{
      action: 'begin'
      actorId: string
      input: Readonly<BeginAdminCaseReviewInput>
    }>
  | Readonly<{
      action: 'finalize'
      actorId: string
      input: Readonly<FinalizeAdminCaseReviewInput>
    }>
  | Readonly<{
      action: 'enforcement'
      actorId: string
      input: Readonly<CreateAdminCaseEnforcementInput>
    }>

type AdminCaseCommandFence = Readonly<{
  version: 1
  actorId: string
  reportId: string
  action: AdminCaseCommand['action']
  operationId: string
}>

export type AdminCaseCommandScopeState = Readonly<{
  phase: 'idle' | 'pending' | 'uncertain' | 'reload-blocked' | 'scope-blocked'
  canRetry: boolean
}>

export type AdminCaseCommandExecutionResult =
  | Readonly<{
      outcome: 'confirmed'
      response: AdminCaseMutationResponse | AdminCaseEnforcementResponse
      fenceCleared: boolean
    }>
  | Readonly<{
      outcome: 'rejected'
      error: ParsedAdminCaseApiError
      fenceCleared: boolean
    }>
  | Readonly<{
      outcome: 'uncertain'
      error: ParsedAdminCaseApiError
      canRetry: boolean
    }>
  | Readonly<{
      outcome: 'blocked'
      reason:
        | 'command-in-flight'
        | 'unresolved-command'
        | 'fence-unavailable'
        | 'fence-invalid'
        | 'scope-mismatch'
        | 'retry-unavailable'
    }>

export interface AdminCaseFenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface AdminCaseCommandCoordinatorDependencies {
  getStorage: () => AdminCaseFenceStorage | null
  dispatchBegin?: typeof beginAdminCaseReview
  dispatchFinalize?: typeof finalizeAdminCaseReview
  dispatchEnforcement?: typeof createAdminCaseEnforcement
}

export const isAdminCaseRequestCurrent = (
  requested: Readonly<{ version: number; reportId: string; actorId?: string }>,
  current: Readonly<{ version: number; reportId: string; actorId?: string }>,
) =>
  requested.version === current.version &&
  requested.reportId === current.reportId &&
  requested.actorId === current.actorId

const definitiveMutationErrorCodes = new Set<AdminCaseErrorCode>([
  'CASE_INPUT_INVALID',
  'CASE_REPORT_NOT_FOUND',
  'CASE_INVALID_TRANSITION',
  'CASE_STALE_REVISION',
  'CASE_ALREADY_STARTED',
  'CASE_ALREADY_FINALIZED',
  'CASE_OPERATION_ID_REUSED',
  'CASE_CAS_CONFLICT',
  'CASE_DUPLICATE_KEY_CONFLICT',
  'CASE_PERSISTENCE_INTEGRITY',
  'CASE_ENFORCEMENT_INPUT_INVALID',
  'CASE_ENFORCEMENT_SOURCE_NOT_FOUND',
  'CASE_ENFORCEMENT_SOURCE_INVALID',
  'CASE_ENFORCEMENT_ACTION_NOT_ALLOWED',
  'CASE_ENFORCEMENT_GUIDELINE_INVALID',
  'CASE_ENFORCEMENT_ALREADY_RECORDED',
  'CASE_ENFORCEMENT_OPERATION_ID_REUSED',
  'CASE_ENFORCEMENT_POLICY_UNAVAILABLE',
  'CASE_ENFORCEMENT_CONFLICT',
])

const cloneCommand = (command: AdminCaseCommand): AdminCaseCommand => {
  if (command.action === 'begin') {
    return {
      action: 'begin',
      actorId: command.actorId,
      input: { reportId: command.input.reportId, operationId: command.input.operationId },
    }
  }
  if (command.action === 'finalize') {
    return {
      action: 'finalize',
      actorId: command.actorId,
      input: {
        reportId: command.input.reportId,
        operationId: command.input.operationId,
        caseId: command.input.caseId,
        expectedRevision: command.input.expectedRevision,
        conclusion: command.input.conclusion,
        rationale: command.input.rationale,
      },
    }
  }
  return {
    action: 'enforcement',
    actorId: command.actorId,
    input: {
      reportId: command.input.reportId,
      operationId: command.input.operationId,
      reviewDecisionId: command.input.reviewDecisionId,
      decisionType: command.input.decisionType,
      reasonSummary: command.input.reasonSummary,
      ...(command.input.reasonCode !== undefined ? { reasonCode: command.input.reasonCode } : {}),
      ...(command.input.guidelineRuleId !== undefined
        ? { guidelineRuleId: command.input.guidelineRuleId }
        : {}),
      ...(command.input.guidelineVersion !== undefined
        ? { guidelineVersion: command.input.guidelineVersion }
        : {}),
    },
  }
}

const fenceForCommand = (command: AdminCaseCommand): AdminCaseCommandFence => ({
  version: 1,
  actorId: command.actorId,
  reportId: command.input.reportId,
  action: command.action,
  operationId: command.input.operationId,
})

const sameFence = (left: AdminCaseCommandFence, right: AdminCaseCommandFence) =>
  left.version === right.version &&
  left.actorId === right.actorId &&
  left.reportId === right.reportId &&
  left.action === right.action &&
  left.operationId === right.operationId

const parseFence = (value: string): AdminCaseCommandFence | null => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      !isRecord(parsed) ||
      Object.keys(parsed).length !== 5 ||
      parsed.version !== 1 ||
      !isObjectId(parsed.actorId) ||
      !isObjectId(parsed.reportId) ||
      !(
        parsed.action === 'begin' ||
        parsed.action === 'finalize' ||
        parsed.action === 'enforcement'
      ) ||
      typeof parsed.operationId !== 'string' ||
      parsed.operationId.length < 1 ||
      parsed.operationId.length > 128 ||
      !operationIdPattern.test(parsed.operationId)
    ) {
      return null
    }
    return {
      version: 1,
      actorId: parsed.actorId,
      reportId: parsed.reportId,
      action: parsed.action,
      operationId: parsed.operationId,
    }
  } catch {
    return null
  }
}

const validEnforcementCommandInput = (input: CreateAdminCaseEnforcementInput) => {
  const guidelineValues = [input.reasonCode, input.guidelineRuleId, input.guidelineVersion]
  const suppliedGuidelineValues = guidelineValues.filter((value) => value !== undefined)
  return (
    isObjectId(input.reviewDecisionId) &&
    ADMIN_CASE_ENFORCEMENT_DECISION_TYPES.includes(input.decisionType) &&
    input.reasonSummary === input.reasonSummary.trim() &&
    [...input.reasonSummary].length >= 1 &&
    [...input.reasonSummary].length <= 1000 &&
    (input.decisionType !== 'formal_warning' || suppliedGuidelineValues.length === 3) &&
    (suppliedGuidelineValues.length === 0 ||
      (suppliedGuidelineValues.length === 3 &&
        guidelineValues.every(
          (value) => typeof value === 'string' && value.length >= 1 && value.length <= 128,
        )))
  )
}

const validCommand = (command: AdminCaseCommand) =>
  isObjectId(command.actorId) &&
  isAdminCaseReportId(command.input.reportId) &&
  command.input.reportId === command.input.reportId.toLowerCase() &&
  operationIdPattern.test(command.input.operationId) &&
  command.input.operationId.length <= 128 &&
  (command.action === 'begin' ||
    (command.action === 'finalize'
      ? isObjectId(command.input.caseId) &&
        Number.isSafeInteger(command.input.expectedRevision) &&
        command.input.expectedRevision >= 0 &&
        isAdminCaseConclusion(command.input.conclusion) &&
        command.input.rationale === command.input.rationale.trim() &&
        [...command.input.rationale].length >= 1 &&
        [...command.input.rationale].length <= 1000
      : validEnforcementCommandInput(command.input)))

const isDefinitiveMutationRejection = (error: ParsedAdminCaseApiError) =>
  error.status === 401 ||
  error.status === 403 ||
  error.status === 400 ||
  error.status === 404 ||
  error.status === 409 ||
  error.status === 422 ||
  (error.code !== 'UNKNOWN' && definitiveMutationErrorCodes.has(error.code))

export function createAdminCaseCommandCoordinator(
  dependencies: AdminCaseCommandCoordinatorDependencies,
) {
  const dispatchBegin = dependencies.dispatchBegin ?? beginAdminCaseReview
  const dispatchFinalize = dependencies.dispatchFinalize ?? finalizeAdminCaseReview
  const dispatchEnforcement = dependencies.dispatchEnforcement ?? createAdminCaseEnforcement
  let retainedCommand: AdminCaseCommand | null = null
  let phase: 'idle' | 'pending' | 'uncertain' = 'idle'
  let retryPermitted = false
  let inFlight = false

  const storage = () => {
    try {
      return dependencies.getStorage()
    } catch {
      return null
    }
  }

  const readFence = () => {
    const target = storage()
    if (!target) return { kind: 'unavailable' as const }
    try {
      const raw = target.getItem(ADMIN_CASE_COMMAND_FENCE_KEY)
      if (raw === null) return { kind: 'none' as const, storage: target }
      const fence = parseFence(raw)
      return fence
        ? { kind: 'valid' as const, storage: target, fence }
        : { kind: 'invalid' as const, storage: target }
    } catch {
      return { kind: 'unavailable' as const }
    }
  }

  const establishFence = (command: AdminCaseCommand) => {
    const observed = readFence()
    if (observed.kind !== 'none') return observed.kind
    const expected = fenceForCommand(command)
    try {
      observed.storage.setItem(ADMIN_CASE_COMMAND_FENCE_KEY, JSON.stringify(expected))
      const persisted = observed.storage.getItem(ADMIN_CASE_COMMAND_FENCE_KEY)
      if (!persisted) return 'unavailable' as const
      const verified = parseFence(persisted)
      return verified && sameFence(verified, expected)
        ? ('established' as const)
        : ('invalid' as const)
    } catch {
      return 'unavailable' as const
    }
  }

  const clearFence = (command: AdminCaseCommand) => {
    const observed = readFence()
    const expected = fenceForCommand(command)
    if (observed.kind !== 'valid' || !sameFence(observed.fence, expected)) return false
    try {
      observed.storage.removeItem(ADMIN_CASE_COMMAND_FENCE_KEY)
      return observed.storage.getItem(ADMIN_CASE_COMMAND_FENCE_KEY) === null
    } catch {
      return false
    }
  }

  const inspect = (actorId: string, reportId: string): AdminCaseCommandScopeState => {
    const observed = readFence()
    if (observed.kind === 'none' && retainedCommand === null) {
      return { phase: 'idle', canRetry: false }
    }
    if (observed.kind !== 'valid') return { phase: 'scope-blocked', canRetry: false }
    if (observed.fence.actorId !== actorId || observed.fence.reportId !== reportId) {
      return { phase: 'scope-blocked', canRetry: false }
    }
    if (!retainedCommand) return { phase: 'reload-blocked', canRetry: false }
    if (!sameFence(observed.fence, fenceForCommand(retainedCommand))) {
      return { phase: 'scope-blocked', canRetry: false }
    }
    return { phase, canRetry: phase === 'uncertain' && retryPermitted }
  }

  const dispatchRetained = async (): Promise<AdminCaseCommandExecutionResult> => {
    const command = retainedCommand
    if (!command) return { outcome: 'blocked', reason: 'retry-unavailable' }
    if (inFlight) return { outcome: 'blocked', reason: 'command-in-flight' }
    const observed = readFence()
    if (observed.kind !== 'valid') {
      return {
        outcome: 'blocked',
        reason: observed.kind === 'invalid' ? 'fence-invalid' : 'fence-unavailable',
      }
    }
    if (!sameFence(observed.fence, fenceForCommand(command))) {
      return { outcome: 'blocked', reason: 'scope-mismatch' }
    }
    inFlight = true
    phase = 'pending'
    retryPermitted = false
    try {
      const response =
        command.action === 'begin'
          ? await dispatchBegin(command.input)
          : command.action === 'finalize'
            ? await dispatchFinalize(command.input)
            : await dispatchEnforcement(command.input)
      const fenceCleared = clearFence(command)
      retainedCommand = null
      phase = 'idle'
      return { outcome: 'confirmed', response, fenceCleared }
    } catch (error) {
      const parsed = parseAdminCaseApiError(error)
      if (isDefinitiveMutationRejection(parsed)) {
        const fenceCleared = clearFence(command)
        retainedCommand = null
        phase = 'idle'
        return { outcome: 'rejected', error: parsed, fenceCleared }
      }
      phase = 'uncertain'
      retryPermitted =
        (parsed.code === 'CASE_OPERATION_UNCONFIRMED' &&
          parsed.retryWithSameOperationId &&
          parsed.operationId === command.input.operationId) ||
        (command.action === 'enforcement' &&
          (parsed.code === 'CASE_ENFORCEMENT_TRANSACTION_UNAVAILABLE' ||
            (parsed.status === 503 && parsed.code === 'UNKNOWN') ||
            (parsed.status === null && parsed.code === 'UNKNOWN')))
      return { outcome: 'uncertain', error: parsed, canRetry: retryPermitted }
    } finally {
      inFlight = false
    }
  }

  const executeNew = async (
    commandValue: AdminCaseCommand,
  ): Promise<AdminCaseCommandExecutionResult> => {
    if (inFlight) return { outcome: 'blocked', reason: 'command-in-flight' }
    if (retainedCommand) return { outcome: 'blocked', reason: 'unresolved-command' }
    const existingFence = readFence()
    if (existingFence.kind !== 'none') {
      return {
        outcome: 'blocked',
        reason:
          existingFence.kind === 'unavailable'
            ? 'fence-unavailable'
            : existingFence.kind === 'invalid'
              ? 'fence-invalid'
              : 'unresolved-command',
      }
    }
    if (!validCommand(commandValue)) return { outcome: 'blocked', reason: 'fence-invalid' }
    const command = cloneCommand(commandValue)
    retainedCommand = command
    phase = 'pending'
    const established = establishFence(command)
    if (established !== 'established') {
      retainedCommand = null
      phase = 'idle'
      return {
        outcome: 'blocked',
        reason: established === 'invalid' ? 'fence-invalid' : 'fence-unavailable',
      }
    }
    return dispatchRetained()
  }

  const retry = async (
    actorId: string,
    reportId: string,
  ): Promise<AdminCaseCommandExecutionResult> => {
    const state = inspect(actorId, reportId)
    if (state.phase !== 'uncertain' || !state.canRetry || !retainedCommand) {
      return { outcome: 'blocked', reason: 'retry-unavailable' }
    }
    return dispatchRetained()
  }

  const retainedAction = (actorId: string, reportId: string): AdminCaseCommand['action'] | null => {
    const state = inspect(actorId, reportId)
    if (
      (state.phase !== 'pending' && state.phase !== 'uncertain') ||
      !retainedCommand ||
      retainedCommand.actorId !== actorId ||
      retainedCommand.input.reportId !== reportId
    ) {
      return null
    }
    return retainedCommand.action
  }

  return Object.freeze({ inspect, retainedAction, executeNew, retry })
}

const browserSessionStorage = () => {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export const adminCaseCommandCoordinator = createAdminCaseCommandCoordinator({
  getStorage: browserSessionStorage,
})

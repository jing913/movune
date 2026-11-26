import api from '@/services/api'

export const ADMIN_REPORT_REASONS = [
  'harassment_or_uncomfortable',
  'spam_or_suspicious',
  'other',
] as const
export const ADMIN_REPORT_SOURCE_TYPES = [
  'public_profile',
  'direct_conversation',
  'direct_message',
] as const
export const ADMIN_REPORT_ACCOUNT_STATUSES = ['active', 'suspended', 'deactivated'] as const

export type AdminReportReason = (typeof ADMIN_REPORT_REASONS)[number]
export type AdminReportSourceType = (typeof ADMIN_REPORT_SOURCE_TYPES)[number]
export type AdminReportAccountStatus = (typeof ADMIN_REPORT_ACCOUNT_STATUSES)[number]

export type ReportIdentityValue =
  { status: 'available'; value: string } | { status: 'missing'; value: null }

export type ReportAccountStatusValue =
  { status: 'available'; value: AdminReportAccountStatus } | { status: 'unavailable'; value: null }

export interface AdminReportQueueItem {
  id: string
  reason: AdminReportReason
  sourceType: AdminReportSourceType
  reportedMemberDisplayName: ReportIdentityValue
  reportedMemberAccount: ReportIdentityValue
  submittedAt: string
}

export interface AdminReportQueueResponse {
  reports: AdminReportQueueItem[]
  pagination: { limit: number; hasMore: boolean; nextCursor: string | null }
}

export interface AdminReportDetail {
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
}

export interface AdminReportEvidence {
  messageId: string
  content: string
  sentAt: string
}

const objectIdPattern = /^[a-f\d]{24}$/i
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T/
const cursorPattern = /^[A-Za-z\d_-]+$/

export const isAdminReportId = (value: string) => objectIdPattern.test(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isDateTime = (value: unknown): value is string =>
  typeof value === 'string' &&
  dateTimePattern.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value

const isReason = (value: unknown): value is AdminReportReason =>
  ADMIN_REPORT_REASONS.includes(value as AdminReportReason)

const isSourceType = (value: unknown): value is AdminReportSourceType =>
  ADMIN_REPORT_SOURCE_TYPES.includes(value as AdminReportSourceType)

const isIdentity = (value: unknown): value is ReportIdentityValue =>
  isRecord(value) &&
  ((value.status === 'available' && typeof value.value === 'string' && value.value.length > 0) ||
    (value.status === 'missing' && value.value === null))

const isAccountStatus = (value: unknown): value is ReportAccountStatusValue =>
  isRecord(value) &&
  ((value.status === 'available' &&
    ADMIN_REPORT_ACCOUNT_STATUSES.includes(value.value as AdminReportAccountStatus)) ||
    (value.status === 'unavailable' && value.value === null))

const invalidResponse = (): never => {
  throw new Error('ADMIN_REPORT_RESPONSE_INVALID')
}

const normalizeIdentity = (value: ReportIdentityValue): ReportIdentityValue =>
  value.status === 'available'
    ? { status: 'available', value: value.value }
    : { status: 'missing', value: null }

const isQueueItem = (value: unknown): value is AdminReportQueueItem =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  isAdminReportId(value.id) &&
  isReason(value.reason) &&
  isSourceType(value.sourceType) &&
  isIdentity(value.reportedMemberDisplayName) &&
  isIdentity(value.reportedMemberAccount) &&
  isDateTime(value.submittedAt)

const normalizeQueueItem = (value: AdminReportQueueItem): AdminReportQueueItem => ({
  id: value.id,
  reason: value.reason,
  sourceType: value.sourceType,
  reportedMemberDisplayName: normalizeIdentity(value.reportedMemberDisplayName),
  reportedMemberAccount: normalizeIdentity(value.reportedMemberAccount),
  submittedAt: value.submittedAt,
})

function requireQueueResponse(value: unknown): AdminReportQueueResponse {
  if (!isRecord(value) || !Array.isArray(value.reports) || !isRecord(value.pagination)) {
    return invalidResponse()
  }
  const { limit, hasMore, nextCursor } = value.pagination
  if (
    !value.reports.every(isQueueItem) ||
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
    reports: value.reports.map((report) => normalizeQueueItem(report as AdminReportQueueItem)),
    pagination: {
      limit: limit as number,
      hasMore,
      nextCursor,
    },
  }
}

function requireDetailResponse(value: unknown): AdminReportDetail {
  if (
    !isRecord(value) ||
    !isRecord(value.report) ||
    !isRecord(value.reportedMember) ||
    !isRecord(value.reporter)
  ) {
    return invalidResponse()
  }
  const report = value.report
  const reportedMember = value.reportedMember
  const reporter = value.reporter
  if (
    typeof report.id !== 'string' ||
    !isAdminReportId(report.id) ||
    !isReason(report.reason) ||
    !isSourceType(report.sourceType) ||
    !isDateTime(report.submittedAt) ||
    (report.description !== undefined && typeof report.description !== 'string') ||
    !(typeof reportedMember.avatar === 'string' || reportedMember.avatar === null) ||
    !isIdentity(reportedMember.displayName) ||
    !isIdentity(reportedMember.account) ||
    !isAccountStatus(reportedMember.effectiveAccountStatus) ||
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
      avatar: reportedMember.avatar,
      displayName: normalizeIdentity(reportedMember.displayName),
      account: normalizeIdentity(reportedMember.account),
      effectiveAccountStatus:
        reportedMember.effectiveAccountStatus.status === 'available'
          ? { status: 'available', value: reportedMember.effectiveAccountStatus.value }
          : { status: 'unavailable', value: null },
    },
    reporter: {
      displayName: normalizeIdentity(reporter.displayName),
      account: normalizeIdentity(reporter.account),
    },
  }
}

function requireEvidenceResponse(value: unknown): AdminReportEvidence {
  if (!isRecord(value) || !isRecord(value.evidence)) return invalidResponse()
  const evidence = value.evidence
  if (
    typeof evidence.messageId !== 'string' ||
    !isAdminReportId(evidence.messageId) ||
    typeof evidence.content !== 'string' ||
    evidence.content.length === 0 ||
    !isDateTime(evidence.sentAt)
  ) {
    return invalidResponse()
  }
  return {
    messageId: evidence.messageId,
    content: evidence.content,
    sentAt: evidence.sentAt,
  }
}

export async function listAdminReports(input: { cursor?: string; limit?: number }) {
  const response = await api.get<unknown>('/api/admin/reports', { params: input })
  return requireQueueResponse(response.data)
}

export async function getAdminReport(reportId: string, signal?: AbortSignal) {
  if (!isAdminReportId(reportId)) throw new Error('ADMIN_REPORT_ID_INVALID')
  const response = await api.get<unknown>(`/api/admin/reports/${encodeURIComponent(reportId)}`, {
    signal,
  })
  return requireDetailResponse(response.data)
}

export async function getAdminReportEvidence(reportId: string, signal?: AbortSignal) {
  if (!isAdminReportId(reportId)) throw new Error('ADMIN_REPORT_ID_INVALID')
  const response = await api.get<unknown>(
    `/api/admin/reports/${encodeURIComponent(reportId)}/evidence`,
    { signal },
  )
  return requireEvidenceResponse(response.data)
}

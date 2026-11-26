import { Types, isObjectIdOrHexString } from 'mongoose'
import { Report } from '../models/reportModel.js'
import {
  confirmReportEvidenceDisclosureGate,
  type ReportEvidenceDisclosureGateDependencies,
} from './reportEvidenceAccessAuditService.js'
import type { ReportReviewAuthorizationIdentity } from '../policies/reportReviewAuthorizationPolicy.js'
import { assertReportReviewAuthorized } from '../policies/reportReviewAuthorizationPolicy.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

export const REPORT_EVIDENCE_SOURCE_PROJECTION =
  '_id sourceType reportedUserId messageId messageEvidence' as const

type SubmittedMessageEvidence = Readonly<{
  messageId: Types.ObjectId
  senderUserId: Types.ObjectId
  content: string
  sentAt: Date
}>

type ReportEvidenceSourceRecord = Readonly<{
  _id: Types.ObjectId
  sourceType: 'public_profile' | 'direct_conversation' | 'direct_message'
  reportedUserId?: Types.ObjectId
  messageId?: Types.ObjectId
  messageEvidence?: SubmittedMessageEvidence
}>

export type AdminReportEvidenceRepository = Readonly<{
  findReport(
    reportId: Types.ObjectId,
    projection: typeof REPORT_EVIDENCE_SOURCE_PROJECTION,
  ): Promise<ReportEvidenceSourceRecord | null>
}>

export type AdminReportEvidenceDependencies = Readonly<{
  repository?: AdminReportEvidenceRepository
  audit?: ReportEvidenceDisclosureGateDependencies
}>

const invalidId = () => new ApiProblem(400, 'ADMIN_REPORT_ID_INVALID', 'Invalid report id')
const notFound = () => new ApiProblem(404, 'ADMIN_REPORT_NOT_FOUND', 'Report not found')
const unavailable = () =>
  new ApiProblem(404, 'ADMIN_REPORT_EVIDENCE_UNAVAILABLE', 'Report evidence is unavailable')
const invalidEvidence = () =>
  new ApiProblem(500, 'ADMIN_REPORT_EVIDENCE_INVALID', 'Report evidence is unavailable')

const mongooseRepository: AdminReportEvidenceRepository = {
  async findReport(reportId, projection) {
    return (await Report.findById(reportId)
      .select(projection)
      .lean()) as unknown as ReportEvidenceSourceRecord | null
  },
}

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.valueOf())

const assertEligibleSnapshot = (report: ReportEvidenceSourceRecord) => {
  if (!report._id || !isObjectIdOrHexString(report._id)) throw invalidEvidence()
  if (report.sourceType !== 'direct_message') {
    if (report.messageId !== undefined || report.messageEvidence !== undefined) {
      throw invalidEvidence()
    }
    throw unavailable()
  }

  const evidence = report.messageEvidence
  if (
    !report.reportedUserId ||
    !isObjectIdOrHexString(report.reportedUserId) ||
    !report.messageId ||
    !isObjectIdOrHexString(report.messageId) ||
    !evidence ||
    !evidence.messageId ||
    !isObjectIdOrHexString(evidence.messageId) ||
    !evidence.senderUserId ||
    !isObjectIdOrHexString(evidence.senderUserId) ||
    typeof evidence.content !== 'string' ||
    evidence.content.length === 0 ||
    !isValidDate(evidence.sentAt) ||
    !evidence.messageId.equals(report.messageId) ||
    !evidence.senderUserId.equals(report.reportedUserId)
  ) {
    throw invalidEvidence()
  }
  return evidence
}

export const getAdminReportEvidence = async (
  reportIdValue: string,
  actor: ReportReviewAuthorizationIdentity,
  evaluatedAt: Date,
  dependencies: AdminReportEvidenceDependencies = {},
) => {
  await assertReportReviewAuthorized(actor, evaluatedAt, dependencies.audit?.loadAccountState)
  if (!isObjectIdOrHexString(reportIdValue)) throw invalidId()
  const reportId = new Types.ObjectId(reportIdValue)
  const report = await (dependencies.repository ?? mongooseRepository).findReport(
    reportId,
    REPORT_EVIDENCE_SOURCE_PROJECTION,
  )
  if (!report) throw notFound()
  if (!report._id.equals(reportId)) throw invalidEvidence()
  const evidence = assertEligibleSnapshot(report)

  const confirmation = await confirmReportEvidenceDisclosureGate(
    {
      actor,
      reportId: report._id.toString(),
      evidenceMessageId: evidence.messageId.toString(),
    },
    {
      ...dependencies.audit,
      now: () => evaluatedAt,
    },
  )
  if (
    confirmation.status !== 'audit-append-confirmed' ||
    confirmation.disclosurePermission !== 'granted'
  ) {
    throw new ApiProblem(
      503,
      'REPORT_EVIDENCE_AUDIT_UNCONFIRMED',
      'Protected evidence access is unavailable',
    )
  }

  return {
    evidence: {
      messageId: evidence.messageId.toString(),
      content: evidence.content,
      sentAt: evidence.sentAt.toISOString(),
    },
  }
}

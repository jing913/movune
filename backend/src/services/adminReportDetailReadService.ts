import { Types, isObjectIdOrHexString } from 'mongoose'
import { Report, type ReportReason, type ReportSourceType } from '../models/reportModel.js'
import { User } from '../models/userModel.js'
import { evaluateAccountEnforcementState } from './accountEnforcementService.js'
import type {
  EffectiveAccountState,
  EffectiveAccountStatus,
} from '../utils/accountEnforcementPolicy.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

export const REPORT_DETAIL_SOURCE_PROJECTION =
  '_id reason description sourceType reporterUserId reportedUserId createdAt' as const
export const REPORT_DETAIL_REPORTED_MEMBER_PROJECTION = '_id account displayName avatar' as const
export const REPORT_DETAIL_REPORTER_PROJECTION = '_id account displayName' as const

const REPORT_REASONS = new Set<ReportReason>([
  'harassment_or_uncomfortable',
  'spam_or_suspicious',
  'other',
])
const REPORT_SOURCE_TYPES = new Set<ReportSourceType>([
  'public_profile',
  'direct_conversation',
  'direct_message',
])

export type ReportDetailIdentityValue =
  Readonly<{ status: 'available'; value: string }> | Readonly<{ status: 'missing'; value: null }>

export type ReportDetailAccountStatusValue =
  | Readonly<{ status: 'available'; value: EffectiveAccountStatus }>
  | Readonly<{ status: 'unavailable'; value: null }>

type ReportDetailSourceRecord = Readonly<{
  _id: Types.ObjectId
  reason: ReportReason
  description?: string
  sourceType: ReportSourceType
  reporterUserId: Types.ObjectId
  reportedUserId: Types.ObjectId
  createdAt: Date
}>

type ReportedMemberRecord = Readonly<{
  _id: Types.ObjectId
  account: string
  displayName?: string
  avatar?: string
}>

type ReporterRecord = Readonly<{
  _id: Types.ObjectId
  account: string
  displayName?: string
}>

export type AdminReportDetailRepository = Readonly<{
  findReport(
    reportId: Types.ObjectId,
    projection: typeof REPORT_DETAIL_SOURCE_PROJECTION,
  ): Promise<ReportDetailSourceRecord | null>
  findReportedMember(
    memberId: Types.ObjectId,
    projection: typeof REPORT_DETAIL_REPORTED_MEMBER_PROJECTION,
  ): Promise<ReportedMemberRecord | null>
  findReporter(
    memberId: Types.ObjectId,
    projection: typeof REPORT_DETAIL_REPORTER_PROJECTION,
  ): Promise<ReporterRecord | null>
}>

export type AdminReportDetailDependencies = Readonly<{
  repository?: AdminReportDetailRepository
  loadAccountState?: (userId: string, evaluatedAt: Date) => Promise<EffectiveAccountState>
}>

const invalidId = () => new ApiProblem(400, 'ADMIN_REPORT_ID_INVALID', 'Invalid report id')
const notFound = () => new ApiProblem(404, 'ADMIN_REPORT_NOT_FOUND', 'Report not found')
const invalidData = () =>
  new ApiProblem(500, 'ADMIN_REPORT_DETAIL_DATA_INVALID', 'Report detail is unavailable')

const mongooseRepository: AdminReportDetailRepository = {
  async findReport(reportId, projection) {
    return (await Report.findById(reportId)
      .select(projection)
      .lean()) as unknown as ReportDetailSourceRecord | null
  },
  async findReportedMember(memberId, projection) {
    return (await User.findById(memberId)
      .select(projection)
      .lean()) as unknown as ReportedMemberRecord | null
  },
  async findReporter(memberId, projection) {
    return (await User.findById(memberId)
      .select(projection)
      .lean()) as unknown as ReporterRecord | null
  },
}

const availableIdentity = (value: string): ReportDetailIdentityValue => ({
  status: 'available',
  value,
})
const missingIdentity = (): ReportDetailIdentityValue => ({ status: 'missing', value: null })
const unavailableAccountStatus = (): ReportDetailAccountStatusValue => ({
  status: 'unavailable',
  value: null,
})

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.valueOf())

const isConsistentAccountState = (state: EffectiveAccountState, evaluatedAt: Date) => {
  if (
    !isValidDate(state.evaluatedAt) ||
    state.evaluatedAt.valueOf() !== evaluatedAt.valueOf() ||
    !Array.isArray(state.activeRestrictionDecisionIds) ||
    !state.activeRestrictionDecisionIds.every(
      (decisionId) => typeof decisionId === 'string' && decisionId.length > 0,
    )
  ) {
    return false
  }
  if (state.status === 'active') {
    return (
      state.governingDecisionId === null &&
      state.activeRestrictionDecisionIds.length === 0 &&
      state.restrictionEndsAt === null
    )
  }
  if (
    typeof state.governingDecisionId !== 'string' ||
    !state.activeRestrictionDecisionIds.includes(state.governingDecisionId)
  ) {
    return false
  }
  if (state.status === 'suspended') return isValidDate(state.restrictionEndsAt)
  if (state.status === 'deactivated') return state.restrictionEndsAt === null
  return false
}

const loadEffectiveStatus = async (
  memberId: string,
  evaluatedAt: Date,
  loader: (userId: string, at: Date) => Promise<EffectiveAccountState>,
): Promise<ReportDetailAccountStatusValue> => {
  try {
    const state = await loader(memberId, evaluatedAt)
    return isConsistentAccountState(state, evaluatedAt)
      ? { status: 'available', value: state.status }
      : unavailableAccountStatus()
  } catch {
    return unavailableAccountStatus()
  }
}

const validUser = (value: ReportedMemberRecord | ReporterRecord | null) =>
  Boolean(
    value &&
    value._id &&
    isObjectIdOrHexString(value._id) &&
    typeof value.account === 'string' &&
    value.account.length > 0,
  )

export const getAdminReportDetail = async (
  reportIdValue: string,
  evaluatedAt: Date,
  dependencies: AdminReportDetailDependencies = {},
) => {
  if (!isObjectIdOrHexString(reportIdValue)) throw invalidId()
  const reportId = new Types.ObjectId(reportIdValue)
  const repository = dependencies.repository ?? mongooseRepository
  const report = await repository.findReport(reportId, REPORT_DETAIL_SOURCE_PROJECTION)
  if (!report) throw notFound()
  if (
    !report._id ||
    !report._id.equals(reportId) ||
    !REPORT_REASONS.has(report.reason) ||
    !REPORT_SOURCE_TYPES.has(report.sourceType) ||
    !report.reporterUserId ||
    !isObjectIdOrHexString(report.reporterUserId) ||
    !report.reportedUserId ||
    !isObjectIdOrHexString(report.reportedUserId) ||
    !isValidDate(report.createdAt) ||
    (report.description !== undefined && typeof report.description !== 'string')
  ) {
    throw invalidData()
  }

  const [reportedMemberValue, reporterValue] = await Promise.all([
    repository.findReportedMember(report.reportedUserId, REPORT_DETAIL_REPORTED_MEMBER_PROJECTION),
    repository.findReporter(report.reporterUserId, REPORT_DETAIL_REPORTER_PROJECTION),
  ])
  const reportedMember = validUser(reportedMemberValue) ? reportedMemberValue : null
  const reporter = validUser(reporterValue) ? reporterValue : null
  const effectiveAccountStatus = reportedMember
    ? await loadEffectiveStatus(
        reportedMember._id.toString(),
        evaluatedAt,
        dependencies.loadAccountState ?? evaluateAccountEnforcementState,
      )
    : unavailableAccountStatus()

  return {
    report: {
      id: report._id.toString(),
      reason: report.reason,
      ...(report.description !== undefined ? { description: report.description } : {}),
      sourceType: report.sourceType,
      submittedAt: report.createdAt.toISOString(),
    },
    reportedMember: {
      avatar:
        reportedMember && typeof reportedMember.avatar === 'string' ? reportedMember.avatar : null,
      displayName: reportedMember
        ? availableIdentity(reportedMember.displayName?.trim() || reportedMember.account)
        : missingIdentity(),
      account: reportedMember ? availableIdentity(reportedMember.account) : missingIdentity(),
      effectiveAccountStatus,
    },
    reporter: {
      displayName: reporter
        ? availableIdentity(reporter.displayName?.trim() || reporter.account)
        : missingIdentity(),
      account: reporter ? availableIdentity(reporter.account) : missingIdentity(),
    },
  }
}

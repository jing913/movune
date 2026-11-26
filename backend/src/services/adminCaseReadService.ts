import { Types, isObjectIdOrHexString, type PipelineStage } from 'mongoose'
import { FinalReviewDecision } from '../models/finalReviewDecisionModel.js'
import { Report, type ReportReason, type ReportSourceType } from '../models/reportModel.js'
import { ReviewCase } from '../models/reviewCaseModel.js'
import { User } from '../models/userModel.js'
import { AccountEnforcementAction } from '../models/accountEnforcementActionModel.js'
import {
  CASE_STATES,
  FINAL_REVIEW_CONCLUSIONS,
  type CaseState,
  type FinalReviewConclusion,
} from '../policies/caseLifecyclePolicy.js'
import { ApiProblem } from '../utils/messagingPolicy.js'
import { getAdminReportDetail } from './adminReportDetailReadService.js'

const CASE_QUEUE_DEFAULT_LIMIT = 20
const CASE_QUEUE_MAX_LIMIT = 50
const CASE_QUEUE_CURSOR_MAX_LENGTH = 256
const CASE_QUEUE_QUERY_KEYS = new Set(['cursor', 'limit', 'state'])
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
const CASE_STATE_SET = new Set<CaseState>(CASE_STATES)
const FINAL_REVIEW_CONCLUSION_SET = new Set<FinalReviewConclusion>(FINAL_REVIEW_CONCLUSIONS)

export const ADMIN_CASE_QUEUE_SORT = Object.freeze({ createdAt: -1, _id: -1 })
export const ADMIN_CASE_MEMBER_PROJECTION = '_id account displayName' as const
export const ADMIN_CASE_DETAIL_PROJECTION =
  '_id reportId state reviewStartedByUserId reviewStartedAt decisionId completedAt revision' as const
export const ADMIN_CASE_DECISION_PROJECTION =
  '_id caseId reportId conclusion rationale reviewStartedByUserId decidedByUserId decidedAt caseRevision' as const
export const ADMIN_CASE_ENFORCEMENT_PROJECTION =
  '_id reviewDecisionId decisionType effectiveAt performedByUserId reasonSummary guidelineRuleId guidelineVersion' as const

export type AdminCaseQueueCursor = Readonly<{
  submittedAt: Date
  id: Types.ObjectId
}>

export type AdminCaseQueueQuery = Readonly<{
  cursor: AdminCaseQueueCursor | null
  limit: number
  state: CaseState | null
}>

export type AdminCaseIdentityValue =
  Readonly<{ status: 'available'; value: string }> | Readonly<{ status: 'missing'; value: null }>

type PersistedCaseRecord = Readonly<{
  _id: Types.ObjectId
  reportId: Types.ObjectId
  state: 'under_review' | 'review_completed'
  reviewStartedByUserId: Types.ObjectId
  reviewStartedAt: Date
  decisionId?: Types.ObjectId | null
  completedAt?: Date | null
  revision: number
}>

type CaseQueueSourceRecord = Readonly<{
  _id: Types.ObjectId
  reason: ReportReason
  sourceType: ReportSourceType
  reportedUserId: Types.ObjectId
  createdAt: Date
  reviewCases: readonly PersistedCaseRecord[]
  reviewDecisions: readonly FinalReviewDecisionSourceRecord[]
}>

type CaseQueueMemberRecord = Readonly<{
  _id: Types.ObjectId
  account: string
  displayName?: string
}>

type FinalReviewDecisionSourceRecord = Readonly<{
  _id: Types.ObjectId
  caseId: Types.ObjectId
  reportId: Types.ObjectId
  conclusion: FinalReviewConclusion
  rationale: string
  reviewStartedByUserId: Types.ObjectId
  decidedByUserId: Types.ObjectId
  decidedAt: Date
  caseRevision: number
}>

type EnforcementSourceRecord = Readonly<{
  _id: Types.ObjectId
  reviewDecisionId: Types.ObjectId
  decisionType: 'no_action' | 'formal_warning'
  effectiveAt: Date
  performedByUserId: Types.ObjectId
  reasonSummary: string
  guidelineRuleId?: string
  guidelineVersion?: string
}>

export type AdminCaseReadRepository = Readonly<{
  findCaseQueue(
    cursor: AdminCaseQueueCursor | null,
    state: CaseState | null,
    limit: number,
  ): Promise<readonly CaseQueueSourceRecord[]>
  findReportedMembers(
    ids: readonly Types.ObjectId[],
    projection: typeof ADMIN_CASE_MEMBER_PROJECTION,
  ): Promise<readonly CaseQueueMemberRecord[]>
  findCaseByReportId(
    reportId: Types.ObjectId,
    projection: typeof ADMIN_CASE_DETAIL_PROJECTION,
  ): Promise<PersistedCaseRecord | null>
  findDecisionsByReportId(
    reportId: Types.ObjectId,
    projection: typeof ADMIN_CASE_DECISION_PROJECTION,
  ): Promise<readonly FinalReviewDecisionSourceRecord[]>
  findEnforcementByReviewDecisionId?(
    reviewDecisionId: Types.ObjectId,
    projection: typeof ADMIN_CASE_ENFORCEMENT_PROJECTION,
  ): Promise<EnforcementSourceRecord | null>
}>

export type AdminCaseReadDependencies = Readonly<{
  repository?: AdminCaseReadRepository
  loadReportDetail?: typeof getAdminReportDetail
}>

const invalidQuery = (field: string) =>
  new ApiProblem(400, 'ADMIN_CASE_QUEUE_QUERY_INVALID', 'Invalid Case queue query', { field })
const invalidId = () => new ApiProblem(400, 'ADMIN_CASE_REPORT_ID_INVALID', 'Invalid Report id')
const invalidData = () => new ApiProblem(500, 'ADMIN_CASE_DATA_INVALID', 'Case data is unavailable')

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.valueOf())
const isObjectId = (value: unknown): value is Types.ObjectId => value instanceof Types.ObjectId

const requireSingleString = (value: unknown, field: string) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidQuery(field)
  return value
}

export const encodeAdminCaseQueueCursor = (cursor: AdminCaseQueueCursor) =>
  Buffer.from(
    JSON.stringify([cursor.submittedAt.toISOString(), cursor.id.toString()]),
    'utf8',
  ).toString('base64url')

export const decodeAdminCaseQueueCursor = (value: string): AdminCaseQueueCursor => {
  if (!value || value.length > CASE_QUEUE_CURSOR_MAX_LENGTH) throw invalidQuery('cursor')
  try {
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) throw new Error()
    const parsed: unknown = JSON.parse(decoded.toString('utf8'))
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string' ||
      !isObjectIdOrHexString(parsed[1])
    ) {
      throw new Error()
    }
    const submittedAt = new Date(parsed[0])
    if (!isValidDate(submittedAt) || submittedAt.toISOString() !== parsed[0]) throw new Error()
    const cursor = { submittedAt, id: new Types.ObjectId(parsed[1]) }
    if (encodeAdminCaseQueueCursor(cursor) !== value) throw new Error()
    return cursor
  } catch {
    throw invalidQuery('cursor')
  }
}

export const parseAdminCaseQueueQuery = (
  query: Readonly<Record<string, unknown>>,
): AdminCaseQueueQuery => {
  const unexpected = Object.keys(query).find((key) => !CASE_QUEUE_QUERY_KEYS.has(key))
  if (unexpected) throw invalidQuery(unexpected)

  const limitValue = requireSingleString(query.limit, 'limit')
  let limit = CASE_QUEUE_DEFAULT_LIMIT
  if (limitValue !== undefined) {
    if (!/^\d+$/.test(limitValue)) throw invalidQuery('limit')
    limit = Number(limitValue)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CASE_QUEUE_MAX_LIMIT) {
      throw invalidQuery('limit')
    }
  }

  const cursorValue = requireSingleString(query.cursor, 'cursor')
  const stateValue = requireSingleString(query.state, 'state')
  if (stateValue !== undefined && !CASE_STATE_SET.has(stateValue as CaseState)) {
    throw invalidQuery('state')
  }

  return {
    cursor: cursorValue === undefined ? null : decodeAdminCaseQueueCursor(cursorValue),
    limit,
    state: stateValue === undefined ? null : (stateValue as CaseState),
  }
}

const cursorMatch = (cursor: AdminCaseQueueCursor | null) =>
  cursor
    ? {
        $or: [
          { createdAt: { $lt: cursor.submittedAt } },
          { createdAt: cursor.submittedAt, _id: { $lt: cursor.id } },
        ],
      }
    : {}

const mongooseRepository: AdminCaseReadRepository = {
  async findCaseQueue(cursor, state, limit) {
    const pipeline: PipelineStage[] = [
      { $match: cursorMatch(cursor) },
      { $sort: ADMIN_CASE_QUEUE_SORT },
      {
        $lookup: {
          from: 'reviewcases',
          localField: '_id',
          foreignField: 'reportId',
          as: 'reviewCases',
        },
      },
      {
        $lookup: {
          from: 'finalreviewdecisions',
          localField: '_id',
          foreignField: 'reportId',
          pipeline: [{ $limit: 2 }],
          as: 'reviewDecisions',
        },
      },
      {
        $set: {
          derivedCaseState: {
            $ifNull: [{ $arrayElemAt: ['$reviewCases.state', 0] }, 'needs_review'],
          },
        },
      },
      ...(state ? [{ $match: { derivedCaseState: state } }] : []),
      { $limit: limit },
      {
        $project: {
          _id: 1,
          reason: 1,
          sourceType: 1,
          reportedUserId: 1,
          createdAt: 1,
          reviewCases: 1,
          reviewDecisions: 1,
        },
      },
    ]
    return (await Report.aggregate(pipeline)) as readonly CaseQueueSourceRecord[]
  },
  async findReportedMembers(ids, projection) {
    if (ids.length === 0) return []
    return (await User.find({ _id: { $in: ids } })
      .select(projection)
      .lean()) as unknown as readonly CaseQueueMemberRecord[]
  },
  async findCaseByReportId(reportId, projection) {
    return (await ReviewCase.findOne({ reportId })
      .select(projection)
      .lean()) as unknown as PersistedCaseRecord | null
  },
  async findDecisionsByReportId(reportId, projection) {
    return (await FinalReviewDecision.find({ reportId })
      .limit(2)
      .select(projection)
      .lean()) as unknown as readonly FinalReviewDecisionSourceRecord[]
  },
  async findEnforcementByReviewDecisionId(reviewDecisionId, projection) {
    return (await AccountEnforcementAction.findOne({
      recordType: 'decision',
      reviewDecisionId,
    })
      .select(projection)
      .lean()) as unknown as EnforcementSourceRecord | null
  },
}

const available = (value: string): AdminCaseIdentityValue => ({ status: 'available', value })
const missing = (): AdminCaseIdentityValue => ({ status: 'missing', value: null })
const isAbsent = (value: unknown) => value === undefined || value === null

const assertValidPersistedCase = (
  value: PersistedCaseRecord,
  reportId: Types.ObjectId,
): PersistedCaseRecord => {
  const validBase =
    value &&
    isObjectId(value._id) &&
    isObjectId(value.reportId) &&
    value.reportId.equals(reportId) &&
    isObjectId(value.reviewStartedByUserId) &&
    isValidDate(value.reviewStartedAt)
  const validUnderReview =
    value.state === 'under_review' &&
    value.revision === 1 &&
    isAbsent(value.decisionId) &&
    isAbsent(value.completedAt)
  const validCompleted =
    value.state === 'review_completed' &&
    value.revision === 2 &&
    isObjectId(value.decisionId) &&
    isValidDate(value.completedAt)
  if (!validBase || (!validUnderReview && !validCompleted)) throw invalidData()
  return value
}

const assertValidQueueSource = (value: CaseQueueSourceRecord) => {
  if (
    !value ||
    !isObjectId(value._id) ||
    !REPORT_REASONS.has(value.reason) ||
    !REPORT_SOURCE_TYPES.has(value.sourceType) ||
    !isObjectId(value.reportedUserId) ||
    !isValidDate(value.createdAt) ||
    !Array.isArray(value.reviewCases) ||
    value.reviewCases.length > 1 ||
    !Array.isArray(value.reviewDecisions) ||
    value.reviewDecisions.length > 1
  ) {
    throw invalidData()
  }
  if (value.reviewCases.length === 0) {
    if (value.reviewDecisions.length !== 0) throw invalidData()
    return
  }
  const persistedCase = assertValidPersistedCase(value.reviewCases[0]!, value._id)
  if (persistedCase.state === 'under_review') {
    if (value.reviewDecisions.length !== 0) throw invalidData()
    return
  }
  if (value.reviewDecisions.length !== 1) throw invalidData()
  assertValidDecision(value.reviewDecisions[0]!, persistedCase, value._id)
}

const caseSummary = (reportId: Types.ObjectId, persistedCase?: PersistedCaseRecord) =>
  persistedCase
    ? {
        id: persistedCase._id.toString(),
        reportId: reportId.toString(),
        state: persistedCase.state,
        revision: persistedCase.revision,
        reviewStartedAt: persistedCase.reviewStartedAt.toISOString(),
        completedAt: persistedCase.completedAt?.toISOString() ?? null,
      }
    : {
        id: null,
        reportId: reportId.toString(),
        state: 'needs_review' as const,
        revision: 0,
        reviewStartedAt: null,
        completedAt: null,
      }

export const listAdminCases = async (
  query: AdminCaseQueueQuery,
  dependencies: AdminCaseReadDependencies = {},
) => {
  const repository = dependencies.repository ?? mongooseRepository
  const sourceRecords = await repository.findCaseQueue(query.cursor, query.state, query.limit + 1)
  sourceRecords.forEach(assertValidQueueSource)
  const hasMore = sourceRecords.length > query.limit
  const pageRecords = sourceRecords.slice(0, query.limit)
  const memberIds = [
    ...new Map(
      pageRecords.map((report) => [report.reportedUserId.toString(), report.reportedUserId]),
    ).values(),
  ]
  const members = await repository.findReportedMembers(memberIds, ADMIN_CASE_MEMBER_PROJECTION)
  const membersById = new Map(
    members
      .filter(
        (member) =>
          member &&
          isObjectId(member._id) &&
          typeof member.account === 'string' &&
          member.account.length > 0,
      )
      .map((member) => [member._id.toString(), member]),
  )

  const cases = pageRecords.map((report) => {
    const member = membersById.get(report.reportedUserId.toString())
    return {
      report: {
        id: report._id.toString(),
        reason: report.reason,
        sourceType: report.sourceType,
        reportedMemberDisplayName: member
          ? available(member.displayName?.trim() || member.account)
          : missing(),
        reportedMemberAccount: member ? available(member.account) : missing(),
        submittedAt: report.createdAt.toISOString(),
      },
      case: caseSummary(report._id, report.reviewCases[0]),
    }
  })
  const last = pageRecords.at(-1)

  return {
    cases,
    pagination: {
      limit: query.limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeAdminCaseQueueCursor({ submittedAt: last.createdAt, id: last._id })
          : null,
    },
  }
}

const assertValidDecision = (
  value: FinalReviewDecisionSourceRecord | null,
  persistedCase: PersistedCaseRecord,
  reportId: Types.ObjectId,
): FinalReviewDecisionSourceRecord => {
  if (
    !value ||
    !isObjectId(value._id) ||
    !persistedCase.decisionId ||
    !value._id.equals(persistedCase.decisionId) ||
    !isObjectId(value.caseId) ||
    !value.caseId.equals(persistedCase._id) ||
    !isObjectId(value.reportId) ||
    !value.reportId.equals(reportId) ||
    !FINAL_REVIEW_CONCLUSION_SET.has(value.conclusion) ||
    typeof value.rationale !== 'string' ||
    value.rationale !== value.rationale.trim() ||
    [...value.rationale].length < 1 ||
    [...value.rationale].length > 1000 ||
    !isObjectId(value.reviewStartedByUserId) ||
    !value.reviewStartedByUserId.equals(persistedCase.reviewStartedByUserId) ||
    !isObjectId(value.decidedByUserId) ||
    !isValidDate(value.decidedAt) ||
    !persistedCase.completedAt ||
    value.decidedAt.valueOf() !== persistedCase.completedAt.valueOf() ||
    value.caseRevision !== persistedCase.revision
  ) {
    throw invalidData()
  }
  return value
}

export const getAdminCaseDetail = async (
  reportIdValue: string,
  evaluatedAt: Date,
  dependencies: AdminCaseReadDependencies = {},
) => {
  if (!isObjectIdOrHexString(reportIdValue)) throw invalidId()
  const reportId = new Types.ObjectId(reportIdValue)
  const loadReportDetail = dependencies.loadReportDetail ?? getAdminReportDetail
  const reportDetail = await loadReportDetail(reportId.toString(), evaluatedAt)
  const repository = dependencies.repository ?? mongooseRepository
  const persistedValue = await repository.findCaseByReportId(reportId, ADMIN_CASE_DETAIL_PROJECTION)
  const decisionValues = await repository.findDecisionsByReportId(
    reportId,
    ADMIN_CASE_DECISION_PROJECTION,
  )
  if (!Array.isArray(decisionValues) || decisionValues.length > 1) throw invalidData()
  if (!persistedValue) {
    if (decisionValues.length !== 0) throw invalidData()
    return {
      ...reportDetail,
      case: {
        ...caseSummary(reportId),
        reviewStartedByUserId: null,
      },
      decision: null,
      enforcement: null,
    }
  }

  const persistedCase = assertValidPersistedCase(persistedValue, reportId)
  let decision = null
  let enforcement = null
  if (persistedCase.state === 'review_completed') {
    if (decisionValues.length !== 1) throw invalidData()
    const decisionValue = decisionValues[0]!
    const validDecision = assertValidDecision(decisionValue, persistedCase, reportId)
    decision = {
      id: validDecision._id.toString(),
      conclusion: validDecision.conclusion,
      rationale: validDecision.rationale,
      decidedByUserId: validDecision.decidedByUserId.toString(),
      decidedAt: validDecision.decidedAt.toISOString(),
      caseRevision: validDecision.caseRevision,
    }
    const enforcementValue = repository.findEnforcementByReviewDecisionId
      ? await repository.findEnforcementByReviewDecisionId(
          validDecision._id,
          ADMIN_CASE_ENFORCEMENT_PROJECTION,
        )
      : null
    if (enforcementValue) {
      const hasRule = typeof enforcementValue.guidelineRuleId === 'string'
      const hasVersion = typeof enforcementValue.guidelineVersion === 'string'
      if (
        !isObjectId(enforcementValue._id) ||
        !isObjectId(enforcementValue.reviewDecisionId) ||
        !enforcementValue.reviewDecisionId.equals(validDecision._id) ||
        !['no_action', 'formal_warning'].includes(enforcementValue.decisionType) ||
        !isValidDate(enforcementValue.effectiveAt) ||
        !isObjectId(enforcementValue.performedByUserId) ||
        typeof enforcementValue.reasonSummary !== 'string' ||
        enforcementValue.reasonSummary !== enforcementValue.reasonSummary.trim() ||
        enforcementValue.reasonSummary.length === 0 ||
        hasRule !== hasVersion ||
        (enforcementValue.decisionType === 'formal_warning' && !hasRule)
      ) {
        throw invalidData()
      }
      enforcement = {
        id: enforcementValue._id.toString(),
        reviewDecisionId: enforcementValue.reviewDecisionId.toString(),
        decisionType: enforcementValue.decisionType,
        effectiveAt: enforcementValue.effectiveAt.toISOString(),
        performedByUserId: enforcementValue.performedByUserId.toString(),
        reasonSummary: enforcementValue.reasonSummary,
        ...(hasRule
          ? {
              guidelineRuleId: enforcementValue.guidelineRuleId,
              guidelineVersion: enforcementValue.guidelineVersion,
            }
          : {}),
      }
    }
  } else if (decisionValues.length !== 0) {
    throw invalidData()
  }

  return {
    ...reportDetail,
    case: {
      ...caseSummary(reportId, persistedCase),
      reviewStartedByUserId: persistedCase.reviewStartedByUserId.toString(),
    },
    decision,
    enforcement,
  }
}

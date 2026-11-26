import { Types, isObjectIdOrHexString } from 'mongoose'
import { Report, type ReportReason, type ReportSourceType } from '../models/reportModel.js'
import { User } from '../models/userModel.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

const REPORT_QUEUE_DEFAULT_LIMIT = 20
const REPORT_QUEUE_MAX_LIMIT = 50
const REPORT_QUEUE_CURSOR_MAX_LENGTH = 256
const ALLOWED_QUERY_KEYS = new Set(['cursor', 'limit'])
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

export const REPORT_QUEUE_SOURCE_PROJECTION =
  '_id reason sourceType reportedUserId createdAt' as const
export const REPORT_QUEUE_MEMBER_PROJECTION = '_id account displayName' as const
export const REPORT_QUEUE_SORT = Object.freeze({ createdAt: -1, _id: -1 })

export type AdminReportQueueCursor = Readonly<{
  submittedAt: Date
  id: Types.ObjectId
}>

export type AdminReportQueueQuery = Readonly<{
  cursor: AdminReportQueueCursor | null
  limit: number
}>

export type ReportQueueIdentityValue =
  Readonly<{ status: 'available'; value: string }> | Readonly<{ status: 'missing'; value: null }>

export type AdminReportQueueItem = Readonly<{
  id: string
  reason: ReportReason
  sourceType: ReportSourceType
  reportedMemberDisplayName: ReportQueueIdentityValue
  reportedMemberAccount: ReportQueueIdentityValue
  submittedAt: string
}>

type ReportQueueSourceRecord = Readonly<{
  _id: Types.ObjectId
  reason: ReportReason
  sourceType: ReportSourceType
  reportedUserId: Types.ObjectId
  createdAt: Date
}>

type ReportQueueMemberRecord = Readonly<{
  _id: Types.ObjectId
  account: string
  displayName?: string
}>

export type AdminReportQueueRepository = Readonly<{
  findReports(
    filter: Readonly<Record<string, unknown>>,
    projection: typeof REPORT_QUEUE_SOURCE_PROJECTION,
    sort: typeof REPORT_QUEUE_SORT,
    limit: number,
  ): Promise<readonly ReportQueueSourceRecord[]>
  findReportedMembers(
    ids: readonly Types.ObjectId[],
    projection: typeof REPORT_QUEUE_MEMBER_PROJECTION,
  ): Promise<readonly ReportQueueMemberRecord[]>
}>

export type AdminReportQueueDependencies = Readonly<{
  repository?: AdminReportQueueRepository
}>

const invalidQuery = (field: string) =>
  new ApiProblem(400, 'ADMIN_REPORT_QUEUE_QUERY_INVALID', 'Invalid report queue query', { field })

const invalidData = () =>
  new ApiProblem(500, 'ADMIN_REPORT_QUEUE_DATA_INVALID', 'Report queue data is unavailable')

const requireSingleString = (value: unknown, field: string) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidQuery(field)
  return value
}

export const encodeAdminReportQueueCursor = (cursor: AdminReportQueueCursor) =>
  Buffer.from(
    JSON.stringify([cursor.submittedAt.toISOString(), cursor.id.toString()]),
    'utf8',
  ).toString('base64url')

export const decodeAdminReportQueueCursor = (value: string): AdminReportQueueCursor => {
  if (!value || value.length > REPORT_QUEUE_CURSOR_MAX_LENGTH) throw invalidQuery('cursor')
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
    if (!Number.isFinite(submittedAt.valueOf()) || submittedAt.toISOString() !== parsed[0]) {
      throw new Error()
    }
    const cursor = { submittedAt, id: new Types.ObjectId(parsed[1]) }
    if (encodeAdminReportQueueCursor(cursor) !== value) throw new Error()
    return cursor
  } catch {
    throw invalidQuery('cursor')
  }
}

export const parseAdminReportQueueQuery = (
  query: Readonly<Record<string, unknown>>,
): AdminReportQueueQuery => {
  const unexpected = Object.keys(query).find((key) => !ALLOWED_QUERY_KEYS.has(key))
  if (unexpected) throw invalidQuery(unexpected)

  const limitValue = requireSingleString(query.limit, 'limit')
  let limit = REPORT_QUEUE_DEFAULT_LIMIT
  if (limitValue !== undefined) {
    if (!/^\d+$/.test(limitValue)) throw invalidQuery('limit')
    limit = Number(limitValue)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > REPORT_QUEUE_MAX_LIMIT) {
      throw invalidQuery('limit')
    }
  }

  const cursorValue = requireSingleString(query.cursor, 'cursor')
  return {
    cursor: cursorValue === undefined ? null : decodeAdminReportQueueCursor(cursorValue),
    limit,
  }
}

export const buildAdminReportQueueFilter = (
  cursor: AdminReportQueueCursor | null,
): Readonly<Record<string, unknown>> =>
  cursor
    ? {
        $or: [
          { createdAt: { $lt: cursor.submittedAt } },
          { createdAt: cursor.submittedAt, _id: { $lt: cursor.id } },
        ],
      }
    : {}

const mongooseRepository: AdminReportQueueRepository = {
  async findReports(filter, projection, sort, limit) {
    return (await Report.find(filter)
      .select(projection)
      .sort(sort)
      .limit(limit)
      .lean()) as unknown as readonly ReportQueueSourceRecord[]
  },
  async findReportedMembers(ids, projection) {
    if (ids.length === 0) return []
    return (await User.find({ _id: { $in: ids } })
      .select(projection)
      .lean()) as unknown as readonly ReportQueueMemberRecord[]
  },
}

const available = (value: string): ReportQueueIdentityValue => ({
  status: 'available',
  value,
})

const missing = (): ReportQueueIdentityValue => ({ status: 'missing', value: null })

const assertValidReport = (report: ReportQueueSourceRecord) => {
  if (
    !report?._id ||
    !isObjectIdOrHexString(report._id) ||
    !REPORT_REASONS.has(report.reason) ||
    !REPORT_SOURCE_TYPES.has(report.sourceType) ||
    !report.reportedUserId ||
    !isObjectIdOrHexString(report.reportedUserId) ||
    !(report.createdAt instanceof Date) ||
    !Number.isFinite(report.createdAt.valueOf())
  ) {
    throw invalidData()
  }
}

export const listAdminReportQueue = async (
  query: AdminReportQueueQuery,
  dependencies: AdminReportQueueDependencies = {},
) => {
  const repository = dependencies.repository ?? mongooseRepository
  const sourceRecords = await repository.findReports(
    buildAdminReportQueueFilter(query.cursor),
    REPORT_QUEUE_SOURCE_PROJECTION,
    REPORT_QUEUE_SORT,
    query.limit + 1,
  )
  sourceRecords.forEach(assertValidReport)

  const hasMore = sourceRecords.length > query.limit
  const pageRecords = sourceRecords.slice(0, query.limit)
  const memberIds = [
    ...new Map(
      pageRecords.map((report) => [report.reportedUserId.toString(), report.reportedUserId]),
    ).values(),
  ]
  const members = await repository.findReportedMembers(memberIds, REPORT_QUEUE_MEMBER_PROJECTION)
  const membersById = new Map(
    members
      .filter(
        (member) =>
          member?._id &&
          isObjectIdOrHexString(member._id) &&
          typeof member.account === 'string' &&
          member.account.length > 0,
      )
      .map((member) => [member._id.toString(), member]),
  )

  const reports = pageRecords.map((report): AdminReportQueueItem => {
    const member = membersById.get(report.reportedUserId.toString())
    return {
      id: report._id.toString(),
      reason: report.reason,
      sourceType: report.sourceType,
      reportedMemberDisplayName: member
        ? available(member.displayName?.trim() || member.account)
        : missing(),
      reportedMemberAccount: member ? available(member.account) : missing(),
      submittedAt: report.createdAt.toISOString(),
    }
  })
  const last = pageRecords.at(-1)

  return {
    reports,
    pagination: {
      limit: query.limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeAdminReportQueueCursor({ submittedAt: last.createdAt, id: last._id })
          : null,
    },
  }
}

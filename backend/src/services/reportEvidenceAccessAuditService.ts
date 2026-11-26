import { Types, isObjectIdOrHexString, type mongo } from 'mongoose'
import {
  appendReportEvidenceAccessAuditEvent,
  type ReportEvidenceAccessAuditEventWrite,
  type ReportEvidenceAuditInsertAcknowledgment,
  type ReportEvidenceAuditWriteOptions,
} from '../models/reportEvidenceAccessAuditEventModel.js'
import {
  assertReportReviewAuthorized,
  type ReportReviewAccountStateLoader,
  type ReportReviewAuthorizationIdentity,
} from '../policies/reportReviewAuthorizationPolicy.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

export const REPORT_EVIDENCE_AUDIT_WRITE_CONCERN = Object.freeze({
  w: 'majority',
  journal: true,
  wtimeoutMS: 5_000,
}) satisfies mongo.WriteConcern

export const REPORT_EVIDENCE_AUDIT_OPERATION_TIMEOUT_MS = 6_000

export type ReportEvidenceAuditAppendRepository = Readonly<{
  append(
    event: ReportEvidenceAccessAuditEventWrite,
    options: ReportEvidenceAuditWriteOptions,
  ): Promise<ReportEvidenceAuditInsertAcknowledgment>
}>

export type ReportEvidenceAuditConfirmed = Readonly<{
  status: 'audit-append-confirmed'
  disclosurePermission: 'granted'
}>

export type ReportEvidenceAuditInput = Readonly<{
  actorUserId: string
  reportId: string
  evidenceMessageId: string
  attemptedAt: Date
}>

export type ReportEvidenceDisclosureGateInput = Readonly<{
  actor: ReportReviewAuthorizationIdentity
  reportId: string
  evidenceMessageId: string
}>

export type ReportEvidenceDisclosureGateDependencies = Readonly<{
  repository?: ReportEvidenceAuditAppendRepository
  loadAccountState?: ReportReviewAccountStateLoader
  now?: () => Date
  operationTimeoutMs?: number
}>

const defaultRepository: ReportEvidenceAuditAppendRepository = {
  append: appendReportEvidenceAccessAuditEvent,
}

const auditUnavailable = () =>
  new ApiProblem(
    503,
    'REPORT_EVIDENCE_AUDIT_UNCONFIRMED',
    'Protected evidence access is unavailable',
  )

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactlyKeys = (value: Record<string, unknown>, expected: readonly string[]) => {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

const asObjectId = (value: unknown) => {
  if (typeof value !== 'string' || !isObjectIdOrHexString(value)) throw auditUnavailable()
  return new Types.ObjectId(value)
}

const parseAuditInput = (value: unknown): ReportEvidenceAccessAuditEventWrite => {
  const keys = ['actorUserId', 'attemptedAt', 'evidenceMessageId', 'reportId'] as const
  if (!isRecord(value) || !hasExactlyKeys(value, keys)) throw auditUnavailable()
  if (!(value.attemptedAt instanceof Date) || !Number.isFinite(value.attemptedAt.valueOf())) {
    throw auditUnavailable()
  }

  return {
    actorUserId: asObjectId(value.actorUserId),
    reportId: asObjectId(value.reportId),
    evidenceMessageId: asObjectId(value.evidenceMessageId),
    eventType: 'report_evidence_access_attempt',
    attemptedAt: new Date(value.attemptedAt.valueOf()),
    outcome: 'attempt_initiated',
  }
}

const confirmedResult = (): ReportEvidenceAuditConfirmed =>
  Object.freeze({ status: 'audit-append-confirmed', disclosurePermission: 'granted' })

const withTimeout = async <Result>(operation: Promise<Result>, timeoutMs: number) => {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw auditUnavailable()
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(auditUnavailable()), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const appendReportEvidenceAccessAudit = async (
  input: ReportEvidenceAuditInput,
  dependencies: Pick<
    ReportEvidenceDisclosureGateDependencies,
    'repository' | 'operationTimeoutMs'
  > = {},
): Promise<ReportEvidenceAuditConfirmed> => {
  const repository = dependencies.repository ?? defaultRepository
  const operationTimeoutMs =
    dependencies.operationTimeoutMs ?? REPORT_EVIDENCE_AUDIT_OPERATION_TIMEOUT_MS
  const event = parseAuditInput(input)
  const expectedId = new Types.ObjectId()
  const persistedEvent = { ...event, _id: expectedId } as ReportEvidenceAccessAuditEventWrite

  try {
    const acknowledgment = await withTimeout(
      repository.append(persistedEvent, {
        writeConcern: REPORT_EVIDENCE_AUDIT_WRITE_CONCERN,
        timeoutMS: operationTimeoutMs,
      }),
      operationTimeoutMs,
    )
    if (
      acknowledgment?.acknowledged !== true ||
      !acknowledgment.insertedId ||
      acknowledgment.insertedId.toString() !== expectedId.toString()
    ) {
      throw auditUnavailable()
    }
    return confirmedResult()
  } catch {
    throw auditUnavailable()
  }
}

export const confirmReportEvidenceDisclosureGate = async (
  input: ReportEvidenceDisclosureGateInput,
  dependencies: ReportEvidenceDisclosureGateDependencies = {},
): Promise<ReportEvidenceAuditConfirmed> => {
  if (!isRecord(input) || !hasExactlyKeys(input, ['actor', 'evidenceMessageId', 'reportId'])) {
    throw auditUnavailable()
  }

  const evaluatedAt = dependencies.now?.() ?? new Date()
  await assertReportReviewAuthorized(input.actor, evaluatedAt, dependencies.loadAccountState)

  return appendReportEvidenceAccessAudit(
    {
      actorUserId: input.actor._id.toString(),
      reportId: input.reportId,
      evidenceMessageId: input.evidenceMessageId,
      attemptedAt: evaluatedAt,
    },
    dependencies,
  )
}

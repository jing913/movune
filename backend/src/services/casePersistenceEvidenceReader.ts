import mongoose, { isObjectIdOrHexString, type ClientSession } from 'mongoose'
import { CaseGovernanceEvent } from '../models/caseGovernanceEventModel.js'
import { FinalReviewDecision } from '../models/finalReviewDecisionModel.js'
import { ReviewCase } from '../models/reviewCaseModel.js'
import {
  FINAL_REVIEW_CONCLUSIONS,
  validateFinalReviewDecision,
  type FinalReviewConclusion,
} from '../policies/caseLifecyclePolicy.js'
import {
  deriveBeginReviewCommandDigest,
  deriveFinalizeReviewCommandDigest,
} from './caseTransactionService.js'

export const CASE_PERSISTENCE_READER_TRANSACTION_OPTIONS = Object.freeze({
  readPreference: 'primary' as const,
  readConcern: Object.freeze({ level: 'snapshot' as const }),
  writeConcern: Object.freeze({ w: 'majority' as const }),
})

export type BeginReviewPersistenceObservation = Readonly<{
  kind: 'begin_review'
  operationId: string
  reportId: string
  actorUserId: string
}>

export type FinalizeReviewPersistenceObservation = Readonly<{
  kind: 'finalize_review'
  operationId: string
  reportId: string
  caseId: string
  actorUserId: string
  expectedRevision: number
  conclusion: FinalReviewConclusion
  rationale: string
}>

export type CasePersistenceObservationRequest =
  | BeginReviewPersistenceObservation
  | FinalizeReviewPersistenceObservation

export type CasePersistenceReaderProvenance = Readonly<{
  source: 'server-controlled-mongodb'
  mode: 'post-transaction-read-only-snapshot'
  readPreference: 'primary'
  readConcern: 'snapshot'
  transactionWriteConcern: 'majority'
}>

export type CasePersistenceEvidenceReaderResult =
  | Readonly<{
      kind: 'observed'
      identity: Readonly<{ kind: 'MATCH' }>
      persistence: Readonly<{ kind: 'COMMITTED'; graph: 'COMPLETE' | 'INCOMPLETE' }>
      reason: 'COMPLETE_GRAPH' | 'INCOMPLETE_GRAPH'
      provenance: CasePersistenceReaderProvenance
    }>
  | Readonly<{
      kind: 'unknown'
      identity: Readonly<{ kind: 'UNKNOWN' }>
      persistence: Readonly<{ kind: 'UNKNOWN' }>
      reason: 'EVENT_NOT_FOUND'
      provenance: CasePersistenceReaderProvenance
    }>
  | Readonly<{
      kind: 'conflict'
      identity: Readonly<{ kind: 'CONFLICT' }>
      persistence: Readonly<{ kind: 'CONFLICT' }>
      reason: 'MALFORMED_EVENT' | 'OPERATION_BINDING_CONFLICT'
      provenance: CasePersistenceReaderProvenance
    }>
  | Readonly<{
      kind: 'unavailable'
      reason: 'INVALID_REQUEST' | 'SOURCE_UNAVAILABLE'
      provenance: CasePersistenceReaderProvenance
    }>

export type CasePersistenceEvidenceRepository = Readonly<{
  findEventByOperationId(operationId: string, session: ClientSession): Promise<unknown | null>
  findCaseById(caseId: string, session: ClientSession): Promise<unknown | null>
  findDecisionById(decisionId: string, session: ClientSession): Promise<unknown | null>
  findEventByCaseAndAction(
    caseId: string,
    action: 'review_completed',
    session: ClientSession,
  ): Promise<unknown | null>
}>

type ReaderTransactionRunner = <Result>(
  operation: (session: ClientSession) => Promise<Result>,
  options: typeof CASE_PERSISTENCE_READER_TRANSACTION_OPTIONS,
) => Promise<Result>

export type CasePersistenceEvidenceReaderDependencies = Readonly<{
  repository?: CasePersistenceEvidenceRepository
  transactionRunner?: ReaderTransactionRunner
}>

type ParsedEvent = Readonly<{
  id: string
  caseId: string
  reportId: string
  actorUserId: string
  action: 'review_started' | 'review_completed'
  occurredAt: Date
  outcome: 'succeeded'
  fromState: 'needs_review' | 'under_review' | 'review_completed'
  toState: 'needs_review' | 'under_review' | 'review_completed'
  fromRevision: number
  toRevision: number
  operationId: string
  commandDigest: string
  decisionId?: string
}>

type ParsedCase = Readonly<{
  id: string
  reportId: string
  state: 'under_review' | 'review_completed'
  reviewStartedByUserId: string
  reviewStartedAt: Date
  decisionId?: string
  completedAt?: Date
  revision: number
}>

type ParsedDecision = Readonly<{
  id: string
  caseId: string
  reportId: string
  conclusion: FinalReviewConclusion
  rationale: string
  reviewStartedByUserId: string
  decidedByUserId: string
  decidedAt: Date
  caseRevision: number
}>

const PROVENANCE: CasePersistenceReaderProvenance = Object.freeze({
  source: 'server-controlled-mongodb',
  mode: 'post-transaction-read-only-snapshot',
  readPreference: 'primary',
  readConcern: 'snapshot',
  transactionWriteConcern: 'majority',
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]) => {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

const stringId = (value: unknown) => {
  if (!isObjectIdOrHexString(value)) return null
  if (typeof value !== 'string' && !isRecord(value)) return null
  try {
    const toString = value.toString
    if (typeof toString !== 'function') return null
    const result = toString.call(value)
    return typeof result === 'string' && result.length > 0 ? result : null
  } catch {
    return null
  }
}

const validDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.valueOf())

const safeRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const validOperationId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= 128 &&
  /^[a-z0-9][a-z0-9._:-]*$/.test(value)

const validDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

const parseRequest = (value: unknown): CasePersistenceObservationRequest | null => {
  if (!isRecord(value) || typeof value.kind !== 'string') return null
  if (value.kind === 'begin_review') {
    if (!hasExactKeys(value, ['kind', 'operationId', 'reportId', 'actorUserId'])) return null
    if (
      !validOperationId(value.operationId) ||
      typeof value.reportId !== 'string' ||
      !stringId(value.reportId) ||
      typeof value.actorUserId !== 'string' ||
      !stringId(value.actorUserId)
    ) {
      return null
    }
    return Object.freeze({
      kind: value.kind,
      operationId: value.operationId,
      reportId: value.reportId,
      actorUserId: value.actorUserId,
    })
  }
  if (value.kind !== 'finalize_review') return null
  if (
    !hasExactKeys(value, [
      'kind',
      'operationId',
      'reportId',
      'caseId',
      'actorUserId',
      'expectedRevision',
      'conclusion',
      'rationale',
    ]) ||
    !validOperationId(value.operationId) ||
    typeof value.reportId !== 'string' ||
    !stringId(value.reportId) ||
    typeof value.caseId !== 'string' ||
    !stringId(value.caseId) ||
    typeof value.actorUserId !== 'string' ||
    !stringId(value.actorUserId) ||
    !safeRevision(value.expectedRevision) ||
    typeof value.conclusion !== 'string' ||
    !FINAL_REVIEW_CONCLUSIONS.includes(value.conclusion as FinalReviewConclusion) ||
    typeof value.rationale !== 'string' ||
    value.rationale !== value.rationale.trim() ||
    [...value.rationale].length < 1 ||
    [...value.rationale].length > 1000
  ) {
    return null
  }
  return Object.freeze({
    kind: value.kind,
    operationId: value.operationId,
    reportId: value.reportId,
    caseId: value.caseId,
    actorUserId: value.actorUserId,
    expectedRevision: value.expectedRevision,
    conclusion: value.conclusion as FinalReviewConclusion,
    rationale: value.rationale,
  })
}

const parseEvent = (value: unknown): ParsedEvent | null => {
  if (!isRecord(value)) return null
  const id = stringId(value.id ?? value._id)
  const caseId = stringId(value.caseId)
  const reportId = stringId(value.reportId)
  const actorUserId = stringId(value.actorUserId)
  const decisionId = value.decisionId === undefined ? undefined : stringId(value.decisionId)
  if (
    !id ||
    !caseId ||
    !reportId ||
    !actorUserId ||
    (value.action !== 'review_started' && value.action !== 'review_completed') ||
    !validDate(value.occurredAt) ||
    value.outcome !== 'succeeded' ||
    (value.fromState !== 'needs_review' &&
      value.fromState !== 'under_review' &&
      value.fromState !== 'review_completed') ||
    (value.toState !== 'needs_review' &&
      value.toState !== 'under_review' &&
      value.toState !== 'review_completed') ||
    !safeRevision(value.fromRevision) ||
    !safeRevision(value.toRevision) ||
    !validOperationId(value.operationId) ||
    !validDigest(value.commandDigest) ||
    (value.decisionId !== undefined && !decisionId)
  ) {
    return null
  }
  return {
    id,
    caseId,
    reportId,
    actorUserId,
    action: value.action,
    occurredAt: new Date(value.occurredAt),
    outcome: value.outcome,
    fromState: value.fromState,
    toState: value.toState,
    fromRevision: value.fromRevision,
    toRevision: value.toRevision,
    operationId: value.operationId,
    commandDigest: value.commandDigest,
    ...(decisionId ? { decisionId } : {}),
  }
}

const parseCase = (value: unknown): ParsedCase | null => {
  if (!isRecord(value)) return null
  const id = stringId(value.id ?? value._id)
  const reportId = stringId(value.reportId)
  const reviewStartedByUserId = stringId(value.reviewStartedByUserId)
  const decisionId = value.decisionId === undefined ? undefined : stringId(value.decisionId)
  const completedAt = value.completedAt === undefined ? undefined : value.completedAt
  if (
    !id ||
    !reportId ||
    !reviewStartedByUserId ||
    (value.state !== 'under_review' && value.state !== 'review_completed') ||
    !validDate(value.reviewStartedAt) ||
    !safeRevision(value.revision) ||
    (value.decisionId !== undefined && !decisionId) ||
    (completedAt !== undefined && !validDate(completedAt))
  ) {
    return null
  }
  return {
    id,
    reportId,
    state: value.state,
    reviewStartedByUserId,
    reviewStartedAt: new Date(value.reviewStartedAt),
    ...(decisionId ? { decisionId } : {}),
    ...(completedAt instanceof Date ? { completedAt: new Date(completedAt) } : {}),
    revision: value.revision,
  }
}

const parseDecision = (value: unknown): ParsedDecision | null => {
  if (!isRecord(value)) return null
  const id = stringId(value.id ?? value._id)
  const caseId = stringId(value.caseId)
  const reportId = stringId(value.reportId)
  const reviewStartedByUserId = stringId(value.reviewStartedByUserId)
  const decidedByUserId = stringId(value.decidedByUserId)
  if (
    !id ||
    !caseId ||
    !reportId ||
    !reviewStartedByUserId ||
    !decidedByUserId ||
    typeof value.conclusion !== 'string' ||
    !FINAL_REVIEW_CONCLUSIONS.includes(value.conclusion as FinalReviewConclusion) ||
    typeof value.rationale !== 'string' ||
    !validDate(value.decidedAt) ||
    !safeRevision(value.caseRevision)
  ) {
    return null
  }
  return {
    id,
    caseId,
    reportId,
    conclusion: value.conclusion as FinalReviewConclusion,
    rationale: value.rationale,
    reviewStartedByUserId,
    decidedByUserId,
    decidedAt: new Date(value.decidedAt),
    caseRevision: value.caseRevision,
  }
}

const sameInstant = (left: Date | undefined, right: Date | undefined) =>
  left instanceof Date &&
  right instanceof Date &&
  Number.isFinite(left.valueOf()) &&
  left.valueOf() === right.valueOf()

const observed = (graph: 'COMPLETE' | 'INCOMPLETE'): CasePersistenceEvidenceReaderResult =>
  Object.freeze({
    kind: 'observed',
    identity: Object.freeze({ kind: 'MATCH' }),
    persistence: Object.freeze({ kind: 'COMMITTED', graph }),
    reason: graph === 'COMPLETE' ? 'COMPLETE_GRAPH' : 'INCOMPLETE_GRAPH',
    provenance: PROVENANCE,
  })

const unknown = (): CasePersistenceEvidenceReaderResult =>
  Object.freeze({
    kind: 'unknown',
    identity: Object.freeze({ kind: 'UNKNOWN' }),
    persistence: Object.freeze({ kind: 'UNKNOWN' }),
    reason: 'EVENT_NOT_FOUND',
    provenance: PROVENANCE,
  })

const conflict = (
  reason: 'MALFORMED_EVENT' | 'OPERATION_BINDING_CONFLICT',
): CasePersistenceEvidenceReaderResult =>
  Object.freeze({
    kind: 'conflict',
    identity: Object.freeze({ kind: 'CONFLICT' }),
    persistence: Object.freeze({ kind: 'CONFLICT' }),
    reason,
    provenance: PROVENANCE,
  })

const unavailable = (
  reason: 'INVALID_REQUEST' | 'SOURCE_UNAVAILABLE',
): CasePersistenceEvidenceReaderResult => Object.freeze({ kind: 'unavailable', reason, provenance: PROVENANCE })

const mongooseRepository: CasePersistenceEvidenceRepository = {
  findEventByOperationId: (operationId, session) =>
    CaseGovernanceEvent.findOne({ operationId }).session(session).lean(),
  findCaseById: (caseId, session) => ReviewCase.findById(caseId).session(session).lean(),
  findDecisionById: (decisionId, session) =>
    FinalReviewDecision.findById(decisionId).session(session).lean(),
  findEventByCaseAndAction: (caseId, action, session) =>
    CaseGovernanceEvent.findOne({ caseId, action }).session(session).lean(),
}

const defaultTransactionRunner: ReaderTransactionRunner = (operation, options) =>
  mongoose.connection.transaction(operation, options)

const completeBeginAfterFinalization = async (
  reviewCase: ParsedCase,
  session: ClientSession,
  repository: CasePersistenceEvidenceRepository,
) => {
  if (
    reviewCase.state !== 'review_completed' ||
    reviewCase.revision !== 2 ||
    !reviewCase.decisionId ||
    !reviewCase.completedAt ||
    reviewCase.completedAt.valueOf() < reviewCase.reviewStartedAt.valueOf()
  ) {
    return false
  }
  const rawDecision = await repository.findDecisionById(reviewCase.decisionId, session)
  const rawCompletionEvent = await repository.findEventByCaseAndAction(
    reviewCase.id,
    'review_completed',
    session,
  )
  const decision = parseDecision(rawDecision)
  const completionEvent = parseEvent(rawCompletionEvent)
  const validated = decision
    ? validateFinalReviewDecision({
        conclusion: decision.conclusion,
        rationale: decision.rationale,
        reviewStartedByUserId: decision.reviewStartedByUserId,
        decidedByUserId: decision.decidedByUserId,
      })
    : null
  const digest =
    decision && validated?.ok
      ? deriveFinalizeReviewCommandDigest(
          decision.reportId,
          decision.caseId,
          decision.decidedByUserId,
          1,
          validated.conclusion,
          validated.rationale,
        )
      : null
  return Boolean(
    decision &&
    completionEvent &&
    decision.id === reviewCase.decisionId &&
    decision.caseId === reviewCase.id &&
    decision.reportId === reviewCase.reportId &&
    decision.reviewStartedByUserId === reviewCase.reviewStartedByUserId &&
    decision.caseRevision === 2 &&
    validated?.ok &&
    validated.conclusion === decision.conclusion &&
    validated.rationale === decision.rationale &&
    sameInstant(decision.decidedAt, reviewCase.completedAt) &&
    completionEvent.caseId === reviewCase.id &&
    completionEvent.reportId === reviewCase.reportId &&
    completionEvent.actorUserId === decision.decidedByUserId &&
    completionEvent.action === 'review_completed' &&
    completionEvent.outcome === 'succeeded' &&
    completionEvent.fromState === 'under_review' &&
    completionEvent.toState === 'review_completed' &&
    completionEvent.fromRevision === 1 &&
    completionEvent.toRevision === 2 &&
    completionEvent.decisionId === decision.id &&
    sameInstant(completionEvent.occurredAt, reviewCase.completedAt) &&
    digest === completionEvent.commandDigest,
  )
}

const inspectBegin = async (
  request: BeginReviewPersistenceObservation,
  event: ParsedEvent,
  session: ClientSession,
  repository: CasePersistenceEvidenceRepository,
) => {
  const digest = deriveBeginReviewCommandDigest(request.reportId, request.actorUserId)
  if (
    event.operationId !== request.operationId ||
    event.action !== 'review_started' ||
    event.commandDigest !== digest ||
    event.reportId !== request.reportId ||
    event.actorUserId !== request.actorUserId ||
    event.outcome !== 'succeeded' ||
    event.fromState !== 'needs_review' ||
    event.toState !== 'under_review' ||
    event.fromRevision !== 0 ||
    event.toRevision !== 1 ||
    event.decisionId !== undefined
  ) {
    return conflict('OPERATION_BINDING_CONFLICT')
  }
  const reviewCase = parseCase(await repository.findCaseById(event.caseId, session))
  if (
    !reviewCase ||
    reviewCase.id !== event.caseId ||
    reviewCase.reportId !== request.reportId ||
    reviewCase.reviewStartedByUserId !== request.actorUserId ||
    !sameInstant(reviewCase.reviewStartedAt, event.occurredAt)
  ) {
    return observed('INCOMPLETE')
  }
  if (
    reviewCase.state === 'under_review' &&
    reviewCase.revision === 1 &&
    reviewCase.decisionId === undefined &&
    reviewCase.completedAt === undefined
  ) {
    return observed('COMPLETE')
  }
  return (await completeBeginAfterFinalization(reviewCase, session, repository))
    ? observed('COMPLETE')
    : observed('INCOMPLETE')
}

const inspectFinalize = async (
  request: FinalizeReviewPersistenceObservation,
  event: ParsedEvent,
  session: ClientSession,
  repository: CasePersistenceEvidenceRepository,
) => {
  const digest = deriveFinalizeReviewCommandDigest(
    request.reportId,
    request.caseId,
    request.actorUserId,
    request.expectedRevision,
    request.conclusion,
    request.rationale,
  )
  if (
    event.operationId !== request.operationId ||
    event.action !== 'review_completed' ||
    event.commandDigest !== digest ||
    event.caseId !== request.caseId ||
    event.reportId !== request.reportId ||
    event.actorUserId !== request.actorUserId ||
    event.outcome !== 'succeeded' ||
    event.fromState !== 'under_review' ||
    event.toState !== 'review_completed' ||
    event.fromRevision !== 1 ||
    event.fromRevision !== request.expectedRevision ||
    event.toRevision !== 2 ||
    !event.decisionId
  ) {
    return conflict('OPERATION_BINDING_CONFLICT')
  }
  const rawCase = await repository.findCaseById(request.caseId, session)
  const rawDecision = await repository.findDecisionById(event.decisionId, session)
  const reviewCase = parseCase(rawCase)
  const decision = parseDecision(rawDecision)
  const validated = decision
    ? validateFinalReviewDecision({
        conclusion: decision.conclusion,
        rationale: decision.rationale,
        reviewStartedByUserId: decision.reviewStartedByUserId,
        decidedByUserId: decision.decidedByUserId,
      })
    : null
  const persistedDigest =
    decision && validated?.ok
      ? deriveFinalizeReviewCommandDigest(
          decision.reportId,
          decision.caseId,
          decision.decidedByUserId,
          event.fromRevision,
          validated.conclusion,
          validated.rationale,
        )
      : null
  return reviewCase &&
    decision &&
    reviewCase.state === 'review_completed' &&
    reviewCase.id === request.caseId &&
    reviewCase.reportId === request.reportId &&
    reviewCase.reviewStartedByUserId === decision.reviewStartedByUserId &&
    reviewCase.decisionId === decision.id &&
    reviewCase.decisionId === event.decisionId &&
    reviewCase.revision === 2 &&
    reviewCase.completedAt !== undefined &&
    reviewCase.completedAt.valueOf() >= reviewCase.reviewStartedAt.valueOf() &&
    sameInstant(reviewCase.completedAt, decision.decidedAt) &&
    sameInstant(decision.decidedAt, event.occurredAt) &&
    decision.id === event.decisionId &&
    decision.caseId === request.caseId &&
    decision.reportId === request.reportId &&
    decision.decidedByUserId === request.actorUserId &&
    decision.caseRevision === 2 &&
    validated?.ok &&
    validated.conclusion === request.conclusion &&
    validated.rationale === request.rationale &&
    persistedDigest === event.commandDigest
    ? observed('COMPLETE')
    : observed('INCOMPLETE')
}

export const createCasePersistenceEvidenceReader = (
  dependencies: CasePersistenceEvidenceReaderDependencies = {},
) => {
  const repository = dependencies.repository ?? mongooseRepository
  const transactionRunner = dependencies.transactionRunner ?? defaultTransactionRunner
  return Object.freeze({
    async observe(input: unknown): Promise<CasePersistenceEvidenceReaderResult> {
      const request = parseRequest(input)
      if (!request) return unavailable('INVALID_REQUEST')
      try {
        return await transactionRunner(async (session) => {
          const rawEvent = await repository.findEventByOperationId(request.operationId, session)
          if (rawEvent === null) return unknown()
          const event = parseEvent(rawEvent)
          if (!event) return conflict('MALFORMED_EVENT')
          return request.kind === 'begin_review'
            ? inspectBegin(request, event, session, repository)
            : inspectFinalize(request, event, session, repository)
        }, CASE_PERSISTENCE_READER_TRANSACTION_OPTIONS)
      } catch {
        return unavailable('SOURCE_UNAVAILABLE')
      }
    },
  })
}

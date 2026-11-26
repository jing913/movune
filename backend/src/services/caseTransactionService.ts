import { createHash } from 'node:crypto'
import mongoose, { Types, isObjectIdOrHexString, type ClientSession } from 'mongoose'
import {
  CaseGovernanceEvent,
  type CaseGovernanceAction,
} from '../models/caseGovernanceEventModel.js'
import { FinalReviewDecision } from '../models/finalReviewDecisionModel.js'
import { Report } from '../models/reportModel.js'
import { ReviewCase } from '../models/reviewCaseModel.js'
import {
  evaluateCaseTransition,
  validateFinalReviewDecision,
  type CaseState,
  type FinalReviewConclusion,
} from '../policies/caseLifecyclePolicy.js'
import {
  assertCaseReviewMutationAuthorized,
  type CaseReviewMutationAuthorizationIdentity,
} from '../policies/caseReviewAuthorizationPolicy.js'
import { evaluateAccountEnforcementState } from './accountEnforcementService.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

export const CASE_TRANSACTION_OPTIONS = Object.freeze({
  readPreference: 'primary' as const,
  readConcern: Object.freeze({ level: 'majority' as const }),
  writeConcern: Object.freeze({ w: 'majority' as const, journal: true }),
  maxCommitTimeMS: 5_000,
})

export type CaseTransactionErrorCode =
  | 'CASE_INPUT_INVALID'
  | 'CASE_REPORT_NOT_FOUND'
  | 'CASE_INVALID_TRANSITION'
  | 'CASE_STALE_REVISION'
  | 'CASE_ALREADY_STARTED'
  | 'CASE_ALREADY_FINALIZED'
  | 'CASE_OPERATION_ID_REUSED'
  | 'CASE_CAS_CONFLICT'
  | 'CASE_DUPLICATE_KEY_CONFLICT'
  | 'CASE_TRANSACTION_UNAVAILABLE'
  | 'CASE_OPERATION_UNCONFIRMED'
  | 'CASE_PERSISTENCE_INTEGRITY'

export class CaseTransactionServiceError extends Error {
  constructor(
    public readonly code: CaseTransactionErrorCode,
    message: string,
    public readonly operationId?: string,
  ) {
    super(message)
    this.name = 'CaseTransactionServiceError'
  }
}

export type ReviewCaseRecord = Readonly<{
  id: string
  reportId: string
  state: 'under_review' | 'review_completed'
  reviewStartedByUserId: string
  reviewStartedAt: Date
  decisionId?: string
  completedAt?: Date
  revision: number
}>

export type FinalReviewDecisionRecord = Readonly<{
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

export type CaseGovernanceEventRecord = Readonly<{
  id: string
  caseId: string
  reportId: string
  actorUserId: string
  action: CaseGovernanceAction
  occurredAt: Date
  outcome: 'succeeded'
  fromState: CaseState
  toState: CaseState
  fromRevision: number
  toRevision: number
  operationId: string
  commandDigest: string
  decisionId?: string
}>

export type BeginReviewInput = Readonly<{
  operationId: string
  reportId: string
}>

export type FinalizeReviewInput = Readonly<{
  operationId: string
  reportId: string
  caseId: string
  expectedRevision: number
  conclusion: FinalReviewConclusion
  rationale: string
}>

export type BeginReviewResult = Readonly<{
  kind: 'committed' | 'replayed'
  operationId: string
  case: ReviewCaseRecord
}>

export type FinalizeReviewResult = Readonly<{
  kind: 'committed' | 'replayed'
  operationId: string
  case: ReviewCaseRecord
  decision: FinalReviewDecisionRecord
}>

export type CaseTransactionRepository = Readonly<{
  reportExists(reportId: string, session: ClientSession): Promise<boolean>
  findCaseByReportId(reportId: string, session: ClientSession): Promise<ReviewCaseRecord | null>
  findCaseById(caseId: string, session: ClientSession): Promise<ReviewCaseRecord | null>
  createCase(value: ReviewCaseRecord, session: ClientSession): Promise<ReviewCaseRecord>
  finalizeCase(
    caseId: string,
    expectedRevision: number,
    decisionId: string,
    completedAt: Date,
    session: ClientSession,
  ): Promise<ReviewCaseRecord | null>
  findDecisionById(
    decisionId: string,
    session: ClientSession,
  ): Promise<FinalReviewDecisionRecord | null>
  createDecision(
    value: FinalReviewDecisionRecord,
    session: ClientSession,
  ): Promise<FinalReviewDecisionRecord>
  findEventByOperationId(
    operationId: string,
    session: ClientSession,
  ): Promise<CaseGovernanceEventRecord | null>
  findEventByCaseAndAction(
    caseId: string,
    action: CaseGovernanceAction,
    session: ClientSession,
  ): Promise<CaseGovernanceEventRecord | null>
  createEvent(
    value: Omit<CaseGovernanceEventRecord, 'id'>,
    session: ClientSession,
  ): Promise<CaseGovernanceEventRecord>
}>

type TransactionRunner = <Result>(
  operation: (session: ClientSession) => Promise<Result>,
  options: typeof CASE_TRANSACTION_OPTIONS,
) => Promise<Result>

type Authorize = (
  actor: CaseReviewMutationAuthorizationIdentity,
  evaluatedAt: Date,
  session: ClientSession,
) => Promise<void>

export type CaseTransactionDependencies = Readonly<{
  repository?: CaseTransactionRepository
  transactionRunner?: TransactionRunner
  authorize?: Authorize
  now?: () => Date
  newId?: () => string
}>

const fail = (code: CaseTransactionErrorCode, message: string, operationId?: string): never => {
  throw new CaseTransactionServiceError(code, message, operationId)
}

const requireId = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !isObjectIdOrHexString(value)) {
    return fail('CASE_INPUT_INVALID', `${field} is invalid`)
  }
  return new Types.ObjectId(value).toString()
}

const requireOperationId = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[a-z0-9][a-z0-9._:-]*$/.test(value)
  ) {
    return fail('CASE_INPUT_INVALID', 'operationId is invalid')
  }
  return value
}

const requireExactInput = (value: unknown, keys: readonly string[]) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('CASE_INPUT_INVALID', 'Case command input is invalid')
  }
  const actual = Object.keys(value)
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    return fail('CASE_INPUT_INVALID', 'Case command input is invalid')
  }
}

const actorId = (actor: CaseReviewMutationAuthorizationIdentity) =>
  requireId(actor._id.toString(), 'actor')

const digestTuple = (tuple: readonly unknown[]) =>
  createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex')

export const deriveBeginReviewCommandDigest = (reportId: string, authenticatedActorId: string) =>
  digestTuple([
    'case-command-v1',
    'review_started',
    reportId,
    authenticatedActorId,
    'needs_review',
    0,
  ])

export const deriveFinalizeReviewCommandDigest = (
  reportId: string,
  caseId: string,
  authenticatedActorId: string,
  expectedRevision: number,
  conclusion: FinalReviewConclusion,
  rationale: string,
) =>
  digestTuple([
    'case-command-v1',
    'review_completed',
    reportId,
    caseId,
    authenticatedActorId,
    expectedRevision,
    conclusion,
    rationale,
  ])

const toCaseRecord = (value: {
  _id: Types.ObjectId
  reportId: Types.ObjectId
  state: 'under_review' | 'review_completed'
  reviewStartedByUserId: Types.ObjectId
  reviewStartedAt: Date
  decisionId?: Types.ObjectId
  completedAt?: Date
  revision: number
}): ReviewCaseRecord => ({
  id: value._id.toString(),
  reportId: value.reportId.toString(),
  state: value.state,
  reviewStartedByUserId: value.reviewStartedByUserId.toString(),
  reviewStartedAt: new Date(value.reviewStartedAt),
  ...(value.decisionId ? { decisionId: value.decisionId.toString() } : {}),
  ...(value.completedAt ? { completedAt: new Date(value.completedAt) } : {}),
  revision: value.revision,
})

const toDecisionRecord = (value: {
  _id: Types.ObjectId
  caseId: Types.ObjectId
  reportId: Types.ObjectId
  conclusion: FinalReviewConclusion
  rationale: string
  reviewStartedByUserId: Types.ObjectId
  decidedByUserId: Types.ObjectId
  decidedAt: Date
  caseRevision: number
}): FinalReviewDecisionRecord => ({
  id: value._id.toString(),
  caseId: value.caseId.toString(),
  reportId: value.reportId.toString(),
  conclusion: value.conclusion,
  rationale: value.rationale,
  reviewStartedByUserId: value.reviewStartedByUserId.toString(),
  decidedByUserId: value.decidedByUserId.toString(),
  decidedAt: new Date(value.decidedAt),
  caseRevision: value.caseRevision,
})

const toEventRecord = (value: {
  _id: Types.ObjectId
  caseId: Types.ObjectId
  reportId: Types.ObjectId
  actorUserId: Types.ObjectId
  action: CaseGovernanceAction
  occurredAt: Date
  outcome: 'succeeded'
  fromState: CaseState
  toState: CaseState
  fromRevision: number
  toRevision: number
  operationId: string
  commandDigest: string
  decisionId?: Types.ObjectId
}): CaseGovernanceEventRecord => ({
  id: value._id.toString(),
  caseId: value.caseId.toString(),
  reportId: value.reportId.toString(),
  actorUserId: value.actorUserId.toString(),
  action: value.action,
  occurredAt: new Date(value.occurredAt),
  outcome: value.outcome,
  fromState: value.fromState,
  toState: value.toState,
  fromRevision: value.fromRevision,
  toRevision: value.toRevision,
  operationId: value.operationId,
  commandDigest: value.commandDigest,
  ...(value.decisionId ? { decisionId: value.decisionId.toString() } : {}),
})

const mongooseRepository: CaseTransactionRepository = {
  async reportExists(reportId, session) {
    return Boolean(await Report.exists({ _id: reportId }).session(session))
  },
  async findCaseByReportId(reportId, session) {
    const value = await ReviewCase.findOne({ reportId }).session(session).lean()
    return value ? toCaseRecord(value) : null
  },
  async findCaseById(caseId, session) {
    const value = await ReviewCase.findById(caseId).session(session).lean()
    return value ? toCaseRecord(value) : null
  },
  async createCase(value, session) {
    const [created] = await ReviewCase.create(
      [
        {
          _id: value.id,
          reportId: value.reportId,
          state: value.state,
          reviewStartedByUserId: value.reviewStartedByUserId,
          reviewStartedAt: value.reviewStartedAt,
          revision: value.revision,
        },
      ],
      { session },
    )
    if (!created) return fail('CASE_PERSISTENCE_INTEGRITY', 'Case creation returned no record')
    return toCaseRecord(created)
  },
  async finalizeCase(caseId, expectedRevision, decisionId, completedAt, session) {
    const value = await ReviewCase.findOneAndUpdate(
      {
        _id: caseId,
        state: 'under_review',
        revision: expectedRevision,
        decisionId: { $exists: false },
      },
      {
        $set: { state: 'review_completed', decisionId, completedAt },
        $inc: { revision: 1 },
      },
      { session, returnDocument: 'after', runValidators: true },
    ).lean()
    return value ? toCaseRecord(value) : null
  },
  async findDecisionById(decisionId, session) {
    const value = await FinalReviewDecision.findById(decisionId).session(session).lean()
    return value ? toDecisionRecord(value) : null
  },
  async createDecision(value, session) {
    const [created] = await FinalReviewDecision.create(
      [
        {
          _id: value.id,
          caseId: value.caseId,
          reportId: value.reportId,
          conclusion: value.conclusion,
          rationale: value.rationale,
          reviewStartedByUserId: value.reviewStartedByUserId,
          decidedByUserId: value.decidedByUserId,
          decidedAt: value.decidedAt,
          caseRevision: value.caseRevision,
        },
      ],
      { session },
    )
    if (!created) return fail('CASE_PERSISTENCE_INTEGRITY', 'Decision creation returned no record')
    return toDecisionRecord(created)
  },
  async findEventByOperationId(operationId, session) {
    const value = await CaseGovernanceEvent.findOne({ operationId }).session(session).lean()
    return value ? toEventRecord(value) : null
  },
  async findEventByCaseAndAction(caseId, action, session) {
    const value = await CaseGovernanceEvent.findOne({ caseId, action }).session(session).lean()
    return value ? toEventRecord(value) : null
  },
  async createEvent(value, session) {
    const [created] = await CaseGovernanceEvent.create(
      [
        {
          caseId: value.caseId,
          reportId: value.reportId,
          actorUserId: value.actorUserId,
          action: value.action,
          occurredAt: value.occurredAt,
          outcome: value.outcome,
          fromState: value.fromState,
          toState: value.toState,
          fromRevision: value.fromRevision,
          toRevision: value.toRevision,
          operationId: value.operationId,
          commandDigest: value.commandDigest,
          ...(value.decisionId ? { decisionId: value.decisionId } : {}),
        },
      ],
      { session },
    )
    if (!created) return fail('CASE_PERSISTENCE_INTEGRITY', 'Event creation returned no record')
    return toEventRecord(created)
  },
}

const defaultTransactionRunner: TransactionRunner = (operation, options) =>
  mongoose.connection.transaction(operation, options)

const defaultAuthorize: Authorize = (actor, evaluatedAt, session) =>
  assertCaseReviewMutationAuthorized(actor, evaluatedAt, (userId, at) =>
    evaluateAccountEnforcementState(userId, at, { session }),
  )

const isDuplicateKeyError = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000

const hasErrorLabel = (error: unknown, label: string) =>
  typeof error === 'object' &&
  error !== null &&
  'hasErrorLabel' in error &&
  typeof error.hasErrorLabel === 'function' &&
  error.hasErrorLabel(label)

const classifyTransitionFailure = (reason: string, operationId: string): never => {
  if (reason === 'already-started') {
    return fail('CASE_ALREADY_STARTED', 'Case review is already started', operationId)
  }
  if (reason === 'already-finalized') {
    return fail('CASE_ALREADY_FINALIZED', 'Case review is already finalized', operationId)
  }
  if (reason === 'stale-revision' || reason === 'stale-state') {
    return fail('CASE_STALE_REVISION', 'Case revision is stale', operationId)
  }
  return fail('CASE_INVALID_TRANSITION', 'Case transition is invalid', operationId)
}

const assertReplayIdentity = (
  event: CaseGovernanceEventRecord,
  action: CaseGovernanceAction,
  digest: string,
  operationId: string,
) => {
  if (event.action !== action || event.commandDigest !== digest) {
    fail('CASE_OPERATION_ID_REUSED', 'operationId is bound to another command', operationId)
  }
}

const sameInstant = (left: Date | undefined, right: Date | undefined) =>
  left instanceof Date &&
  right instanceof Date &&
  Number.isFinite(left.valueOf()) &&
  left.valueOf() === right.valueOf()

const hasConsistentUnderReviewBeginReplayState = (reviewCase: ReviewCaseRecord) =>
  reviewCase.state === 'under_review' &&
  reviewCase.revision === 1 &&
  reviewCase.decisionId === undefined &&
  reviewCase.completedAt === undefined

const hasConsistentCompletedBeginReplayState = async (
  reviewCase: ReviewCaseRecord,
  session: ClientSession,
  repository: CaseTransactionRepository,
) => {
  if (
    reviewCase.state !== 'review_completed' ||
    reviewCase.revision !== 2 ||
    !reviewCase.decisionId ||
    !isObjectIdOrHexString(reviewCase.decisionId) ||
    !(reviewCase.completedAt instanceof Date) ||
    !Number.isFinite(reviewCase.completedAt.valueOf()) ||
    reviewCase.completedAt.valueOf() < reviewCase.reviewStartedAt.valueOf()
  ) {
    return false
  }

  const decision = await repository.findDecisionById(reviewCase.decisionId, session)
  const completionEvent = await repository.findEventByCaseAndAction(
    reviewCase.id,
    'review_completed',
    session,
  )
  const validatedDecision = decision
    ? validateFinalReviewDecision({
        conclusion: decision.conclusion,
        rationale: decision.rationale,
        reviewStartedByUserId: decision.reviewStartedByUserId,
        decidedByUserId: decision.decidedByUserId,
      })
    : null
  const persistedDigest =
    decision && validatedDecision?.ok
      ? deriveFinalizeReviewCommandDigest(
          decision.reportId,
          decision.caseId,
          decision.decidedByUserId,
          1,
          validatedDecision.conclusion,
          validatedDecision.rationale,
        )
      : null

  return Boolean(
    decision &&
    completionEvent &&
    decision.id === reviewCase.decisionId &&
    isObjectIdOrHexString(decision.id) &&
    decision.caseId === reviewCase.id &&
    decision.reportId === reviewCase.reportId &&
    decision.reviewStartedByUserId === reviewCase.reviewStartedByUserId &&
    isObjectIdOrHexString(decision.decidedByUserId) &&
    decision.caseRevision === 2 &&
    validatedDecision?.ok &&
    validatedDecision.conclusion === decision.conclusion &&
    validatedDecision.rationale === decision.rationale &&
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
    persistedDigest === completionEvent.commandDigest,
  )
}

const replayBegin = async (
  event: CaseGovernanceEventRecord,
  reportId: string,
  actorUserId: string,
  session: ClientSession,
  repository: CaseTransactionRepository,
): Promise<BeginReviewResult> => {
  const reviewCase = await repository.findCaseById(event.caseId, session)
  if (
    !reviewCase ||
    event.reportId !== reportId ||
    event.actorUserId !== actorUserId ||
    event.outcome !== 'succeeded' ||
    event.fromState !== 'needs_review' ||
    event.toState !== 'under_review' ||
    event.fromRevision !== 0 ||
    event.toRevision !== 1 ||
    event.decisionId !== undefined ||
    reviewCase.id !== event.caseId ||
    reviewCase.reportId !== reportId ||
    reviewCase.reviewStartedByUserId !== actorUserId ||
    !sameInstant(reviewCase.reviewStartedAt, event.occurredAt) ||
    deriveBeginReviewCommandDigest(reviewCase.reportId, reviewCase.reviewStartedByUserId) !==
      event.commandDigest
  ) {
    return fail(
      'CASE_PERSISTENCE_INTEGRITY',
      'Committed Case replay is inconsistent',
      event.operationId,
    )
  }
  if (
    !hasConsistentUnderReviewBeginReplayState(reviewCase) &&
    !(await hasConsistentCompletedBeginReplayState(reviewCase, session, repository))
  ) {
    return fail(
      'CASE_PERSISTENCE_INTEGRITY',
      'Committed Case replay is inconsistent',
      event.operationId,
    )
  }
  return {
    kind: 'replayed',
    operationId: event.operationId,
    case: {
      id: event.caseId,
      reportId,
      state: 'under_review',
      reviewStartedByUserId: actorUserId,
      reviewStartedAt: event.occurredAt,
      revision: 1,
    },
  }
}

const replayFinalize = async (
  event: CaseGovernanceEventRecord,
  reportId: string,
  caseId: string,
  actorUserId: string,
  expectedRevision: number,
  conclusion: FinalReviewConclusion,
  rationale: string,
  session: ClientSession,
  repository: CaseTransactionRepository,
): Promise<FinalizeReviewResult> => {
  if (!event.decisionId) {
    return fail(
      'CASE_PERSISTENCE_INTEGRITY',
      'Committed decision replay is incomplete',
      event.operationId,
    )
  }
  const reviewCase = await repository.findCaseById(caseId, session)
  const decision = await repository.findDecisionById(event.decisionId, session)
  const validatedDecision = decision
    ? validateFinalReviewDecision({
        conclusion: decision.conclusion,
        rationale: decision.rationale,
        reviewStartedByUserId: decision.reviewStartedByUserId,
        decidedByUserId: decision.decidedByUserId,
      })
    : null
  const persistedDigest =
    decision && validatedDecision?.ok
      ? deriveFinalizeReviewCommandDigest(
          decision.reportId,
          decision.caseId,
          decision.decidedByUserId,
          event.fromRevision,
          validatedDecision.conclusion,
          validatedDecision.rationale,
        )
      : null
  if (
    !reviewCase ||
    !decision ||
    event.caseId !== caseId ||
    event.reportId !== reportId ||
    event.actorUserId !== actorUserId ||
    event.outcome !== 'succeeded' ||
    event.fromState !== 'under_review' ||
    event.toState !== 'review_completed' ||
    event.fromRevision !== 1 ||
    event.fromRevision !== expectedRevision ||
    event.toRevision !== 2 ||
    reviewCase.state !== 'review_completed' ||
    reviewCase.id !== caseId ||
    reviewCase.reportId !== reportId ||
    reviewCase.reviewStartedByUserId !== decision.reviewStartedByUserId ||
    reviewCase.decisionId !== decision.id ||
    reviewCase.decisionId !== event.decisionId ||
    reviewCase.revision !== 2 ||
    !sameInstant(reviewCase.completedAt, decision.decidedAt) ||
    !sameInstant(decision.decidedAt, event.occurredAt) ||
    decision.id !== event.decisionId ||
    decision.caseId !== caseId ||
    decision.reportId !== reportId ||
    decision.decidedByUserId !== actorUserId ||
    decision.caseRevision !== 2 ||
    !validatedDecision?.ok ||
    validatedDecision.conclusion !== conclusion ||
    validatedDecision.rationale !== rationale ||
    persistedDigest !== event.commandDigest
  ) {
    return fail(
      'CASE_PERSISTENCE_INTEGRITY',
      'Committed decision replay is inconsistent',
      event.operationId,
    )
  }
  return { kind: 'replayed', operationId: event.operationId, case: reviewCase, decision }
}

export const createCaseTransactionService = (dependencies: CaseTransactionDependencies = {}) => {
  const repository = dependencies.repository ?? mongooseRepository
  const transactionRunner = dependencies.transactionRunner ?? defaultTransactionRunner
  const authorize = dependencies.authorize ?? defaultAuthorize
  const now = dependencies.now ?? (() => new Date())
  const newId = dependencies.newId ?? (() => new Types.ObjectId().toString())

  const transact = async <Result>(
    operationId: string,
    operation: (session: ClientSession) => Promise<Result>,
  ) => {
    try {
      return await transactionRunner(operation, CASE_TRANSACTION_OPTIONS)
    } catch (error) {
      if (error instanceof CaseTransactionServiceError || error instanceof ApiProblem) throw error
      if (isDuplicateKeyError(error)) {
        return fail(
          'CASE_DUPLICATE_KEY_CONFLICT',
          'A uniqueness conflict prevented the operation',
          operationId,
        )
      }
      if (hasErrorLabel(error, 'UnknownTransactionCommitResult')) {
        return fail(
          'CASE_OPERATION_UNCONFIRMED',
          'The commit outcome is unknown; retry later with the same operationId',
          operationId,
        )
      }
      return fail(
        'CASE_TRANSACTION_UNAVAILABLE',
        'The Case transaction did not complete',
        operationId,
      )
    }
  }

  return {
    beginReview(actor: CaseReviewMutationAuthorizationIdentity, input: BeginReviewInput) {
      requireExactInput(input, ['operationId', 'reportId'])
      const operationId = requireOperationId(input.operationId)
      const reportId = requireId(input.reportId, 'reportId')
      const authenticatedActorId = actorId(actor)
      const digest = deriveBeginReviewCommandDigest(reportId, authenticatedActorId)
      const caseId = requireId(newId(), 'generated caseId')

      return transact(operationId, async (session) => {
        const occurredAt = now()
        await authorize(actor, occurredAt, session)

        const priorEvent = await repository.findEventByOperationId(operationId, session)
        if (priorEvent) {
          assertReplayIdentity(priorEvent, 'review_started', digest, operationId)
          return replayBegin(priorEvent, reportId, authenticatedActorId, session, repository)
        }
        if (!(await repository.reportExists(reportId, session))) {
          return fail('CASE_REPORT_NOT_FOUND', 'Report does not exist', operationId)
        }
        const current = await repository.findCaseByReportId(reportId, session)
        if (current) {
          return fail(
            current.state === 'review_completed'
              ? 'CASE_ALREADY_FINALIZED'
              : 'CASE_ALREADY_STARTED',
            current.state === 'review_completed'
              ? 'Case review is already finalized'
              : 'Case review is already started',
            operationId,
          )
        }

        const transition = evaluateCaseTransition({
          action: 'begin_review',
          currentState: 'needs_review',
          expectedState: 'needs_review',
          currentRevision: 0,
          expectedRevision: 0,
        })
        if (!transition.ok) return classifyTransitionFailure(transition.reason, operationId)

        const created = await repository.createCase(
          {
            id: caseId,
            reportId,
            state: 'under_review',
            reviewStartedByUserId: authenticatedActorId,
            reviewStartedAt: occurredAt,
            revision: transition.nextRevision,
          },
          session,
        )
        await repository.createEvent(
          {
            caseId,
            reportId,
            actorUserId: authenticatedActorId,
            action: 'review_started',
            occurredAt,
            outcome: 'succeeded',
            fromState: transition.fromState,
            toState: transition.toState,
            fromRevision: transition.currentRevision,
            toRevision: transition.nextRevision,
            operationId,
            commandDigest: digest,
          },
          session,
        )
        return { kind: 'committed', operationId, case: created } satisfies BeginReviewResult
      })
    },

    finalizeReview(actor: CaseReviewMutationAuthorizationIdentity, input: FinalizeReviewInput) {
      requireExactInput(input, [
        'operationId',
        'reportId',
        'caseId',
        'expectedRevision',
        'conclusion',
        'rationale',
      ])
      const operationId = requireOperationId(input.operationId)
      const reportId = requireId(input.reportId, 'reportId')
      const caseId = requireId(input.caseId, 'caseId')
      const authenticatedActorId = actorId(actor)
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
        return Promise.reject(
          new CaseTransactionServiceError(
            'CASE_INPUT_INVALID',
            'expectedRevision is invalid',
            operationId,
          ),
        )
      }
      const preliminary = validateFinalReviewDecision({
        conclusion: input.conclusion,
        rationale: input.rationale,
        reviewStartedByUserId: 'persisted-starter',
        decidedByUserId: authenticatedActorId,
      })
      if (!preliminary.ok) {
        return Promise.reject(
          new CaseTransactionServiceError(
            'CASE_INPUT_INVALID',
            'Final decision input is invalid',
            operationId,
          ),
        )
      }
      const digest = deriveFinalizeReviewCommandDigest(
        reportId,
        caseId,
        authenticatedActorId,
        input.expectedRevision,
        preliminary.conclusion,
        preliminary.rationale,
      )
      const decisionId = requireId(newId(), 'generated decisionId')

      return transact(operationId, async (session) => {
        const occurredAt = now()
        await authorize(actor, occurredAt, session)

        const priorEvent = await repository.findEventByOperationId(operationId, session)
        if (priorEvent) {
          assertReplayIdentity(priorEvent, 'review_completed', digest, operationId)
          return replayFinalize(
            priorEvent,
            reportId,
            caseId,
            authenticatedActorId,
            input.expectedRevision,
            preliminary.conclusion,
            preliminary.rationale,
            session,
            repository,
          )
        }
        if (!(await repository.reportExists(reportId, session))) {
          return fail('CASE_REPORT_NOT_FOUND', 'Report does not exist', operationId)
        }
        const current = await repository.findCaseById(caseId, session)
        if (!current || current.reportId !== reportId) {
          return fail('CASE_INVALID_TRANSITION', 'Case does not match the Report', operationId)
        }
        if (current.state === 'review_completed') {
          return fail('CASE_ALREADY_FINALIZED', 'Case review is already finalized', operationId)
        }
        if (current.state !== 'under_review' || current.revision !== 1) {
          return fail(
            'CASE_PERSISTENCE_INTEGRITY',
            'Persisted Case state and revision are inconsistent',
            operationId,
          )
        }
        const validated = validateFinalReviewDecision({
          conclusion: preliminary.conclusion,
          rationale: preliminary.rationale,
          reviewStartedByUserId: current.reviewStartedByUserId,
          decidedByUserId: authenticatedActorId,
        })
        if (!validated.ok)
          return fail('CASE_INPUT_INVALID', 'Final decision input is invalid', operationId)

        const transition = evaluateCaseTransition({
          action: 'finalize_review',
          currentState: current.state,
          expectedState: 'under_review',
          currentRevision: current.revision,
          expectedRevision: input.expectedRevision,
        })
        if (!transition.ok) return classifyTransitionFailure(transition.reason, operationId)

        const updated = await repository.finalizeCase(
          caseId,
          input.expectedRevision,
          decisionId,
          occurredAt,
          session,
        )
        if (!updated) {
          const observed = await repository.findCaseById(caseId, session)
          if (!observed) return fail('CASE_INVALID_TRANSITION', 'Case does not exist', operationId)
          if (observed.state === 'review_completed') {
            return fail('CASE_ALREADY_FINALIZED', 'Case review is already finalized', operationId)
          }
          if (observed.revision !== input.expectedRevision) {
            return fail('CASE_STALE_REVISION', 'Case revision is stale', operationId)
          }
          return fail('CASE_CAS_CONFLICT', 'Case compare-and-set did not succeed', operationId)
        }
        if (
          updated.id !== current.id ||
          updated.reportId !== current.reportId ||
          updated.state !== 'review_completed' ||
          updated.reviewStartedByUserId !== current.reviewStartedByUserId ||
          !sameInstant(updated.reviewStartedAt, current.reviewStartedAt) ||
          updated.decisionId !== decisionId ||
          !sameInstant(updated.completedAt, occurredAt) ||
          updated.revision !== 2
        ) {
          return fail(
            'CASE_PERSISTENCE_INTEGRITY',
            'Finalized Case result is inconsistent',
            operationId,
          )
        }

        const decision = await repository.createDecision(
          {
            id: decisionId,
            caseId,
            reportId,
            conclusion: validated.conclusion,
            rationale: validated.rationale,
            reviewStartedByUserId: validated.reviewStartedByUserId,
            decidedByUserId: validated.decidedByUserId,
            decidedAt: occurredAt,
            caseRevision: transition.nextRevision,
          },
          session,
        )
        await repository.createEvent(
          {
            caseId,
            reportId,
            actorUserId: authenticatedActorId,
            action: 'review_completed',
            occurredAt,
            outcome: 'succeeded',
            fromState: transition.fromState,
            toState: transition.toState,
            fromRevision: transition.currentRevision,
            toRevision: transition.nextRevision,
            operationId,
            commandDigest: digest,
            decisionId,
          },
          session,
        )
        return {
          kind: 'committed',
          operationId,
          case: updated,
          decision,
        } satisfies FinalizeReviewResult
      })
    },
  }
}

export const caseTransactionService = createCaseTransactionService()

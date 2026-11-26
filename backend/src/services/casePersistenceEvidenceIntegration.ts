import { Types, isObjectIdOrHexString } from 'mongoose'
import { validateFinalReviewDecision } from '../policies/caseLifecyclePolicy.js'
import type { ReportReviewAuthorizationIdentity } from '../policies/reportReviewAuthorizationPolicy.js'
import {
  createCasePersistenceEvidenceProvider,
  type CasePersistenceEvidenceProviderResult,
} from './casePersistenceEvidenceProvider.js'
import { createCasePersistenceEvidenceReader } from './casePersistenceEvidenceReader.js'

type EvidenceProviderPort = Readonly<{
  read(context: unknown): Promise<CasePersistenceEvidenceProviderResult>
}>

type CasePersistenceEvidenceIntegration = Readonly<{
  observeBegin(
    authenticatedActor: ReportReviewAuthorizationIdentity,
    operationSelector: unknown,
    transactionResult: unknown,
  ): Promise<CasePersistenceEvidenceProviderResult>
  observeFinalize(
    authenticatedActor: ReportReviewAuthorizationIdentity,
    operationSelector: unknown,
    transactionResult: unknown,
  ): Promise<CasePersistenceEvidenceProviderResult>
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]) => {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

const normalizedId = (value: unknown) => {
  try {
    if (!isObjectIdOrHexString(value)) return null
    if (typeof value === 'string') return new Types.ObjectId(value).toString()
    if (!isRecord(value)) return null
    const toString = value.toString
    if (typeof toString !== 'function') return null
    const result = toString.call(value)
    return typeof result === 'string' && isObjectIdOrHexString(result)
      ? new Types.ObjectId(result).toString()
      : null
  } catch {
    return null
  }
}

const validOperationId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= 128 &&
  /^[a-z0-9][a-z0-9._:-]*$/.test(value)

const validDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.valueOf())

const sameInstant = (left: Date, right: Date) => left.valueOf() === right.valueOf()

const unavailable = (
  reason: 'INVALID_CONTEXT' | 'SOURCE_UNAVAILABLE',
): CasePersistenceEvidenceProviderResult => Object.freeze({ kind: 'EVIDENCE_UNAVAILABLE', reason })

const beginContext = (
  authenticatedActor: ReportReviewAuthorizationIdentity,
  operationSelector: unknown,
  transactionResult: unknown,
) => {
  if (
    !isRecord(operationSelector) ||
    !hasExactKeys(operationSelector, ['operationId', 'reportId']) ||
    !validOperationId(operationSelector.operationId)
  ) {
    return null
  }
  const selectorReportId = normalizedId(operationSelector.reportId)
  const actorUserId = normalizedId(authenticatedActor?._id)
  if (!selectorReportId || !actorUserId) return null

  if (
    !isRecord(transactionResult) ||
    !hasExactKeys(transactionResult, ['kind', 'operationId', 'case']) ||
    (transactionResult.kind !== 'committed' && transactionResult.kind !== 'replayed') ||
    transactionResult.operationId !== operationSelector.operationId ||
    !isRecord(transactionResult.case)
  ) {
    return null
  }

  const reviewCase = transactionResult.case
  const expectedCaseKeys =
    reviewCase.state === 'under_review'
      ? ['id', 'reportId', 'state', 'reviewStartedByUserId', 'reviewStartedAt', 'revision']
      : [
          'id',
          'reportId',
          'state',
          'reviewStartedByUserId',
          'reviewStartedAt',
          'decisionId',
          'completedAt',
          'revision',
        ]
  if (!hasExactKeys(reviewCase, expectedCaseKeys)) return null

  const caseId = normalizedId(reviewCase.id)
  const resultReportId = normalizedId(reviewCase.reportId)
  const starterUserId = normalizedId(reviewCase.reviewStartedByUserId)
  if (
    !caseId ||
    !resultReportId ||
    !starterUserId ||
    resultReportId !== selectorReportId ||
    starterUserId !== actorUserId ||
    !validDate(reviewCase.reviewStartedAt)
  ) {
    return null
  }

  if (reviewCase.state === 'under_review') {
    if (reviewCase.revision !== 1) return null
  } else {
    const decisionId = normalizedId(reviewCase.decisionId)
    if (
      reviewCase.state !== 'review_completed' ||
      reviewCase.revision !== 2 ||
      !decisionId ||
      !validDate(reviewCase.completedAt) ||
      reviewCase.completedAt.valueOf() < reviewCase.reviewStartedAt.valueOf()
    ) {
      return null
    }
  }

  return Object.freeze({
    kind: 'begin_review' as const,
    operationId: transactionResult.operationId,
    reportId: resultReportId,
    actorUserId,
  })
}

const finalizeContext = (
  authenticatedActor: ReportReviewAuthorizationIdentity,
  operationSelector: unknown,
  transactionResult: unknown,
) => {
  if (
    !isRecord(operationSelector) ||
    !hasExactKeys(operationSelector, [
      'operationId',
      'reportId',
      'caseId',
      'expectedRevision',
      'conclusion',
      'rationale',
    ]) ||
    !validOperationId(operationSelector.operationId) ||
    !Number.isSafeInteger(operationSelector.expectedRevision) ||
    (operationSelector.expectedRevision as number) < 0
  ) {
    return null
  }

  const selectorReportId = normalizedId(operationSelector.reportId)
  const selectorCaseId = normalizedId(operationSelector.caseId)
  const actorUserId = normalizedId(authenticatedActor?._id)
  if (!selectorReportId || !selectorCaseId || !actorUserId) return null

  if (
    !isRecord(transactionResult) ||
    !hasExactKeys(transactionResult, ['kind', 'operationId', 'case', 'decision']) ||
    (transactionResult.kind !== 'committed' && transactionResult.kind !== 'replayed') ||
    transactionResult.operationId !== operationSelector.operationId ||
    !isRecord(transactionResult.case) ||
    !isRecord(transactionResult.decision)
  ) {
    return null
  }

  const reviewCase = transactionResult.case
  const decision = transactionResult.decision
  if (
    !hasExactKeys(reviewCase, [
      'id',
      'reportId',
      'state',
      'reviewStartedByUserId',
      'reviewStartedAt',
      'decisionId',
      'completedAt',
      'revision',
    ]) ||
    !hasExactKeys(decision, [
      'id',
      'caseId',
      'reportId',
      'conclusion',
      'rationale',
      'reviewStartedByUserId',
      'decidedByUserId',
      'decidedAt',
      'caseRevision',
    ])
  ) {
    return null
  }

  const resultCaseId = normalizedId(reviewCase.id)
  const resultReportId = normalizedId(reviewCase.reportId)
  const starterUserId = normalizedId(reviewCase.reviewStartedByUserId)
  const resultDecisionId = normalizedId(reviewCase.decisionId)
  const decisionId = normalizedId(decision.id)
  const decisionCaseId = normalizedId(decision.caseId)
  const decisionReportId = normalizedId(decision.reportId)
  const decisionStarterUserId = normalizedId(decision.reviewStartedByUserId)
  const deciderUserId = normalizedId(decision.decidedByUserId)
  if (
    !resultCaseId ||
    !resultReportId ||
    !starterUserId ||
    !resultDecisionId ||
    !decisionId ||
    !decisionCaseId ||
    !decisionReportId ||
    !decisionStarterUserId ||
    !deciderUserId ||
    resultCaseId !== selectorCaseId ||
    resultCaseId !== decisionCaseId ||
    resultReportId !== selectorReportId ||
    resultReportId !== decisionReportId ||
    resultDecisionId !== decisionId ||
    starterUserId !== decisionStarterUserId ||
    deciderUserId !== actorUserId ||
    reviewCase.state !== 'review_completed' ||
    reviewCase.revision !== decision.caseRevision ||
    reviewCase.revision !== (operationSelector.expectedRevision as number) + 1 ||
    !validDate(reviewCase.reviewStartedAt) ||
    !validDate(reviewCase.completedAt) ||
    !validDate(decision.decidedAt) ||
    !sameInstant(reviewCase.completedAt, decision.decidedAt) ||
    reviewCase.completedAt.valueOf() < reviewCase.reviewStartedAt.valueOf()
  ) {
    return null
  }

  const validatedDecision = validateFinalReviewDecision({
    conclusion: operationSelector.conclusion,
    rationale: operationSelector.rationale,
    reviewStartedByUserId: starterUserId,
    decidedByUserId: actorUserId,
  })
  if (
    !validatedDecision.ok ||
    validatedDecision.conclusion !== decision.conclusion ||
    validatedDecision.rationale !== decision.rationale
  ) {
    return null
  }

  return Object.freeze({
    kind: 'finalize_review' as const,
    operationId: transactionResult.operationId,
    reportId: resultReportId,
    caseId: resultCaseId,
    actorUserId,
    expectedRevision: operationSelector.expectedRevision as number,
    conclusion: validatedDecision.conclusion,
    rationale: validatedDecision.rationale,
  })
}

const createIntegration = (provider: EvidenceProviderPort): CasePersistenceEvidenceIntegration =>
  Object.freeze({
    async observeBegin(authenticatedActor, operationSelector, transactionResult) {
      let context
      try {
        context = beginContext(authenticatedActor, operationSelector, transactionResult)
      } catch {
        return unavailable('INVALID_CONTEXT')
      }
      if (!context) return unavailable('INVALID_CONTEXT')
      try {
        return await provider.read(context)
      } catch {
        return unavailable('SOURCE_UNAVAILABLE')
      }
    },
    async observeFinalize(authenticatedActor, operationSelector, transactionResult) {
      let context
      try {
        context = finalizeContext(authenticatedActor, operationSelector, transactionResult)
      } catch {
        return unavailable('INVALID_CONTEXT')
      }
      if (!context) return unavailable('INVALID_CONTEXT')
      try {
        return await provider.read(context)
      } catch {
        return unavailable('SOURCE_UNAVAILABLE')
      }
    },
  })

const concreteReader = createCasePersistenceEvidenceReader()
const concreteProvider = createCasePersistenceEvidenceProvider({ reader: concreteReader })

export const casePersistenceEvidenceIntegration = createIntegration(concreteProvider)

/** @internal Narrow construction seam for synthetic tests; production composition remains fixed. */
export const createCasePersistenceEvidenceIntegrationForSyntheticTest = (
  provider: EvidenceProviderPort,
) => createIntegration(provider)

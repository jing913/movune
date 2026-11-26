import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { assertCaseReviewAuthorized } from '../policies/caseReviewAuthorizationPolicy.js'
import {
  getAdminCaseDetail,
  listAdminCases,
  parseAdminCaseQueueQuery,
} from '../services/adminCaseReadService.js'
import {
  CaseTransactionServiceError,
  caseTransactionService,
  type BeginReviewResult,
  type FinalizeReviewInput,
  type FinalizeReviewResult,
  type ReviewCaseRecord,
} from '../services/caseTransactionService.js'
import { ApiProblem } from '../utils/messagingPolicy.js'
import {
  CaseEnforcementServiceError,
  caseEnforcementService,
  type CaseEnforcementResult,
} from '../services/caseEnforcementService.js'
import type { CaseEnforcementCommand } from '../policies/caseEnforcementPolicy.js'
import { COMMUNITY_GUIDELINE_CATALOG } from '../policies/communityGuidelineCatalog.js'
import { assertMemberEnforcementAuthorized } from '../policies/memberEnforcementAuthorizationPolicy.js'

type CaseParams = { reportId: string }

const BEGIN_REVIEW_BODY_KEYS = Object.freeze(['operationId'])
const FINALIZE_REVIEW_BODY_KEYS = Object.freeze([
  'operationId',
  'caseId',
  'expectedRevision',
  'conclusion',
  'rationale',
])
const ENFORCEMENT_BODY_KEYS = Object.freeze([
  'operationId',
  'reviewDecisionId',
  'decisionType',
  'reasonSummary',
])
const ENFORCEMENT_REASON_BODY_KEYS = Object.freeze([...ENFORCEMENT_BODY_KEYS, 'reasonCode'])
const ENFORCEMENT_GUIDELINE_BODY_KEYS = Object.freeze([
  ...ENFORCEMENT_BODY_KEYS,
  'reasonCode',
  'guidelineRuleId',
  'guidelineVersion',
])

const CASE_ENFORCEMENT_STATUS: Readonly<Record<CaseEnforcementServiceError['code'], number>> = {
  CASE_ENFORCEMENT_INPUT_INVALID: StatusCodes.BAD_REQUEST,
  CASE_ENFORCEMENT_SOURCE_NOT_FOUND: StatusCodes.NOT_FOUND,
  CASE_ENFORCEMENT_SOURCE_INVALID: StatusCodes.CONFLICT,
  CASE_ENFORCEMENT_ACTION_NOT_ALLOWED: StatusCodes.UNPROCESSABLE_ENTITY,
  CASE_ENFORCEMENT_GUIDELINE_INVALID: StatusCodes.BAD_REQUEST,
  CASE_ENFORCEMENT_ALREADY_RECORDED: StatusCodes.CONFLICT,
  CASE_ENFORCEMENT_OPERATION_ID_REUSED: StatusCodes.CONFLICT,
  CASE_ENFORCEMENT_POLICY_UNAVAILABLE: StatusCodes.SERVICE_UNAVAILABLE,
  CASE_ENFORCEMENT_TRANSACTION_UNAVAILABLE: StatusCodes.SERVICE_UNAVAILABLE,
  CASE_ENFORCEMENT_CONFLICT: StatusCodes.CONFLICT,
}

const CASE_TRANSACTION_STATUS: Readonly<Record<CaseTransactionServiceError['code'], number>> = {
  CASE_INPUT_INVALID: StatusCodes.BAD_REQUEST,
  CASE_REPORT_NOT_FOUND: StatusCodes.NOT_FOUND,
  CASE_INVALID_TRANSITION: StatusCodes.CONFLICT,
  CASE_STALE_REVISION: StatusCodes.CONFLICT,
  CASE_ALREADY_STARTED: StatusCodes.CONFLICT,
  CASE_ALREADY_FINALIZED: StatusCodes.CONFLICT,
  CASE_OPERATION_ID_REUSED: StatusCodes.CONFLICT,
  CASE_CAS_CONFLICT: StatusCodes.CONFLICT,
  CASE_DUPLICATE_KEY_CONFLICT: StatusCodes.CONFLICT,
  CASE_TRANSACTION_UNAVAILABLE: StatusCodes.SERVICE_UNAVAILABLE,
  CASE_OPERATION_UNCONFIRMED: StatusCodes.SERVICE_UNAVAILABLE,
  CASE_PERSISTENCE_INTEGRITY: StatusCodes.INTERNAL_SERVER_ERROR,
}

const invalidCaseInput = () =>
  new ApiProblem(StatusCodes.BAD_REQUEST, 'CASE_INPUT_INVALID', 'Case command input is invalid', {})

const invalidEnforcementInput = () =>
  new ApiProblem(
    StatusCodes.BAD_REQUEST,
    'CASE_ENFORCEMENT_INPUT_INVALID',
    'Enforcement command input is invalid',
    {},
  )

const requireExactBody = (body: unknown, keys: readonly string[]) => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalidCaseInput()
  const value = body as Record<string, unknown>
  const actual = Object.keys(value)
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw invalidCaseInput()
  }
  return value
}

const parseBeginReviewBody = (body: unknown) => {
  const value = requireExactBody(body, BEGIN_REVIEW_BODY_KEYS)
  if (typeof value.operationId !== 'string') throw invalidCaseInput()
  return { operationId: value.operationId }
}

const parseFinalizeReviewBody = (body: unknown): Omit<FinalizeReviewInput, 'reportId'> => {
  const value = requireExactBody(body, FINALIZE_REVIEW_BODY_KEYS)
  if (
    typeof value.operationId !== 'string' ||
    typeof value.caseId !== 'string' ||
    typeof value.expectedRevision !== 'number' ||
    typeof value.conclusion !== 'string' ||
    typeof value.rationale !== 'string'
  ) {
    throw invalidCaseInput()
  }
  return {
    operationId: value.operationId,
    caseId: value.caseId,
    expectedRevision: value.expectedRevision,
    conclusion: value.conclusion as FinalizeReviewInput['conclusion'],
    rationale: value.rationale,
  }
}

const parseEnforcementBody = (body: unknown): CaseEnforcementCommand => {
  let value: Record<string, unknown>
  try {
    try {
      try {
        value = requireExactBody(body, ENFORCEMENT_BODY_KEYS)
      } catch {
        value = requireExactBody(body, ENFORCEMENT_REASON_BODY_KEYS)
      }
    } catch {
      value = requireExactBody(body, ENFORCEMENT_GUIDELINE_BODY_KEYS)
    }
  } catch {
    throw invalidEnforcementInput()
  }
  if (
    typeof value.operationId !== 'string' ||
    typeof value.reviewDecisionId !== 'string' ||
    typeof value.decisionType !== 'string' ||
    typeof value.reasonSummary !== 'string'
  ) {
    throw invalidEnforcementInput()
  }
  if (
    (Object.hasOwn(value, 'reasonCode') && typeof value.reasonCode !== 'string') ||
    (Object.hasOwn(value, 'guidelineRuleId') &&
      (typeof value.guidelineRuleId !== 'string' || typeof value.guidelineVersion !== 'string'))
  ) {
    throw invalidEnforcementInput()
  }
  return value as CaseEnforcementCommand
}

const caseDto = (value: ReviewCaseRecord) => ({
  id: value.id,
  reportId: value.reportId,
  state: value.state,
  revision: value.revision,
  reviewStartedByUserId: value.reviewStartedByUserId,
  reviewStartedAt: value.reviewStartedAt.toISOString(),
  completedAt: value.completedAt?.toISOString() ?? null,
})

const beginReviewDto = (result: BeginReviewResult) => ({
  kind: result.kind,
  operationId: result.operationId,
  case: caseDto(result.case),
})

const finalizeReviewDto = (result: FinalizeReviewResult) => ({
  kind: result.kind,
  operationId: result.operationId,
  case: caseDto(result.case),
  decision: {
    id: result.decision.id,
    conclusion: result.decision.conclusion,
    rationale: result.decision.rationale,
    decidedByUserId: result.decision.decidedByUserId,
    decidedAt: result.decision.decidedAt.toISOString(),
    caseRevision: result.decision.caseRevision,
  },
})

const mapCaseTransactionError = (error: unknown) => {
  if (!(error instanceof CaseTransactionServiceError)) return error
  const details: Record<string, unknown> = {}
  if (error.operationId) details.operationId = error.operationId
  if (error.code === 'CASE_OPERATION_UNCONFIRMED') {
    details.retryWithSameOperationId = true
  }
  return new ApiProblem(CASE_TRANSACTION_STATUS[error.code], error.code, error.message, details)
}

const enforcementDto = (result: CaseEnforcementResult) => ({
  kind: result.kind,
  operationId: result.operationId,
  action: {
    ...result.action,
    effectiveAt: result.action.effectiveAt.toISOString(),
  },
})

const mapCaseEnforcementError = (error: unknown) => {
  if (!(error instanceof CaseEnforcementServiceError)) return error
  return new ApiProblem(
    CASE_ENFORCEMENT_STATUS[error.code],
    error.code,
    error.message,
    error.operationId ? { operationId: error.operationId } : {},
  )
}

export const listAdminCasesController = async (req: Request, res: Response, next: NextFunction) => {
  const evaluatedAt = new Date()
  try {
    await assertCaseReviewAuthorized(req.user, evaluatedAt)
    const query = parseAdminCaseQueueQuery(req.query)
    res.status(StatusCodes.OK).json(await listAdminCases(query))
  } catch (error) {
    next(error)
  }
}

export const getAdminCaseController = async (
  req: Request<CaseParams>,
  res: Response,
  next: NextFunction,
) => {
  const evaluatedAt = new Date()
  try {
    await assertCaseReviewAuthorized(req.user, evaluatedAt)
    res.status(StatusCodes.OK).json(await getAdminCaseDetail(req.params.reportId, evaluatedAt))
  } catch (error) {
    next(error)
  }
}

export const beginAdminCaseReviewController = async (
  authenticatedActor: Express.User,
  req: Request<CaseParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const body = parseBeginReviewBody(req.body)
    const result = await caseTransactionService.beginReview(authenticatedActor, {
      operationId: body.operationId,
      reportId: req.params.reportId,
    })
    res.status(StatusCodes.OK).json(beginReviewDto(result))
  } catch (error) {
    next(mapCaseTransactionError(error))
  }
}

export const finalizeAdminCaseReviewController = async (
  authenticatedActor: Express.User,
  req: Request<CaseParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const body = parseFinalizeReviewBody(req.body)
    const result = await caseTransactionService.finalizeReview(authenticatedActor, {
      ...body,
      reportId: req.params.reportId,
    })
    res.status(StatusCodes.OK).json(finalizeReviewDto(result))
  } catch (error) {
    next(mapCaseTransactionError(error))
  }
}

export const createAdminCaseEnforcementController = async (
  authenticatedActor: Express.User,
  req: Request<CaseParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const result = await caseEnforcementService.recordInitialDecision(
      authenticatedActor,
      req.params.reportId,
      parseEnforcementBody(req.body),
    )
    res.status(StatusCodes.OK).json(enforcementDto(result))
  } catch (error) {
    next(mapCaseEnforcementError(error))
  }
}

export const listAdminCaseEnforcementGuidelinesController = async (
  authenticatedActor: Express.User,
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  try {
    await assertMemberEnforcementAuthorized(authenticatedActor, new Date())
    res.status(StatusCodes.OK).json({ guidelines: COMMUNITY_GUIDELINE_CATALOG })
  } catch (error) {
    next(error)
  }
}

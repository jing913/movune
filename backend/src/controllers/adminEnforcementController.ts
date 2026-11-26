import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { assertMemberEnforcementAuthorized } from '../policies/memberEnforcementAuthorizationPolicy.js'
import {
  AccountEnforcementReversalCommandError,
  type AccountEnforcementReversalCommandErrorCode,
} from '../services/accountEnforcementReversalCommandService.js'
import { accountEnforcementReversalApplicationService } from '../services/accountEnforcementReversalApplicationService.js'
import { readAdminEnforcementDecisions } from '../services/adminEnforcementReadService.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

type DecisionParams = { decisionId: string }

const STATUS: Readonly<Record<AccountEnforcementReversalCommandErrorCode, number>> = {
  ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID: StatusCodes.BAD_REQUEST,
  ACCOUNT_ENFORCEMENT_REVERSAL_DECISION_NOT_FOUND: StatusCodes.NOT_FOUND,
  ACCOUNT_ENFORCEMENT_REVERSAL_DECISION_NOT_REVERSIBLE: StatusCodes.UNPROCESSABLE_ENTITY,
  ACCOUNT_ENFORCEMENT_PERMANENT_REVERSAL_BLOCKED: StatusCodes.FORBIDDEN,
  ACCOUNT_ENFORCEMENT_REVERSAL_PREDATES_DECISION: StatusCodes.CONFLICT,
  ACCOUNT_ENFORCEMENT_REVERSAL_ALREADY_RECORDED: StatusCodes.CONFLICT,
  ACCOUNT_ENFORCEMENT_REVERSAL_OPERATION_ID_REUSED: StatusCodes.CONFLICT,
  ACCOUNT_ENFORCEMENT_REVERSAL_CONFLICT: StatusCodes.CONFLICT,
  ACCOUNT_ENFORCEMENT_REVERSAL_TRANSACTION_UNAVAILABLE: StatusCodes.SERVICE_UNAVAILABLE,
  ACCOUNT_ENFORCEMENT_REVERSAL_OPERATION_UNCONFIRMED: StatusCodes.SERVICE_UNAVAILABLE,
}

const invalidInput = () =>
  new ApiProblem(
    StatusCodes.BAD_REQUEST,
    'ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID',
    'Reversal command input is invalid',
    {},
  )

const parseBody = (body: unknown) => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalidInput()
  const value = body as Record<string, unknown>
  const allowed = new Set(['operationId', 'reasonSummary', 'memberFacingReasonCode'])
  const keys = Object.keys(value)
  if (
    keys.some((key) => !allowed.has(key)) ||
    !Object.hasOwn(value, 'operationId') ||
    !Object.hasOwn(value, 'reasonSummary') ||
    typeof value.operationId !== 'string' ||
    typeof value.reasonSummary !== 'string' ||
    (Object.hasOwn(value, 'memberFacingReasonCode') &&
      typeof value.memberFacingReasonCode !== 'string')
  ) {
    throw invalidInput()
  }
  return value as {
    operationId: string
    reasonSummary: string
    memberFacingReasonCode?: 'warning_reversed_after_review_v1'
  }
}

const mapError = (error: unknown) => {
  if (!(error instanceof AccountEnforcementReversalCommandError)) return error
  const details: Record<string, unknown> = {}
  if (error.operationId) details.operationId = error.operationId
  if (error.code === 'ACCOUNT_ENFORCEMENT_REVERSAL_OPERATION_UNCONFIRMED') {
    details.retryWithSameOperationId = true
  }
  return new ApiProblem(STATUS[error.code], error.code, error.message, details)
}

export const listAdminEnforcementDecisionsController = async (
  actor: Express.User,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const evaluatedAt = new Date()
  try {
    await assertMemberEnforcementAuthorized(actor, evaluatedAt)
    const keys = Object.keys(req.query)
    if (
      keys.length !== 1 ||
      keys[0] !== 'targetUserId' ||
      typeof req.query.targetUserId !== 'string'
    ) {
      throw new ApiProblem(400, 'ADMIN_ENFORCEMENT_TARGET_INVALID', 'Target member id is invalid')
    }
    const result = await readAdminEnforcementDecisions(req.query.targetUserId, evaluatedAt)
    res.status(StatusCodes.OK).json({
      ...result,
      decisions: result.decisions.map((decision) => ({
        ...decision,
        effectiveAt: decision.effectiveAt.toISOString(),
        endsAt: decision.endsAt?.toISOString() ?? null,
        reversal: decision.reversal
          ? { ...decision.reversal, effectiveAt: decision.reversal.effectiveAt.toISOString() }
          : null,
      })),
    })
  } catch (error) {
    next(error)
  }
}

export const reverseAdminEnforcementDecisionController = async (
  actor: Express.User,
  req: Request<DecisionParams>,
  res: Response,
  next: NextFunction,
) => {
  try {
    const body = parseBody(req.body)
    const result = await accountEnforcementReversalApplicationService.reverseDecision(actor, {
      ...body,
      decisionId: req.params.decisionId,
    })
    res.status(StatusCodes.OK).json({
      ...result,
      reversal: { ...result.reversal, effectiveAt: result.reversal.effectiveAt.toISOString() },
    })
  } catch (error) {
    next(mapError(error))
  }
}

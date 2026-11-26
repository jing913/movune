import { isObjectIdOrHexString } from 'mongoose'
import {
  resolveAccountEnforcementReversalReason,
  type AccountEnforcementReversalReasonCode,
} from '../policies/accountEnforcementReversalReasonCatalog.js'
import {
  assertMemberEnforcementAuthorized,
  type MemberEnforcementAuthorizationIdentity,
} from '../policies/memberEnforcementAuthorizationPolicy.js'
import { ApiProblem } from '../utils/messagingPolicy.js'
import {
  AccountEnforcementReversalCommandError,
  accountEnforcementReversalCommandService,
  type AccountEnforcementReversalCommandResult,
} from './accountEnforcementReversalCommandService.js'
import { evaluateAccountEnforcementState } from './accountEnforcementService.js'
import {
  accountEnforcementReversalAuditService,
  type ReversalAuditIdentity,
} from './accountEnforcementReversalAuditService.js'

export type AdminEnforcementReversalInput = Readonly<{
  operationId: string
  decisionId: string
  reasonSummary: string
  memberFacingReasonCode?: AccountEnforcementReversalReasonCode
}>

export type ReversalApplicationDependencies = Readonly<{
  authorize?: (actor: MemberEnforcementAuthorizationIdentity, evaluatedAt: Date) => Promise<void>
  now?: () => Date
  audit?: typeof accountEnforcementReversalAuditService
  reverse?: (
    actor: MemberEnforcementAuthorizationIdentity,
    input: unknown,
  ) => Promise<AccountEnforcementReversalCommandResult>
}>

const actorId = (actor: MemberEnforcementAuthorizationIdentity) => {
  const value = actor?._id?.toString()
  if (!value || !isObjectIdOrHexString(value)) {
    throw new ApiProblem(
      400,
      'ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID',
      'Actor is invalid',
    )
  }
  return value
}

const errorCode = (error: unknown) =>
  error instanceof AccountEnforcementReversalCommandError || error instanceof ApiProblem
    ? error.code
    : 'ACCOUNT_ENFORCEMENT_REVERSAL_UNEXPECTED_FAILURE'

export const createAccountEnforcementReversalApplicationService = (
  dependencies: ReversalApplicationDependencies = {},
) => {
  const authorize =
    dependencies.authorize ??
    ((actor, evaluatedAt) =>
      assertMemberEnforcementAuthorized(actor, evaluatedAt, evaluateAccountEnforcementState))
  const now = dependencies.now ?? (() => new Date())
  const audit = dependencies.audit ?? accountEnforcementReversalAuditService
  const reverse =
    dependencies.reverse ??
    ((actor, input) => accountEnforcementReversalCommandService.reverseDecision(actor, input))

  return {
    async reverseDecision(
      actor: MemberEnforcementAuthorizationIdentity,
      input: AdminEnforcementReversalInput,
    ) {
      const identity: ReversalAuditIdentity = {
        actorUserId: actorId(actor),
        decisionId: input.decisionId,
        operationId: input.operationId,
      }
      const attemptId = await audit.start(identity)

      try {
        await authorize(actor, now())
      } catch (error) {
        await audit.terminal(identity, attemptId, 'denied', errorCode(error))
        throw error
      }

      const publicReason =
        input.memberFacingReasonCode === undefined
          ? null
          : resolveAccountEnforcementReversalReason(input.memberFacingReasonCode)
      if (input.memberFacingReasonCode !== undefined && !publicReason) {
        const error = new ApiProblem(
          400,
          'ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID',
          'Member-facing reversal reason is invalid',
        )
        await audit.terminal(identity, attemptId, 'failed', error.code)
        throw error
      }

      try {
        return await reverse(actor, {
          operationId: input.operationId,
          decisionId: input.decisionId,
          reasonSummary: input.reasonSummary,
          ...(publicReason ? { memberFacingReasonSummary: publicReason.summary } : {}),
        })
      } catch (error) {
        const code = errorCode(error)
        if (
          error instanceof AccountEnforcementReversalCommandError &&
          error.code === 'ACCOUNT_ENFORCEMENT_REVERSAL_OPERATION_UNCONFIRMED'
        ) {
          try {
            await audit.terminal(identity, attemptId, 'unconfirmed', code)
          } catch {
            // The authoritative unknown-commit response must not be replaced by an audit error.
          }
          throw error
        }
        const terminalType =
          error instanceof ApiProblem && error.status === 403 ? 'denied' : 'failed'
        await audit.terminal(identity, attemptId, terminalType, code)
        throw error
      }
    },
  }
}

export const accountEnforcementReversalApplicationService =
  createAccountEnforcementReversalApplicationService()

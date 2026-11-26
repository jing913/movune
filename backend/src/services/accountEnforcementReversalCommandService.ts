import { createHash } from 'node:crypto'
import mongoose, { Types, isObjectIdOrHexString, type ClientSession } from 'mongoose'
import { AccountEnforcementAction } from '../models/accountEnforcementActionModel.js'
import {
  assertMemberEnforcementAuthorized,
  type MemberEnforcementAuthorizationIdentity,
} from '../policies/memberEnforcementAuthorizationPolicy.js'
import {
  ENFORCEMENT_REASON_SUMMARY_MAX_LENGTH,
  type AccountEnforcementDecisionType,
} from '../utils/accountEnforcementPolicy.js'
import { ApiProblem } from '../utils/messagingPolicy.js'
import { CASE_TRANSACTION_OPTIONS } from './caseTransactionService.js'
import { evaluateAccountEnforcementState } from './accountEnforcementService.js'

export const ACCOUNT_ENFORCEMENT_REVERSAL_REASON_CODE = 'admin.reversal' as const

export type AccountEnforcementReversalCommand = Readonly<{
  operationId: string
  decisionId: string
  reasonSummary: string
  memberFacingReasonSummary?: string
}>

export type AccountEnforcementReversalCommandErrorCode =
  | 'ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID'
  | 'ACCOUNT_ENFORCEMENT_REVERSAL_DECISION_NOT_FOUND'
  | 'ACCOUNT_ENFORCEMENT_REVERSAL_DECISION_NOT_REVERSIBLE'
  | 'ACCOUNT_ENFORCEMENT_PERMANENT_REVERSAL_BLOCKED'
  | 'ACCOUNT_ENFORCEMENT_REVERSAL_PREDATES_DECISION'
  | 'ACCOUNT_ENFORCEMENT_REVERSAL_ALREADY_RECORDED'
  | 'ACCOUNT_ENFORCEMENT_REVERSAL_OPERATION_ID_REUSED'
  | 'ACCOUNT_ENFORCEMENT_REVERSAL_CONFLICT'
  | 'ACCOUNT_ENFORCEMENT_REVERSAL_TRANSACTION_UNAVAILABLE'
  | 'ACCOUNT_ENFORCEMENT_REVERSAL_OPERATION_UNCONFIRMED'

export class AccountEnforcementReversalCommandError extends Error {
  constructor(
    public readonly code: AccountEnforcementReversalCommandErrorCode,
    message: string,
    public readonly operationId?: string,
  ) {
    super(message)
    this.name = 'AccountEnforcementReversalCommandError'
  }
}

export type AccountEnforcementReversalCommandResult = Readonly<{
  kind: 'committed' | 'replayed'
  operationId: string
  reversal: Readonly<{
    id: string
    targetUserId: string
    performedByUserId: string
    reversesDecisionId: string
    effectiveAt: Date
    reasonCode: typeof ACCOUNT_ENFORCEMENT_REVERSAL_REASON_CODE
    reasonSummary: string
    memberFacingReasonSummary?: string
  }>
}>

type TransactionRunner = <Result>(
  operation: (session: ClientSession) => Promise<Result>,
) => Promise<Result>

type PersistedAction = Readonly<{
  _id?: unknown
  targetUserId?: unknown
  recordType?: unknown
  decisionType?: unknown
  effectiveAt?: unknown
  performedByUserId?: unknown
  operationId?: unknown
  commandDigest?: unknown
  reasonCode?: unknown
  reasonSummary?: unknown
  memberFacingReasonSummary?: unknown
  reversesDecisionId?: unknown
}>

type ConsistentReversalAction = Readonly<{
  _id: string | Readonly<{ toString(): string }>
  targetUserId: string | Readonly<{ toString(): string }>
  recordType: 'reversal'
  effectiveAt: Date
  performedByUserId: string | Readonly<{ toString(): string }>
  operationId: string
  commandDigest: string
  reasonCode: typeof ACCOUNT_ENFORCEMENT_REVERSAL_REASON_CODE
  reasonSummary: string
  memberFacingReasonSummary?: string
  reversesDecisionId: string | Readonly<{ toString(): string }>
}>

export type AccountEnforcementReversalCommandRepository = Readonly<{
  findDecisionById(decisionId: string, session: ClientSession): Promise<PersistedAction | null>
  findActionByOperationId(
    operationId: string,
    session: ClientSession,
  ): Promise<PersistedAction | null>
  findReversalByDecisionId(
    decisionId: string,
    session: ClientSession,
  ): Promise<PersistedAction | null>
  createReversal(
    value: Record<string, unknown>,
    session: ClientSession,
  ): Promise<PersistedAction | null>
}>

export type AccountEnforcementReversalCommandDependencies = Readonly<{
  authorize?: (
    actor: MemberEnforcementAuthorizationIdentity,
    evaluatedAt: Date,
    session: ClientSession,
  ) => Promise<void>
  transactionRunner?: TransactionRunner
  now?: () => Date
  repository?: AccountEnforcementReversalCommandRepository
}>

const fail = (
  code: AccountEnforcementReversalCommandErrorCode,
  message: string,
  operationId?: string,
): never => {
  throw new AccountEnforcementReversalCommandError(code, message, operationId)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const validReason = (value: unknown): value is string =>
  typeof value === 'string' &&
  value === value.trim() &&
  value.length > 0 &&
  [...value].length <= ENFORCEMENT_REASON_SUMMARY_MAX_LENGTH

const requireOperationId = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[a-z0-9][a-z0-9._:-]*$/.test(value)
  ) {
    return fail(
      'ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID',
      'Reversal operationId is invalid',
    )
  }
  return value
}

const requireId = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !isObjectIdOrHexString(value)) {
    return fail('ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID', `${field} is invalid`)
  }
  return new Types.ObjectId(value).toString()
}

const requireActorId = (actor: unknown) => {
  if (!isRecord(actor) || (!Object.hasOwn(actor, '_id') && !(actor instanceof mongoose.Model))) {
    return fail(
      'ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID',
      'Authenticated actor is invalid',
    )
  }
  const value = actor._id
  if (typeof value !== 'string' && (!isRecord(value) || typeof value.toString !== 'function')) {
    return fail(
      'ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID',
      'Authenticated actor is invalid',
    )
  }
  return requireId(value.toString(), 'actor')
}

const validateInput = (value: unknown) => {
  if (!isRecord(value)) {
    return fail(
      'ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID',
      'Reversal command input is invalid',
    )
  }
  const expected = [
    'decisionId',
    ...(Object.hasOwn(value, 'memberFacingReasonSummary') ? ['memberFacingReasonSummary'] : []),
    'operationId',
    'reasonSummary',
  ].sort()
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return fail(
      'ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID',
      'Reversal command input is invalid',
    )
  }
  if (
    !validReason(value.reasonSummary) ||
    (Object.hasOwn(value, 'memberFacingReasonSummary') &&
      !validReason(value.memberFacingReasonSummary))
  ) {
    return fail('ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID', 'Reversal reason is invalid')
  }
  return {
    operationId: requireOperationId(value.operationId),
    decisionId: requireId(value.decisionId, 'decisionId'),
    reasonSummary: value.reasonSummary,
    ...(value.memberFacingReasonSummary !== undefined
      ? { memberFacingReasonSummary: value.memberFacingReasonSummary }
      : {}),
  } as AccountEnforcementReversalCommand
}

export const deriveAccountEnforcementReversalCommandDigest = (
  actorId: string,
  input: AccountEnforcementReversalCommand,
) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        'account-enforcement-reversal-command-v1',
        actorId,
        input.decisionId,
        input.reasonSummary,
        input.memberFacingReasonSummary ?? null,
      ]),
      'utf8',
    )
    .digest('hex')

const mongooseRepository: AccountEnforcementReversalCommandRepository = {
  findDecisionById: async (decisionId, session) =>
    (await AccountEnforcementAction.findById(decisionId)
      .session(session)
      .lean()) as PersistedAction | null,
  findActionByOperationId: async (operationId, session) =>
    (await AccountEnforcementAction.findOne({ operationId })
      .session(session)
      .lean()) as PersistedAction | null,
  findReversalByDecisionId: async (decisionId, session) =>
    (await AccountEnforcementAction.findOne({
      recordType: 'reversal',
      reversesDecisionId: decisionId,
    })
      .session(session)
      .lean()) as PersistedAction | null,
  async createReversal(value, session) {
    const [created] = await AccountEnforcementAction.create([value], { session })
    return created ?? null
  },
}

const defaultTransactionRunner: TransactionRunner = (operation) =>
  mongoose.connection.transaction(operation, CASE_TRANSACTION_OPTIONS)

const isDuplicateKeyError = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 11000

const hasErrorLabel = (error: unknown, label: string) =>
  typeof error === 'object' &&
  error !== null &&
  'hasErrorLabel' in error &&
  typeof error.hasErrorLabel === 'function' &&
  error.hasErrorLabel(label)

const toResult = (
  kind: 'committed' | 'replayed',
  action: ConsistentReversalAction,
): AccountEnforcementReversalCommandResult => ({
  kind,
  operationId: action.operationId,
  reversal: {
    id: action._id.toString(),
    targetUserId: action.targetUserId.toString(),
    performedByUserId: action.performedByUserId.toString(),
    reversesDecisionId: action.reversesDecisionId.toString(),
    effectiveAt: new Date(action.effectiveAt),
    reasonCode: ACCOUNT_ENFORCEMENT_REVERSAL_REASON_CODE,
    reasonSummary: action.reasonSummary,
    ...(action.memberFacingReasonSummary !== undefined
      ? { memberFacingReasonSummary: action.memberFacingReasonSummary }
      : {}),
  },
})

const isConsistentReversal = (
  action: PersistedAction | null,
  input: AccountEnforcementReversalCommand,
  actorId: string,
  targetUserId: string,
  commandDigest: string,
): action is ConsistentReversalAction =>
  action !== null &&
  action.recordType === 'reversal' &&
  isObjectIdOrHexString(action._id) &&
  action.operationId === input.operationId &&
  action.commandDigest === commandDigest &&
  action.reversesDecisionId?.toString() === input.decisionId &&
  action.performedByUserId?.toString() === actorId &&
  action.targetUserId?.toString() === targetUserId &&
  action.effectiveAt instanceof Date &&
  Number.isFinite(action.effectiveAt.valueOf()) &&
  action.reasonCode === ACCOUNT_ENFORCEMENT_REVERSAL_REASON_CODE &&
  action.reasonSummary === input.reasonSummary &&
  action.memberFacingReasonSummary === input.memberFacingReasonSummary

const decisionType = (
  decision: PersistedAction | null,
): AccountEnforcementDecisionType | undefined => {
  if (decision?.recordType !== 'decision') return undefined
  switch (decision.decisionType) {
    case 'no_action':
    case 'formal_warning':
    case 'temporary_suspension':
    case 'permanent_deactivation':
      return decision.decisionType
    default:
      return undefined
  }
}

export const createAccountEnforcementReversalCommandService = (
  dependencies: AccountEnforcementReversalCommandDependencies = {},
) => {
  const repository = dependencies.repository ?? mongooseRepository
  const runTransaction = dependencies.transactionRunner ?? defaultTransactionRunner
  const now = dependencies.now ?? (() => new Date())
  const authorize =
    dependencies.authorize ??
    ((actor, evaluatedAt, session) =>
      assertMemberEnforcementAuthorized(actor, evaluatedAt, (userId, at) =>
        evaluateAccountEnforcementState(userId, at, { session }),
      ))

  return {
    async reverseDecision(
      actor: MemberEnforcementAuthorizationIdentity,
      rawInput: unknown,
    ): Promise<AccountEnforcementReversalCommandResult> {
      const input = validateInput(rawInput)
      const actorId = requireActorId(actor)
      const commandDigest = deriveAccountEnforcementReversalCommandDigest(actorId, input)

      try {
        return await runTransaction(async (session) => {
          const evaluatedAt = now()
          await authorize(actor, evaluatedAt, session)

          const decision = await repository.findDecisionById(input.decisionId, session)
          const sourceType = decisionType(decision)
          if (!decision || !sourceType) {
            return fail(
              'ACCOUNT_ENFORCEMENT_REVERSAL_DECISION_NOT_FOUND',
              'The referenced enforcement decision does not exist',
              input.operationId,
            )
          }
          if (sourceType === 'permanent_deactivation') {
            return fail(
              'ACCOUNT_ENFORCEMENT_PERMANENT_REVERSAL_BLOCKED',
              'Permanent Deactivation reversal requires a separately approved elevated flow',
              input.operationId,
            )
          }
          if (sourceType !== 'formal_warning' && sourceType !== 'temporary_suspension') {
            return fail(
              'ACCOUNT_ENFORCEMENT_REVERSAL_DECISION_NOT_REVERSIBLE',
              'The referenced decision is not reversible in this command foundation',
              input.operationId,
            )
          }
          if (sourceType === 'formal_warning' && !validReason(input.memberFacingReasonSummary)) {
            return fail(
              'ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID',
              'A Formal Warning reversal requires an approved member-facing reason',
              input.operationId,
            )
          }
          if (
            sourceType === 'temporary_suspension' &&
            input.memberFacingReasonSummary !== undefined
          ) {
            return fail(
              'ACCOUNT_ENFORCEMENT_REVERSAL_COMMAND_INPUT_INVALID',
              'A Temporary Suspension reversal cannot include a member-facing reason',
              input.operationId,
            )
          }

          const targetUserId = decision.targetUserId?.toString()
          if (typeof targetUserId !== 'string' || !isObjectIdOrHexString(targetUserId)) {
            return fail(
              'ACCOUNT_ENFORCEMENT_REVERSAL_CONFLICT',
              'The referenced decision target is invalid',
              input.operationId,
            )
          }

          const priorOperation = await repository.findActionByOperationId(
            input.operationId,
            session,
          )
          if (priorOperation) {
            if (priorOperation.commandDigest !== commandDigest) {
              return fail(
                'ACCOUNT_ENFORCEMENT_REVERSAL_OPERATION_ID_REUSED',
                'operationId was already used for a different command',
                input.operationId,
              )
            }
            if (
              !isConsistentReversal(priorOperation, input, actorId, targetUserId, commandDigest)
            ) {
              return fail(
                'ACCOUNT_ENFORCEMENT_REVERSAL_CONFLICT',
                'Persisted reversal replay state is inconsistent',
                input.operationId,
              )
            }
            return toResult('replayed', priorOperation)
          }

          if (await repository.findReversalByDecisionId(input.decisionId, session)) {
            return fail(
              'ACCOUNT_ENFORCEMENT_REVERSAL_ALREADY_RECORDED',
              'The referenced decision already has a reversal',
              input.operationId,
            )
          }
          if (!(evaluatedAt instanceof Date) || !Number.isFinite(evaluatedAt.valueOf())) {
            return fail(
              'ACCOUNT_ENFORCEMENT_REVERSAL_TRANSACTION_UNAVAILABLE',
              'The authoritative reversal time is unavailable',
              input.operationId,
            )
          }
          if (!(decision.effectiveAt instanceof Date) || evaluatedAt < decision.effectiveAt) {
            return fail(
              'ACCOUNT_ENFORCEMENT_REVERSAL_PREDATES_DECISION',
              'A reversal cannot predate its decision',
              input.operationId,
            )
          }

          const created = await repository.createReversal(
            {
              targetUserId,
              recordType: 'reversal',
              effectiveAt: evaluatedAt,
              performedByUserId: actorId,
              operationId: input.operationId,
              commandDigest,
              reasonCode: ACCOUNT_ENFORCEMENT_REVERSAL_REASON_CODE,
              reasonSummary: input.reasonSummary,
              ...(input.memberFacingReasonSummary !== undefined
                ? { memberFacingReasonSummary: input.memberFacingReasonSummary }
                : {}),
              reversesDecisionId: input.decisionId,
            },
            session,
          )
          if (!isConsistentReversal(created, input, actorId, targetUserId, commandDigest)) {
            return fail(
              'ACCOUNT_ENFORCEMENT_REVERSAL_CONFLICT',
              'Reversal persistence returned an inconsistent record',
              input.operationId,
            )
          }
          return toResult('committed', created)
        })
      } catch (error) {
        if (
          error instanceof AccountEnforcementReversalCommandError ||
          error instanceof ApiProblem
        ) {
          throw error
        }
        if (isDuplicateKeyError(error)) {
          return fail(
            'ACCOUNT_ENFORCEMENT_REVERSAL_CONFLICT',
            'A concurrent reversal command conflicted',
            input.operationId,
          )
        }
        if (hasErrorLabel(error, 'UnknownTransactionCommitResult')) {
          return fail(
            'ACCOUNT_ENFORCEMENT_REVERSAL_OPERATION_UNCONFIRMED',
            'The commit outcome is unknown; retry with the same operationId',
            input.operationId,
          )
        }
        return fail(
          'ACCOUNT_ENFORCEMENT_REVERSAL_TRANSACTION_UNAVAILABLE',
          'The reversal transaction did not complete',
          input.operationId,
        )
      }
    },
  }
}

export const accountEnforcementReversalCommandService =
  createAccountEnforcementReversalCommandService()

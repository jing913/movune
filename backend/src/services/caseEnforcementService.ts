import { createHash } from 'node:crypto'
import mongoose, { Types, isObjectIdOrHexString, type ClientSession } from 'mongoose'
import {
  AccountEnforcementAction,
  STAGE_B_MEMBER_NOTICE_PROVENANCE,
} from '../models/accountEnforcementActionModel.js'
import { FinalReviewDecision } from '../models/finalReviewDecisionModel.js'
import { Report } from '../models/reportModel.js'
import { ReviewCase } from '../models/reviewCaseModel.js'
import {
  assertMemberEnforcementAuthorized,
  type MemberEnforcementAuthorizationIdentity,
} from '../policies/memberEnforcementAuthorizationPolicy.js'
import {
  isCaseEnforcementDecisionType,
  isConclusionActionAllowed,
  validEnforcementGuidelineReference,
  validEnforcementReasonCode,
  validMemberFacingReason,
  type CaseEnforcementCommand,
  type CaseEnforcementDecisionType,
} from '../policies/caseEnforcementPolicy.js'
import type { FinalReviewConclusion } from '../policies/caseLifecyclePolicy.js'
import {
  resolveCommunityGuideline,
  type RequestedCommunityGuideline,
} from '../policies/communityGuidelineCatalog.js'
import { CASE_TRANSACTION_OPTIONS } from './caseTransactionService.js'
import { evaluateAccountEnforcementState } from './accountEnforcementService.js'

export type EnforcementGuidelineReference = Readonly<{
  reasonCode: string
  guidelineRuleId: string
  guidelineVersion: string
}>

export type EnforcementGuidelineResolver = (
  conclusion: FinalReviewConclusion,
  decisionType: CaseEnforcementDecisionType,
  requested: RequestedCommunityGuideline,
) => EnforcementGuidelineReference | null | undefined

export type CaseEnforcementErrorCode =
  | 'CASE_ENFORCEMENT_INPUT_INVALID'
  | 'CASE_ENFORCEMENT_SOURCE_NOT_FOUND'
  | 'CASE_ENFORCEMENT_SOURCE_INVALID'
  | 'CASE_ENFORCEMENT_ACTION_NOT_ALLOWED'
  | 'CASE_ENFORCEMENT_GUIDELINE_INVALID'
  | 'CASE_ENFORCEMENT_ALREADY_RECORDED'
  | 'CASE_ENFORCEMENT_OPERATION_ID_REUSED'
  | 'CASE_ENFORCEMENT_POLICY_UNAVAILABLE'
  | 'CASE_ENFORCEMENT_TRANSACTION_UNAVAILABLE'
  | 'CASE_ENFORCEMENT_CONFLICT'

export class CaseEnforcementServiceError extends Error {
  constructor(
    public readonly code: CaseEnforcementErrorCode,
    message: string,
    public readonly operationId?: string,
  ) {
    super(message)
    this.name = 'CaseEnforcementServiceError'
  }
}

export type CaseEnforcementResult = Readonly<{
  kind: 'committed' | 'replayed'
  operationId: string
  action: Readonly<{
    id: string
    reviewDecisionId: string
    targetUserId: string
    decisionType: CaseEnforcementDecisionType
    effectiveAt: Date
    performedByUserId: string
    reasonCode?: string
    reasonSummary: string
    guidelineRuleId?: string
    guidelineVersion?: string
  }>
}>

type TransactionRunner = <Result>(
  operation: (session: ClientSession) => Promise<Result>,
) => Promise<Result>

export type CaseEnforcementRepository = Readonly<{
  findActionByOperationId(operationId: string, session: ClientSession): Promise<any | null>
  findActionByReviewDecisionId(
    reviewDecisionId: string,
    session: ClientSession,
  ): Promise<any | null>
  findReviewDecision(reviewDecisionId: string, session: ClientSession): Promise<any | null>
  findReviewCase(caseId: string, session: ClientSession): Promise<any | null>
  findReport(reportId: string, session: ClientSession): Promise<any | null>
  createAction(value: Record<string, unknown>, session: ClientSession): Promise<any>
}>

export type CaseEnforcementDependencies = Readonly<{
  resolveGuideline?: EnforcementGuidelineResolver
  authorize?: (
    actor: MemberEnforcementAuthorizationIdentity,
    evaluatedAt: Date,
    session: ClientSession,
  ) => Promise<void>
  transactionRunner?: TransactionRunner
  now?: () => Date
  repository?: CaseEnforcementRepository
}>

const fail = (code: CaseEnforcementErrorCode, message: string, operationId?: string): never => {
  throw new CaseEnforcementServiceError(code, message, operationId)
}

const requireId = (value: unknown) => {
  if (typeof value !== 'string' || !isObjectIdOrHexString(value)) {
    return fail('CASE_ENFORCEMENT_INPUT_INVALID', 'Enforcement command id is invalid')
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
    return fail('CASE_ENFORCEMENT_INPUT_INVALID', 'operationId is invalid')
  }
  return value
}

const validateInput = (input: CaseEnforcementCommand) => {
  const operationId = requireOperationId(input.operationId)
  const reviewDecisionId = requireId(input.reviewDecisionId)
  if (
    !isCaseEnforcementDecisionType(input.decisionType) ||
    !validMemberFacingReason(input.reasonSummary)
  ) {
    return fail('CASE_ENFORCEMENT_INPUT_INVALID', 'Enforcement command input is invalid')
  }
  const hasReasonCode = input.reasonCode !== undefined
  const hasGuidelineRule = input.guidelineRuleId !== undefined
  const hasGuidelineVersion = input.guidelineVersion !== undefined
  const hasGuidelinePair = hasGuidelineRule && hasGuidelineVersion
  if (
    (hasReasonCode && !validEnforcementReasonCode(input.reasonCode)) ||
    hasGuidelineRule !== hasGuidelineVersion ||
    (hasGuidelinePair &&
      (!hasReasonCode ||
        !validEnforcementGuidelineReference({
          reasonCode: input.reasonCode,
          guidelineRuleId: input.guidelineRuleId,
          guidelineVersion: input.guidelineVersion,
        })))
  ) {
    return fail('CASE_ENFORCEMENT_GUIDELINE_INVALID', 'Guideline selection is invalid')
  }
  if (input.decisionType === 'formal_warning' && (!hasReasonCode || !hasGuidelinePair)) {
    return fail('CASE_ENFORCEMENT_GUIDELINE_INVALID', 'Formal Warning requires a guideline')
  }
  return { ...input, operationId, reviewDecisionId }
}

const digestCommand = (
  reportId: string,
  actorId: string,
  input: ReturnType<typeof validateInput>,
) => {
  const base = [
    input.guidelineRuleId
      ? 'case-enforcement-command-v2'
      : input.reasonCode
        ? 'case-enforcement-command-v1-reason'
        : 'case-enforcement-command-v1',
    reportId,
    input.reviewDecisionId,
    actorId,
    input.decisionType,
    input.reasonSummary,
  ]
  if (input.guidelineRuleId) {
    base.push(input.reasonCode!, input.guidelineRuleId, input.guidelineVersion!)
  } else if (input.reasonCode) {
    base.push(input.reasonCode)
  }
  return createHash('sha256').update(JSON.stringify(base), 'utf8').digest('hex')
}

const defaultTransactionRunner: TransactionRunner = async (operation) => {
  const session = await mongoose.startSession()
  try {
    let result: Awaited<ReturnType<typeof operation>> | undefined
    await session.withTransaction(async () => {
      result = await operation(session)
    }, CASE_TRANSACTION_OPTIONS)
    if (result === undefined) {
      return fail('CASE_ENFORCEMENT_TRANSACTION_UNAVAILABLE', 'Transaction produced no result')
    }
    return result
  } catch (error) {
    if (error instanceof CaseEnforcementServiceError) throw error
    throw new CaseEnforcementServiceError(
      'CASE_ENFORCEMENT_TRANSACTION_UNAVAILABLE',
      'Enforcement transaction could not be confirmed',
    )
  } finally {
    await session.endSession()
  }
}

const toResult = (kind: 'committed' | 'replayed', action: any): CaseEnforcementResult => ({
  kind,
  operationId: action.operationId,
  action: {
    id: action._id.toString(),
    reviewDecisionId: action.reviewDecisionId.toString(),
    targetUserId: action.targetUserId.toString(),
    decisionType: action.decisionType,
    effectiveAt: new Date(action.effectiveAt),
    performedByUserId: action.performedByUserId.toString(),
    ...(action.reasonCode ? { reasonCode: action.reasonCode } : {}),
    reasonSummary: action.reasonSummary,
    ...(action.guidelineRuleId ? { guidelineRuleId: action.guidelineRuleId } : {}),
    ...(action.guidelineVersion ? { guidelineVersion: action.guidelineVersion } : {}),
  },
})

const mongooseRepository: CaseEnforcementRepository = {
  findActionByOperationId: (operationId, session) =>
    AccountEnforcementAction.findOne({ operationId }).session(session).lean(),
  findActionByReviewDecisionId: (reviewDecisionId, session) =>
    AccountEnforcementAction.findOne({ reviewDecisionId }).session(session).lean(),
  findReviewDecision: (reviewDecisionId, session) =>
    FinalReviewDecision.findById(reviewDecisionId).session(session).lean(),
  findReviewCase: (caseId, session) => ReviewCase.findById(caseId).session(session).lean(),
  findReport: (reportId, session) =>
    Report.findById(reportId).session(session).select('reportedUserId').lean(),
  async createAction(value, session) {
    const [created] = await AccountEnforcementAction.create([value], { session })
    return created ?? null
  },
}

export const createCaseEnforcementService = (dependencies: CaseEnforcementDependencies = {}) => {
  const authorize =
    dependencies.authorize ??
    ((actor, evaluatedAt, session) =>
      assertMemberEnforcementAuthorized(actor, evaluatedAt, (userId, at) =>
        evaluateAccountEnforcementState(userId, at, { session }),
      ))
  const runTransaction = dependencies.transactionRunner ?? defaultTransactionRunner
  const now = dependencies.now ?? (() => new Date())
  const resolveGuideline =
    dependencies.resolveGuideline ??
    ((_conclusion, _decisionType, requested) => resolveCommunityGuideline(requested))
  const repository = dependencies.repository ?? mongooseRepository

  return {
    async recordInitialDecision(
      actor: MemberEnforcementAuthorizationIdentity,
      reportIdValue: string,
      rawInput: CaseEnforcementCommand,
    ): Promise<CaseEnforcementResult> {
      const evaluatedAt = now()
      const reportId = requireId(reportIdValue)
      const input = validateInput(rawInput)
      const actorId = requireId(actor._id.toString())
      const commandDigest = digestCommand(reportId, actorId, input)

      return runTransaction(async (session) => {
        await authorize(actor, evaluatedAt, session)
        const replay = await repository.findActionByOperationId(input.operationId, session)
        if (replay) {
          if (replay.commandDigest !== commandDigest) {
            return fail(
              'CASE_ENFORCEMENT_OPERATION_ID_REUSED',
              'operationId was already used for a different command',
              input.operationId,
            )
          }
          return toResult('replayed', replay)
        }

        const decision = await repository.findReviewDecision(input.reviewDecisionId, session)
        if (!decision) {
          return fail('CASE_ENFORCEMENT_SOURCE_NOT_FOUND', 'Review Decision was not found')
        }
        if (decision.reportId.toString() !== reportId) {
          return fail(
            'CASE_ENFORCEMENT_SOURCE_INVALID',
            'Review Decision does not belong to Report',
          )
        }
        const reviewCase = await repository.findReviewCase(decision.caseId.toString(), session)
        const report = await repository.findReport(reportId, session)
        if (
          !reviewCase ||
          reviewCase.state !== 'review_completed' ||
          reviewCase.reportId.toString() !== reportId ||
          reviewCase.decisionId?.toString() !== input.reviewDecisionId ||
          !report
        ) {
          return fail('CASE_ENFORCEMENT_SOURCE_INVALID', 'Review Decision source is incomplete')
        }
        if (!isConclusionActionAllowed(decision.conclusion, input.decisionType)) {
          return fail(
            'CASE_ENFORCEMENT_ACTION_NOT_ALLOWED',
            'Enforcement action is not allowed for the Review conclusion',
          )
        }
        const requestedGuideline = input.guidelineRuleId
          ? {
              reasonCode: input.reasonCode!,
              guidelineRuleId: input.guidelineRuleId,
              guidelineVersion: input.guidelineVersion!,
            }
          : null
        const guideline = requestedGuideline
          ? resolveGuideline(decision.conclusion, input.decisionType, requestedGuideline)
          : null
        if (
          guideline === undefined ||
          (guideline !== null &&
            (!validEnforcementGuidelineReference(guideline) ||
              !requestedGuideline ||
              guideline.reasonCode !== requestedGuideline.reasonCode ||
              guideline.guidelineRuleId !== requestedGuideline.guidelineRuleId ||
              guideline.guidelineVersion !== requestedGuideline.guidelineVersion))
        ) {
          return fail(
            'CASE_ENFORCEMENT_POLICY_UNAVAILABLE',
            'Approved enforcement guideline and reason catalog is unavailable',
          )
        }
        if (requestedGuideline && guideline === null) {
          return fail(
            'CASE_ENFORCEMENT_GUIDELINE_INVALID',
            'Guideline selection is not an approved catalog entry',
          )
        }
        const existing = await repository.findActionByReviewDecisionId(
          input.reviewDecisionId,
          session,
        )
        if (existing) {
          return fail(
            'CASE_ENFORCEMENT_ALREADY_RECORDED',
            'Review Decision already has an initial Enforcement Decision',
          )
        }

        try {
          const created = await repository.createAction(
            {
              targetUserId: report.reportedUserId,
              recordType: 'decision',
              effectiveAt: evaluatedAt,
              performedByUserId: actorId,
              reviewDecisionId: input.reviewDecisionId,
              operationId: input.operationId,
              commandDigest,
              reasonSummary: input.reasonSummary,
              decisionType: input.decisionType,
              ...(input.decisionType === 'formal_warning'
                ? { memberNoticeProvenance: STAGE_B_MEMBER_NOTICE_PROVENANCE }
                : {}),
              ...(guideline
                ? {
                    reasonCode: guideline.reasonCode,
                    guidelineRuleId: guideline.guidelineRuleId,
                    guidelineVersion: guideline.guidelineVersion,
                  }
                : input.reasonCode
                  ? { reasonCode: input.reasonCode }
                  : {}),
            },
            session,
          )
          if (!created) return fail('CASE_ENFORCEMENT_CONFLICT', 'Enforcement write failed')
          return toResult('committed', created)
        } catch (error) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === 11000
          ) {
            return fail('CASE_ENFORCEMENT_CONFLICT', 'Concurrent enforcement command conflicted')
          }
          throw error
        }
      })
    },
  }
}

export const caseEnforcementService = createCaseEnforcementService()

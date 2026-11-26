import { Types, isObjectIdOrHexString, type mongo } from 'mongoose'
import {
  appendAccountEnforcementReversalAuditEvent,
  type AccountEnforcementReversalAuditEventType,
  type AccountEnforcementReversalAuditWriteOptions,
  type IAccountEnforcementReversalAuditEvent,
} from '../models/accountEnforcementReversalAuditEventModel.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

export const ACCOUNT_ENFORCEMENT_REVERSAL_AUDIT_WRITE_CONCERN = Object.freeze({
  w: 'majority',
  journal: true,
  wtimeoutMS: 5_000,
}) satisfies mongo.WriteConcern
export const ACCOUNT_ENFORCEMENT_REVERSAL_AUDIT_TIMEOUT_MS = 6_000

export type ReversalAuditRepository = Readonly<{
  append(
    event: IAccountEnforcementReversalAuditEvent,
    options: AccountEnforcementReversalAuditWriteOptions,
  ): Promise<{ acknowledged: boolean; insertedId?: Types.ObjectId }>
}>

export type ReversalAuditDependencies = Readonly<{
  repository?: ReversalAuditRepository
  now?: () => Date
  timeoutMs?: number
  newAttemptId?: () => Types.ObjectId
}>

export type ReversalAuditIdentity = Readonly<{
  actorUserId: string
  decisionId: string
  operationId: string
}>

const defaultRepository: ReversalAuditRepository = {
  append: appendAccountEnforcementReversalAuditEvent,
}

const unavailable = () =>
  new ApiProblem(
    503,
    'ACCOUNT_ENFORCEMENT_REVERSAL_AUDIT_UNAVAILABLE',
    'Reversal audit confirmation is unavailable',
  )

const objectId = (value: string) => {
  if (!isObjectIdOrHexString(value)) throw unavailable()
  return new Types.ObjectId(value)
}

const withTimeout = async <Result>(operation: Promise<Result>, timeoutMs: number) => {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw unavailable()
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(unavailable()), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const createAccountEnforcementReversalAuditService = (
  dependencies: ReversalAuditDependencies = {},
) => {
  const repository = dependencies.repository ?? defaultRepository
  const now = dependencies.now ?? (() => new Date())
  const timeoutMs = dependencies.timeoutMs ?? ACCOUNT_ENFORCEMENT_REVERSAL_AUDIT_TIMEOUT_MS
  const newAttemptId = dependencies.newAttemptId ?? (() => new Types.ObjectId())

  const append = async (
    identity: ReversalAuditIdentity,
    attemptId: Types.ObjectId,
    eventType: AccountEnforcementReversalAuditEventType,
    failureCode?: string,
  ) => {
    const occurredAt = now()
    if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.valueOf())) {
      throw unavailable()
    }
    const event: IAccountEnforcementReversalAuditEvent = {
      attemptId,
      actorUserId: objectId(identity.actorUserId),
      decisionId: objectId(identity.decisionId),
      operationId: identity.operationId,
      eventType,
      occurredAt,
      ...(failureCode ? { failureCode } : {}),
    }
    try {
      const acknowledgment = await withTimeout(
        repository.append(event, {
          writeConcern: ACCOUNT_ENFORCEMENT_REVERSAL_AUDIT_WRITE_CONCERN,
          timeoutMS: timeoutMs,
        }),
        timeoutMs,
      )
      if (acknowledgment.acknowledged !== true || !acknowledgment.insertedId) {
        throw unavailable()
      }
    } catch {
      throw unavailable()
    }
  }

  return {
    async start(identity: ReversalAuditIdentity) {
      const attemptId = newAttemptId()
      await append(identity, attemptId, 'started')
      return attemptId
    },
    terminal(
      identity: ReversalAuditIdentity,
      attemptId: Types.ObjectId,
      eventType: Exclude<AccountEnforcementReversalAuditEventType, 'started'>,
      failureCode: string,
    ) {
      return append(identity, attemptId, eventType, failureCode)
    },
  }
}

export const accountEnforcementReversalAuditService = createAccountEnforcementReversalAuditService()

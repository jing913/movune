import axios from 'axios'
import api from '@/services/api'

export type AdminEnforcementDecisionType = 'formal_warning' | 'temporary_suspension'
export type AdminEnforcementDecisionState = 'reversible' | 'reversed'

export interface AdminEnforcementDecision {
  id: string
  targetUserId: string
  decisionType: AdminEnforcementDecisionType
  effectiveAt: string
  endsAt: string | null
  reasonSummary: string
  expired: boolean
  state: AdminEnforcementDecisionState
  reversal: { id: string; operationId: string | null; effectiveAt: string } | null
}

export interface AdminEnforcementReadResponse {
  member: { id: string; displayName: string; account: string }
  decisions: AdminEnforcementDecision[]
  memberFacingReasonOptions: Array<{ code: string; summary: string }>
}

export interface AdminReversalBody {
  operationId: string
  reasonSummary: string
  memberFacingReasonCode?: string
}

export interface AdminReversalCommand extends AdminReversalBody {
  actorId: string
  decisionId: string
}

export interface AdminReversalResponse {
  kind: 'committed' | 'replayed'
  operationId: string
  reversal: {
    id: string
    targetUserId: string
    performedByUserId: string
    reversesDecisionId: string
    effectiveAt: string
    reasonCode: 'admin.reversal'
    reasonSummary: string
    memberFacingReasonSummary?: string
  }
}

export interface AdminReversalApiError {
  status: number | null
  code: string
  operationId: string | null
  retryWithSameOperationId: boolean
}

const objectIdPattern = /^[a-f\d]{24}$/i
const operationIdPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const datePattern = /^\d{4}-\d{2}-\d{2}T/
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isObjectId = (value: unknown): value is string =>
  typeof value === 'string' && objectIdPattern.test(value)
const isDate = (value: unknown): value is string =>
  typeof value === 'string' && datePattern.test(value) && Number.isFinite(Date.parse(value))

const invalidResponse = (): never => {
  throw new Error('ADMIN_ENFORCEMENT_RESPONSE_INVALID')
}

const requireResponse = (value: unknown): AdminEnforcementReadResponse => {
  if (
    !isRecord(value) ||
    !isRecord(value.member) ||
    !isObjectId(value.member.id) ||
    typeof value.member.displayName !== 'string' ||
    typeof value.member.account !== 'string' ||
    !Array.isArray(value.decisions) ||
    !Array.isArray(value.memberFacingReasonOptions)
  ) {
    return invalidResponse()
  }
  for (const decision of value.decisions) {
    if (
      !isRecord(decision) ||
      !isObjectId(decision.id) ||
      decision.targetUserId !== value.member.id ||
      !['formal_warning', 'temporary_suspension'].includes(String(decision.decisionType)) ||
      !isDate(decision.effectiveAt) ||
      !(decision.endsAt === null || isDate(decision.endsAt)) ||
      typeof decision.reasonSummary !== 'string' ||
      typeof decision.expired !== 'boolean' ||
      !['reversible', 'reversed'].includes(String(decision.state)) ||
      !(decision.reversal === null || isRecord(decision.reversal))
    ) {
      return invalidResponse()
    }
  }
  for (const option of value.memberFacingReasonOptions) {
    if (
      !isRecord(option) ||
      typeof option.code !== 'string' ||
      typeof option.summary !== 'string'
    ) {
      return invalidResponse()
    }
  }
  return value as unknown as AdminEnforcementReadResponse
}

export const isAdminEnforcementTargetId = (value: string) => objectIdPattern.test(value)

export async function getAdminEnforcementDecisions(targetUserId: string, signal?: AbortSignal) {
  if (!isAdminEnforcementTargetId(targetUserId)) throw new Error('ADMIN_ENFORCEMENT_TARGET_INVALID')
  const response = await api.get<unknown>('/api/admin/enforcement-decisions', {
    params: { targetUserId },
    signal,
  })
  return requireResponse(response.data)
}

export async function reverseAdminEnforcementDecision(decisionId: string, body: AdminReversalBody) {
  if (!isObjectId(decisionId) || !operationIdPattern.test(body.operationId)) {
    throw new Error('ADMIN_ENFORCEMENT_COMMAND_INVALID')
  }
  const response = await api.post<AdminReversalResponse>(
    `/api/admin/enforcement-decisions/${encodeURIComponent(decisionId)}/reversal`,
    body,
  )
  return response.data
}

export const parseAdminReversalApiError = (error: unknown): AdminReversalApiError => {
  if (!axios.isAxiosError(error)) {
    return { status: null, code: 'UNKNOWN', operationId: null, retryWithSameOperationId: false }
  }
  const problem =
    isRecord(error.response?.data) && isRecord(error.response?.data.error)
      ? error.response.data.error
      : null
  const details = problem && isRecord(problem.details) ? problem.details : null
  return {
    status: error.response?.status ?? null,
    code: problem && typeof problem.code === 'string' ? problem.code : 'UNKNOWN',
    operationId: details && typeof details.operationId === 'string' ? details.operationId : null,
    retryWithSameOperationId:
      details?.retryWithSameOperationId === true && typeof details.operationId === 'string',
  }
}

export const createAdminReversalOperationId = () =>
  `reversal.web.${crypto.randomUUID().toLowerCase()}`

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const STORAGE_KEY = 'movune.admin.reversal.uncertain.v1'

const browserStorage = (): StorageLike | null => {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

const validCommand = (value: unknown): value is AdminReversalCommand =>
  isRecord(value) &&
  isObjectId(value.actorId) &&
  isObjectId(value.decisionId) &&
  typeof value.operationId === 'string' &&
  operationIdPattern.test(value.operationId) &&
  typeof value.reasonSummary === 'string' &&
  (value.memberFacingReasonCode === undefined || typeof value.memberFacingReasonCode === 'string')

export const createAdminReversalCommandCoordinator = (
  dependencies: {
    storage?: StorageLike | null
    execute?: typeof reverseAdminEnforcementDecision
  } = {},
) => {
  const storage = dependencies.storage === undefined ? browserStorage() : dependencies.storage
  const execute = dependencies.execute ?? reverseAdminEnforcementDecision
  const load = () => {
    try {
      const raw = storage?.getItem(STORAGE_KEY)
      if (!raw) return null
      const parsed: unknown = JSON.parse(raw)
      return validCommand(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  const save = (command: AdminReversalCommand) =>
    storage?.setItem(STORAGE_KEY, JSON.stringify(command))
  const clear = () => storage?.removeItem(STORAGE_KEY)

  const run = async (command: AdminReversalCommand) => {
    save(command)
    try {
      const response = await execute(command.decisionId, {
        operationId: command.operationId,
        reasonSummary: command.reasonSummary,
        ...(command.memberFacingReasonCode
          ? { memberFacingReasonCode: command.memberFacingReasonCode }
          : {}),
      })
      clear()
      return { kind: 'success' as const, response }
    } catch (error) {
      const parsed = parseAdminReversalApiError(error)
      if (!parsed.retryWithSameOperationId || parsed.operationId !== command.operationId) clear()
      return {
        kind: parsed.retryWithSameOperationId ? ('uncertain' as const) : ('failed' as const),
        error: parsed,
      }
    }
  }

  return {
    inspect(actorId: string) {
      const command = load()
      return {
        command: command?.actorId === actorId ? command : null,
        blockedByOtherActor: command !== null && command.actorId !== actorId,
      }
    },
    executeNew(command: AdminReversalCommand) {
      if (load()) throw new Error('ADMIN_ENFORCEMENT_UNRESOLVED_COMMAND')
      return run(command)
    },
    retry(actorId: string) {
      const command = load()
      if (!command || command.actorId !== actorId) {
        throw new Error('ADMIN_ENFORCEMENT_RETRY_UNAVAILABLE')
      }
      return run(command)
    },
    clear,
  }
}

export const adminReversalCommandCoordinator = createAdminReversalCommandCoordinator()

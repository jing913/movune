import type { EffectiveAccountState } from '../utils/accountEnforcementPolicy.js'
import { evaluateAccountEnforcementState } from '../services/accountEnforcementService.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

export const MEMBER_ENFORCEMENT_PERMISSION = 'members:enforce' as const

export type MemberEnforcementAuthorizationIdentity = Readonly<{
  _id: string | Readonly<{ toString(): string }>
  role: 'user' | 'admin'
  memberEnforcementEnabled?: unknown
}>

export type MemberEnforcementCapabilities = Readonly<{ enforceMembers: boolean }>

export type MemberEnforcementAccountStateLoader = (
  userId: string,
  evaluatedAt: Date,
) => Promise<EffectiveAccountState>

const validDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.valueOf())

const validActiveState = (value: EffectiveAccountState, evaluatedAt: Date) =>
  value.status === 'active' &&
  validDate(value.evaluatedAt) &&
  value.evaluatedAt.valueOf() === evaluatedAt.valueOf() &&
  value.governingDecisionId === null &&
  Array.isArray(value.activeRestrictionDecisionIds) &&
  value.activeRestrictionDecisionIds.length === 0 &&
  value.restrictionEndsAt === null

export const deriveMemberEnforcementCapabilities = async (
  user: MemberEnforcementAuthorizationIdentity | null | undefined,
  evaluatedAt: Date,
  loadAccountState: MemberEnforcementAccountStateLoader = evaluateAccountEnforcementState,
): Promise<MemberEnforcementCapabilities> => {
  if (
    !user ||
    user.role !== 'admin' ||
    user.memberEnforcementEnabled !== true ||
    !validDate(evaluatedAt)
  ) {
    return { enforceMembers: false }
  }

  try {
    const userId = user._id.toString()
    if (!userId) return { enforceMembers: false }
    const accountState = await loadAccountState(userId, evaluatedAt)
    return { enforceMembers: validActiveState(accountState, evaluatedAt) }
  } catch {
    return { enforceMembers: false }
  }
}

export const assertMemberEnforcementAuthorized = async (
  user: MemberEnforcementAuthorizationIdentity | null | undefined,
  evaluatedAt: Date,
  loadAccountState: MemberEnforcementAccountStateLoader = evaluateAccountEnforcementState,
) => {
  const capabilities = await deriveMemberEnforcementCapabilities(
    user,
    evaluatedAt,
    loadAccountState,
  )
  if (!capabilities.enforceMembers) {
    throw new ApiProblem(
      403,
      'MEMBER_ENFORCEMENT_FORBIDDEN',
      'Member Enforcement permission is required',
    )
  }
}

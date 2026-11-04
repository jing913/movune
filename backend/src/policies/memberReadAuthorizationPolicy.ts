import type { EffectiveAccountState } from '../utils/accountEnforcementPolicy.js'
import { evaluateAccountEnforcementState } from '../services/accountEnforcementService.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

export const MEMBER_READ_PERMISSION = 'members:read' as const

export type MemberReadAuthorizationIdentity = Readonly<{
  _id: string | Readonly<{ toString(): string }>
  role: 'user' | 'admin'
}>

export type MemberReadCapabilities = Readonly<{
  viewMembers: boolean
}>

export type AccountStateLoader = (
  userId: string,
  evaluatedAt: Date,
) => Promise<EffectiveAccountState>

export const isMemberReadAuthorized = (
  user: MemberReadAuthorizationIdentity | null | undefined,
  accountState: EffectiveAccountState | null | undefined,
) => user?.role === 'admin' && accountState?.status === 'active'

export const deriveMemberReadCapabilities = async (
  user: MemberReadAuthorizationIdentity | null | undefined,
  evaluatedAt: Date,
  loadAccountState: AccountStateLoader = evaluateAccountEnforcementState,
): Promise<MemberReadCapabilities> => {
  if (!user || user.role !== 'admin') return { viewMembers: false }

  try {
    const accountState = await loadAccountState(user._id.toString(), evaluatedAt)
    return { viewMembers: isMemberReadAuthorized(user, accountState) }
  } catch {
    return { viewMembers: false }
  }
}

export const assertMemberReadAuthorized = async (
  user: MemberReadAuthorizationIdentity | null | undefined,
  evaluatedAt: Date,
  loadAccountState: AccountStateLoader = evaluateAccountEnforcementState,
) => {
  const capabilities = await deriveMemberReadCapabilities(user, evaluatedAt, loadAccountState)
  if (!capabilities.viewMembers) {
    throw new ApiProblem(403, 'MEMBERS_READ_FORBIDDEN', 'Members Read permission is required')
  }
}

import api from '@/services/api'

export const ADMIN_MEMBER_STATUSES = ['active', 'suspended', 'deactivated'] as const
export const ADMIN_MEMBER_ROLES = ['user', 'admin'] as const
export const ADMIN_MEMBER_DEFAULT_LIMITS = { desktop: 20, mobile: 5 } as const

export const adminMemberDefaultLimit = (isMobile: boolean) =>
  isMobile ? ADMIN_MEMBER_DEFAULT_LIMITS.mobile : ADMIN_MEMBER_DEFAULT_LIMITS.desktop

export type AdminMemberStatus = (typeof ADMIN_MEMBER_STATUSES)[number]
export type AdminMemberRole = (typeof ADMIN_MEMBER_ROLES)[number]

export interface AdminMemberListItem {
  id: string
  avatar: string | null
  displayName: string
  account: string
  accountStatus: AdminMemberStatus
  registrationDate: string
  recentLogin: { status: 'unavailable'; at: null }
}

export interface AdminMemberDetail extends AdminMemberListItem {
  bio: string | null
  role: AdminMemberRole
}

export interface AdminMemberListQuery {
  search?: string
  status?: AdminMemberStatus
  role?: AdminMemberRole
  registeredFrom?: string
  registeredTo?: string
  page?: number
  limit?: number
}

export interface AdminMemberListResponse {
  members: AdminMemberListItem[]
  pagination: { page: number; limit: number; total: number; totalPages: number }
}

const objectIdPattern = /^[a-f\d]{24}$/i
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T/

export const isAdminMemberId = (value: string) => objectIdPattern.test(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringOrNull = (value: unknown): value is string | null =>
  typeof value === 'string' || value === null

const isMemberStatus = (value: unknown): value is AdminMemberStatus =>
  ADMIN_MEMBER_STATUSES.includes(value as AdminMemberStatus)

const isMemberRole = (value: unknown): value is AdminMemberRole =>
  ADMIN_MEMBER_ROLES.includes(value as AdminMemberRole)

function isRecentLogin(value: unknown): value is AdminMemberListItem['recentLogin'] {
  return isRecord(value) && value.status === 'unavailable' && value.at === null
}

function isListItem(value: unknown): value is AdminMemberListItem {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isAdminMemberId(value.id) &&
    isStringOrNull(value.avatar) &&
    typeof value.displayName === 'string' &&
    typeof value.account === 'string' &&
    isMemberStatus(value.accountStatus) &&
    typeof value.registrationDate === 'string' &&
    dateTimePattern.test(value.registrationDate) &&
    Number.isFinite(Date.parse(value.registrationDate)) &&
    isRecentLogin(value.recentLogin)
  )
}

function invalidResponse(): never {
  throw new Error('ADMIN_MEMBER_RESPONSE_INVALID')
}

const normalizeListItem = (member: AdminMemberListItem): AdminMemberListItem => ({
  id: member.id,
  avatar: member.avatar,
  displayName: member.displayName,
  account: member.account,
  accountStatus: member.accountStatus,
  registrationDate: member.registrationDate,
  recentLogin: { status: 'unavailable', at: null },
})

function requireListResponse(value: unknown): AdminMemberListResponse {
  if (!isRecord(value) || !Array.isArray(value.members) || !isRecord(value.pagination)) {
    return invalidResponse()
  }
  const { page, limit, total, totalPages } = value.pagination
  if (
    !value.members.every(isListItem) ||
    ![page, limit, total, totalPages].every(Number.isSafeInteger) ||
    (page as number) < 1 ||
    (limit as number) < 1 ||
    (total as number) < 0 ||
    (totalPages as number) < 0
  ) {
    return invalidResponse()
  }
  return {
    members: value.members.map((member) => normalizeListItem(member as AdminMemberListItem)),
    pagination: {
      page: page as number,
      limit: limit as number,
      total: total as number,
      totalPages: totalPages as number,
    },
  }
}

function requireDetailResponse(value: unknown): AdminMemberDetail {
  if (!isRecord(value) || !isRecord(value.member)) return invalidResponse()
  const member = value.member
  if (!isListItem(member) || !isStringOrNull(member.bio) || !isMemberRole(member.role)) {
    return invalidResponse()
  }
  return {
    ...normalizeListItem(member as unknown as AdminMemberListItem),
    bio: member.bio,
    role: member.role,
  } as AdminMemberDetail
}

export async function listAdminMembers(query: AdminMemberListQuery) {
  const response = await api.get<unknown>('/api/admin/members', { params: query })
  return requireListResponse(response.data)
}

export async function getAdminMember(memberId: string) {
  if (!isAdminMemberId(memberId)) throw new Error('ADMIN_MEMBER_ID_INVALID')
  const response = await api.get<unknown>(`/api/admin/members/${encodeURIComponent(memberId)}`)
  return requireDetailResponse(response.data)
}

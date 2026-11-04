import { isObjectIdOrHexString, type PipelineStage, type QueryFilter, type Types } from 'mongoose'
import { User, type IUser } from '../models/userModel.js'
import { AccountEnforcementAction } from '../models/accountEnforcementActionModel.js'
import { evaluateAccountEnforcementState } from './accountEnforcementService.js'
import type { EffectiveAccountStatus } from '../utils/accountEnforcementPolicy.js'
import { ApiProblem } from '../utils/messagingPolicy.js'

const MEMBER_SEARCH_MAX_LENGTH = 50
const MEMBER_PAGE_MAX = 10_000
const MEMBER_PAGE_LIMIT_MAX = 30
const ALLOWED_QUERY_KEYS = new Set([
  'search',
  'status',
  'role',
  'registeredFrom',
  'registeredTo',
  'page',
  'limit',
])
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const EFFECTIVE_ACCOUNT_STATUSES = new Set<EffectiveAccountStatus>([
  'active',
  'suspended',
  'deactivated',
])
const MEMBER_ROLES = new Set<IUser['role']>(['user', 'admin'])

export type AdminMemberListQuery = Readonly<{
  search: string
  status?: EffectiveAccountStatus
  role?: IUser['role']
  registeredFrom?: Date
  registeredToExclusive?: Date
  page: number
  limit: number
}>

export type RecentLoginUnavailable = Readonly<{
  status: 'unavailable'
  at: null
}>

export type AdminMemberListItem = Readonly<{
  id: string
  avatar: string | null
  displayName: string
  account: string
  accountStatus: EffectiveAccountStatus
  registrationDate: string
  recentLogin: RecentLoginUnavailable
}>

export type AdminMemberDetail = AdminMemberListItem &
  Readonly<{
    bio: string | null
    role: IUser['role']
  }>

type AggregateMember = Omit<AdminMemberListItem, 'registrationDate'> & {
  registrationDate: Date
}

type AggregateFacet = {
  members: AggregateMember[]
  total: Array<{ count: number }>
}

type MemberDetailRecord = {
  _id: Types.ObjectId
  account: string
  displayName?: string
  avatar?: string
  bio?: string
  role: IUser['role']
  createdAt: Date
}

const invalidQuery = (field: string) =>
  new ApiProblem(400, 'ADMIN_MEMBER_QUERY_INVALID', 'Invalid member query', { field })

const requireSingleString = (value: unknown, field: string) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw invalidQuery(field)
  return value
}

const parsePositiveInteger = (
  value: unknown,
  field: string,
  fallback: number,
  maximum?: number,
) => {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw invalidQuery(field)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || (maximum !== undefined && parsed > maximum)) {
    throw invalidQuery(field)
  }
  return parsed
}

const parseDate = (value: unknown, field: string) => {
  const text = requireSingleString(value, field)
  if (text === undefined) return undefined
  if (!DATE_PATTERN.test(text)) throw invalidQuery(field)
  const date = new Date(`${text}T00:00:00.000Z`)
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== text) {
    throw invalidQuery(field)
  }
  return date
}

const nextUtcDay = (date: Date) => {
  const result = new Date(date)
  result.setUTCDate(result.getUTCDate() + 1)
  return result
}

export const parseAdminMemberListQuery = (
  query: Readonly<Record<string, unknown>>,
): AdminMemberListQuery => {
  const unknownKey = Object.keys(query).find((key) => !ALLOWED_QUERY_KEYS.has(key))
  if (unknownKey) throw invalidQuery(unknownKey)

  const search = requireSingleString(query.search, 'search')?.trim() ?? ''
  if (search.length > MEMBER_SEARCH_MAX_LENGTH) throw invalidQuery('search')

  const statusValue = requireSingleString(query.status, 'status')
  if (
    statusValue !== undefined &&
    !EFFECTIVE_ACCOUNT_STATUSES.has(statusValue as EffectiveAccountStatus)
  ) {
    throw invalidQuery('status')
  }

  const roleValue = requireSingleString(query.role, 'role')
  if (roleValue !== undefined && !MEMBER_ROLES.has(roleValue as IUser['role'])) {
    throw invalidQuery('role')
  }

  const registeredFrom = parseDate(query.registeredFrom, 'registeredFrom')
  const registeredTo = parseDate(query.registeredTo, 'registeredTo')
  const registeredToExclusive = registeredTo ? nextUtcDay(registeredTo) : undefined
  if (registeredFrom && registeredToExclusive && registeredFrom >= registeredToExclusive) {
    throw invalidQuery('registeredFrom')
  }

  return {
    search,
    ...(statusValue ? { status: statusValue as EffectiveAccountStatus } : {}),
    ...(roleValue ? { role: roleValue as IUser['role'] } : {}),
    ...(registeredFrom ? { registeredFrom } : {}),
    ...(registeredToExclusive ? { registeredToExclusive } : {}),
    page: parsePositiveInteger(query.page, 'page', 1, MEMBER_PAGE_MAX),
    limit: parsePositiveInteger(query.limit, 'limit', 20, MEMBER_PAGE_LIMIT_MAX),
  }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const buildUserMatch = (query: AdminMemberListQuery): QueryFilter<IUser> => {
  const match: QueryFilter<IUser> = {}
  if (query.search) {
    const search = { $regex: escapeRegExp(query.search), $options: 'i' }
    match.$or = [{ account: search }, { displayName: search }]
  }
  if (query.role) match.role = query.role
  if (query.registeredFrom || query.registeredToExclusive) {
    match.createdAt = {
      ...(query.registeredFrom ? { $gte: query.registeredFrom } : {}),
      ...(query.registeredToExclusive ? { $lt: query.registeredToExclusive } : {}),
    }
  }
  return match
}

const statusStages = (evaluatedAt: Date): PipelineStage[] => [
  {
    $lookup: {
      from: AccountEnforcementAction.collection.name,
      let: { memberId: '$_id' },
      pipeline: [
        { $match: { $expr: { $eq: ['$targetUserId', '$$memberId'] } } },
        { $sort: { effectiveAt: 1, _id: 1 } },
      ],
      as: 'enforcementHistory',
    },
  },
  {
    $set: {
      effectiveReversalIds: {
        $map: {
          input: {
            $filter: {
              input: '$enforcementHistory',
              as: 'action',
              cond: {
                $and: [
                  { $eq: ['$$action.recordType', 'reversal'] },
                  { $lte: ['$$action.effectiveAt', evaluatedAt] },
                ],
              },
            },
          },
          as: 'reversal',
          in: '$$reversal.reversesDecisionId',
        },
      },
    },
  },
  {
    $set: {
      activeRestrictions: {
        $filter: {
          input: '$enforcementHistory',
          as: 'action',
          cond: {
            $and: [
              { $eq: ['$$action.recordType', 'decision'] },
              { $lte: ['$$action.effectiveAt', evaluatedAt] },
              { $not: [{ $in: ['$$action._id', '$effectiveReversalIds'] }] },
              {
                $or: [
                  { $eq: ['$$action.decisionType', 'permanent_deactivation'] },
                  {
                    $and: [
                      { $eq: ['$$action.decisionType', 'temporary_suspension'] },
                      { $gt: ['$$action.endsAt', evaluatedAt] },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    },
  },
  {
    $set: {
      accountStatus: {
        $cond: [
          {
            $in: [
              'permanent_deactivation',
              {
                $map: {
                  input: '$activeRestrictions',
                  as: 'restriction',
                  in: '$$restriction.decisionType',
                },
              },
            ],
          },
          'deactivated',
          {
            $cond: [{ $gt: [{ $size: '$activeRestrictions' }, 0] }, 'suspended', 'active'],
          },
        ],
      },
    },
  },
]

const memberProjection: PipelineStage.Project['$project'] = {
  _id: 0,
  id: { $toString: '$_id' },
  avatar: { $ifNull: ['$avatar', null] },
  displayName: {
    $cond: [
      { $gt: [{ $strLenCP: { $ifNull: ['$displayName', ''] } }, 0] },
      '$displayName',
      '$account',
    ],
  },
  account: 1,
  accountStatus: 1,
  registrationDate: '$createdAt',
  recentLogin: { $literal: { status: 'unavailable', at: null } },
}

export const buildAdminMemberListPipeline = (
  query: AdminMemberListQuery,
  evaluatedAt: Date,
): PipelineStage[] => {
  const sortAndPage: PipelineStage[] = [
    { $sort: { createdAt: -1, _id: -1 } },
    { $skip: (query.page - 1) * query.limit },
    { $limit: query.limit },
  ]
  const deriveStatus = statusStages(evaluatedAt)

  if (!query.status) {
    return [
      { $match: buildUserMatch(query) },
      {
        $facet: {
          members: [
            ...sortAndPage,
            ...deriveStatus,
            { $project: memberProjection },
          ] as PipelineStage.FacetPipelineStage[],
          total: [{ $count: 'count' }],
        },
      },
    ]
  }

  return [
    { $match: buildUserMatch(query) },
    ...deriveStatus,
    { $match: { accountStatus: query.status } },
    {
      $facet: {
        members: [
          ...sortAndPage,
          { $project: memberProjection },
        ] as PipelineStage.FacetPipelineStage[],
        total: [{ $count: 'count' }],
      },
    },
  ]
}

export const listAdminMembers = async (query: AdminMemberListQuery, evaluatedAt: Date) => {
  const [result] = await User.aggregate<AggregateFacet>(
    buildAdminMemberListPipeline(query, evaluatedAt),
  )
  const total = result?.total[0]?.count ?? 0
  return {
    members: (result?.members ?? []).map((member): AdminMemberListItem => ({
      id: member.id,
      avatar: member.avatar,
      displayName: member.displayName,
      account: member.account,
      accountStatus: member.accountStatus,
      registrationDate: new Date(member.registrationDate).toISOString(),
      recentLogin: { status: 'unavailable', at: null },
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  }
}

export const getAdminMember = async (memberId: string, evaluatedAt: Date) => {
  if (!isObjectIdOrHexString(memberId)) {
    throw new ApiProblem(400, 'ADMIN_MEMBER_ID_INVALID', 'Invalid member id')
  }

  const member = (await User.findById(memberId)
    .select('_id account displayName avatar bio role createdAt')
    .lean()) as MemberDetailRecord | null
  if (!member) throw new ApiProblem(404, 'ADMIN_MEMBER_NOT_FOUND', 'Member not found')

  const accountState = await evaluateAccountEnforcementState(memberId, evaluatedAt)
  return {
    id: member._id.toString(),
    avatar: member.avatar ?? null,
    displayName: member.displayName?.trim() || member.account,
    account: member.account,
    accountStatus: accountState.status,
    registrationDate: new Date(member.createdAt).toISOString(),
    recentLogin: { status: 'unavailable', at: null },
    bio: member.bio ?? null,
    role: member.role,
  } satisfies AdminMemberDetail
}

import { isDeepStrictEqual } from 'node:util'
import type { AnnouncementAdminRecord } from '../services/announcementDraftAdminService.js'
import type {
  AnnouncementCategory,
  AnnouncementMaintenanceStatus,
  AnnouncementPriority,
} from '../policies/announcementLifecyclePolicy.js'
import type { AnnouncementGovernanceChanges } from '../models/announcementGovernanceEventModel.js'
import { ApiProblem } from './messagingPolicy.js'
import {
  ANNOUNCEMENT_EFFECTIVE_AT_BASES,
  normalizeAnnouncementEffectiveDate,
  type AnnouncementEffectiveAtBasis,
} from './announcementHistoricalPolicy.js'

export type AnnouncementRevisionRequest = Readonly<{ expectedRevision: number }>
export type AnnouncementHistoricalPublishRequest = Readonly<{
  expectedRevision: number
  effectiveAt: Date
  effectiveAtBasis: AnnouncementEffectiveAtBasis
}>
export const ANNOUNCEMENT_REMOVAL_REASON_CODES = [
  'privacy',
  'legal',
  'safety',
  'mistaken_publication',
  'other',
] as const
export type AnnouncementRemovalRequest = Readonly<{
  expectedRevision: number
  reasonCode: (typeof ANNOUNCEMENT_REMOVAL_REASON_CODES)[number]
  reasonSummary: string
}>
export type AnnouncementPublishedEditRequest = Readonly<{
  expectedRevision: number
  editIntent: 'general_correction' | 'important_update'
  category: unknown
  priority: unknown
  title: unknown
  body: unknown
  maintenance?: unknown
  updateNote?: string
}>
export type AnnouncementMaintenanceTransitionRequest = Readonly<{
  expectedRevision: number
  status: AnnouncementMaintenanceStatus
  actualCompletionTime?: Date
}>

const problem = (
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
) => new ApiProblem(status, code, message, details)

export const announcementGovernanceRequestInvalid = () =>
  problem(400, 'ANNOUNCEMENT_REQUEST_INVALID', 'Announcement request is invalid')
export const announcementGovernanceNotFound = () =>
  problem(404, 'ANNOUNCEMENT_NOT_FOUND', 'Announcement not found')
export const announcementGovernanceStateConflict = () =>
  problem(409, 'ANNOUNCEMENT_STATE_CONFLICT', 'Announcement state conflict')
export const announcementGovernanceRevisionConflict = () =>
  problem(409, 'ANNOUNCEMENT_REVISION_CONFLICT', 'Announcement revision conflict')
export const announcementGovernanceTransactionFailed = () =>
  problem(
    500,
    'ANNOUNCEMENT_GOVERNANCE_TRANSACTION_FAILED',
    'Announcement governance transaction failed',
  )

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
) =>
  Object.keys(value).every((key) => allowed.includes(key)) &&
  required.every((key) => Object.hasOwn(value, key))

const parseRevision = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw announcementGovernanceRequestInvalid()
  }
  return value
}

const parseCanonicalDate = (value: unknown) => {
  if (typeof value !== 'string') throw announcementGovernanceRequestInvalid()
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    throw announcementGovernanceRequestInvalid()
  }
  return date
}

const normalizeMaintenance = (value: unknown) => {
  if (!isRecord(value)) return value
  const normalized = { ...value }
  for (const field of ['startsAt', 'endsAt', 'actualCompletionTime'] as const) {
    if (typeof normalized[field] === 'string') {
      normalized[field] = parseCanonicalDate(normalized[field])
    }
  }
  return normalized
}

export const parseAnnouncementRevisionRequest = (value: unknown): AnnouncementRevisionRequest => {
  if (!isRecord(value) || !exactKeys(value, ['expectedRevision'], ['expectedRevision'])) {
    throw announcementGovernanceRequestInvalid()
  }
  return { expectedRevision: parseRevision(value.expectedRevision) }
}

export const parseAnnouncementHistoricalPublishRequest = (
  value: unknown,
): AnnouncementHistoricalPublishRequest => {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      ['expectedRevision', 'effectiveAt', 'effectiveAtBasis'],
      ['expectedRevision', 'effectiveAt', 'effectiveAtBasis'],
    ) ||
    typeof value.effectiveAt !== 'string' ||
    typeof value.effectiveAtBasis !== 'string' ||
    !(ANNOUNCEMENT_EFFECTIVE_AT_BASES as readonly string[]).includes(value.effectiveAtBasis)
  ) {
    throw announcementGovernanceRequestInvalid()
  }

  try {
    return {
      expectedRevision: parseRevision(value.expectedRevision),
      effectiveAt: normalizeAnnouncementEffectiveDate(value.effectiveAt),
      effectiveAtBasis: value.effectiveAtBasis as AnnouncementEffectiveAtBasis,
    }
  } catch {
    throw announcementGovernanceRequestInvalid()
  }
}

export const parseAnnouncementRemovalRequest = (value: unknown): AnnouncementRemovalRequest => {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      ['expectedRevision', 'reasonCode', 'reasonSummary'],
      ['expectedRevision', 'reasonCode', 'reasonSummary'],
    ) ||
    typeof value.reasonCode !== 'string' ||
    !(ANNOUNCEMENT_REMOVAL_REASON_CODES as readonly string[]).includes(value.reasonCode) ||
    typeof value.reasonSummary !== 'string' ||
    value.reasonSummary.length === 0 ||
    value.reasonSummary.length > 500 ||
    value.reasonSummary !== value.reasonSummary.trim()
  ) {
    throw announcementGovernanceRequestInvalid()
  }
  return {
    expectedRevision: parseRevision(value.expectedRevision),
    reasonCode: value.reasonCode as AnnouncementRemovalRequest['reasonCode'],
    reasonSummary: value.reasonSummary,
  }
}

export const parseAnnouncementPublishedEditRequest = (
  value: unknown,
): AnnouncementPublishedEditRequest => {
  const allowed = [
    'expectedRevision',
    'editIntent',
    'category',
    'priority',
    'title',
    'body',
    'maintenance',
    'updateNote',
  ] as const
  const required = ['expectedRevision', 'editIntent', 'category', 'priority', 'title', 'body']
  if (!isRecord(value) || !exactKeys(value, allowed, required)) {
    throw announcementGovernanceRequestInvalid()
  }
  if (value.editIntent !== 'general_correction' && value.editIntent !== 'important_update') {
    throw announcementGovernanceRequestInvalid()
  }
  if (value.editIntent === 'general_correction' && Object.hasOwn(value, 'updateNote')) {
    throw announcementGovernanceRequestInvalid()
  }
  if (
    value.editIntent === 'important_update' &&
    (typeof value.updateNote !== 'string' ||
      value.updateNote.length === 0 ||
      value.updateNote !== value.updateNote.trim())
  ) {
    throw announcementGovernanceRequestInvalid()
  }
  return {
    expectedRevision: parseRevision(value.expectedRevision),
    editIntent: value.editIntent,
    category: value.category,
    priority: value.priority,
    title: value.title,
    body: value.body,
    ...(Object.hasOwn(value, 'maintenance')
      ? { maintenance: normalizeMaintenance(value.maintenance) }
      : {}),
    ...(value.editIntent === 'important_update' ? { updateNote: value.updateNote as string } : {}),
  }
}

export const parseAnnouncementMaintenanceTransitionRequest = (
  value: unknown,
): AnnouncementMaintenanceTransitionRequest => {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      ['expectedRevision', 'status', 'actualCompletionTime'],
      ['expectedRevision', 'status'],
    ) ||
    typeof value.status !== 'string' ||
    !['scheduled', 'in_progress', 'completed'].includes(value.status)
  ) {
    throw announcementGovernanceRequestInvalid()
  }
  if (value.status === 'completed' && !Object.hasOwn(value, 'actualCompletionTime')) {
    throw announcementGovernanceRequestInvalid()
  }
  if (value.status !== 'completed' && Object.hasOwn(value, 'actualCompletionTime')) {
    throw announcementGovernanceRequestInvalid()
  }
  return {
    expectedRevision: parseRevision(value.expectedRevision),
    status: value.status as AnnouncementMaintenanceStatus,
    ...(value.status === 'completed'
      ? { actualCompletionTime: parseCanonicalDate(value.actualCompletionTime) }
      : {}),
  }
}

const maintenanceFields = [
  'status',
  'startsAt',
  'endsAt',
  'affectedAreas',
  'expectedImpact',
  'actualCompletionTime',
] as const

export const deriveAnnouncementGovernanceChanges = (
  current: AnnouncementAdminRecord,
  next: Readonly<Record<string, unknown>>,
): AnnouncementGovernanceChanges | undefined => {
  const fields: string[] = []
  for (const field of ['category', 'priority', 'title', 'body'] as const) {
    if (!isDeepStrictEqual(current[field], next[field])) fields.push(field)
  }
  const currentMaintenance = current.maintenance ?? undefined
  const nextMaintenance = next.maintenance as Record<string, unknown> | undefined
  for (const field of maintenanceFields) {
    if (!isDeepStrictEqual(currentMaintenance?.[field], nextMaintenance?.[field])) {
      fields.push(`maintenance.${field}`)
    }
  }
  const category =
    current.category !== next.category
      ? {
          from: current.category,
          to: next.category as AnnouncementCategory,
        }
      : undefined
  const priority =
    current.priority !== next.priority
      ? {
          from: current.priority,
          to: next.priority as AnnouncementPriority,
        }
      : undefined
  const currentStatus = currentMaintenance?.status
  const nextStatus = nextMaintenance?.status
  const maintenanceStatus =
    currentStatus !== undefined && nextStatus !== undefined && currentStatus !== nextStatus
      ? {
          from: currentStatus,
          to: nextStatus as AnnouncementMaintenanceStatus,
        }
      : undefined
  return fields.length > 0 || category || priority || maintenanceStatus
    ? {
        ...(fields.length > 0 ? { fields } : {}),
        ...(category ? { category } : {}),
        ...(priority ? { priority } : {}),
        ...(maintenanceStatus ? { maintenanceStatus } : {}),
      }
    : undefined
}

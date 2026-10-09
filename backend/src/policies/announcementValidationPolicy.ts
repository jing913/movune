import {
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_GOVERNANCE_STATUSES,
  ANNOUNCEMENT_MAINTENANCE_STATUSES,
  ANNOUNCEMENT_PRIORITIES,
  ANNOUNCEMENT_PUBLICATION_STATUSES,
} from './announcementLifecyclePolicy.js'
import { isAnnouncementRichText } from '../utils/announcementRichText.js'
import { ANNOUNCEMENT_EFFECTIVE_AT_BASES } from '../utils/announcementHistoricalPolicy.js'

export type AnnouncementValidationIssue = Readonly<{
  field: string
  code: 'required' | 'invalid' | 'not_allowed' | 'unsupported'
  message: string
}>

export type AnnouncementValidationResult = Readonly<{
  valid: boolean
  issues: readonly AnnouncementValidationIssue[]
}>

export type AnnouncementValidationInput = Readonly<{
  category?: unknown
  priority?: unknown
  title?: unknown
  body?: unknown
  publicationStatus?: unknown
  governanceStatus?: unknown
  effectiveAt?: unknown
  effectiveAtBasis?: unknown
  maintenance?: unknown
  revision?: unknown
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isValidDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.valueOf())

const isNonemptyTrimmedText = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value === value.trim()

const issue = (
  field: string,
  code: AnnouncementValidationIssue['code'],
  message: string,
): AnnouncementValidationIssue => ({ field, code, message })

const validateRequiredEnum = (
  issues: AnnouncementValidationIssue[],
  field: string,
  value: unknown,
  allowed: readonly string[],
) => {
  if (value === undefined) issues.push(issue(field, 'required', `${field} is required`))
  else if (typeof value !== 'string' || !allowed.includes(value)) {
    issues.push(issue(field, 'invalid', `${field} is invalid`))
  }
}

const validateOptionalRootState = (
  issues: AnnouncementValidationIssue[],
  input: AnnouncementValidationInput,
) => {
  if (
    input.publicationStatus !== undefined &&
    (typeof input.publicationStatus !== 'string' ||
      !(ANNOUNCEMENT_PUBLICATION_STATUSES as readonly string[]).includes(input.publicationStatus))
  ) {
    issues.push(issue('publicationStatus', 'invalid', 'publicationStatus is invalid'))
  }
  if (
    input.governanceStatus !== undefined &&
    (typeof input.governanceStatus !== 'string' ||
      !(ANNOUNCEMENT_GOVERNANCE_STATUSES as readonly string[]).includes(input.governanceStatus))
  ) {
    issues.push(issue('governanceStatus', 'invalid', 'governanceStatus is invalid'))
  }
  if (input.revision === undefined) {
    issues.push(issue('revision', 'required', 'revision is required'))
  } else if (!Number.isInteger(input.revision) || (input.revision as number) < 0) {
    issues.push(issue('revision', 'invalid', 'revision must be a non-negative integer'))
  }
}

const maintenanceKeys = [
  'status',
  'startsAt',
  'endsAt',
  'affectedAreas',
  'expectedImpact',
  'actualCompletionTime',
] as const

const validateMaintenance = (
  value: unknown,
  completeness: 'partial' | 'complete',
): AnnouncementValidationIssue[] => {
  if (!isRecord(value)) return [issue('maintenance', 'invalid', 'maintenance must be an object')]

  const issues: AnnouncementValidationIssue[] = []
  for (const key of Object.keys(value)) {
    if (!(maintenanceKeys as readonly string[]).includes(key)) {
      issues.push(issue(`maintenance.${key}`, 'unsupported', `${key} is not supported`))
    }
  }

  const required = (field: (typeof maintenanceKeys)[number]) => {
    if (completeness === 'complete' && value[field] === undefined) {
      issues.push(issue(`maintenance.${field}`, 'required', `${field} is required`))
      return true
    }
    return false
  }

  if (!required('status') && value.status !== undefined) {
    if (
      typeof value.status !== 'string' ||
      !(ANNOUNCEMENT_MAINTENANCE_STATUSES as readonly string[]).includes(value.status)
    ) {
      issues.push(issue('maintenance.status', 'invalid', 'maintenance status is invalid'))
    }
  }

  for (const field of ['startsAt', 'endsAt'] as const) {
    if (!required(field) && value[field] !== undefined && !isValidDate(value[field])) {
      issues.push(issue(`maintenance.${field}`, 'invalid', `${field} must be a valid Date`))
    }
  }
  if (isValidDate(value.startsAt) && isValidDate(value.endsAt) && value.startsAt >= value.endsAt) {
    issues.push(issue('maintenance.endsAt', 'invalid', 'endsAt must follow startsAt'))
  }

  if (!required('affectedAreas') && value.affectedAreas !== undefined) {
    if (
      !Array.isArray(value.affectedAreas) ||
      value.affectedAreas.length === 0 ||
      !value.affectedAreas.every(isNonemptyTrimmedText)
    ) {
      issues.push(
        issue('maintenance.affectedAreas', 'invalid', 'affectedAreas must contain valid values'),
      )
    }
  }

  if (
    !required('expectedImpact') &&
    value.expectedImpact !== undefined &&
    !isNonemptyTrimmedText(value.expectedImpact)
  ) {
    issues.push(
      issue(
        'maintenance.expectedImpact',
        'invalid',
        'expectedImpact must be non-empty and trimmed',
      ),
    )
  }

  if (value.actualCompletionTime !== undefined) {
    if (!isValidDate(value.actualCompletionTime)) {
      issues.push(
        issue(
          'maintenance.actualCompletionTime',
          'invalid',
          'actualCompletionTime must be a valid Date',
        ),
      )
    }
    if (value.status !== 'completed') {
      issues.push(
        issue(
          'maintenance.actualCompletionTime',
          'not_allowed',
          'actualCompletionTime is only allowed for completed maintenance',
        ),
      )
    }
  } else if (completeness === 'complete' && value.status === 'completed') {
    issues.push(
      issue(
        'maintenance.actualCompletionTime',
        'required',
        'actualCompletionTime is required for completed maintenance',
      ),
    )
  }

  return issues
}

const validateCommon = (input: AnnouncementValidationInput) => {
  const issues: AnnouncementValidationIssue[] = []
  validateRequiredEnum(
    issues,
    'category',
    input.category,
    ANNOUNCEMENT_CATEGORIES as readonly string[],
  )
  validateRequiredEnum(
    issues,
    'priority',
    input.priority,
    ANNOUNCEMENT_PRIORITIES as readonly string[],
  )
  validateOptionalRootState(issues, input)
  const hasEffectiveAt = input.effectiveAt !== undefined
  const hasEffectiveAtBasis = input.effectiveAtBasis !== undefined
  if (hasEffectiveAt !== hasEffectiveAtBasis) {
    issues.push(
      issue(
        hasEffectiveAt ? 'effectiveAtBasis' : 'effectiveAt',
        'required',
        'effectiveAt and effectiveAtBasis must be provided together',
      ),
    )
  }
  if (hasEffectiveAt && !isValidDate(input.effectiveAt)) {
    issues.push(issue('effectiveAt', 'invalid', 'effectiveAt must be a valid Date'))
  }
  if (
    hasEffectiveAtBasis &&
    (typeof input.effectiveAtBasis !== 'string' ||
      !(ANNOUNCEMENT_EFFECTIVE_AT_BASES as readonly string[]).includes(input.effectiveAtBasis))
  ) {
    issues.push(issue('effectiveAtBasis', 'invalid', 'effectiveAtBasis is invalid'))
  }
  return issues
}

const result = (issues: AnnouncementValidationIssue[]): AnnouncementValidationResult => ({
  valid: issues.length === 0,
  issues,
})

export const validateAnnouncementDraft = (
  input: AnnouncementValidationInput,
): AnnouncementValidationResult => {
  const issues = validateCommon(input)

  if (input.publicationStatus !== 'draft') {
    issues.push(issue('publicationStatus', 'invalid', 'Draft publicationStatus must be draft'))
  }
  if (input.governanceStatus !== 'normal') {
    issues.push(issue('governanceStatus', 'invalid', 'Draft governanceStatus must be normal'))
  }
  if (input.effectiveAt !== undefined || input.effectiveAtBasis !== undefined) {
    issues.push(
      issue(
        'effectiveAt',
        'not_allowed',
        'Historical metadata cannot be established through the Draft API',
      ),
    )
  }
  if (input.title !== undefined && !isNonemptyTrimmedText(input.title)) {
    issues.push(issue('title', 'invalid', 'title must be non-empty and trimmed'))
  }
  if (input.body !== undefined && !isAnnouncementRichText(input.body)) {
    issues.push(issue('body', 'invalid', 'body must satisfy the Announcement Rich Text contract'))
  }

  if (input.maintenance !== undefined) {
    if (input.category !== 'system_maintenance') {
      issues.push(
        issue('maintenance', 'not_allowed', 'maintenance is only allowed for system_maintenance'),
      )
    } else {
      issues.push(...validateMaintenance(input.maintenance, 'partial'))
    }
  }

  return result(issues)
}

export const validateAnnouncementForPublication = (
  input: AnnouncementValidationInput,
): AnnouncementValidationResult => {
  const issues = validateCommon(input)

  if (input.title === undefined) issues.push(issue('title', 'required', 'title is required'))
  else if (!isNonemptyTrimmedText(input.title)) {
    issues.push(issue('title', 'invalid', 'title must be non-empty and trimmed'))
  }

  if (input.body === undefined) issues.push(issue('body', 'required', 'body is required'))
  else if (!isAnnouncementRichText(input.body)) {
    issues.push(issue('body', 'invalid', 'body must satisfy the Announcement Rich Text contract'))
  }

  if (input.category === 'system_maintenance') {
    if (input.maintenance === undefined) {
      issues.push(issue('maintenance', 'required', 'maintenance is required'))
    } else {
      issues.push(...validateMaintenance(input.maintenance, 'complete'))
    }
  } else if (input.maintenance !== undefined) {
    issues.push(
      issue('maintenance', 'not_allowed', 'maintenance is only allowed for system_maintenance'),
    )
  }

  return result(issues)
}

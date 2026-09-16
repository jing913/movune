import { ApiProblem, invalidInput } from './messagingPolicy.js'

export const REPORT_DESCRIPTION_MAX_LENGTH = 1000

export type ReportReason = 'harassment_or_uncomfortable' | 'spam_or_suspicious' | 'other'

export type ReportRequest = Readonly<{
  reason: ReportReason
  description?: string
}>

const reasons = new Set<ReportReason>([
  'harassment_or_uncomfortable',
  'spam_or_suspicious',
  'other',
])

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export const parseReportRequest = (value: unknown): ReportRequest => {
  if (!isPlainObject(value)) throw invalidInput('reason')

  const keys = Object.keys(value)
  if (keys.some((key) => key !== 'reason' && key !== 'description')) {
    throw invalidInput('body')
  }
  if (!Object.hasOwn(value, 'reason')) throw invalidInput('reason')
  if (typeof value.reason !== 'string' || !reasons.has(value.reason as ReportReason)) {
    throw new ApiProblem(400, 'REPORT_INVALID_REASON', 'Report reason is invalid.', {
      field: 'reason',
    })
  }

  if (!Object.hasOwn(value, 'description')) return { reason: value.reason as ReportReason }
  if (typeof value.description !== 'string') throw invalidInput('description')
  const description = value.description.trim()
  if ([...description].length > REPORT_DESCRIPTION_MAX_LENGTH) {
    throw invalidInput('description')
  }
  return description
    ? { reason: value.reason as ReportReason, description }
    : { reason: value.reason as ReportReason }
}

export type IdentityEvidence =
  | { kind: 'MATCH' }
  | { kind: 'MISMATCH' }
  | { kind: 'UNKNOWN' }
  | { kind: 'CONFLICT' }

export type PersistenceEvidence =
  | { kind: 'COMMITTED'; graph: 'COMPLETE' }
  | { kind: 'COMMITTED'; graph: 'INCOMPLETE' }
  | { kind: 'NON_COMMITTED' }
  | { kind: 'UNKNOWN' }
  | { kind: 'CONFLICT' }

export type ReplayEligibility =
  | { kind: 'ELIGIBLE' }
  | { kind: 'EXPIRED' }
  | { kind: 'UNDETERMINED' }
  | { kind: 'CONFLICT' }

export type ReviewEvidence =
  | { kind: 'INDEPENDENTLY_AUTHORIZED' }
  | { kind: 'NOT_AUTHORIZED' }

export interface IS1EvidenceInput {
  identity: IdentityEvidence
  persistence: PersistenceEvidence
  normalReplay: ReplayEligibility
  review: ReviewEvidence
}

export type IS1Disposition = 'INTEGRITY_CONFLICT' | 'REJECT' | 'REPLAY_CANDIDATE'

export type IS1Reason =
  | 'INVALID_INPUT'
  | 'IDENTITY_CONFLICT'
  | 'PERSISTENCE_CONFLICT'
  | 'INCOMPLETE_PERSISTENCE'
  | 'REPLAY_ELIGIBILITY_CONFLICT'
  | 'INCOMPATIBLE_EVIDENCE'
  | 'IDENTITY_NOT_VERIFIED'
  | 'PERSISTENCE_NOT_PROVEN'
  | 'REPLAY_EXPIRED'
  | 'REPLAY_ELIGIBILITY_UNKNOWN'
  | 'REPLAY_CANDIDATE_ONLY'

export type IS1ReviewMarker =
  | 'REVIEW_PREREQUISITE_REPORTED'
  | 'NO_REVIEW_PREREQUISITE'

export interface IS1Classification {
  disposition: IS1Disposition
  reason: IS1Reason
  review: IS1ReviewMarker
}

const INVALID_CLASSIFICATION: Readonly<IS1Classification> = Object.freeze({
  disposition: 'REJECT',
  reason: 'INVALID_INPUT',
  review: 'NO_REVIEW_PREREQUISITE',
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]) => {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

const parseIdentity = (value: unknown): IdentityEvidence | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['kind'])) return null
  if (
    value.kind !== 'MATCH' &&
    value.kind !== 'MISMATCH' &&
    value.kind !== 'UNKNOWN' &&
    value.kind !== 'CONFLICT'
  ) {
    return null
  }
  return { kind: value.kind }
}

const parsePersistence = (value: unknown): PersistenceEvidence | null => {
  if (!isRecord(value) || typeof value.kind !== 'string') return null
  if (value.kind === 'COMMITTED') {
    if (
      !hasExactKeys(value, ['kind', 'graph']) ||
      (value.graph !== 'COMPLETE' && value.graph !== 'INCOMPLETE')
    ) {
      return null
    }
    return { kind: value.kind, graph: value.graph }
  }
  if (!hasExactKeys(value, ['kind'])) return null
  if (value.kind !== 'NON_COMMITTED' && value.kind !== 'UNKNOWN' && value.kind !== 'CONFLICT') {
    return null
  }
  return { kind: value.kind }
}

const parseNormalReplay = (value: unknown): ReplayEligibility | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['kind'])) return null
  if (
    value.kind !== 'ELIGIBLE' &&
    value.kind !== 'EXPIRED' &&
    value.kind !== 'UNDETERMINED' &&
    value.kind !== 'CONFLICT'
  ) {
    return null
  }
  return { kind: value.kind }
}

const parseReview = (value: unknown): ReviewEvidence | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['kind'])) return null
  if (value.kind !== 'INDEPENDENTLY_AUTHORIZED' && value.kind !== 'NOT_AUTHORIZED') {
    return null
  }
  return { kind: value.kind }
}

const parseInput = (input: unknown): IS1EvidenceInput | null => {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['identity', 'persistence', 'normalReplay', 'review'])
  ) {
    return null
  }
  const identity = parseIdentity(input.identity)
  const persistence = parsePersistence(input.persistence)
  const normalReplay = parseNormalReplay(input.normalReplay)
  const review = parseReview(input.review)
  if (!identity || !persistence || !normalReplay || !review) return null
  return { identity, persistence, normalReplay, review }
}

const result = (
  disposition: IS1Disposition,
  reason: IS1Reason,
  review: IS1ReviewMarker,
): Readonly<IS1Classification> => Object.freeze({ disposition, reason, review })

export const classifyCaseEvidence = (input: unknown): Readonly<IS1Classification> => {
  const parsed = parseInput(input)
  if (!parsed) return INVALID_CLASSIFICATION

  const review =
    parsed.review.kind === 'INDEPENDENTLY_AUTHORIZED'
      ? 'REVIEW_PREREQUISITE_REPORTED'
      : 'NO_REVIEW_PREREQUISITE'

  if (parsed.identity.kind === 'MISMATCH' || parsed.identity.kind === 'CONFLICT') {
    return result('INTEGRITY_CONFLICT', 'IDENTITY_CONFLICT', review)
  }
  if (parsed.persistence.kind === 'CONFLICT') {
    return result('INTEGRITY_CONFLICT', 'PERSISTENCE_CONFLICT', review)
  }
  if (parsed.persistence.kind === 'COMMITTED' && parsed.persistence.graph === 'INCOMPLETE') {
    return result('INTEGRITY_CONFLICT', 'INCOMPLETE_PERSISTENCE', review)
  }
  if (parsed.normalReplay.kind === 'CONFLICT') {
    return result('INTEGRITY_CONFLICT', 'REPLAY_ELIGIBILITY_CONFLICT', review)
  }
  if (
    (parsed.persistence.kind === 'NON_COMMITTED' || parsed.persistence.kind === 'UNKNOWN') &&
    parsed.normalReplay.kind === 'ELIGIBLE'
  ) {
    return result('INTEGRITY_CONFLICT', 'INCOMPATIBLE_EVIDENCE', review)
  }
  if (parsed.identity.kind === 'UNKNOWN') {
    return result('REJECT', 'IDENTITY_NOT_VERIFIED', review)
  }
  if (parsed.persistence.kind !== 'COMMITTED' || parsed.persistence.graph !== 'COMPLETE') {
    return result('REJECT', 'PERSISTENCE_NOT_PROVEN', review)
  }
  if (parsed.normalReplay.kind === 'EXPIRED') {
    return result('REJECT', 'REPLAY_EXPIRED', review)
  }
  if (parsed.normalReplay.kind === 'UNDETERMINED') {
    return result('REJECT', 'REPLAY_ELIGIBILITY_UNKNOWN', review)
  }
  return result('REPLAY_CANDIDATE', 'REPLAY_CANDIDATE_ONLY', review)
}

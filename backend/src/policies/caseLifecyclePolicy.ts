export const CASE_STATES = Object.freeze([
  'needs_review',
  'under_review',
  'review_completed',
] as const)

export type CaseState = (typeof CASE_STATES)[number]

export const FINAL_REVIEW_CONCLUSIONS = Object.freeze([
  'violation_confirmed',
  'no_violation_found',
  'insufficient_evidence',
] as const)

export type FinalReviewConclusion = (typeof FINAL_REVIEW_CONCLUSIONS)[number]

export const CASE_TRANSITION_ACTIONS = Object.freeze(['begin_review', 'finalize_review'] as const)

export type CaseTransitionAction = (typeof CASE_TRANSITION_ACTIONS)[number]

export type CaseTransitionFailureReason =
  | 'malformed-input'
  | 'unsupported-action'
  | 'unsupported-state'
  | 'invalid-revision'
  | 'stale-state'
  | 'stale-revision'
  | 'already-started'
  | 'already-finalized'
  | 'invalid-transition'

export type CaseTransitionDecision =
  | Readonly<{
      ok: true
      action: CaseTransitionAction
      fromState: CaseState
      toState: CaseState
      currentRevision: number
      nextRevision: number
    }>
  | Readonly<{
      ok: false
      reason: CaseTransitionFailureReason
    }>

export type ReviewRationaleFailureReason =
  'rationale-invalid-type' | 'rationale-required' | 'rationale-too-long'

export type ReviewRationaleDecision =
  | Readonly<{
      ok: true
      rationale: string
      codePointLength: number
    }>
  | Readonly<{
      ok: false
      reason: ReviewRationaleFailureReason
    }>

export type FinalReviewDecisionValidationFailureReason =
  | 'malformed-input'
  | 'unsupported-conclusion'
  | 'invalid-reviewer-provenance'
  | ReviewRationaleFailureReason

export type FinalReviewDecisionValidation =
  | Readonly<{
      ok: true
      conclusion: FinalReviewConclusion
      rationale: string
      reviewStartedByUserId: string
      decidedByUserId: string
    }>
  | Readonly<{
      ok: false
      reason: FinalReviewDecisionValidationFailureReason
    }>

export type CaseOperationReplayDecision =
  | Readonly<{ ok: true; kind: 'new-operation' | 'same-operation-replay' }>
  | Readonly<{ ok: false; reason: 'malformed-input' | 'operation-id-reused' }>

const MAX_RATIONALE_CODE_POINTS = 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actualKeys = Object.keys(value)
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

const isOneOf = <Value extends string>(
  value: unknown,
  permitted: readonly Value[],
): value is Value => typeof value === 'string' && permitted.includes(value as Value)

export const isCaseState = (value: unknown): value is CaseState => isOneOf(value, CASE_STATES)

export const isFinalReviewConclusion = (value: unknown): value is FinalReviewConclusion =>
  isOneOf(value, FINAL_REVIEW_CONCLUSIONS)

export const isAllowedCaseTransition = (fromState: unknown, toState: unknown) =>
  isCaseState(fromState) &&
  isCaseState(toState) &&
  ((fromState === 'needs_review' && toState === 'under_review') ||
    (fromState === 'under_review' && toState === 'review_completed'))

const transitionFailure = (reason: CaseTransitionFailureReason): CaseTransitionDecision =>
  Object.freeze({ ok: false, reason })

/**
 * Evaluates the conceptual Case transition only. Future persistence services
 * must independently provide authorization, atomic compare-and-set behavior,
 * uniqueness, idempotency storage, and durable audit provenance.
 */
export const evaluateCaseTransition = (value: unknown): CaseTransitionDecision => {
  const keys = [
    'action',
    'currentState',
    'expectedState',
    'currentRevision',
    'expectedRevision',
  ] as const

  if (!isRecord(value) || !hasExactlyKeys(value, keys)) {
    return transitionFailure('malformed-input')
  }

  if (!isOneOf(value.action, CASE_TRANSITION_ACTIONS)) {
    return transitionFailure('unsupported-action')
  }
  if (!isCaseState(value.currentState) || !isCaseState(value.expectedState)) {
    return transitionFailure('unsupported-state')
  }
  if (
    !Number.isSafeInteger(value.currentRevision) ||
    (value.currentRevision as number) < 0 ||
    (value.currentRevision as number) >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(value.expectedRevision) ||
    (value.expectedRevision as number) < 0
  ) {
    return transitionFailure('invalid-revision')
  }
  if (value.expectedState !== value.currentState) return transitionFailure('stale-state')
  if (value.expectedRevision !== value.currentRevision) return transitionFailure('stale-revision')

  if (value.action === 'begin_review') {
    if (value.currentState === 'under_review') return transitionFailure('already-started')
    if (value.currentState === 'review_completed') return transitionFailure('already-finalized')

    return Object.freeze({
      ok: true,
      action: value.action,
      fromState: value.currentState,
      toState: 'under_review',
      currentRevision: value.currentRevision as number,
      nextRevision: (value.currentRevision as number) + 1,
    })
  }

  if (value.currentState === 'review_completed') return transitionFailure('already-finalized')
  if (value.currentState !== 'under_review') return transitionFailure('invalid-transition')

  return Object.freeze({
    ok: true,
    action: value.action,
    fromState: value.currentState,
    toState: 'review_completed',
    currentRevision: value.currentRevision as number,
    nextRevision: (value.currentRevision as number) + 1,
  })
}

export const validateReviewRationale = (value: unknown): ReviewRationaleDecision => {
  if (typeof value !== 'string') {
    return Object.freeze({ ok: false, reason: 'rationale-invalid-type' })
  }

  const rationale = value.trim()
  const codePointLength = [...rationale].length
  if (codePointLength === 0) return Object.freeze({ ok: false, reason: 'rationale-required' })
  if (codePointLength > MAX_RATIONALE_CODE_POINTS) {
    return Object.freeze({ ok: false, reason: 'rationale-too-long' })
  }

  return Object.freeze({ ok: true, rationale, codePointLength })
}

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

/**
 * Validates only minimized decision metadata. Unexpected fields are rejected so
 * Report descriptions and protected evidence cannot become policy inputs.
 */
export const validateFinalReviewDecision = (value: unknown): FinalReviewDecisionValidation => {
  const keys = ['conclusion', 'rationale', 'reviewStartedByUserId', 'decidedByUserId'] as const

  if (!isRecord(value) || !hasExactlyKeys(value, keys)) {
    return Object.freeze({ ok: false, reason: 'malformed-input' })
  }
  if (!isFinalReviewConclusion(value.conclusion)) {
    return Object.freeze({ ok: false, reason: 'unsupported-conclusion' })
  }
  if (!isIdentifier(value.reviewStartedByUserId) || !isIdentifier(value.decidedByUserId)) {
    return Object.freeze({ ok: false, reason: 'invalid-reviewer-provenance' })
  }

  const rationale = validateReviewRationale(value.rationale)
  if (!rationale.ok) return rationale

  return Object.freeze({
    ok: true,
    conclusion: value.conclusion,
    rationale: rationale.rationale,
    reviewStartedByUserId: value.reviewStartedByUserId.trim(),
    decidedByUserId: value.decidedByUserId.trim(),
  })
}

/**
 * Classifies already-loaded idempotency metadata. It does not load, reserve, or
 * persist operation IDs and therefore provides no database-backed guarantee.
 */
export const classifyCaseOperationReplay = (value: unknown): CaseOperationReplayDecision => {
  const keys = ['operationId', 'commandDigest', 'storedCommandDigest'] as const
  if (!isRecord(value) || !hasExactlyKeys(value, keys)) {
    return Object.freeze({ ok: false, reason: 'malformed-input' })
  }

  if (
    !isIdentifier(value.operationId) ||
    !isIdentifier(value.commandDigest) ||
    (value.storedCommandDigest !== null && !isIdentifier(value.storedCommandDigest))
  ) {
    return Object.freeze({ ok: false, reason: 'malformed-input' })
  }

  if (value.storedCommandDigest === null) {
    return Object.freeze({ ok: true, kind: 'new-operation' })
  }
  if (value.storedCommandDigest === value.commandDigest) {
    return Object.freeze({ ok: true, kind: 'same-operation-replay' })
  }
  return Object.freeze({ ok: false, reason: 'operation-id-reused' })
}

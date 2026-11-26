import type { PersistenceEvidence } from '../policies/caseEvidenceClassificationPolicy.js'
import {
  createCasePersistenceEvidenceReader,
  type CasePersistenceReaderProvenance,
} from './casePersistenceEvidenceReader.js'

export type ProviderPersistenceEvidence = Exclude<
  PersistenceEvidence,
  Readonly<{ kind: 'NON_COMMITTED' }>
>

export type CasePersistenceEvidenceProviderResult =
  | Readonly<{
      kind: 'EVIDENCE_READY'
      persistence: ProviderPersistenceEvidence
      provenance: CasePersistenceReaderProvenance
    }>
  | Readonly<{
      kind: 'EVIDENCE_UNAVAILABLE'
      reason: 'INVALID_CONTEXT' | 'SOURCE_UNAVAILABLE'
    }>

type CasePersistenceEvidenceReaderPort = Readonly<{
  observe(input: unknown): Promise<unknown>
}>

export type CasePersistenceEvidenceProviderDependencies = Readonly<{
  reader?: CasePersistenceEvidenceReaderPort
}>

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]) => {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

const CANONICAL_PROVENANCE: CasePersistenceReaderProvenance = Object.freeze({
  source: 'server-controlled-mongodb',
  mode: 'post-transaction-read-only-snapshot',
  readPreference: 'primary',
  readConcern: 'snapshot',
  transactionWriteConcern: 'majority',
})

const validProvenance = (value: unknown) =>
  isPlainRecord(value) &&
  hasExactKeys(value, [
    'source',
    'mode',
    'readPreference',
    'readConcern',
    'transactionWriteConcern',
  ]) &&
  value.source === CANONICAL_PROVENANCE.source &&
  value.mode === CANONICAL_PROVENANCE.mode &&
  value.readPreference === CANONICAL_PROVENANCE.readPreference &&
  value.readConcern === CANONICAL_PROVENANCE.readConcern &&
  value.transactionWriteConcern === CANONICAL_PROVENANCE.transactionWriteConcern

const exactKind = (value: unknown, kind: string) =>
  isPlainRecord(value) && hasExactKeys(value, ['kind']) && value.kind === kind

type ValidatedReaderResult =
  | Readonly<{ kind: 'observed'; graph: 'COMPLETE' | 'INCOMPLETE' }>
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'unavailable'; reason: 'INVALID_REQUEST' | 'SOURCE_UNAVAILABLE' }>

const validateReaderResult = (value: unknown): ValidatedReaderResult | null => {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return null
  if (value.kind === 'observed') {
    if (
      !hasExactKeys(value, ['kind', 'identity', 'persistence', 'reason', 'provenance']) ||
      !exactKind(value.identity, 'MATCH') ||
      !isPlainRecord(value.persistence) ||
      !hasExactKeys(value.persistence, ['kind', 'graph']) ||
      value.persistence.kind !== 'COMMITTED' ||
      (value.persistence.graph !== 'COMPLETE' && value.persistence.graph !== 'INCOMPLETE') ||
      value.reason !== `${value.persistence.graph}_GRAPH` ||
      !validProvenance(value.provenance)
    ) {
      return null
    }
    return Object.freeze({ kind: value.kind, graph: value.persistence.graph })
  }
  if (value.kind === 'unknown') {
    if (
      !hasExactKeys(value, ['kind', 'identity', 'persistence', 'reason', 'provenance']) ||
      !exactKind(value.identity, 'UNKNOWN') ||
      !exactKind(value.persistence, 'UNKNOWN') ||
      value.reason !== 'EVENT_NOT_FOUND' ||
      !validProvenance(value.provenance)
    ) {
      return null
    }
    return Object.freeze({ kind: value.kind })
  }
  if (value.kind === 'conflict') {
    if (
      !hasExactKeys(value, ['kind', 'identity', 'persistence', 'reason', 'provenance']) ||
      !exactKind(value.identity, 'CONFLICT') ||
      !exactKind(value.persistence, 'CONFLICT') ||
      (value.reason !== 'MALFORMED_EVENT' && value.reason !== 'OPERATION_BINDING_CONFLICT') ||
      !validProvenance(value.provenance)
    ) {
      return null
    }
    return Object.freeze({ kind: value.kind })
  }
  if (value.kind === 'unavailable') {
    if (
      !hasExactKeys(value, ['kind', 'reason', 'provenance']) ||
      (value.reason !== 'INVALID_REQUEST' && value.reason !== 'SOURCE_UNAVAILABLE') ||
      !validProvenance(value.provenance)
    ) {
      return null
    }
    return Object.freeze({ kind: value.kind, reason: value.reason })
  }
  return null
}

const sanitizeOperationContext = (value: unknown): Readonly<Record<string, unknown>> | null => {
  if (!isPlainRecord(value)) return null
  if (value.kind === 'begin_review') {
    if (!hasExactKeys(value, ['kind', 'operationId', 'reportId', 'actorUserId'])) return null
    return Object.freeze({
      kind: value.kind,
      operationId: value.operationId,
      reportId: value.reportId,
      actorUserId: value.actorUserId,
    })
  }
  if (value.kind !== 'finalize_review') return null
  if (
    !hasExactKeys(value, [
      'kind',
      'operationId',
      'reportId',
      'caseId',
      'actorUserId',
      'expectedRevision',
      'conclusion',
      'rationale',
    ])
  ) {
    return null
  }
  return Object.freeze({
    kind: value.kind,
    operationId: value.operationId,
    reportId: value.reportId,
    caseId: value.caseId,
    actorUserId: value.actorUserId,
    expectedRevision: value.expectedRevision,
    conclusion: value.conclusion,
    rationale: value.rationale,
  })
}

const ready = (
  persistence: ProviderPersistenceEvidence,
  provenance: CasePersistenceReaderProvenance,
): CasePersistenceEvidenceProviderResult =>
  Object.freeze({
    kind: 'EVIDENCE_READY',
    persistence: Object.freeze({ ...persistence }),
    provenance,
  })

const unavailable = (
  reason: 'INVALID_CONTEXT' | 'SOURCE_UNAVAILABLE',
): CasePersistenceEvidenceProviderResult => Object.freeze({ kind: 'EVIDENCE_UNAVAILABLE', reason })

const mapReaderResult = (
  result: ValidatedReaderResult,
): CasePersistenceEvidenceProviderResult => {
  if (result.kind === 'observed') {
    return ready(Object.freeze({ kind: 'COMMITTED', graph: result.graph }), CANONICAL_PROVENANCE)
  }
  if (result.kind === 'unknown') {
    return ready(Object.freeze({ kind: 'UNKNOWN' }), CANONICAL_PROVENANCE)
  }
  if (result.kind === 'conflict') {
    return ready(Object.freeze({ kind: 'CONFLICT' }), CANONICAL_PROVENANCE)
  }
  return unavailable(result.reason === 'INVALID_REQUEST' ? 'INVALID_CONTEXT' : 'SOURCE_UNAVAILABLE')
}

export const createCasePersistenceEvidenceProvider = (
  dependencies: CasePersistenceEvidenceProviderDependencies = {},
) => {
  const reader = dependencies.reader ?? createCasePersistenceEvidenceReader()
  return Object.freeze({
    async read(serverConstructedContext: unknown): Promise<CasePersistenceEvidenceProviderResult> {
      const context = sanitizeOperationContext(serverConstructedContext)
      if (!context) return unavailable('INVALID_CONTEXT')
      try {
        const result = validateReaderResult(await reader.observe(context))
        return result ? mapReaderResult(result) : unavailable('SOURCE_UNAVAILABLE')
      } catch {
        return unavailable('SOURCE_UNAVAILABLE')
      }
    },
  })
}

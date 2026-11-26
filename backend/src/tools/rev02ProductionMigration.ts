export const REV02_PRODUCTION_DATABASE = 'test' as const
export const REV02_ENFORCEMENT_COLLECTION = 'accountenforcementactions' as const
export const REV02_AUDIT_COLLECTION = 'accountenforcementreversalauditevents' as const

export type IndexKey = Readonly<Record<string, number>>

export type RequiredIndex = Readonly<{
  collection: typeof REV02_ENFORCEMENT_COLLECTION | typeof REV02_AUDIT_COLLECTION
  key: IndexKey
  options: Readonly<{
    name: string
    unique?: boolean
    partialFilterExpression?: Readonly<Record<string, unknown>>
  }>
}>

export const REV02_REQUIRED_INDEXES: readonly RequiredIndex[] = Object.freeze([
  Object.freeze({
    collection: REV02_ENFORCEMENT_COLLECTION,
    key: Object.freeze({ operationId: 1 }),
    options: Object.freeze({
      name: 'operationId_1',
      unique: true,
      partialFilterExpression: Object.freeze({
        operationId: Object.freeze({ $exists: true }),
      }),
    }),
  }),
  Object.freeze({
    collection: REV02_AUDIT_COLLECTION,
    key: Object.freeze({ attemptId: 1, eventType: 1 }),
    options: Object.freeze({
      name: 'reversal_audit_attempt_event_unique',
      unique: true,
    }),
  }),
  Object.freeze({
    collection: REV02_AUDIT_COLLECTION,
    key: Object.freeze({ actorUserId: 1, occurredAt: 1, _id: 1 }),
    options: Object.freeze({ name: 'reversal_audit_actor_history' }),
  }),
])

export type CollectionMetadata = Readonly<{ name: string; type: string }>

export type IndexMetadata = Readonly<{
  name?: string
  key?: IndexKey
  unique?: boolean
  sparse?: boolean
  hidden?: boolean
  expireAfterSeconds?: number
  partialFilterExpression?: unknown
  collation?: Readonly<{ locale?: string }>
}>

export type DuplicatePreflight = Readonly<{
  status: 'VERIFIED' | 'NOT_VERIFIED'
  eligibleRecords: number
  duplicateGroups: number
}>

export type MigrationAction =
  | Readonly<{ type: 'createCollection'; collection: typeof REV02_AUDIT_COLLECTION }>
  | Readonly<{
      type: 'createIndex'
      collection: RequiredIndex['collection']
      name: string
    }>

export type MigrationPlan = Readonly<{
  actions: readonly MigrationAction[]
  operationIdPreflight: DuplicatePreflight | null
}>

export type MigrationResult = Readonly<{
  schemaVersion: 1
  status: 'DRY_RUN_READY' | 'APPLIED' | 'NO_OP'
  mode: 'dry-run' | 'apply'
  database: typeof REV02_PRODUCTION_DATABASE
  actions: readonly MigrationAction[]
  operationIdDuplicateSafety: 'VERIFIED' | 'NOT_REQUIRED'
  operationIdPreflight: DuplicatePreflight | null
}>

export interface Rev02MigrationAdapter {
  readonly databaseName: string
  listCollections(names: readonly string[]): Promise<readonly CollectionMetadata[]>
  listIndexes(collection: string): Promise<readonly IndexMetadata[]>
  preflightOperationIdDuplicates(): Promise<DuplicatePreflight>
  createCollection(name: typeof REV02_AUDIT_COLLECTION): Promise<void>
  createIndex(definition: RequiredIndex): Promise<void>
}

export class Rev02MigrationError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'Rev02MigrationError'
    this.code = code
  }
}

const stop = (code: string): never => {
  throw new Rev02MigrationError(code)
}

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Readonly<Record<string, unknown>>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    )
  }
  return value
}

const sameDocument = (left: unknown, right: unknown) =>
  JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))

const sameOrderedKey = (left: IndexKey | undefined, right: IndexKey) =>
  JSON.stringify(Object.entries(left ?? {})) === JSON.stringify(Object.entries(right))

const matchingIndex = (observed: IndexMetadata, expected: RequiredIndex) =>
  observed.name === expected.options.name &&
  sameOrderedKey(observed.key, expected.key) &&
  (observed.unique === true) === (expected.options.unique === true) &&
  sameDocument(observed.partialFilterExpression, expected.options.partialFilterExpression) &&
  observed.sparse !== true &&
  observed.hidden !== true &&
  observed.expireAfterSeconds === undefined &&
  (observed.collation === undefined || observed.collation.locale === 'simple')

const validatePreflight = (preflight: DuplicatePreflight) => {
  if (
    preflight.status !== 'VERIFIED' ||
    !Number.isSafeInteger(preflight.eligibleRecords) ||
    preflight.eligibleRecords < 0 ||
    !Number.isSafeInteger(preflight.duplicateGroups) ||
    preflight.duplicateGroups < 0
  ) {
    stop('OPERATION_ID_DUPLICATE_PREFLIGHT_NOT_VERIFIED')
  }
  if (preflight.duplicateGroups > 0) stop('OPERATION_ID_DUPLICATES_FOUND')
}

const inspectIndex = (
  indexes: readonly IndexMetadata[],
  expected: RequiredIndex,
): 'MATCH' | 'MISSING' => {
  const named = indexes.find(({ name }) => name === expected.options.name)
  if (named) {
    if (!matchingIndex(named, expected)) stop(`INDEX_CONFLICT_${expected.options.name}`)
    return 'MATCH'
  }
  if (indexes.some((index) => sameOrderedKey(index.key, expected.key))) {
    stop(`INDEX_KEY_CONFLICT_${expected.options.name}`)
  }
  return 'MISSING'
}

export const inspectRev02ProductionMigration = async (
  adapter: Rev02MigrationAdapter,
): Promise<MigrationPlan> => {
  if (adapter.databaseName !== REV02_PRODUCTION_DATABASE) stop('TARGET_DATABASE_MISMATCH')

  const requestedCollections = [REV02_ENFORCEMENT_COLLECTION, REV02_AUDIT_COLLECTION] as const
  const collections = await adapter.listCollections(requestedCollections)
  if (collections.some(({ name }) => !requestedCollections.includes(name as never))) {
    stop('UNEXPECTED_COLLECTION_METADATA')
  }
  const enforcement = collections.find(({ name }) => name === REV02_ENFORCEMENT_COLLECTION)
  if (!enforcement) return stop('ENFORCEMENT_COLLECTION_MISSING')
  if (enforcement.type !== 'collection') stop('ENFORCEMENT_COLLECTION_CONFLICT')

  const audit = collections.find(({ name }) => name === REV02_AUDIT_COLLECTION)
  if (audit && audit.type !== 'collection') stop('AUDIT_COLLECTION_CONFLICT')

  const indexes = new Map<string, readonly IndexMetadata[]>()
  indexes.set(REV02_ENFORCEMENT_COLLECTION, await adapter.listIndexes(REV02_ENFORCEMENT_COLLECTION))
  if (audit) indexes.set(REV02_AUDIT_COLLECTION, await adapter.listIndexes(REV02_AUDIT_COLLECTION))

  const actions: MigrationAction[] = []
  if (!audit) actions.push({ type: 'createCollection', collection: REV02_AUDIT_COLLECTION })

  for (const definition of REV02_REQUIRED_INDEXES) {
    const current = indexes.get(definition.collection) ?? []
    if (inspectIndex(current, definition) === 'MISSING') {
      actions.push({
        type: 'createIndex',
        collection: definition.collection,
        name: definition.options.name,
      })
    }
  }

  const operationIndexMissing = actions.some(
    (action) => action.type === 'createIndex' && action.name === 'operationId_1',
  )
  const operationIdPreflight = operationIndexMissing
    ? await adapter.preflightOperationIdDuplicates()
    : null
  if (operationIdPreflight) validatePreflight(operationIdPreflight)

  return Object.freeze({
    actions: Object.freeze(actions),
    operationIdPreflight,
  })
}

const applyAction = async (adapter: Rev02MigrationAdapter, action: MigrationAction) => {
  if (action.type === 'createCollection') {
    await adapter.createCollection(action.collection)
    return
  }
  const definition = REV02_REQUIRED_INDEXES.find(
    (candidate) =>
      candidate.collection === action.collection && candidate.options.name === action.name,
  )
  if (!definition) return stop('INTERNAL_INDEX_ALLOWLIST_FAILURE')
  await adapter.createIndex(definition)
}

export const runRev02ProductionMigration = async (
  adapter: Rev02MigrationAdapter,
  mode: 'dry-run' | 'apply' = 'dry-run',
): Promise<MigrationResult> => {
  const plan = await inspectRev02ProductionMigration(adapter)
  const duplicateSafety = plan.operationIdPreflight ? 'VERIFIED' : 'NOT_REQUIRED'

  if (mode === 'dry-run') {
    return Object.freeze({
      schemaVersion: 1,
      status: plan.actions.length === 0 ? 'NO_OP' : 'DRY_RUN_READY',
      mode,
      database: REV02_PRODUCTION_DATABASE,
      actions: plan.actions,
      operationIdDuplicateSafety: duplicateSafety,
      operationIdPreflight: plan.operationIdPreflight,
    })
  }

  if (plan.actions.length === 0) {
    return Object.freeze({
      schemaVersion: 1,
      status: 'NO_OP',
      mode,
      database: REV02_PRODUCTION_DATABASE,
      actions: plan.actions,
      operationIdDuplicateSafety: duplicateSafety,
      operationIdPreflight: plan.operationIdPreflight,
    })
  }

  try {
    for (const action of plan.actions) await applyAction(adapter, action)
  } catch (error) {
    if (
      error instanceof Rev02MigrationError ||
      (error instanceof Error && error.name === 'Rev02MongoOperationFailure')
    ) {
      throw error
    }
    stop('MIGRATION_APPLY_FAILED')
  }

  const verification = await inspectRev02ProductionMigration(adapter)
  if (verification.actions.length !== 0) stop('POST_APPLY_VERIFICATION_FAILED')

  return Object.freeze({
    schemaVersion: 1,
    status: 'APPLIED',
    mode,
    database: REV02_PRODUCTION_DATABASE,
    actions: plan.actions,
    operationIdDuplicateSafety: duplicateSafety,
    operationIdPreflight: plan.operationIdPreflight,
  })
}

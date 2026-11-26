import test from 'node:test'
import assert from 'node:assert/strict'
import { MongoServerError } from 'mongodb'
import {
  REV02_AUDIT_COLLECTION,
  REV02_ENFORCEMENT_COLLECTION,
  REV02_REQUIRED_INDEXES,
  Rev02MigrationError,
  runRev02ProductionMigration,
} from '../dist/tools/rev02ProductionMigration.js'
import {
  REV02_APPLY_ACK,
  REV02_PRODUCTION_ACK,
  REV02_TEST_ACK,
  parseRev02MigrationCli,
  safeMongoOperationDiagnostic,
  validateRev02MigrationConfiguration,
} from '../dist/tools/runRev02ProductionMigration.js'

const enforcementBaseIndexes = () => [
  { name: '_id_', key: { _id: 1 } },
  {
    name: 'reversesDecisionId_1',
    key: { reversesDecisionId: 1 },
    unique: true,
    partialFilterExpression: { recordType: 'reversal' },
  },
]

const asIndexMetadata = (definition) => ({
  name: definition.options.name,
  key: { ...definition.key },
  ...(definition.options.unique === true ? { unique: true } : {}),
  ...(definition.options.partialFilterExpression
    ? { partialFilterExpression: structuredClone(definition.options.partialFilterExpression) }
    : {}),
})

class MockAdapter {
  databaseName = 'test'

  constructor({
    auditExists = false,
    allRequiredIndexes = false,
    preflight = { status: 'VERIFIED', eligibleRecords: 3, duplicateGroups: 0 },
  } = {}) {
    this.collections = new Map([[REV02_ENFORCEMENT_COLLECTION, 'collection']])
    this.indexes = new Map([[REV02_ENFORCEMENT_COLLECTION, enforcementBaseIndexes()]])
    if (auditExists) {
      this.collections.set(REV02_AUDIT_COLLECTION, 'collection')
      this.indexes.set(REV02_AUDIT_COLLECTION, [{ name: '_id_', key: { _id: 1 } }])
    }
    if (allRequiredIndexes) {
      this.collections.set(REV02_AUDIT_COLLECTION, 'collection')
      for (const definition of REV02_REQUIRED_INDEXES) {
        const indexes = this.indexes.get(definition.collection) ?? [
          { name: '_id_', key: { _id: 1 } },
        ]
        indexes.push(asIndexMetadata(definition))
        this.indexes.set(definition.collection, indexes)
      }
    }
    this.preflight = preflight
    this.preflightCalls = 0
    this.writes = []
    this.failOnWrite = null
    this.writeAttempts = 0
  }

  async listCollections(names) {
    return names.flatMap((name) => {
      const type = this.collections.get(name)
      return type ? [{ name, type }] : []
    })
  }

  async listIndexes(collection) {
    return structuredClone(this.indexes.get(collection) ?? [])
  }

  async preflightOperationIdDuplicates() {
    this.preflightCalls += 1
    return this.preflight
  }

  async createCollection(name) {
    this.#beforeWrite()
    this.writes.push({ type: 'createCollection', collection: name })
    this.collections.set(name, 'collection')
    this.indexes.set(name, [{ name: '_id_', key: { _id: 1 } }])
  }

  async createIndex(definition) {
    this.#beforeWrite()
    this.writes.push({
      type: 'createIndex',
      collection: definition.collection,
      name: definition.options.name,
    })
    this.indexes.get(definition.collection).push(asIndexMetadata(definition))
  }

  #beforeWrite() {
    this.writeAttempts += 1
    if (this.failOnWrite === this.writeAttempts) throw new Error('synthetic write failure')
  }
}

test('fixed migration delta contains only the audit collection and three RC indexes', () => {
  assert.equal(REV02_AUDIT_COLLECTION, 'accountenforcementreversalauditevents')
  assert.deepEqual(
    REV02_REQUIRED_INDEXES.map(({ collection, key, options }) => ({
      collection,
      key,
      options,
    })),
    [
      {
        collection: 'accountenforcementactions',
        key: { operationId: 1 },
        options: {
          name: 'operationId_1',
          unique: true,
          partialFilterExpression: { operationId: { $exists: true } },
        },
      },
      {
        collection: 'accountenforcementreversalauditevents',
        key: { attemptId: 1, eventType: 1 },
        options: { name: 'reversal_audit_attempt_event_unique', unique: true },
      },
      {
        collection: 'accountenforcementreversalauditevents',
        key: { actorUserId: 1, occurredAt: 1, _id: 1 },
        options: { name: 'reversal_audit_actor_history' },
      },
    ],
  )
})

test('dry-run plans the empty target delta and performs no writes', async () => {
  const adapter = new MockAdapter()
  const result = await runRev02ProductionMigration(adapter)
  assert.equal(result.status, 'DRY_RUN_READY')
  assert.equal(result.mode, 'dry-run')
  assert.equal(result.operationIdDuplicateSafety, 'VERIFIED')
  assert.deepEqual(result.operationIdPreflight, {
    status: 'VERIFIED',
    eligibleRecords: 3,
    duplicateGroups: 0,
  })
  assert.deepEqual(result.actions, [
    { type: 'createCollection', collection: REV02_AUDIT_COLLECTION },
    {
      type: 'createIndex',
      collection: REV02_ENFORCEMENT_COLLECTION,
      name: 'operationId_1',
    },
    {
      type: 'createIndex',
      collection: REV02_AUDIT_COLLECTION,
      name: 'reversal_audit_attempt_event_unique',
    },
    {
      type: 'createIndex',
      collection: REV02_AUDIT_COLLECTION,
      name: 'reversal_audit_actor_history',
    },
  ])
  assert.equal(adapter.preflightCalls, 1)
  assert.deepEqual(adapter.writes, [])
})

test('apply creates only the allowlisted delta and repeated execution is a no-op', async () => {
  const adapter = new MockAdapter()
  const first = await runRev02ProductionMigration(adapter, 'apply')
  assert.equal(first.status, 'APPLIED')
  assert.deepEqual(adapter.writes, first.actions)
  assert.ok(
    adapter.indexes
      .get(REV02_ENFORCEMENT_COLLECTION)
      .some(({ name }) => name === 'reversesDecisionId_1'),
  )

  const writesAfterFirstRun = adapter.writes.length
  const second = await runRev02ProductionMigration(adapter, 'apply')
  assert.equal(second.status, 'NO_OP')
  assert.equal(adapter.writes.length, writesAfterFirstRun)
})

test('existing compatible objects are skipped without a duplicate preflight', async () => {
  const adapter = new MockAdapter({ auditExists: true, allRequiredIndexes: true })
  const result = await runRev02ProductionMigration(adapter)
  assert.equal(result.status, 'NO_OP')
  assert.equal(result.operationIdDuplicateSafety, 'NOT_REQUIRED')
  assert.equal(adapter.preflightCalls, 0)
  assert.deepEqual(adapter.writes, [])
})

test('operationId index is blocked when duplicate safety is missing or fails', async (t) => {
  await t.test('not verified', async () => {
    const adapter = new MockAdapter({
      preflight: { status: 'NOT_VERIFIED', eligibleRecords: 0, duplicateGroups: 0 },
    })
    await assert.rejects(runRev02ProductionMigration(adapter, 'apply'), {
      code: 'OPERATION_ID_DUPLICATE_PREFLIGHT_NOT_VERIFIED',
    })
    assert.deepEqual(adapter.writes, [])
  })

  await t.test('duplicates found', async () => {
    const adapter = new MockAdapter({
      preflight: { status: 'VERIFIED', eligibleRecords: 4, duplicateGroups: 1 },
    })
    await assert.rejects(runRev02ProductionMigration(adapter, 'apply'), {
      code: 'OPERATION_ID_DUPLICATES_FOUND',
    })
    assert.deepEqual(adapter.writes, [])
  })
})

test('index name, key, and option conflicts fail closed before writes', async (t) => {
  await t.test('same name with incompatible unique option', async () => {
    const adapter = new MockAdapter()
    adapter.indexes.get(REV02_ENFORCEMENT_COLLECTION).push({
      name: 'operationId_1',
      key: { operationId: 1 },
    })
    await assert.rejects(runRev02ProductionMigration(adapter, 'apply'), {
      code: 'INDEX_CONFLICT_operationId_1',
    })
    assert.deepEqual(adapter.writes, [])
  })

  await t.test('same key under a different name', async () => {
    const adapter = new MockAdapter()
    adapter.indexes.get(REV02_ENFORCEMENT_COLLECTION).push({
      name: 'unexpected_operation_index',
      key: { operationId: 1 },
      unique: true,
      partialFilterExpression: { operationId: { $exists: true } },
    })
    await assert.rejects(runRev02ProductionMigration(adapter, 'apply'), {
      code: 'INDEX_KEY_CONFLICT_operationId_1',
    })
    assert.deepEqual(adapter.writes, [])
  })
})

test('partial success is preserved and a safe rerun completes the remaining delta', async () => {
  const adapter = new MockAdapter()
  adapter.failOnWrite = 3
  await assert.rejects(runRev02ProductionMigration(adapter, 'apply'), {
    code: 'MIGRATION_APPLY_FAILED',
  })
  assert.deepEqual(adapter.writes, [
    { type: 'createCollection', collection: REV02_AUDIT_COLLECTION },
    {
      type: 'createIndex',
      collection: REV02_ENFORCEMENT_COLLECTION,
      name: 'operationId_1',
    },
  ])

  adapter.failOnWrite = null
  const rerun = await runRev02ProductionMigration(adapter, 'apply')
  assert.equal(rerun.status, 'APPLIED')
  assert.deepEqual(rerun.actions, [
    {
      type: 'createIndex',
      collection: REV02_AUDIT_COLLECTION,
      name: 'reversal_audit_attempt_event_unique',
    },
    {
      type: 'createIndex',
      collection: REV02_AUDIT_COLLECTION,
      name: 'reversal_audit_actor_history',
    },
  ])
})

test('target collection and database mismatches fail closed', async (t) => {
  await t.test('wrong database', async () => {
    const adapter = new MockAdapter()
    adapter.databaseName = 'other'
    await assert.rejects(runRev02ProductionMigration(adapter), {
      code: 'TARGET_DATABASE_MISMATCH',
    })
  })

  await t.test('existing audit namespace is not a collection', async () => {
    const adapter = new MockAdapter()
    adapter.collections.set(REV02_AUDIT_COLLECTION, 'view')
    await assert.rejects(runRev02ProductionMigration(adapter), {
      code: 'AUDIT_COLLECTION_CONFLICT',
    })
  })
})

test('CLI defaults to dry-run and configuration enforces isolated and production boundaries', () => {
  assert.deepEqual(parseRev02MigrationCli([]), { mode: 'dry-run', testMode: false })
  assert.deepEqual(parseRev02MigrationCli(['--test-mode']), {
    mode: 'dry-run',
    testMode: true,
  })
  assert.deepEqual(parseRev02MigrationCli(['--apply', '--test-mode']), {
    mode: 'apply',
    testMode: true,
  })
  assert.throws(() => parseRev02MigrationCli(['--unknown']), { code: 'CLI_INVALID' })

  const local = {
    MOVUNE_REV02_MIGRATION_DB_URL: 'mongodb://localhost:27017/test',
    MOVUNE_REV02_TARGET_DATABASE: 'test',
    MOVUNE_REV02_TARGET_CLUSTER: 'local-fixture',
    MOVUNE_REV02_TEST_ACK: REV02_TEST_ACK,
  }
  assert.equal(
    validateRev02MigrationConfiguration(local, parseRev02MigrationCli(['--test-mode'])).testMode,
    true,
  )
  assert.throws(
    () =>
      validateRev02MigrationConfiguration(
        { ...local, DB_URL: 'mongodb://must-not-be-used' },
        parseRev02MigrationCli(['--test-mode']),
      ),
    { code: 'APPLICATION_DB_URL_PRESENT' },
  )

  const production = {
    MOVUNE_REV02_MIGRATION_DB_URL:
      'mongodb+srv://future_writer:SIMULATED@movune.ndbtzal.mongodb.net/test?appName=Movune',
    MOVUNE_REV02_TARGET_DATABASE: 'test',
    MOVUNE_REV02_TARGET_CLUSTER: 'Movune',
    MOVUNE_REV02_MIGRATION_ACK: REV02_PRODUCTION_ACK,
    MOVUNE_REV02_EXPECTED_USERNAME: 'future_writer',
  }
  assert.equal(
    validateRev02MigrationConfiguration(production, parseRev02MigrationCli([])).mode,
    'dry-run',
  )
  assert.throws(
    () => validateRev02MigrationConfiguration(production, parseRev02MigrationCli(['--apply'])),
    { code: 'MIGRATION_APPLY_ACK_REQUIRED' },
  )
  assert.throws(
    () =>
      validateRev02MigrationConfiguration(
        {
          ...production,
          MOVUNE_REV02_MIGRATION_APPLY_ACK: REV02_APPLY_ACK,
          MOVUNE_REV02_RECOVERY_EVIDENCE_ID: 'synthetic-recovery-evidence',
          MOVUNE_REV02_MUTATION_AUTHORIZATION_ID: 'synthetic-mutation-authorization',
        },
        parseRev02MigrationCli(['--apply']),
      ),
    { code: 'OPERATION_ID_PREFLIGHT_EVIDENCE_REQUIRED' },
  )
  const applyConfiguration = validateRev02MigrationConfiguration(
    {
      ...production,
      MOVUNE_REV02_MIGRATION_APPLY_ACK: REV02_APPLY_ACK,
      MOVUNE_REV02_RECOVERY_EVIDENCE_ID: 'synthetic-recovery-evidence',
      MOVUNE_REV02_OPERATION_ID_PREFLIGHT_EVIDENCE_ID: 'synthetic-preflight-evidence',
      MOVUNE_REV02_MUTATION_AUTHORIZATION_ID: 'synthetic-mutation-authorization',
    },
    parseRev02MigrationCli(['--apply']),
  )
  assert.equal(applyConfiguration.mode, 'apply')
  assert.equal(applyConfiguration.testMode, false)
})

test('sanitized failures never include URI or credential material', async () => {
  const secret = 'SIMULATED-CREDENTIAL-MATERIAL'
  let error
  try {
    validateRev02MigrationConfiguration(
      {
        MOVUNE_REV02_MIGRATION_DB_URL: `mongodb://user:${secret}@localhost:27017/other`,
        MOVUNE_REV02_TARGET_DATABASE: 'test',
        MOVUNE_REV02_TARGET_CLUSTER: 'local-fixture',
        MOVUNE_REV02_TEST_ACK: REV02_TEST_ACK,
      },
      parseRev02MigrationCli(['--test-mode']),
    )
  } catch (caught) {
    error = caught
  }
  assert.ok(error instanceof Rev02MigrationError)
  assert.equal(JSON.stringify({ error: error.code }).includes(secret), false)
})

test('sanitizes MongoDB server diagnostics to allowlisted operation, code, and codeName', () => {
  const error = new MongoServerError({
    ok: 0,
    errmsg: 'sensitive server message mongodb://user:password@example.invalid/test',
    code: 13,
    codeName: 'Unauthorized',
  })
  const diagnostic = safeMongoOperationDiagnostic('LIST_INDEXES_ENFORCEMENT', error)
  assert.deepEqual(diagnostic, {
    error: 'MONGO_SERVER_ERROR',
    operation: 'LIST_INDEXES_ENFORCEMENT',
    mongoCode: 13,
    mongoCodeName: 'Unauthorized',
  })
  assert.equal(JSON.stringify(diagnostic).includes('sensitive server message'), false)
  assert.equal(JSON.stringify(diagnostic).includes('password'), false)
})

test('classifies unexpected operation failures without exposing exception data', () => {
  const diagnostic = safeMongoOperationDiagnostic(
    'OPERATION_ID_DUPLICATE_PREFLIGHT',
    new Error('sensitive document or credential material'),
  )
  assert.deepEqual(diagnostic, {
    error: 'MIGRATION_OPERATION_UNEXPECTED_FAILURE',
    operation: 'OPERATION_ID_DUPLICATE_PREFLIGHT',
    mongoCode: null,
    mongoCodeName: null,
  })
  assert.equal(JSON.stringify(diagnostic).includes('sensitive'), false)
})

test('drops non-allowlisted MongoDB codeName text', () => {
  const error = new MongoServerError({
    ok: 0,
    errmsg: 'not emitted',
    code: 999,
    codeName: 'Unsafe value mongodb://credential',
  })
  assert.equal(
    safeMongoOperationDiagnostic('LIST_COLLECTIONS', error).mongoCodeName,
    null,
  )
})

test('preserves the allowlisted MongoDB operation failure across the apply boundary', async () => {
  const adapter = new MockAdapter()
  const operationFailure = Object.assign(new Error('REV02_MONGO_OPERATION_FAILURE'), {
    name: 'Rev02MongoOperationFailure',
  })
  adapter.createCollection = async () => {
    throw operationFailure
  }
  await assert.rejects(runRev02ProductionMigration(adapter, 'apply'), (error) => {
    assert.equal(error, operationFailure)
    return true
  })
})

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MongoClient, MongoServerError, type Db, type Document } from 'mongodb'
import {
  REV02_AUDIT_COLLECTION,
  REV02_ENFORCEMENT_COLLECTION,
  REV02_PRODUCTION_DATABASE,
  REV02_REQUIRED_INDEXES,
  Rev02MigrationError,
  runRev02ProductionMigration,
  type CollectionMetadata,
  type DuplicatePreflight,
  type IndexMetadata,
  type RequiredIndex,
  type Rev02MigrationAdapter,
} from './rev02ProductionMigration.js'

export const REV02_PRODUCTION_CLUSTER = 'Movune' as const
export const REV02_PRODUCTION_SRV_HOST = 'movune.ndbtzal.mongodb.net' as const
export const REV02_PRODUCTION_ACK = 'movune-rev02-bounded-production-migration' as const
export const REV02_APPLY_ACK = 'movune-rev02-bounded-production-migration-apply' as const
export const REV02_TEST_ACK = 'movune-rev02-isolated-fixture' as const

export type Rev02MigrationCli = Readonly<{
  mode: 'dry-run' | 'apply'
  testMode: boolean
}>

export type Rev02MigrationConfiguration = Readonly<{
  uri: string
  databaseName: typeof REV02_PRODUCTION_DATABASE
  targetCluster: string
  mode: Rev02MigrationCli['mode']
  testMode: boolean
}>

const stop = (code: string): never => {
  throw new Rev02MigrationError(code)
}

export const REV02_MONGO_OPERATION_STAGES = Object.freeze([
  'LIST_COLLECTIONS',
  'LIST_INDEXES_ENFORCEMENT',
  'LIST_INDEXES_AUDIT',
  'OPERATION_ID_DUPLICATE_PREFLIGHT',
  'CREATE_AUDIT_COLLECTION',
  'CREATE_OPERATION_ID_INDEX',
  'CREATE_AUDIT_ATTEMPT_EVENT_INDEX',
  'CREATE_AUDIT_ACTOR_HISTORY_INDEX',
] as const)

export type Rev02MongoOperationStage = (typeof REV02_MONGO_OPERATION_STAGES)[number]

export type Rev02SafeFailureDiagnostic = Readonly<{
  error: 'MONGO_SERVER_ERROR' | 'MIGRATION_OPERATION_UNEXPECTED_FAILURE'
  operation: Rev02MongoOperationStage
  mongoCode: number | null
  mongoCodeName: string | null
}>

class Rev02MongoOperationFailure extends Error {
  readonly diagnostic: Rev02SafeFailureDiagnostic

  constructor(operation: Rev02MongoOperationStage, error: unknown) {
    super('REV02_MONGO_OPERATION_FAILURE')
    this.name = 'Rev02MongoOperationFailure'
    this.diagnostic = safeMongoOperationDiagnostic(operation, error)
  }
}

const safeMongoCodeName = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : null

export const safeMongoOperationDiagnostic = (
  operation: Rev02MongoOperationStage,
  error: unknown,
): Rev02SafeFailureDiagnostic => {
  if (error instanceof MongoServerError) {
    return Object.freeze({
      error: 'MONGO_SERVER_ERROR',
      operation,
      mongoCode: Number.isSafeInteger(error.code) ? Number(error.code) : null,
      mongoCodeName: safeMongoCodeName(error.codeName),
    })
  }
  return Object.freeze({
    error: 'MIGRATION_OPERATION_UNEXPECTED_FAILURE',
    operation,
    mongoCode: null,
    mongoCodeName: null,
  })
}

const runMongoOperation = async <T>(
  operation: Rev02MongoOperationStage,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work()
  } catch (error) {
    throw new Rev02MongoOperationFailure(operation, error)
  }
}

const hasOwn = (environment: NodeJS.ProcessEnv, name: string) =>
  Object.prototype.hasOwnProperty.call(environment, name)

const required = (environment: NodeJS.ProcessEnv, name: string, code: string): string => {
  const value = environment[name]
  if (typeof value !== 'string' || value.trim().length === 0) stop(code)
  return value as string
}

const isLoopbackHost = (host: string) => {
  const normalized = host.toLowerCase().replace(/^\[(.*)\]$/, '$1')
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost'
}

export const parseRev02MigrationCli = (args: readonly string[]): Rev02MigrationCli => {
  if (args.some((argument) => argument !== '--apply' && argument !== '--test-mode')) {
    return stop('CLI_INVALID')
  }
  if (new Set(args).size !== args.length) stop('CLI_INVALID')
  return Object.freeze({
    mode: args.includes('--apply') ? 'apply' : 'dry-run',
    testMode: args.includes('--test-mode'),
  })
}

type ParsedMongoOptions = Readonly<{
  dbName?: string
  srvHost?: string
  hosts: readonly Readonly<{ host?: string }>[]
  credentials?: Readonly<{ username?: string }>
  tls?: boolean
}>

const parseMongoOptions = (uri: string): ParsedMongoOptions => {
  try {
    return new MongoClient(uri).options as unknown as ParsedMongoOptions
  } catch {
    return stop('MIGRATION_DB_URI_INVALID')
  }
}

export const validateRev02MigrationConfiguration = (
  environment: NodeJS.ProcessEnv,
  cli: Rev02MigrationCli,
): Rev02MigrationConfiguration => {
  if (hasOwn(environment, 'DB_URL')) stop('APPLICATION_DB_URL_PRESENT')

  const uri = required(environment, 'MOVUNE_REV02_MIGRATION_DB_URL', 'MIGRATION_DB_URL_REQUIRED')
  const databaseName = required(
    environment,
    'MOVUNE_REV02_TARGET_DATABASE',
    'TARGET_DATABASE_REQUIRED',
  )
  if (databaseName !== REV02_PRODUCTION_DATABASE) stop('TARGET_DATABASE_NOT_ALLOWLISTED')

  const targetCluster = required(
    environment,
    'MOVUNE_REV02_TARGET_CLUSTER',
    'TARGET_CLUSTER_REQUIRED',
  )
  const options = parseMongoOptions(uri)
  if (options.dbName !== REV02_PRODUCTION_DATABASE) stop('MIGRATION_DB_NAME_MISMATCH')

  const hosts = options.srvHost
    ? [options.srvHost]
    : options.hosts
        .map(({ host }) => host)
        .filter((host): host is string => typeof host === 'string')
  if (hosts.length === 0) stop('MIGRATION_DB_HOST_REQUIRED')

  if (cli.testMode) {
    if (targetCluster !== 'local-fixture') stop('TEST_TARGET_CLUSTER_INVALID')
    if (!hosts.every(isLoopbackHost)) stop('TEST_MODE_REQUIRES_LOOPBACK')
    if (required(environment, 'MOVUNE_REV02_TEST_ACK', 'TEST_ACK_REQUIRED') !== REV02_TEST_ACK) {
      stop('TEST_ACK_INVALID')
    }
  } else {
    if (targetCluster !== REV02_PRODUCTION_CLUSTER) stop('TARGET_CLUSTER_NOT_ALLOWLISTED')
    if (options.srvHost?.toLowerCase() !== REV02_PRODUCTION_SRV_HOST) {
      stop('TARGET_SRV_HOST_NOT_ALLOWLISTED')
    }
    if (options.tls !== true) stop('PRODUCTION_TLS_REQUIRED')
    if (
      required(environment, 'MOVUNE_REV02_MIGRATION_ACK', 'MIGRATION_ACK_REQUIRED') !==
      REV02_PRODUCTION_ACK
    ) {
      stop('MIGRATION_ACK_INVALID')
    }
    const expectedUsername = required(
      environment,
      'MOVUNE_REV02_EXPECTED_USERNAME',
      'EXPECTED_USERNAME_REQUIRED',
    )
    if (!options.credentials?.username || options.credentials.username !== expectedUsername) {
      stop('MIGRATION_USERNAME_MISMATCH')
    }
  }

  const applyOnlyVariables = [
    'MOVUNE_REV02_MIGRATION_APPLY_ACK',
    'MOVUNE_REV02_RECOVERY_EVIDENCE_ID',
    'MOVUNE_REV02_OPERATION_ID_PREFLIGHT_EVIDENCE_ID',
    'MOVUNE_REV02_MUTATION_AUTHORIZATION_ID',
  ] as const
  if (cli.mode === 'apply' && !cli.testMode) {
    if (
      required(environment, 'MOVUNE_REV02_MIGRATION_APPLY_ACK', 'MIGRATION_APPLY_ACK_REQUIRED') !==
      REV02_APPLY_ACK
    ) {
      stop('MIGRATION_APPLY_ACK_INVALID')
    }
    required(environment, 'MOVUNE_REV02_RECOVERY_EVIDENCE_ID', 'RECOVERY_EVIDENCE_REQUIRED')
    required(
      environment,
      'MOVUNE_REV02_OPERATION_ID_PREFLIGHT_EVIDENCE_ID',
      'OPERATION_ID_PREFLIGHT_EVIDENCE_REQUIRED',
    )
    required(
      environment,
      'MOVUNE_REV02_MUTATION_AUTHORIZATION_ID',
      'MUTATION_AUTHORIZATION_REQUIRED',
    )
  } else if (
    cli.mode === 'dry-run' &&
    applyOnlyVariables.some((name) => hasOwn(environment, name))
  ) {
    stop('APPLY_CONFIGURATION_FORBIDDEN_IN_DRY_RUN')
  }

  return Object.freeze({
    uri,
    databaseName: REV02_PRODUCTION_DATABASE,
    targetCluster,
    mode: cli.mode,
    testMode: cli.testMode,
  })
}

class MongoRev02MigrationAdapter implements Rev02MigrationAdapter {
  readonly databaseName: string
  readonly #database: Db

  constructor(database: Db) {
    this.#database = database
    this.databaseName = database.databaseName
  }

  async listCollections(names: readonly string[]): Promise<readonly CollectionMetadata[]> {
    const allowedNames: ReadonlySet<string> = new Set([
      REV02_ENFORCEMENT_COLLECTION,
      REV02_AUDIT_COLLECTION,
    ])
    if (names.some((name) => !allowedNames.has(name))) {
      stop('COLLECTION_METADATA_REQUEST_NOT_ALLOWLISTED')
    }
    if (new Set(names).size !== names.length) stop('DUPLICATE_COLLECTION_METADATA_REQUEST')

    const metadata: Document[] = []
    for (const name of names) {
      const exactMetadata = await runMongoOperation('LIST_COLLECTIONS', () =>
        this.#database
          .listCollections({ name }, { nameOnly: false, authorizedCollections: true })
          .toArray(),
      )
      if (exactMetadata.length > 1) stop('DUPLICATE_COLLECTION_METADATA')
      if (exactMetadata.some((item) => item.name !== name)) stop('UNEXPECTED_COLLECTION_METADATA')
      metadata.push(...exactMetadata)
    }
    return metadata.map(({ name, type }) => {
      if (typeof type !== 'string') return stop('INVALID_COLLECTION_METADATA')
      return { name, type }
    })
  }

  async listIndexes(collection: string): Promise<readonly IndexMetadata[]> {
    if (collection !== REV02_ENFORCEMENT_COLLECTION && collection !== REV02_AUDIT_COLLECTION) {
      stop('INDEX_COLLECTION_NOT_ALLOWLISTED')
    }
    const operation =
      collection === REV02_ENFORCEMENT_COLLECTION
        ? 'LIST_INDEXES_ENFORCEMENT'
        : 'LIST_INDEXES_AUDIT'
    return (await runMongoOperation(operation, () =>
      this.#database.collection(collection).listIndexes().toArray(),
    )) as IndexMetadata[]
  }

  async preflightOperationIdDuplicates(): Promise<DuplicatePreflight> {
    const rows = await runMongoOperation('OPERATION_ID_DUPLICATE_PREFLIGHT', () =>
      this.#database
        .collection(REV02_ENFORCEMENT_COLLECTION)
        .aggregate<{
          eligibleRecords: number
          duplicateGroups: number
        }>(
          [
            { $match: { operationId: { $exists: true } } },
            { $group: { _id: '$operationId', occurrences: { $sum: 1 } } },
            {
              $group: {
                _id: null,
                eligibleRecords: { $sum: '$occurrences' },
                duplicateGroups: {
                  $sum: { $cond: [{ $gt: ['$occurrences', 1] }, 1, 0] },
                },
              },
            },
            { $project: { _id: 0, eligibleRecords: 1, duplicateGroups: 1 } },
          ],
          { allowDiskUse: false, maxTimeMS: 30_000, batchSize: 1 },
        )
        .toArray(),
    )
    const result = rows[0]
    return Object.freeze({
      status: 'VERIFIED',
      eligibleRecords: result?.eligibleRecords ?? 0,
      duplicateGroups: result?.duplicateGroups ?? 0,
    })
  }

  async createCollection(name: typeof REV02_AUDIT_COLLECTION): Promise<void> {
    if (name !== REV02_AUDIT_COLLECTION) stop('COLLECTION_NOT_ALLOWLISTED')
    await runMongoOperation('CREATE_AUDIT_COLLECTION', () => this.#database.createCollection(name))
  }

  async createIndex(definition: RequiredIndex): Promise<void> {
    if (!REV02_REQUIRED_INDEXES.includes(definition)) stop('INDEX_NOT_ALLOWLISTED')
    const operationByName = {
      operationId_1: 'CREATE_OPERATION_ID_INDEX',
      reversal_audit_attempt_event_unique: 'CREATE_AUDIT_ATTEMPT_EVENT_INDEX',
      reversal_audit_actor_history: 'CREATE_AUDIT_ACTOR_HISTORY_INDEX',
    } as const
    const operation = operationByName[definition.options.name as keyof typeof operationByName]
    if (!operation) stop('INDEX_OPERATION_STAGE_NOT_ALLOWLISTED')
    await runMongoOperation(operation, () =>
      this.#database
        .collection(definition.collection)
        .createIndex(definition.key as Document, definition.options),
    )
  }
}

const emit = (record: Readonly<Record<string, unknown>>) => {
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

export const main = async (
  args: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
) => {
  let client: MongoClient | undefined
  let stage = 'configuration'
  try {
    const cli = parseRev02MigrationCli(args)
    const configuration = validateRev02MigrationConfiguration(environment, cli)
    stage = 'connection'
    client = new MongoClient(configuration.uri, {
      appName: 'MovuneRev02BoundedMigration',
      retryReads: false,
      retryWrites: false,
      serverSelectionTimeoutMS: 10_000,
    })
    await client.connect()
    stage = 'migration'
    const result = await runRev02ProductionMigration(
      new MongoRev02MigrationAdapter(client.db(configuration.databaseName)),
      configuration.mode,
    )
    emit({
      ...result,
      targetCluster: configuration.targetCluster,
      testMode: configuration.testMode,
    })
    return 0
  } catch (error) {
    const diagnostic =
      error instanceof Rev02MongoOperationFailure ? error.diagnostic : undefined
    emit({
      schemaVersion: 1,
      status: 'FAIL_CLOSED',
      stage,
      error: error instanceof Rev02MigrationError ? error.code : diagnostic?.error ?? 'MIGRATION_UNEXPECTED_FAILURE',
      ...(diagnostic ?? {}),
    })
    return 2
  } finally {
    if (client) await client.close().catch(() => undefined)
  }
}

const invokedPath = process.argv[1]
if (invokedPath && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  process.exitCode = await main()
}
